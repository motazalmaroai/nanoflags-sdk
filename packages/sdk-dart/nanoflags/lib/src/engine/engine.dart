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
    default:
      return false;
  }
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
