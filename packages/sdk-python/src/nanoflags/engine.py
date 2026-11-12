"""Pure-Python port of ``@nanoflags/engine`` (``packages/engine/src/index.ts``).

Deterministic and dependency-free: the same bundle, flag key and context produce the same result
here, in the TypeScript engine (dashboard, edge, JS SDK) and in CI. Rules are data; no user code is
ever executed. Parity with the TypeScript engine is asserted by ``packages/engine/fixtures/parity.json``.

Inputs are JSON documents as produced by :func:`json.loads` (``dict``, ``list``, ``str``, ``int``,
``float``, ``bool``, ``None``). Results follow JavaScript semantics, e.g. ``True`` never equals ``1``.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

from ._js import (
    UNDEFINED,
    is_number,
    js_number_to_string,
    js_string,
    js_stringify,
    js_to_number,
    js_trim,
    js_truthy,
    js_typeof,
    string_to_number,
)

__all__ = [
    "ENGINE_VERSION",
    "Evaluation",
    "TraceStep",
    "bucket_of",
    "client_bundle",
    "evaluate",
    "match_condition",
    "match_segment",
    "murmur3",
    "supports_engine",
]

#: Version of the evaluation semantics implemented here (``ENGINE_VERSION`` of ``@nanoflags/engine``).
ENGINE_VERSION = 1

JsonValue = Any
Context = Mapping[str, Any]

# ---------------------------------------------------------------- hashing

_SURROGATE = re.compile("[\ud800-\udfff]")
_M32 = 0xFFFFFFFF


def _utf8(s: str) -> bytes:
    # TextEncoder replaces lone surrogates with U+FFFD.
    return _SURROGATE.sub("�", unicodedata.normalize("NFC", s)).encode("utf-8")


def murmur3(data: str, seed: int = 0) -> int:
    """MurmurHash3 x86 32-bit over the UTF-8 bytes of the NFC-normalised string. Distribution only, never security."""
    b = _utf8(data)
    c1, c2 = 0xCC9E2D51, 0x1B873593
    h = seed & _M32
    n = len(b)
    blocks = n >> 2
    for i in range(blocks):
        o = i * 4
        k = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
        k = (k * c1) & _M32
        k = ((k << 15) | (k >> 17)) & _M32
        k = (k * c2) & _M32
        h ^= k
        h = ((h << 13) | (h >> 19)) & _M32
        h = (h * 5 + 0xE6546B64) & _M32
    k = 0
    tail = blocks * 4
    rem = n & 3
    if rem == 3:
        k ^= b[tail + 2] << 16
    if rem >= 2:
        k ^= b[tail + 1] << 8
    if rem >= 1:
        k ^= b[tail]
        k = (k * c1) & _M32
        k = ((k << 15) | (k >> 17)) & _M32
        k = (k * c2) & _M32
        h ^= k
    h ^= n & _M32
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & _M32
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & _M32
    h ^= h >> 16
    return h


def bucket_of(seed: str, identity: str) -> float:
    """Bucket in [0, 100) with two decimals of resolution. Stable for a given seed + identity."""
    return (murmur3(f"{seed}:{identity}") % 10000) / 100


# ---------------------------------------------------------------- JavaScript property access


class _EvalError(Exception):
    """The equivalent of a TypeError thrown inside the TypeScript engine."""


def _own(obj: Any, key: Any) -> Any:
    """Own-property lookup on a plain object (``Object.prototype.hasOwnProperty``)."""
    if not isinstance(obj, dict):
        return UNDEFINED
    k = key if isinstance(key, str) else js_string(key)
    return obj.get(k, UNDEFINED) if k in obj else UNDEFINED


def _get(obj: Any, key: str) -> Any:
    """``obj.key``: throws for null/undefined like JavaScript, ``undefined`` for a missing member."""
    if obj is None or obj is UNDEFINED:
        raise _EvalError(f"Cannot read properties of {js_string(obj)} (reading '{key}')")
    if isinstance(obj, dict):
        return obj.get(key, UNDEFINED)
    if isinstance(obj, (list, str)) and key == "length":
        return len(obj)
    return UNDEFINED


def _nullish(v: Any) -> bool:
    return v is None or v is UNDEFINED


def _items(seq: Any, what: str) -> List[Any]:
    """Iterate something the engine indexes with ``.length`` / ``[i]``, or throw as JavaScript would."""
    if isinstance(seq, list):
        return seq
    if isinstance(seq, str):
        return list(seq)
    raise _EvalError(f"{what} is not iterable")


# ---------------------------------------------------------------- conditions


def _loose_eq(a: Any, b: Any) -> bool:
    if a is UNDEFINED or b is UNDEFINED:
        return False
    if js_typeof(a) == "object" or js_typeof(b) == "object":
        return js_stringify(a) == js_stringify(b)
    if is_number(a) and is_number(b):
        return float(a) == float(b)
    if isinstance(a, bool) and isinstance(b, bool):
        return a is b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return False


def _num(v: Any) -> Optional[float]:
    if is_number(v):
        f = js_to_number(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    if isinstance(v, str) and js_trim(v) != "":
        f = string_to_number(v)
        if f == f and f not in (float("inf"), float("-inf")):
            return f
    return None


def _some(conditions: Any, pred: Any) -> bool:
    if isinstance(conditions, list):
        return any(pred(c) for c in conditions)
    raise _EvalError("conditions.some is not a function")


def _every(conditions: Any, pred: Any) -> bool:
    if isinstance(conditions, list):
        return all(pred(c) for c in conditions)
    raise _EvalError("conditions.every is not a function")


def match_condition(c: Any, ctx: Any, segments: Any, depth: int = 0) -> bool:
    """Whether one condition matches ``ctx`` (``matchCondition`` of the TypeScript engine)."""
    op = _get(c, "op")
    if op == "segment" or op == "not_segment":
        value = _get(c, "value")
        seg = _own(segments, value) if isinstance(value, str) else UNDEFINED
        in_seg = seg is not UNDEFINED and depth < 4 and _match_all(_get(seg, "match"), _get(seg, "conditions"), ctx, segments, depth + 1)
        return in_seg if op == "segment" else (seg is not UNDEFINED and not in_seg)
    actual = _own(ctx, _get(c, "attribute"))
    value = _get(c, "value")
    if op == "exists":
        return not _nullish(actual)
    if op == "not_exists":
        return _nullish(actual)
    if op == "eq":
        return _loose_eq(actual, value)
    if op == "neq":
        return actual is not UNDEFINED and not _loose_eq(actual, value)
    if op == "in":
        return isinstance(value, list) and any(_loose_eq(actual, v) for v in value)
    if op == "not_in":
        return actual is not UNDEFINED and isinstance(value, list) and not any(_loose_eq(actual, v) for v in value)
    if op in ("contains", "starts_with", "ends_with"):
        if not (isinstance(actual, str) and isinstance(value, str)):
            return False
        if op == "contains":
            return value in actual
        if op == "starts_with":
            return actual.startswith(value)
        return actual.endswith(value)
    if op in ("gt", "gte", "lt", "lte"):
        a = _num(actual)
        b = _num(value)
        if a is None or b is None:
            return False
        if op == "gt":
            return a > b
        if op == "gte":
            return a >= b
        if op == "lt":
            return a < b
        return a <= b
    return False


def _match_all(mode: Any, conditions: Any, ctx: Any, segments: Any, depth: int = 0) -> bool:
    if _get(conditions, "length") == 0:
        return True
    pred = lambda c: match_condition(c, ctx, segments, depth)  # noqa: E731
    return _some(conditions, pred) if mode == "any" else _every(conditions, pred)


def match_segment(segment: Mapping[str, Any], ctx: Context, segments: Optional[Mapping[str, Any]] = None) -> bool:
    """Whether ``ctx`` is in ``segment`` (``matchSegment`` of the TypeScript engine)."""
    return _match_all(_get(segment, "match"), _get(segment, "conditions"), ctx, segments if segments is not None else {}, 1)


_WORDS = {
    "eq": "=", "neq": "≠", "in": "in", "not_in": "not in", "contains": "contains", "starts_with": "starts with",
    "ends_with": "ends with", "gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "exists": "exists",
    "not_exists": "does not exist", "segment": "in segment", "not_segment": "not in segment",
}


def describe_condition(c: Any) -> str:
    """Human-readable condition, as shown in traces (``describeCondition``)."""
    value = _get(c, "value")
    op = _get(c, "op")
    if isinstance(value, list):
        v = ", ".join("" if _nullish(x) else js_string(x) for x in value)
    elif value is UNDEFINED:
        v = ""
    else:
        v = js_string(value)
    word = _WORDS.get(op, "undefined") if isinstance(op, str) else "undefined"
    attribute = js_string(_get(c, "attribute"))
    if op in ("segment", "not_segment"):
        return f"{word} {v}"
    if op in ("exists", "not_exists"):
        return f"{attribute} {word}"
    return f"{attribute} {word} {v}"


# ---------------------------------------------------------------- evaluation


@dataclass(frozen=True)
class TraceStep:
    kind: str
    title: str
    detail: str
    matched: Optional[bool] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"kind": self.kind, "title": self.title, "detail": self.detail}
        if self.matched is not None:
            d["matched"] = self.matched
        return d


@dataclass(frozen=True)
class Evaluation:
    """Result of one evaluation. ``reason`` is one of ``rule_match``, ``default``, ``off``, ``flag_not_found``, ``error``."""

    flag_key: str
    value: Any
    reason: str
    revision: Any = 0
    rule_index: Optional[int] = None
    rule_id: Optional[Any] = None
    in_rollout: Optional[bool] = None
    bucket: Optional[float] = None
    trace: List[TraceStep] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """The camelCase shape of the TypeScript ``Evaluation`` (absent members omitted)."""
        d: Dict[str, Any] = {"flagKey": self.flag_key, "value": self.value, "reason": self.reason, "revision": self.revision}
        for name, key in (("rule_index", "ruleIndex"), ("rule_id", "ruleId"), ("in_rollout", "inRollout"), ("bucket", "bucket"), ("error", "error")):
            v = getattr(self, name)
            if v is not None:
                d[key] = v
        d["trace"] = [t.to_dict() for t in self.trace]
        return d


def fmt(v: Any) -> str:
    if isinstance(v, str):
        return v
    s = js_stringify(v)
    return "undefined" if s is UNDEFINED else s


def _out(v: Any) -> Any:
    return None if v is UNDEFINED else v


def _gt_zero(v: Any) -> bool:
    if is_number(v):
        return float(v) > 0
    n = js_to_number(v)
    return n == n and n > 0


def evaluate(bundle: Optional[Mapping[str, Any]], flag_key: str, ctx: Optional[Context], fallback: Any) -> Evaluation:
    """Evaluate one flag. Never raises: on any problem it returns ``fallback`` with reason
    ``flag_not_found`` or ``error``, so callers always have an explicit default."""
    revision: Any = 0
    if bundle is not None:
        r = bundle.get("revision", UNDEFINED) if isinstance(bundle, dict) else UNDEFINED
        revision = 0 if _nullish(r) else r
    ctx = {} if ctx is None else ctx
    trace: List[TraceStep] = []
    try:
        flags = bundle.get("flags", UNDEFINED) if isinstance(bundle, dict) else UNDEFINED
        flag = _own(flags, flag_key)
        if bundle is None or not js_truthy(flag):
            detail = "Flag is not in this configuration. The application fallback applies." if bundle is not None else "No configuration is loaded. The application fallback applies."
            trace.append(TraceStep("result", f"Returned {fmt(fallback)}", detail))
            return Evaluation(flag_key, fallback, "flag_not_found", revision, trace=trace)
        trace.append(TraceStep("config", "Configuration loaded", f"r{js_string(revision)}" if _gt_zero(revision) else "draft"))
        if not js_truthy(_get(flag, "enabled")):
            off = _get(flag, "off")
            trace.append(TraceStep("result", f"Returned {fmt(off)}", "Flag is disabled in this environment."))
            return Evaluation(flag_key, _out(off), "off", revision, trace=trace)
        segments = bundle.get("segments", UNDEFINED)
        rules = _get(flag, "rules")
        # `for (i = 0; i < flag.rules.length; i++)`: throws for null/undefined, runs zero times without a length.
        rule_list = [] if _get(rules, "length") is UNDEFINED else _items(rules, "rules")
        for i, rule in enumerate(rule_list):
            conditions = _get(rule, "conditions")
            match = _get(rule, "match")
            matched = _match_all(match, conditions, ctx, segments)
            label = f"Rule {i + 1:02d}"
            if _get(conditions, "length"):
                if not isinstance(conditions, list):
                    raise _EvalError("rule.conditions.map is not a function")
                summary = (" OR " if match == "any" else " AND ").join(describe_condition(c) for c in conditions)
            else:
                summary = "all contexts"
            trace.append(TraceStep("rule", f"{label} matched" if matched else f"{label} did not match", summary, matched))
            if not matched:
                continue
            serve = _get(rule, "serve")
            rule_id = _out(_get(rule, "id"))
            if _get(serve, "type") == "fixed":
                value = _get(serve, "value")
                trace.append(TraceStep("result", f"Returned {fmt(value)}", f"{label} serves a fixed value."))
                return Evaluation(flag_key, _out(value), "rule_match", revision, rule_index=i, rule_id=rule_id, trace=trace)
            bucket_by = _get(serve, "bucketBy")
            attr = "key" if _nullish(bucket_by) else bucket_by
            identity = _own(ctx, attr)
            otherwise = _get(serve, "otherwise")
            if _nullish(identity) or identity == "":
                trace.append(TraceStep("allocation", "Allocation skipped", f'Context has no "{js_string(attr)}" to bucket by; treated as outside the allocation.', False))
                trace.append(TraceStep("result", f"Returned {fmt(otherwise)}", "Remaining eligible users."))
                return Evaluation(flag_key, _out(otherwise), "rule_match", revision, rule_index=i, rule_id=rule_id, in_rollout=False, trace=trace)
            seed = _get(serve, "seed")
            bucket = bucket_of(flag_key if _nullish(seed) else js_string(seed), js_string(identity))
            percentage = _get(serve, "percentage")
            p = js_to_number(percentage)
            in_rollout = p == p and bucket < p
            pct = js_string(percentage)
            trace.append(TraceStep("allocation", "Allocation evaluated", f"{pct}% rollout · {js_string(attr)} {'inside' if in_rollout else 'outside'} allocation (bucket {bucket:.2f})", in_rollout))
            value = _get(serve, "value") if in_rollout else otherwise
            trace.append(TraceStep("result", f"Returned {fmt(value)}", f"Inside the {pct}% allocation." if in_rollout else "Remaining eligible users."))
            return Evaluation(flag_key, _out(value), "rule_match", revision, rule_index=i, rule_id=rule_id, in_rollout=in_rollout, bucket=bucket, trace=trace)
        default = _get(flag, "default")
        trace.append(TraceStep("result", f"Returned {fmt(default)}", "No rule matched. The flag default applies."))
        return Evaluation(flag_key, _out(default), "default", revision, trace=trace)
    except Exception as e:  # noqa: BLE001 - the engine never raises
        error = str(e) or type(e).__name__
        trace.append(TraceStep("result", f"Returned {fmt(fallback)}", f"Evaluation error: {error}. The application fallback applies."))
        return Evaluation(flag_key, fallback, "error", revision, trace=trace, error=error)


# ---------------------------------------------------------------- bundles


def supports_engine(bundle: Mapping[str, Any]) -> bool:
    """True when this engine can evaluate ``bundle`` (its ``engine`` is absent or not newer than :data:`ENGINE_VERSION`)."""
    e = bundle.get("engine", UNDEFINED) if isinstance(bundle, dict) else UNDEFINED
    if e is UNDEFINED:
        return True
    return is_number(e) and float(e).is_integer() and 1 <= e <= ENGINE_VERSION


def client_bundle(bundle: Mapping[str, Any]) -> Dict[str, Any]:
    """The browser-key view: client-exposed flags and only the segments they reference (transitively)."""
    flags = {k: f for k, f in (bundle.get("flags") or {}).items() if isinstance(f, dict) and f.get("clientExposed") is True}
    segments_in = bundle.get("segments") or {}
    pending: List[str] = []

    def refs(conditions: Any) -> None:
        for c in conditions or []:
            if isinstance(c, dict) and c.get("op") in ("segment", "not_segment") and isinstance(c.get("value"), str):
                pending.append(c["value"])

    for f in flags.values():
        for r in f.get("rules") or []:
            refs(r.get("conditions") if isinstance(r, dict) else None)
    needed = set()
    while pending:
        k = pending.pop()
        seg = segments_in.get(k) if isinstance(segments_in, dict) else None
        if k in needed or seg is None:
            continue
        needed.add(k)
        refs(seg.get("conditions") if isinstance(seg, dict) else None)
    segments = {k: v for k, v in segments_in.items() if k in needed}
    return {**bundle, "flags": flags, "segments": segments}


def is_bundle(v: Any) -> bool:
    """Structural check of a configuration bundle (``schema`` 1, numeric ``revision``, ``flags`` and ``segments`` objects)."""
    return (
        isinstance(v, dict)
        and v.get("schema") == 1
        and not isinstance(v.get("schema"), bool)
        and is_number(v.get("revision"))
        and isinstance(v.get("flags"), dict)
        and isinstance(v.get("segments"), (dict, list))
    )


def type_of(v: Any) -> str:
    """``null``, ``array``, or the JavaScript ``typeof`` of ``v``."""
    if v is None:
        return "null"
    if isinstance(v, list):
        return "array"
    return js_typeof(v)


__all__ += ["describe_condition", "fmt", "is_bundle", "type_of", "js_number_to_string"]
