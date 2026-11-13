/// JavaScript value semantics the engine depends on.
///
/// The reference engine is TypeScript and evaluates configuration that is plain JSON with JavaScript
/// semantics: truthiness, loose property access, `Number()`, `String()`, `JSON.stringify` (number
/// formatting and key order) and `true !== 1`. This library reproduces exactly that subset on top of
/// the values `jsonDecode` produces (`Map<String, dynamic>`, `List`, `String`, `int`, `double`,
/// `bool`, `null`), so the Dart engine returns byte-identical results, malformed configurations
/// included (asserted by `packages/engine/fixtures/parity.json`).
///
/// Dart strings are UTF-16 like JavaScript strings, so `length`, indexing, `includes`,
/// `startsWith` and `endsWith` already behave identically, lone surrogates included.
library;

import 'dart:math' as math;

/// JavaScript `undefined`: an absent property. Distinct from `null` (JSON null).
final class JsUndefined {
  const JsUndefined._();
  @override
  String toString() => 'undefined';
}

/// The single `undefined` value.
const Object undefined = JsUndefined._();

/// A built-in method read as a property (`"abc".match`, `[].some`): only ever compared or printed.
final class JsFunction {
  const JsFunction(this.name);
  final String name;
  @override
  String toString() => 'function $name() { [native code] }';
}

/// A `TypeError` with V8's message, thrown inside an evaluation and turned into reason `error`.
final class JsTypeError implements Exception {
  JsTypeError(this.message);
  final String message;
  @override
  String toString() => message;
}

bool isUndefined(Object? v) => identical(v, undefined);
bool isNullish(Object? v) => v == null || identical(v, undefined);

/// `typeof v` (with arrays and null reported as "object", as JavaScript does).
String jsTypeOf(Object? v) {
  if (identical(v, undefined)) return 'undefined';
  if (v is bool) return 'boolean';
  if (v is num) return 'number';
  if (v is String) return 'string';
  if (v is JsFunction) return 'function';
  return 'object';
}

bool _isObjectLike(Object? v) => v == null || v is List || v is Map || (v is! bool && v is! num && v is! String && v is! JsFunction && !identical(v, undefined));

/// `ToBoolean(v)`.
bool jsTruthy(Object? v) {
  if (v == null || identical(v, undefined)) return false;
  if (v is bool) return v;
  if (v is num) {
    final d = v.toDouble();
    return d != 0 && !d.isNaN;
  }
  if (v is String) return v.isNotEmpty;
  return true; // objects, arrays and functions, even empty ones
}

/* ---------------- Number::toString ---------------- */

/// ECMAScript `Number::toString(x)` for radix 10 (what `String(n)` and `JSON.stringify` print).
String jsNumberToString(num value) {
  final x = value.toDouble();
  if (x.isNaN) return 'NaN';
  if (x == 0) return '0';
  if (x.isInfinite) return x > 0 ? 'Infinity' : '-Infinity';
  final sign = x < 0 ? '-' : '';
  // Shortest round-trip digits in d.ddde±x form, the same digits JavaScript chooses.
  final e = x.abs().toStringAsExponential();
  final at = e.indexOf('e');
  final mantissa = e.substring(0, at);
  final digits = mantissa.replaceFirst('.', '');
  final k = digits.length;
  final n = int.parse(e.substring(at + 1)) + 1;
  String out;
  if (k <= n && n <= 21) {
    out = digits + '0' * (n - k);
  } else if (0 < n && n <= 21) {
    out = '${digits.substring(0, n)}.${digits.substring(n)}';
  } else if (-6 < n && n <= 0) {
    out = '0.${'0' * -n}$digits';
  } else {
    final exp = n - 1;
    final es = exp < 0 ? '-${-exp}' : '+$exp';
    out = k == 1 ? '${digits}e$es' : '${digits[0]}.${digits.substring(1)}e$es';
  }
  return sign + out;
}

/* ---------------- String(v) ---------------- */

/// `String(v)` (also what a template literal produces).
String jsString(Object? v) {
  if (identical(v, undefined)) return 'undefined';
  if (v == null) return 'null';
  if (v is bool) return v ? 'true' : 'false';
  if (v is num) return jsNumberToString(v);
  if (v is String) return v;
  if (v is List) return jsJoin(v, ',');
  if (v is JsFunction) return v.toString();
  return '[object Object]';
}

/// `Array.prototype.join(sep)`: null and undefined elements print as empty strings.
String jsJoin(List<Object?> list, String sep) {
  final sb = StringBuffer();
  for (var i = 0; i < list.length; i++) {
    if (i > 0) sb.write(sep);
    final e = list[i];
    if (!isNullish(e)) sb.write(jsString(e));
  }
  return sb.toString();
}

/* ---------------- JSON.stringify ---------------- */

/// `JSON.stringify(v)`, or `null` where JavaScript returns `undefined`.
///
/// Key order follows JavaScript's own-property order: array-index keys ascending first, then the
/// other keys in insertion order (the order `jsonDecode` keeps).
String? jsStringify(Object? v) {
  final sb = StringBuffer();
  return _writeJson(sb, v) ? sb.toString() : null;
}

bool _writeJson(StringBuffer sb, Object? v) {
  if (identical(v, undefined) || v is JsFunction) return false;
  if (v == null) {
    sb.write('null');
  } else if (v is bool) {
    sb.write(v ? 'true' : 'false');
  } else if (v is num) {
    final d = v.toDouble();
    sb.write(d.isFinite ? jsNumberToString(d) : 'null');
  } else if (v is String) {
    quoteJson(sb, v);
  } else if (v is List) {
    sb.write('[');
    for (var i = 0; i < v.length; i++) {
      if (i > 0) sb.write(',');
      if (!_writeJson(sb, v[i])) sb.write('null');
    }
    sb.write(']');
  } else if (v is Map) {
    sb.write('{');
    var first = true;
    for (final k in jsOwnKeys(v)) {
      final value = v[k];
      final member = StringBuffer();
      if (!_writeJson(member, value)) continue;
      if (!first) sb.write(',');
      first = false;
      quoteJson(sb, k);
      sb.write(':');
      sb.write(member);
    }
    sb.write('}');
  } else {
    // Not a JSON value (the engine only ever sees JSON); serialise its string form.
    quoteJson(sb, v.toString());
  }
  return true;
}

/// Own enumerable string keys of a plain object in JavaScript order.
List<String> jsOwnKeys(Map<dynamic, dynamic> m) {
  final index = <String>[];
  final other = <String>[];
  for (final key in m.keys) {
    final k = key is String ? key : jsString(key);
    (arrayIndex(k) != null ? index : other).add(k);
  }
  if (index.isEmpty) return other;
  index.sort((a, b) => arrayIndex(a)!.compareTo(arrayIndex(b)!));
  return [...index, ...other];
}

/// The canonical array index (0 … 2^32 - 2) that `k` spells, or null.
int? arrayIndex(String k) {
  final n = k.length;
  if (n == 0 || n > 10) return null;
  for (var i = 0; i < n; i++) {
    final c = k.codeUnitAt(i);
    if (c < 0x30 || c > 0x39) return null;
  }
  if (n > 1 && k.codeUnitAt(0) == 0x30) return null;
  final v = int.parse(k);
  return v < 4294967295 ? v : null;
}

/// Writes `s` as a JSON string literal, exactly as `JSON.stringify` (well-formed variant) does.
void quoteJson(StringBuffer sb, String s) {
  sb.write('"');
  final n = s.length;
  var start = 0;
  for (var i = 0; i < n; i++) {
    final c = s.codeUnitAt(i);
    String? esc;
    if (c == 0x22) {
      esc = r'\"';
    } else if (c == 0x5c) {
      esc = r'\\';
    } else if (c < 0x20) {
      esc = switch (c) {
        0x08 => r'\b',
        0x0c => r'\f',
        0x0a => r'\n',
        0x0d => r'\r',
        0x09 => r'\t',
        _ => '\\u${c.toRadixString(16).padLeft(4, '0')}',
      };
    } else if (c >= 0xd800 && c <= 0xdfff) {
      // A surrogate pair stays as it is; a lone surrogate is escaped.
      if (c <= 0xdbff && i + 1 < n) {
        final d = s.codeUnitAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          i++;
          continue;
        }
      }
      esc = '\\u${c.toRadixString(16)}';
    }
    if (esc != null) {
      sb.write(s.substring(start, i));
      sb.write(esc);
      start = i + 1;
    }
  }
  sb.write(s.substring(start));
  sb.write('"');
}

/* ---------------- ToNumber ---------------- */

bool _isJsWhitespace(int c) =>
    c == 0x09 || c == 0x0a || c == 0x0b || c == 0x0c || c == 0x0d || c == 0x20 || c == 0xa0 || c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;

/// `String.prototype.trim`.
String jsTrim(String s) {
  var a = 0;
  var b = s.length;
  while (a < b && _isJsWhitespace(s.codeUnitAt(a))) {
    a++;
  }
  while (b > a && _isJsWhitespace(s.codeUnitAt(b - 1))) {
    b--;
  }
  return (a == 0 && b == s.length) ? s : s.substring(a, b);
}

final RegExp _decimal = RegExp(r'^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$');
final RegExp _radix = RegExp(r'^0([xXoObB])([0-9a-fA-F]+)$');

/// ECMAScript `StringToNumber` (what `Number(s)` does for a string).
double stringToNumber(String s) {
  final t = jsTrim(s);
  if (t.isEmpty) return 0;
  if (t == 'Infinity' || t == '+Infinity') return double.infinity;
  if (t == '-Infinity') return double.negativeInfinity;
  final r = _radix.firstMatch(t);
  if (r != null) {
    final kind = r.group(1)!.toLowerCase();
    final base = kind == 'x' ? 16 : (kind == 'o' ? 8 : 2);
    final digits = r.group(2)!;
    for (var i = 0; i < digits.length; i++) {
      final d = int.parse(digits[i], radix: 16);
      if (d >= base) return double.nan;
    }
    return BigInt.parse(digits, radix: base).toDouble();
  }
  if (_decimal.hasMatch(t)) return double.parse(t);
  return double.nan;
}

/// `ToNumber(ToPrimitive(v, number))`.
double jsToNumber(Object? v) {
  if (identical(v, undefined)) return double.nan;
  if (v == null) return 0;
  if (v is bool) return v ? 1 : 0;
  if (v is num) return v.toDouble();
  if (v is String) return stringToNumber(v);
  return stringToNumber(jsString(v));
}

/* ---------------- property access ---------------- */

const Set<String> _stringMethods = {
  'anchor', 'at', 'big', 'blink', 'bold', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'constructor', 'endsWith',
  'fixed', 'fontcolor', 'fontsize', 'includes', 'indexOf', 'isWellFormed', 'italics', 'lastIndexOf', 'link',
  'localeCompare', 'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'search',
  'slice', 'small', 'split', 'strike', 'sub', 'substr', 'substring', 'sup', 'toLocaleLowerCase', 'toLocaleUpperCase',
  'toLowerCase', 'toString', 'toUpperCase', 'toWellFormed', 'trim', 'trimEnd', 'trimLeft', 'trimRight', 'trimStart',
  'valueOf',
};

const Set<String> _arrayMethods = {
  'at', 'concat', 'constructor', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop',
  'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'toLocaleString',
  'toReversed', 'toSorted', 'toSpliced', 'toString', 'unshift', 'values', 'with',
};

/// Object.prototype members, as `${words[name]}` renders them in `describeCondition`.
const Map<String, String> objectProtoStrings = {
  'constructor': 'function Object() { [native code] }',
  '__defineGetter__': 'function __defineGetter__() { [native code] }',
  '__defineSetter__': 'function __defineSetter__() { [native code] }',
  'hasOwnProperty': 'function hasOwnProperty() { [native code] }',
  '__lookupGetter__': 'function __lookupGetter__() { [native code] }',
  '__lookupSetter__': 'function __lookupSetter__() { [native code] }',
  'isPrototypeOf': 'function isPrototypeOf() { [native code] }',
  'propertyIsEnumerable': 'function propertyIsEnumerable() { [native code] }',
  'toString': 'function toString() { [native code] }',
  'valueOf': 'function valueOf() { [native code] }',
  '__proto__': '[object Object]',
  'toLocaleString': 'function toLocaleString() { [native code] }',
};

/// The property read `v[name]` for the fixed member names the engine reads. Throws V8's TypeError
/// for null / undefined. Plain objects expose own properties only: none of those names exist on
/// Object.prototype.
Object? jsGet(Object? v, String name) {
  if (v == null || identical(v, undefined)) {
    throw JsTypeError("Cannot read properties of ${jsString(v)} (reading '$name')");
  }
  if (v is Map) return v.containsKey(name) ? v[name] : undefined;
  if (v is String) {
    if (name == 'length') return v.length;
    final i = arrayIndex(name);
    if (i != null) return i < v.length ? v[i] : undefined;
    if (_stringMethods.contains(name)) return JsFunction(name);
    return undefined;
  }
  if (v is List) {
    if (name == 'length') return v.length;
    final i = arrayIndex(name);
    if (i != null) return i < v.length ? v[i] : undefined;
    if (_arrayMethods.contains(name)) return JsFunction(name);
    return undefined;
  }
  return undefined;
}

/// The engine's `own(obj, key)`: `Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined`.
Object? jsOwn(Object? obj, String key) {
  if (obj is Map) return obj.containsKey(key) ? obj[key] : undefined;
  if (obj is String || obj is List) {
    if (key == 'length' || arrayIndex(key) != null) return jsGet(obj, key);
  }
  return undefined;
}

/// `a === b` for the primitive kinds (objects never reach it in the engine).
bool jsStrictEquals(Object? a, Object? b) {
  if (identical(a, undefined) || identical(b, undefined)) return identical(a, b);
  if (a == null || b == null) return a == null && b == null;
  if (a is num && b is num) return a.toDouble() == b.toDouble();
  if (a is bool && b is bool) return a == b;
  if (a is String && b is String) return a == b;
  if (a is JsFunction && b is JsFunction) return a.name == b.name;
  return identical(a, b);
}

/// The engine's `looseEq`: undefined never matches; objects compare by their JSON text.
bool looseEq(Object? a, Object? b) {
  if (identical(a, undefined) || identical(b, undefined)) return false;
  if (_isObjectLike(a) || _isObjectLike(b)) return jsStringify(a) == jsStringify(b);
  return jsStrictEquals(a, b);
}

/// `null`, `array`, or the JavaScript `typeof` of `v` (the SDK's `typeOf`).
String typeName(Object? v) {
  if (v == null) return 'null';
  if (v is List) return 'array';
  return jsTypeOf(v);
}

/// `Number.isInteger(v)`.
bool jsIsInteger(Object? v) => v is num && v.isFinite && v.toDouble() == v.toDouble().truncateToDouble();

/// `Math.max(lo, Math.min(hi, v))` with NaN mapping to [lo].
double clampDouble(double v, double lo, double hi) => v.isNaN ? lo : math.max(lo, math.min(hi, v));
