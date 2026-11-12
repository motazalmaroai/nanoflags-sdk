"""JavaScript value semantics the engine depends on.

The reference engine is TypeScript. Its results depend on a handful of JavaScript behaviours that
Python does not share: ``JSON.stringify`` number formatting, ``Number(string)`` parsing, ``String(x)``,
truthiness, and ``true !== 1``. This module reproduces exactly those, so the Python evaluator returns
the same results for the same JSON inputs (asserted by the cross-language parity fixtures).
"""

from __future__ import annotations

import math
import re
from typing import Any

__all__ = [
    "UNDEFINED",
    "is_number",
    "js_number_to_string",
    "js_string",
    "js_stringify",
    "js_to_number",
    "js_truthy",
    "js_typeof",
    "string_to_number",
]


class _Undefined:
    """JavaScript ``undefined``: an absent property. Distinct from ``None`` (JSON ``null``)."""

    _instance: _Undefined | None = None

    def __new__(cls) -> _Undefined:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNDEFINED"

    def __bool__(self) -> bool:
        return False


UNDEFINED: Any = _Undefined()


def is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def js_typeof(v: Any) -> str:
    if v is UNDEFINED:
        return "undefined"
    if v is None or isinstance(v, (dict, list, tuple)):
        return "object"
    if isinstance(v, bool):
        return "boolean"
    if is_number(v):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"


def js_truthy(v: Any) -> bool:
    if v is UNDEFINED or v is None or v is False:
        return False
    if isinstance(v, bool):
        return True
    if is_number(v):
        f = float(v)
        return not (f == 0 or math.isnan(f))
    if isinstance(v, str):
        return v != ""
    return True  # objects and arrays, even empty ones


def _to_double(v: int | float) -> float:
    try:
        return float(v)
    except OverflowError:  # integers beyond the double range
        return math.inf if v > 0 else -math.inf


def js_number_to_string(v: int | float) -> str:
    """``Number.prototype.toString()`` / ``String(n)`` for a JavaScript number (ECMA-262 Number::toString)."""
    x = _to_double(v)
    if math.isnan(x):
        return "NaN"
    if x == 0:
        return "0"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    sign = "-" if x < 0 else ""
    r = repr(abs(x))  # shortest round-trip digits, like JavaScript
    mantissa, _, exp_part = r.partition("e")
    exp = int(exp_part) if exp_part else 0
    int_part, _, frac_part = mantissa.partition(".")
    digits = (int_part + frac_part).lstrip("0")
    # position of the decimal point relative to the start of `digits`
    point = len(int_part) + exp
    if int_part.strip("0") == "":
        # 0.000123 → leading zeros of the fraction shift the point left
        stripped = frac_part.lstrip("0")
        point = exp - (len(frac_part) - len(stripped))
        digits = stripped
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    es = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + digits + "e" + es
    return sign + digits[0] + "." + digits[1:] + "e" + es


def js_string(v: Any) -> str:
    """``String(v)`` (also what a template literal produces)."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if is_number(v):
        return js_number_to_string(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ",".join("" if (x is None or x is UNDEFINED) else js_string(x) for x in v)
    return "[object Object]"


_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_NEEDS_ESCAPE = re.compile(r'["\\\x00-\x1f\ud800-\udfff]')


def _quote(s: str) -> str:
    def repl(m: re.Match[str]) -> str:
        c = m.group(0)
        if c in _ESCAPES:
            return _ESCAPES[c]
        return "\\u%04x" % ord(c)  # control characters and lone surrogates (well-formed JSON.stringify)

    return '"' + _NEEDS_ESCAPE.sub(repl, s) + '"'


def js_stringify(v: Any) -> Any:
    """``JSON.stringify(v)`` for JSON-like values. Returns ``UNDEFINED`` where JavaScript returns ``undefined``."""
    if v is UNDEFINED:
        return UNDEFINED
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if is_number(v):
        x = _to_double(v)
        return "null" if (math.isnan(x) or math.isinf(x)) else js_number_to_string(x)
    if isinstance(v, str):
        return _quote(v)
    if isinstance(v, (list, tuple)):
        parts = []
        for x in v:
            s = js_stringify(x)
            parts.append("null" if s is UNDEFINED else s)
        return "[" + ",".join(parts) + "]"
    if isinstance(v, dict):
        # JavaScript orders integer-like keys first (ascending), then string keys in insertion order.
        keys = [str(k) for k in v.keys()]
        index_keys = sorted((k for k in keys if _is_array_index(k)), key=int)
        other = [k for k in keys if not _is_array_index(k)]
        lookup = {str(k): val for k, val in v.items()}
        parts = []
        for k in index_keys + other:
            s = js_stringify(lookup[k])
            if s is not UNDEFINED:
                parts.append(_quote(k) + ":" + s)
        return "{" + ",".join(parts) + "}"
    return UNDEFINED


def _is_array_index(k: str) -> bool:
    return k.isascii() and k.isdigit() and (k == "0" or not k.startswith("0")) and int(k) < 4294967295


# ECMAScript WhiteSpace + LineTerminator (String.prototype.trim, StringToNumber).
_JS_WS = "\t\n\v\f\r                  　﻿"
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_HEX = re.compile(r"0[xX][0-9a-fA-F]+")
_OCT = re.compile(r"0[oO][0-7]+")
_BIN = re.compile(r"0[bB][01]+")


def js_trim(s: str) -> str:
    return s.strip(_JS_WS)


def _big_to_float(i: int) -> float:
    try:
        return float(i)
    except OverflowError:
        return math.inf


def string_to_number(s: str) -> float:
    """``Number(s)`` for a string."""
    t = js_trim(s)
    if t == "":
        return 0.0
    if t in ("Infinity", "+Infinity"):
        return math.inf
    if t == "-Infinity":
        return -math.inf
    if _HEX.fullmatch(t):
        return _big_to_float(int(t[2:], 16))
    if _OCT.fullmatch(t):
        return _big_to_float(int(t[2:], 8))
    if _BIN.fullmatch(t):
        return _big_to_float(int(t[2:], 2))
    if _DECIMAL.fullmatch(t):
        return float(t)
    return math.nan


def js_to_number(v: Any) -> float:
    """``ToNumber(v)`` (what a relational comparison applies to a non-number operand)."""
    if v is UNDEFINED:
        return math.nan
    if v is None or v is False:
        return 0.0
    if v is True:
        return 1.0
    if is_number(v):
        return _to_double(v)
    if isinstance(v, str):
        return string_to_number(v)
    if isinstance(v, (list, tuple)):
        return string_to_number(js_string(v))  # ToPrimitive → join
    return math.nan
