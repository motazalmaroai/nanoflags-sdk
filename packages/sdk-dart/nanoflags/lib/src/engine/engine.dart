/// Dart port of `@nanoflags/engine` (`packages/engine/src/index.ts`).
///
/// Pure and deterministic: the same bundle, flag key and context produce the same result here, in
/// the TypeScript engine (dashboard, edge, JS SDK), in the Go and Python SDKs and in CI — including
/// the bucket of percentage rollouts (MurmurHash3 x86 32-bit over the UTF-8 bytes of the
/// NFC-normalised `seed:identity`). Rules are data; no user code ever runs.
///
/// Inputs are JSON documents as `jsonDecode` produces them. Results follow JavaScript semantics
/// (`true` never equals `1`, numbers print like JavaScript numbers, objects compare by their
/// `JSON.stringify` text). Parity is asserted by `packages/engine/fixtures/parity.json`.
library;

import 'dart:convert';

import 'package:unorm_dart/unorm_dart.dart' as unorm;

import 'js.dart';

/// Version of the evaluation semantics implemented here (`ENGINE_VERSION` of `@nanoflags/engine`).
const int engineVersion = 1;

/// Why an evaluation produced its value.
abstract final class Reasons {
  static const ruleMatch = 'rule_match';
  static const defaultValue = 'default';
  static const off = 'off';
  static const flagNotFound = 'flag_not_found';
  static const error = 'error';
}

/// One line of the human-readable explanation of an evaluation.
final class TraceStep {
  const TraceStep(this.kind, this.title, this.detail, [this.matched]);

  /// `config`, `rule`, `allocation` or `result`.
  final String kind;
  final String title;
  final String detail;

  /// Set for rule and allocation steps.
  final bool? matched;

  Map<String, Object?> toJson() => {'kind': kind, 'title': title, 'detail': detail, if (matched != null) 'matched': matched};

  @override
  bool operator ==(Object other) =>
      other is TraceStep && other.kind == kind && other.title == title && other.detail == detail && other.matched == matched;

  @override
  int get hashCode => Object.hash(kind, title, detail, matched);

  @override
  String toString() => 'TraceStep(${jsonEncode(toJson())})';
}

/// The full outcome of [evaluate], mirroring the engine's `Evaluation` object.
final class Evaluation {
  const Evaluation({
    required this.flagKey,
    required this.value,
    required this.reason,
    required this.revision,
    required this.trace,
    this.ruleIndex,
    this.ruleId,
    this.inRollout,
    this.bucket,
    this.error,
  });

  final String flagKey;

  /// The served value (JSON data). `null` also stands for JavaScript `undefined` (a malformed flag
  /// that serves nothing).
  final Object? value;

  /// One of [Reasons].
  final String reason;

  /// The bundle's `revision` as stored (normally an int; 0 without a bundle).
  final Object? revision;

  /// Zero-based index of the matching rule.
  final int? ruleIndex;

  /// The matching rule's `id`.
  final Object? ruleId;

  /// For rollout rules: whether the context fell inside the allocation.
  final bool? inRollout;

  /// For rollout rules that bucketed the context: its bucket in [0, 100).
  final double? bucket;
  final List<TraceStep> trace;

  /// The evaluation error message (reason `error` only).
  final String? error;

  Map<String, Object?> toJson() => {
        'flagKey': flagKey,
        'value': value,
        'reason': reason,
        if (ruleIndex != null) 'ruleIndex': ruleIndex,
        if (ruleId != null) 'ruleId': ruleId,
        if (inRollout != null) 'inRollout': inRollout,
        if (bucket != null) 'bucket': bucket,
        'revision': revision,
        'trace': [for (final t in trace) t.toJson()],
        if (error != null) 'error': error,
      };
}

/* ---------------- hashing ---------------- */

/// `TextEncoder.encode(input.normalize("NFC"))`: lone surrogates become U+FFFD (as `utf8.encode` does).
List<int> hashInput(String input) {
  var plain = true;
  for (var i = 0; i < input.length; i++) {
    // Code units below U+0300 can neither compose nor be decomposed by NFC.
    if (input.codeUnitAt(i) >= 0x300) {
      plain = false;
      break;
    }
  }
  return utf8.encode(plain ? input : unorm.nfc(input));
}

int _mul32(int a, int b) {
  // 32-bit multiplication that stays exact on the web (no 64-bit integers there).
  final lo = (a & 0xffff) * b;
  final hi = ((a >>> 16) * b) & 0xffff;
  return (lo + (hi << 16)) & 0xffffffff;
}

int _rotl(int x, int r) => ((x << r) | (x >>> (32 - r))) & 0xffffffff;

/// MurmurHash3 x86 32-bit over the UTF-8 bytes of the NFC-normalised [input]. Used for
/// distribution only — never for security.
int murmur3(String input, [int seed = 0]) {
  final data = hashInput(input);
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  var h = seed & 0xffffffff;
  final n = data.length;
  final blocks = n >> 2;
  for (var i = 0; i < blocks; i++) {
    final o = i * 4;
    var k = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
    k = _mul32(k & 0xffffffff, c1);
    k = _rotl(k, 15);
    k = _mul32(k, c2);
    h ^= k;
    h = _rotl(h, 13);
    h = (_mul32(h, 5) + 0xe6546b64) & 0xffffffff;
  }
  var k = 0;
  final tail = blocks * 4;
  final rem = n & 3;
  if (rem == 3) k ^= data[tail + 2] << 16;
  if (rem >= 2) k ^= data[tail + 1] << 8;
  if (rem >= 1) {
    k ^= data[tail];
    k = _mul32(k, c1);
    k = _rotl(k, 15);
    k = _mul32(k, c2);
    h ^= k;
  }
  h ^= n & 0xffffffff;
  h ^= h >>> 16;
  h = _mul32(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = _mul32(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h & 0xffffffff;
}

/// Bucket in [0, 100) with two decimals of resolution. Stable for a given seed + identity.
double bucketOf(String seed, String identity) => (murmur3('$seed:$identity') % 10000) / 100;

/* ---------------- conditions ---------------- */

double? _num(Object? v) {
  if (v is num) {
    final d = v.toDouble();
    return d.isFinite ? d : null;
  }
  if (v is String && jsTrim(v).isNotEmpty) {
    final d = stringToNumber(v);
    return d.isFinite ? d : null;
  }
  return null;
}

/// Whether one condition matches [ctx] (`matchCondition` of the TypeScript engine). May throw a
/// [JsTypeError] for malformed configuration, as the TypeScript engine does.
bool matchCondition(Object? c, Map<String, Object?> ctx, Object? segments, [int depth = 0]) {
  final op = jsGet(c, 'op');
  if (op == 'segment' || op == 'not_segment') {
    final value = jsGet(c, 'value');
    final seg = value is String ? jsOwn(segments, value) : undefined;
    var inSeg = false;
    if (!isUndefined(seg) && depth < 4) {
      final match = jsGet(seg, 'match');
      final conditions = jsGet(seg, 'conditions');
      inSeg = _matchAll(match, conditions, ctx, segments, depth + 1);
    }
    return op == 'segment' ? inSeg : !isUndefined(seg) && !inSeg;
  }
  final attribute = jsString(jsGet(c, 'attribute'));
  final actual = ctx.containsKey(attribute) ? ctx[attribute] : undefined;
  final value = jsGet(c, 'value');
  if (op is! String) return false;
  switch (op) {
    case 'exists':
      return !isNullish(actual);
    case 'not_exists':
      return isNullish(actual);
    case 'eq':
      return looseEq(actual, value);
    case 'neq':
      return !isUndefined(actual) && !looseEq(actual, value);
    case 'in':
      return value is List && value.any((v) => looseEq(actual, v));
    case 'not_in':
      return !isUndefined(actual) && value is List && !value.any((v) => looseEq(actual, v));
    case 'contains':
      return actual is String && value is String && actual.contains(value);
    case 'starts_with':
      return actual is String && value is String && actual.startsWith(value);
    case 'ends_with':
      return actual is String && value is String && actual.endsWith(value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      final a = _num(actual);
      final b = _num(value);
      if (a == null || b == null) return false;
      return switch (op) { 'gt' => a > b, 'gte' => a >= b, 'lt' => a < b, _ => a <= b };
    case 'semver_eq':
    case 'semver_neq':
    case 'semver_gt':
    case 'semver_gte':
    case 'semver_lt':
    case 'semver_lte':
      return _matchSemver(op, actual, value);
    case 'before':
    case 'after':
      return _matchDate(op, actual, value);
    default:
      return false;
  }
}

/* ---------------- versions and dates ---------------- */
// Port of parseSemver / compareSemver / parseInstant. Strings are UTF-16 as in JavaScript; only ASCII characters can
// make up a valid version or date.

const int _maxVersionLength = 256;

bool _isDigitUnit(int c) => c >= 48 && c <= 57;
bool _isIdentUnit(int c) => _isDigitUnit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45;

String _stripZeros(String d) {
  var i = 0;
  while (i < d.length - 1 && d.codeUnitAt(i) == 48) {
    i++;
  }
  return d.substring(i);
}

bool _allDigits(String s) => s.isNotEmpty && s.codeUnits.every(_isDigitUnit);

/// `parseSemver`: `[major, minor, patch, prerelease identifiers]`, or null.
(List<String>, List<String>)? parseSemver(Object? v) {
  if (v is! String || v.isEmpty || v.length > _maxVersionLength) return null;
  final s = v;
  final n = s.length;
  var i = (s.codeUnitAt(0) == 118 || s.codeUnitAt(0) == 86) ? 1 : 0;
  final core = <String>[];
  while (true) {
    final start = i;
    while (i < n && _isDigitUnit(s.codeUnitAt(i))) {
      i++;
    }
    if (i == start) return null;
    core.add(_stripZeros(s.substring(start, i)));
    if (core.length < 3 && i < n && s.codeUnitAt(i) == 46) {
      i++;
      continue;
    }
    break;
  }
  while (core.length < 3) {
    core.add('0');
  }
  (List<String>, int)? idents(int from, bool stopAtPlus) {
    final out = <String>[];
    var j = from;
    var start = j;
    while (true) {
      while (j < n && _isIdentUnit(s.codeUnitAt(j))) {
        j++;
      }
      if (j == start) return null;
      out.add(s.substring(start, j));
      if (j < n && s.codeUnitAt(j) == 46) {
        j++;
        start = j;
        continue;
      }
      if (j == n || (stopAtPlus && s.codeUnitAt(j) == 43)) return (out, j);
      return null;
    }
  }

  var pre = <String>[];
  if (i < n && s.codeUnitAt(i) == 45) {
    final r = idents(i + 1, true);
    if (r == null) return null;
    pre = r.$1;
    i = r.$2;
  }
  if (i < n && s.codeUnitAt(i) == 43) {
    final r = idents(i + 1, false);
    if (r == null) return null;
    i = r.$2;
  }
  if (i != n) return null;
  return (core, pre);
}

int _compareDigits(String a, String b) {
  if (a.length != b.length) return a.length < b.length ? -1 : 1;
  return a.compareTo(b).sign;
}

/// `compareSemver`: SemVer 2.0 precedence, -1 / 0 / 1.
int compareSemver((List<String>, List<String>) a, (List<String>, List<String>) b) {
  for (var k = 0; k < 3; k++) {
    final c = _compareDigits(a.$1[k], b.$1[k]);
    if (c != 0) return c;
  }
  final pa = a.$2;
  final pb = b.$2;
  if (pa.isEmpty || pb.isEmpty) return pa.length == pb.length ? 0 : (pa.isEmpty ? 1 : -1);
  for (var k = 0; k < pa.length && k < pb.length; k++) {
    final x = pa[k];
    final y = pb[k];
    final xn = _allDigits(x);
    final yn = _allDigits(y);
    final c = xn && yn ? _compareDigits(_stripZeros(x), _stripZeros(y)) : xn ? -1 : yn ? 1 : x.compareTo(y).sign;
    if (c != 0) return c;
  }
  return pa.length == pb.length ? 0 : (pa.length < pb.length ? -1 : 1);
}

bool _matchSemver(String op, Object? actual, Object? expected) {
  final a = parseSemver(actual);
  final b = parseSemver(expected);
  if (a == null || b == null) return false;
  final c = compareSemver(a, b);
  return switch (op) {
    'semver_eq' => c == 0,
    'semver_neq' => c != 0,
    'semver_gt' => c > 0,
    'semver_gte' => c >= 0,
    'semver_lt' => c < 0,
    _ => c <= 0,
  };
}

int _daysFromCivil(int year, int m, int d) {
  final y = m <= 2 ? year - 1 : year;
  final era = (y >= 0 ? y : y - 399) ~/ 400;
  final yoe = y - era * 400;
  final doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) ~/ 5 + d - 1;
  final doe = yoe * 365 + yoe ~/ 4 - yoe ~/ 100 + doy;
  return era * 146097 + doe - 719468;
}

int? _digitsAt(String s, int i, int n) {
  if (i + n > s.length) return null;
  var v = 0;
  for (var j = i; j < i + n; j++) {
    final c = s.codeUnitAt(j);
    if (!_isDigitUnit(c)) return null;
    v = v * 10 + (c - 48);
  }
  return v;
}

/// `parseInstant`: Unix epoch milliseconds, or null.
double? parseInstant(Object? v) {
  if (v is num) {
    final x = v.toDouble();
    if (!x.isFinite) return null;
    return x.abs() >= 1e12 ? x : x * 1000;
  }
  if (v is! String) return null;
  final s = v;
  final n = s.length;
  if (n < 10 || n > _maxVersionLength) return null;
  final y = _digitsAt(s, 0, 4);
  final mo = _digitsAt(s, 5, 2);
  final d = _digitsAt(s, 8, 2);
  if (y == null || mo == null || d == null || s.codeUnitAt(4) != 45 || s.codeUnitAt(7) != 45) return null;
  if (mo < 1 || mo > 12 || d < 1) return null;
  final leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
  final dim = mo == 2 ? (leap ? 29 : 28) : (mo == 4 || mo == 6 || mo == 9 || mo == 11) ? 30 : 31;
  if (d > dim) return null;
  var ms = _daysFromCivil(y, mo, d) * 86400000;
  if (n == 10) return ms.toDouble();
  final t = s.codeUnitAt(10);
  if (t != 84 && t != 116 && t != 32) return null;
  final h = _digitsAt(s, 11, 2);
  final mi = _digitsAt(s, 14, 2);
  if (h == null || mi == null || s.codeUnitAt(13) != 58) return null;
  var i = 16;
  var sec = 0;
  var frac = 0;
  if (i < n && s.codeUnitAt(i) == 58) {
    final x = _digitsAt(s, i + 1, 2);
    if (x == null) return null;
    sec = x;
    i += 3;
    if (i < n && s.codeUnitAt(i) == 46) {
      var j = i + 1;
      while (j < n && _isDigitUnit(s.codeUnitAt(j))) {
        j++;
      }
      if (j == i + 1 || j - i - 1 > 9) return null;
      frac = int.parse('${s.substring(i + 1, j)}00'.substring(0, 3));
      i = j;
    }
  }
  if (h > 23 || mi > 59 || sec > 59 || i >= n) return null;
  ms += h * 3600000 + mi * 60000 + sec * 1000 + frac;
  final z = s.codeUnitAt(i);
  if ((z == 90 || z == 122) && i + 1 == n) return ms.toDouble();
  if ((z == 43 || z == 45) && i + 6 == n && s.codeUnitAt(i + 3) == 58) {
    final oh = _digitsAt(s, i + 1, 2);
    final om = _digitsAt(s, i + 4, 2);
    if (oh == null || om == null || oh > 23 || om > 59) return null;
    final off = (oh * 60 + om) * 60000;
    return (z == 45 ? ms + off : ms - off).toDouble();
  }
  return null;
}

bool _matchDate(String op, Object? actual, Object? expected) {
  final a = parseInstant(actual);
  final b = parseInstant(expected);
  if (a == null || b == null) return false;
  return op == 'before' ? a < b : a > b;
}

bool _matchAll(Object? mode, Object? conditions, Map<String, Object?> ctx, Object? segments, int depth) {
  final length = jsGet(conditions, 'length');
  if (length is num && length == 0) return true;
  final any = mode == 'any';
  if (conditions is! List) throw JsTypeError('conditions.${any ? 'some' : 'every'} is not a function');
  return any
      ? conditions.any((c) => matchCondition(c, ctx, segments, depth))
      : conditions.every((c) => matchCondition(c, ctx, segments, depth));
}

/// Whether [ctx] is in [segment] (`matchSegment` of the TypeScript engine).
bool matchSegment(Map<String, Object?> segment, Map<String, Object?> ctx, [Map<String, Object?> segments = const {}]) =>
    _matchAll(jsGet(segment, 'match'), jsGet(segment, 'conditions'), ctx, segments, 1);

const Map<String, String> _words = {
  'eq': '=', 'neq': '≠', 'in': 'in', 'not_in': 'not in', 'contains': 'contains', 'starts_with': 'starts with',
  'ends_with': 'ends with', 'gt': '>', 'gte': '≥', 'lt': '<', 'lte': '≤', 'exists': 'exists',
  'not_exists': 'does not exist', 'segment': 'in segment', 'not_segment': 'not in segment',
  'semver_eq': 'version =', 'semver_neq': 'version ≠', 'semver_gt': 'version >', 'semver_gte': 'version ≥',
  'semver_lt': 'version <', 'semver_lte': 'version ≤', 'before': 'before', 'after': 'after',
};

/// Human-readable condition, as shown in traces (`describeCondition`).
String describeCondition(Object? c) {
  final value = jsGet(c, 'value');
  final v = value is List ? jsJoin(value, ', ') : (isUndefined(value) ? '' : jsString(value));
  final op = jsGet(c, 'op');
  final key = jsString(op);
  final word = _words[key] ?? objectProtoStrings[key] ?? 'undefined';
  if (op == 'segment' || op == 'not_segment') return '$word $v';
  final attribute = jsString(jsGet(c, 'attribute'));
  if (op == 'exists' || op == 'not_exists') return '$attribute $word';
  return '$attribute $word $v';
}

/// The engine's `fmt(v)`: strings as they are, everything else as JSON (`undefined` prints as such).
String fmt(Object? v) => v is String ? v : (jsStringify(v) ?? 'undefined');

/* ---------------- evaluation ---------------- */

Object? _out(Object? v) => isUndefined(v) ? null : v;

/// Evaluates one flag of [bundle] (a parsed bundle document; `null` for "no configuration loaded").
///
/// Never throws: on any problem it returns [fallback] with reason `flag_not_found` or `error`, so
/// callers always have an explicit default.
Evaluation evaluate(Object? bundle, String flagKey, Map<String, Object?> ctx, Object? fallback) {
  final nullish = isNullish(bundle);
  Object? revision = 0;
  if (!nullish) {
    final r = jsGet(bundle, 'revision');
    if (!isNullish(r)) revision = r;
  }
  final trace = <TraceStep>[];
  try {
    final flag = nullish ? undefined : jsOwn(jsGet(bundle, 'flags'), flagKey);
    if (!jsTruthy(bundle) || !jsTruthy(flag)) {
      final detail = jsTruthy(bundle)
          ? 'Flag is not in this configuration. The application fallback applies.'
          : 'No configuration is loaded. The application fallback applies.';
      trace.add(TraceStep('result', 'Returned ${fmt(fallback)}', detail));
      return Evaluation(flagKey: flagKey, value: fallback, reason: Reasons.flagNotFound, revision: revision, trace: trace);
    }
    trace.add(TraceStep('config', 'Configuration loaded', jsToNumber(revision) > 0 ? 'r${jsString(revision)}' : 'draft'));
    if (!jsTruthy(jsGet(flag, 'enabled'))) {
      final off = jsGet(flag, 'off');
      trace.add(TraceStep('result', 'Returned ${fmt(off)}', 'Flag is disabled in this environment.'));
      return Evaluation(flagKey: flagKey, value: _out(off), reason: Reasons.off, revision: revision, trace: trace);
    }
    final segments = jsGet(bundle, 'segments');
    for (var i = 0;; i++) {
      final rules = jsGet(flag, 'rules');
      if (!(i < jsToNumber(jsGet(rules, 'length')))) break;
      final rule = jsGet(rules, '$i');
      final match = jsGet(rule, 'match');
      final conditions = jsGet(rule, 'conditions');
      final matched = _matchAll(match, conditions, ctx, segments, 0);
      final label = 'Rule ${'${i + 1}'.padLeft(2, '0')}';
      var summary = 'all contexts';
      if (jsTruthy(jsGet(conditions, 'length'))) {
        if (conditions is! List) throw JsTypeError('rule.conditions.map is not a function');
        summary = conditions.map(describeCondition).join(match == 'any' ? ' OR ' : ' AND ');
      }
      trace.add(TraceStep('rule', matched ? '$label matched' : '$label did not match', summary, matched));
      if (!matched) continue;
      final serve = jsGet(rule, 'serve');
      final serveType = jsGet(serve, 'type');
      final ruleId = _out(jsGet(rule, 'id'));
      if (serveType == 'fixed') {
        final value = jsGet(serve, 'value');
        trace.add(TraceStep('result', 'Returned ${fmt(value)}', '$label serves a fixed value.'));
        return Evaluation(flagKey: flagKey, value: _out(value), reason: Reasons.ruleMatch, revision: revision, trace: trace, ruleIndex: i, ruleId: ruleId);
      }
      final bucketBy = jsGet(serve, 'bucketBy');
      final attr = isNullish(bucketBy) ? 'key' : jsString(bucketBy);
      final identity = ctx.containsKey(attr) ? ctx[attr] : undefined;
      final otherwise = jsGet(serve, 'otherwise');
      if (isNullish(identity) || identity == '') {
        trace.add(TraceStep('allocation', 'Allocation skipped', 'Context has no "$attr" to bucket by; treated as outside the allocation.', false));
        trace.add(TraceStep('result', 'Returned ${fmt(otherwise)}', 'Remaining eligible users.'));
        return Evaluation(flagKey: flagKey, value: _out(otherwise), reason: Reasons.ruleMatch, revision: revision, trace: trace, ruleIndex: i, ruleId: ruleId, inRollout: false);
      }
      final seed = jsGet(serve, 'seed');
      final bucket = bucketOf(isNullish(seed) ? flagKey : jsString(seed), jsString(identity));
      final percentage = jsGet(serve, 'percentage');
      final inRollout = bucket < jsToNumber(percentage);
      final pct = jsString(percentage);
      trace.add(TraceStep('allocation', 'Allocation evaluated',
          '$pct% rollout · $attr ${inRollout ? 'inside' : 'outside'} allocation (bucket ${bucket.toStringAsFixed(2)})', inRollout));
      final value = inRollout ? jsGet(serve, 'value') : otherwise;
      trace.add(TraceStep('result', 'Returned ${fmt(value)}', inRollout ? 'Inside the $pct% allocation.' : 'Remaining eligible users.'));
      return Evaluation(
          flagKey: flagKey, value: _out(value), reason: Reasons.ruleMatch, revision: revision, trace: trace, ruleIndex: i, ruleId: ruleId, inRollout: inRollout, bucket: bucket);
    }
    final def = jsGet(flag, 'default');
    trace.add(TraceStep('result', 'Returned ${fmt(def)}', 'No rule matched. The flag default applies.'));
    return Evaluation(flagKey: flagKey, value: _out(def), reason: Reasons.defaultValue, revision: revision, trace: trace);
  } catch (e) {
    final error = e is JsTypeError ? e.message : e.toString();
    trace.add(TraceStep('result', 'Returned ${fmt(fallback)}', 'Evaluation error: $error. The application fallback applies.'));
    return Evaluation(flagKey: flagKey, value: fallback, reason: Reasons.error, revision: revision, trace: trace, error: error);
  }
}

/* ---------------- bundles ---------------- */

/// True when this engine can evaluate [bundle] (its `engine` is absent or not newer than [engineVersion]).
bool supportsEngine(Object? bundle) {
  final e = bundle is Map ? (bundle.containsKey('engine') ? bundle['engine'] : undefined) : undefined;
  if (isUndefined(e)) return true;
  return jsIsInteger(e) && (e as num) >= 1 && e <= engineVersion;
}

/// The browser-key view: client-exposed flags and only the segments they reference (transitively).
Map<String, Object?> clientBundle(Map<String, Object?> bundle) {
  final flagsIn = bundle['flags'];
  final flags = <String, Object?>{};
  if (flagsIn is Map) {
    for (final e in flagsIn.entries) {
      final f = e.value;
      if (f is Map && f['clientExposed'] == true) flags['${e.key}'] = f;
    }
  }
  final segmentsIn = bundle['segments'];
  final pending = <String>[];
  void refs(Object? conditions) {
    if (conditions is! List) return;
    for (final c in conditions) {
      if (c is Map && (c['op'] == 'segment' || c['op'] == 'not_segment') && c['value'] is String) pending.add(c['value'] as String);
    }
  }

  for (final f in flags.values) {
    final rules = (f as Map)['rules'];
    if (rules is List) {
      for (final r in rules) {
        if (r is Map) refs(r['conditions']);
      }
    }
  }
  final needed = <String>{};
  while (pending.isNotEmpty) {
    final k = pending.removeLast();
    final seg = segmentsIn is Map && segmentsIn.containsKey(k) ? segmentsIn[k] : null;
    if (needed.contains(k) || seg == null) continue;
    needed.add(k);
    if (seg is Map) refs(seg['conditions']);
  }
  final segments = <String, Object?>{};
  if (segmentsIn is Map) {
    for (final e in segmentsIn.entries) {
      if (needed.contains(e.key)) segments['${e.key}'] = e.value;
    }
  }
  return {...bundle, 'flags': flags, 'segments': segments};
}

/// Structural check of a configuration bundle: `schema` 1, numeric `revision`, `flags` object and
/// `segments` object (the JS SDK's `isBundle`).
bool isBundle(Object? v) {
  if (v is! Map) return false;
  final schema = v['schema'];
  final flags = v['flags'];
  final segments = v['segments'];
  return schema is num && schema == 1 && v['revision'] is num && flags is Map && (segments is Map || segments is List);
}
