"""Shadow evaluation of drafts (migration 0179, RUNTIME.md "Shadow evaluation of drafts").

While a change waits for approval in an environment whose admin turned shadow evaluation on, the edge announces a
signed shadow bundle (``X-NanoFlags-Shadow`` on ``/v1/bundle``, the bundle itself on ``/v1/shadow``). For a sample of
the evaluations of the flags the draft changes, the client evaluates the draft as well and counts, per flag, how often
the value would change. Only those counters leave the process (with the next ``/v1/events`` report)::

    {sessionId, checksum, version?, flags: [{flag, samples, flips, pairs: [{live, shadow, count}], rules: {"<i>" | "default": n}}]}

No context, attribute, key or identifier is ever part of it. Values are the flag's own configured values, as JSON text
with object keys sorted, at most 100 characters (longer ones are replaced by a hash); a side that used the app's own
fallback (flag missing there, evaluation error, wrong type) is reported as ``"<fallback>"``, never as the value. The
shadow bundle is NEVER applied: the app always gets the live value, and the client refuses any bundle that carries a
``shadow`` member as configuration.

Same wire format and rules as the JavaScript SDK (``packages/sdk/src/shadow.ts``).
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Set

from ._js import UNDEFINED, is_number, js_stringify
from .engine import murmur3

__all__ = [
    "FALLBACK_TOKEN",
    "MAX_SHADOW_FLAGS",
    "MAX_SHADOW_PAIRS",
    "MAX_SHADOW_RULES",
    "MAX_SHADOW_VALUE_CHARS",
    "SHADOW_FLUSH_INTERVAL",
    "SHADOW_RETRY_INTERVAL",
    "ShadowCounters",
    "ShadowOptions",
    "changed_flags",
    "changed_segments",
    "is_shadow_bundle",
    "is_shadow_marker",
    "parse_shadow_header",
    "repr_value",
    "stable_stringify",
    "utf16_len",
    "utf16_truncate",
]

MAX_SHADOW_FLAGS = 100
MAX_SHADOW_PAIRS = 10
MAX_SHADOW_RULES = 50
MAX_SHADOW_VALUE_CHARS = 100
#: The edge accepts counts up to 10^7; a counter stops there (the next report starts from zero again).
MAX_SHADOW_COUNT = 10_000_000
#: The edge accepts flag keys of 1–63 characters in a report.
MAX_SHADOW_FLAG_KEY = 63
#: Shadow counters go out with the events report at most this often, in seconds (and always on flush() and close()).
SHADOW_FLUSH_INTERVAL = 60.0
#: A failed shadow fetch is not retried for the same announcement before this, in seconds.
SHADOW_RETRY_INTERVAL = 60.0
#: Reported instead of a value that did not come from a bundle: the application's own fallback (flag missing on that
#: side, evaluation error, or a value of the wrong type). The fallback is the app's data and never leaves the SDK.
FALLBACK_TOKEN = "<fallback>"

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_CHECKSUM = re.compile(r"[0-9a-f]{32}")
_HEADER = re.compile(r"([0-9a-f-]{36})\.([0-9a-f]{32})", re.I)


@dataclass(frozen=True)
class ShadowOptions:
    """Shadow evaluation of drafts (needs ``events`` enabled).

    ``enabled``: ``False`` never fetches nor evaluates shadow bundles (same as ``shadow=False``).
    ``sample_rate``: fraction of evaluations of changed flags that are also evaluated with the draft, 0–1.
    ``random``: random source for sampling (tests).
    """

    enabled: bool = True
    sample_rate: float = 0.1
    random: Optional[Callable[[], float]] = None


def utf16_len(s: str) -> int:
    """Length in UTF-16 code units (JavaScript ``String.length``), which is what the edge counts."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def utf16_truncate(s: str, n: int) -> str:
    """The first ``n`` UTF-16 code units of ``s`` (never splitting a surrogate pair)."""
    if utf16_len(s) <= n:
        return s
    out: List[str] = []
    used = 0
    for ch in s:
        w = 2 if ord(ch) > 0xFFFF else 1
        if used + w > n:
            break
        out.append(ch)
        used += w
    return "".join(out)


def parse_shadow_header(v: Optional[str]) -> Optional[Dict[str, str]]:
    """``X-NanoFlags-Shadow: <sessionId>.<checksum>`` → ``{"sessionId", "checksum"}`` (lower case), or None."""
    if not v:
        return None
    m = _HEADER.fullmatch(v.strip())
    if not m or not _UUID.fullmatch(m.group(1)):
        return None
    return {"sessionId": m.group(1).lower(), "checksum": m.group(2).lower()}


def is_shadow_marker(v: Any) -> bool:
    return (
        isinstance(v, dict)
        and isinstance(v.get("sessionId"), str)
        and _UUID.fullmatch(v["sessionId"]) is not None
        and isinstance(v.get("checksum"), str)
        and _CHECKSUM.fullmatch(v["checksum"]) is not None
        and isinstance(v.get("environmentId"), str)
        and is_number(v.get("baseRevision"))
    )


def is_shadow_bundle(v: Any) -> bool:
    """A shadow bundle: the bundle shape (object ``segments``) plus its ``shadow`` marker (inside the signed bytes)."""
    return (
        isinstance(v, dict)
        and v.get("schema") == 1
        and not isinstance(v.get("schema"), bool)
        and is_number(v.get("revision"))
        and isinstance(v.get("flags"), dict)
        and isinstance(v.get("segments"), dict)
        and is_shadow_marker(v.get("shadow"))
    )


def _utf16_key(k: str) -> bytes:
    # JavaScript sorts strings by UTF-16 code units; big-endian UTF-16 bytes compare the same way.
    return k.encode("utf-16-be", "surrogatepass")


def stable_stringify(v: Any) -> str:
    """JSON text with object keys sorted, so two configurations compare equal whatever their key order."""
    if v is UNDEFINED:
        return "null"
    if isinstance(v, dict):
        parts = []
        for k in sorted((str(k) for k in v.keys()), key=_utf16_key):
            x = v.get(k)
            if x is UNDEFINED:
                continue
            parts.append(js_stringify(k) + ":" + stable_stringify(x))
        return "{" + ",".join(parts) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(stable_stringify(x) for x in v) + "]"
    s = js_stringify(v)
    return "null" if s is UNDEFINED else s


def _condition_refs(conditions: Any) -> List[str]:
    """Segment keys a list of conditions references directly (segment / not_segment)."""
    out: List[str] = []
    for c in conditions if isinstance(conditions, list) else []:
        if isinstance(c, dict) and c.get("op") in ("segment", "not_segment") and isinstance(c.get("value"), str):
            out.append(c["value"])
    return out


def _segment_refs(f: Any) -> List[str]:
    rules = f.get("rules") if isinstance(f, dict) else None
    out: List[str] = []
    for r in rules if isinstance(rules, list) else []:
        out.extend(_condition_refs(r.get("conditions") if isinstance(r, dict) else None))
    return out


def _segments_of(b: Mapping[str, Any]) -> Dict[str, Any]:
    s = b.get("segments")
    return s if isinstance(s, dict) else {}


def changed_segments(live: Mapping[str, Any], shadow: Mapping[str, Any]) -> Set[str]:
    """Segments whose evaluation can differ between the live and the shadow bundle: the definition differs (new, edited
    or removed in the draft), or one of its conditions references such a segment, transitively. Iterated to a fixpoint.
    Same rule as the database (``app.shadow_changed_segments``) and the JavaScript SDK."""
    ls, ss = _segments_of(live), _segments_of(shadow)
    changed: Set[str] = set()
    for k in ss:
        if k not in ls or stable_stringify(ls[k]) != stable_stringify(ss[k]):
            changed.add(k)
    for k in ls:
        if k not in ss:
            changed.add(k)
    grew = True
    while grew:
        grew = False
        for k, seg in ss.items():
            if k not in changed and any(x in changed for x in _condition_refs(seg.get("conditions") if isinstance(seg, dict) else None)):
                changed.add(k)
                grew = True
    return changed


def changed_flags(live: Mapping[str, Any], shadow: Mapping[str, Any]) -> Set[str]:
    """Keys of the shadow bundle's flags that the draft changes compared with the live bundle: a different
    configuration, or a segment they reference (directly or through other segments) that differs."""
    segs = changed_segments(live, shadow)
    lf_raw, sf_raw = live.get("flags"), shadow.get("flags")
    lf: Dict[str, Any] = lf_raw if isinstance(lf_raw, dict) else {}
    sf: Dict[str, Any] = sf_raw if isinstance(sf_raw, dict) else {}
    out: Set[str] = set()
    for k, s in sf.items():
        if k not in lf or stable_stringify(lf[k]) != stable_stringify(s) or any(x in segs for x in _segment_refs(s)):
            out.add(k)
    return out


def repr_value(v: Any) -> str:
    """A value as it is reported: JSON text with object keys sorted, at most 100 characters (longer: ``#<hash>``)."""
    try:
        text = stable_stringify(v)
    except Exception:  # noqa: BLE001
        text = "null"
    return text if utf16_len(text) <= MAX_SHADOW_VALUE_CHARS else "#" + format(murmur3(text), "08x")


class _FlagCounter:
    __slots__ = ("samples", "flips", "pairs", "rules")

    def __init__(self) -> None:
        self.samples = 0
        self.flips = 0
        self.pairs: Dict[str, Dict[str, Any]] = {}
        self.rules: Dict[str, int] = {}


class ShadowCounters:
    """In-memory counters of one shadow session. Bounded: 100 flags × (10 value pairs + 50 rule counters).
    Safe for concurrent use."""

    def __init__(self, session_id: str, checksum: str) -> None:
        self.session_id = session_id
        self.checksum = checksum
        self._flags: Dict[str, _FlagCounter] = {}
        self._lock = threading.Lock()

    @property
    def size(self) -> int:
        return len(self._flags)

    def add(self, flag: str, live: Any, shadow: Any, rule_index: Optional[int], live_fallback: bool = False, shadow_fallback: bool = False) -> None:
        """One sampled evaluation: the value the app got, what the draft would give, and which draft rule matched. A
        side whose value is the app's fallback is reported as ``"<fallback>"``, never as the value. Whether the value
        changes is decided on canonical JSON, whatever the order of object keys."""
        if not isinstance(flag, str) or not flag or utf16_len(flag) > MAX_SHADOW_FLAG_KEY:
            return  # the edge would refuse the whole report
        try:
            same = stable_stringify(live) == stable_stringify(shadow)
        except Exception:  # noqa: BLE001
            same = False
        a = b = ""
        if not same:
            a = FALLBACK_TOKEN if live_fallback else repr_value(live)
            b = FALLBACK_TOKEN if shadow_fallback else repr_value(shadow)
        rk = str(rule_index) if isinstance(rule_index, int) and not isinstance(rule_index, bool) and 0 <= rule_index < 10_000 else "default"
        with self._lock:
            c = self._flags.get(flag)
            if c is None:
                if len(self._flags) >= MAX_SHADOW_FLAGS:
                    return
                c = self._flags[flag] = _FlagCounter()
            if c.samples >= MAX_SHADOW_COUNT:
                return
            c.samples += 1
            if rk in c.rules or len(c.rules) < MAX_SHADOW_RULES:
                c.rules[rk] = c.rules.get(rk, 0) + 1
            if same:
                return
            c.flips += 1
            key = f"{a}\x00{b}"
            if key not in c.pairs and len(c.pairs) >= MAX_SHADOW_PAIRS - 1:
                key = "*\x00*"
            p = c.pairs.get(key)
            if p is None:
                p = c.pairs[key] = {"live": "*" if key == "*\x00*" else a, "shadow": "*" if key == "*\x00*" else b, "count": 0}
            p["count"] += 1

    def drain(self, version: Optional[str]) -> Optional[Dict[str, Any]]:
        """The report of everything counted so far (None when nothing was), and a fresh start."""
        with self._lock:
            flags, self._flags = self._flags, {}
        if not flags:
            return None
        report: Dict[str, Any] = {"sessionId": self.session_id, "checksum": self.checksum}
        if version:
            report["version"] = version
        report["flags"] = [
            {"flag": k, "samples": c.samples, "flips": c.flips, "pairs": [dict(p) for p in c.pairs.values()], "rules": dict(c.rules)}
            for k, c in flags.items()
        ]
        return report
