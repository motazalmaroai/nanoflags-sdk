// Shadow evaluation of drafts (migration 0179; RUNTIME.md "Shadow evaluation of drafts"; same rules and wire format as
// the JS SDK's `src/shadow.ts`).
//
// While a change waits for approval in an environment whose admin turned shadow evaluation on, the edge announces a
// signed shadow bundle (`X-NanoFlags-Shadow` on `/v1/bundle`, the bundle itself on `/v1/shadow`). For a sample of the
// evaluations of the flags the draft changes, the client evaluates the draft as well and counts, per flag, how often
// the value would change. Only those counters leave the device, with the next `/v1/events` report:
//
//   { sessionId, checksum, version?, flags: [{ flag, samples, flips, pairs: [{ live, shadow, count }], rules: { "<i>" | "default": n } }] }
//
// No context, attribute, key or identifier is ever part of it. Values are the flag's own configured values as JSON
// text with object keys sorted, at most 100 characters (longer ones are replaced by a hash); a side that used the
// app's own fallback (flag missing there, evaluation error, wrong type) is reported as "<fallback>", never as the
// value. The shadow bundle is NEVER applied: the app always gets the live value, and the client refuses any bundle
// that carries a `shadow` member as configuration. Client keys receive the client view of the draft (client-exposed
// flags only); the server counts their reports only for flags the draft exposes to clients.

import 'engine/engine.dart';
import 'engine/js.dart';

const int maxShadowFlags = 100;
const int maxShadowPairs = 10;
const int maxShadowRules = 50;
const int maxShadowValueChars = 100;

/// The edge accepts counts up to 10^7; a flag's counter stops there (the next report starts from zero again).
const int maxShadowCount = 10000000;

/// The edge accepts flag keys of 1–63 characters (UTF-16 code units, as [String.length] counts) in a report.
const int maxShadowFlagKey = 63;

/// Shadow counters go out with the events report at most this often (and on `flush()`, `pause()` and `close()`).
const Duration shadowFlushInterval = Duration(minutes: 1);

/// A failed shadow fetch is not retried for the same announcement before this.
const Duration shadowRetryInterval = Duration(minutes: 1);

/// How long a shadow bundle waits for the live configuration's first verification to pin the environment.
const Duration shadowPinWait = Duration(seconds: 10);

/// Reported instead of a value that did not come from a bundle: the application's own fallback.
const String fallbackToken = '<fallback>';

final RegExp _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);
final RegExp _checksum = RegExp(r'^[0-9a-f]{32}$');
final RegExp _header = RegExp(r'^([0-9a-f-]{36})\.([0-9a-f]{32})$', caseSensitive: false);

/// `X-NanoFlags-Shadow: <sessionId>.<checksum>` → its parts (lowercased), or null.
({String sessionId, String checksum})? parseShadowHeader(String? v) {
  if (v == null || v.isEmpty) return null;
  final m = _header.firstMatch(v.trim());
  if (m == null || !_uuid.hasMatch(m.group(1)!)) return null;
  return (sessionId: m.group(1)!.toLowerCase(), checksum: m.group(2)!.toLowerCase());
}

/// The `shadow` member of a signed shadow bundle: `{ sessionId, checksum, environmentId, baseRevision }`.
bool isShadowMarker(Object? v) {
  if (v is! Map) return false;
  final id = v['sessionId'], sum = v['checksum'];
  return id is String && _uuid.hasMatch(id) && sum is String && _checksum.hasMatch(sum) && v['environmentId'] is String && v['baseRevision'] is num;
}

/// The bundle shape plus its `shadow` marker (inside the signed bytes).
bool isShadowBundle(Object? v) {
  if (v is! Map) return false;
  final schema = v['schema'];
  return schema is num && schema == 1 && v['revision'] is num && v['flags'] is Map && v['segments'] is Map && isShadowMarker(v['shadow']);
}

/// JSON text with object keys sorted (UTF-16 order, like JavaScript's `sort()`), so two configurations compare equal
/// whatever their key order.
String stableStringify(Object? v) {
  final sb = StringBuffer();
  _write(sb, v);
  return sb.toString();
}

void _write(StringBuffer sb, Object? v) {
  if (v is Map) {
    sb.write('{');
    var first = true;
    final keys = [for (final k in v.keys) '$k']..sort();
    for (final k in keys) {
      final x = v[k];
      if (isUndefined(x) || x is JsFunction) continue;
      if (!first) sb.write(',');
      first = false;
      sb.write(jsStringify(k));
      sb.write(':');
      _write(sb, x);
    }
    sb.write('}');
  } else if (v is List) {
    sb.write('[');
    for (var i = 0; i < v.length; i++) {
      if (i > 0) sb.write(',');
      _write(sb, v[i]);
    }
    sb.write(']');
  } else {
    sb.write(jsStringify(v) ?? 'null');
  }
}

/// A value as it is reported: canonical JSON text, at most 100 characters (longer values become `#<murmur3 hex>`).
String reprValue(Object? v) {
  String text;
  try {
    text = stableStringify(v);
  } catch (_) {
    text = 'null';
  }
  return text.length <= maxShadowValueChars ? text : '#${murmur3(text).toRadixString(16).padLeft(8, '0')}';
}

Map<dynamic, dynamic> _map(Object? v) => v is Map ? v : const {};

/// Segment keys a list of conditions references directly (segment / not_segment).
List<String> _conditionRefs(Object? conditions) => [
      if (conditions is List)
        for (final c in conditions)
          if (c is Map && (c['op'] == 'segment' || c['op'] == 'not_segment') && c['value'] is String) c['value'] as String,
    ];

/// Segment keys a flag's rules reference directly.
List<String> _segmentRefs(Object? flag) {
  final rules = flag is Map ? flag['rules'] : null;
  return [
    if (rules is List)
      for (final r in rules) ..._conditionRefs(r is Map ? r['conditions'] : null),
  ];
}

/// Segments whose evaluation can differ between the live and the shadow bundle: the definition differs (new, edited or
/// removed in the draft), or one of its conditions references such a segment, transitively (to a fixpoint). Same rule
/// as the database (`app.shadow_changed_segments`).
Set<String> changedSegments(Map<dynamic, dynamic> live, Map<dynamic, dynamic> shadow) {
  final ls = _map(live['segments']);
  final ss = _map(shadow['segments']);
  final changed = <String>{};
  for (final k in ss.keys) {
    if (!ls.containsKey(k) || stableStringify(ls[k]) != stableStringify(ss[k])) changed.add('$k');
  }
  for (final k in ls.keys) {
    if (!ss.containsKey(k)) changed.add('$k');
  }
  for (var grew = true; grew;) {
    grew = false;
    for (final k in ss.keys) {
      final s = ss[k];
      if (!changed.contains('$k') && _conditionRefs(s is Map ? s['conditions'] : null).any(changed.contains)) {
        changed.add('$k');
        grew = true;
      }
    }
  }
  return changed;
}

/// Keys of the shadow bundle's flags that the draft changes compared with the live bundle: a different configuration,
/// or a referenced segment that differs. Same rule as the database (`app.shadow_flags`).
Set<String> changedFlags(Map<dynamic, dynamic> live, Map<dynamic, dynamic> shadow) {
  final segs = changedSegments(live, shadow);
  final lf = _map(live['flags']);
  final sf = _map(shadow['flags']);
  return {
    for (final k in sf.keys)
      if (!lf.containsKey(k) || stableStringify(lf[k]) != stableStringify(sf[k]) || _segmentRefs(sf[k]).any(segs.contains)) '$k',
  };
}

final class _Pair {
  _Pair(this.live, this.shadow);
  final String live;
  final String shadow;
  int count = 0;
}

final class _Counter {
  int samples = 0;
  int flips = 0;
  final Map<String, _Pair> pairs = {};
  final Map<String, int> rules = {};
}

/// In-memory counters of one shadow session. Bounded: 100 flags × (10 value pairs + 50 rule counters).
final class ShadowCounters {
  ShadowCounters(this.sessionId, this.checksum);
  final String sessionId;
  final String checksum;
  final Map<String, _Counter> _flags = {};

  int get size => _flags.length;

  /// One sampled evaluation: the value the app got, what the draft would give, and which draft rule matched. A side
  /// whose value is the app's fallback ([liveFallback] / [shadowFallback]) is reported as `"<fallback>"`.
  void add(String flag, Object? live, Object? shadow, int? ruleIndex, {bool liveFallback = false, bool shadowFallback = false}) {
    // The edge refuses the whole report (400) over one flag key outside 1–63 characters.
    if (flag.isEmpty || flag.length > maxShadowFlagKey) return;
    var c = _flags[flag];
    if (c == null) {
      if (_flags.length >= maxShadowFlags) return;
      c = _flags[flag] = _Counter();
    }
    // Every count of a flag (flips, pair and rule counters) is ≤ samples, so stopping samples keeps them all ≤ 10^7.
    if (c.samples >= maxShadowCount) return;
    c.samples++;
    final rk = ruleIndex != null && ruleIndex >= 0 && ruleIndex < 10000 ? '$ruleIndex' : 'default';
    if (c.rules.containsKey(rk) || c.rules.length < maxShadowRules) c.rules[rk] = (c.rules[rk] ?? 0) + 1;
    bool same;
    try {
      same = stableStringify(live) == stableStringify(shadow);
    } catch (_) {
      same = false;
    }
    if (same) return;
    final a = liveFallback ? fallbackToken : reprValue(live);
    final b = shadowFallback ? fallbackToken : reprValue(shadow);
    c.flips++;
    var key = '$a\u0000$b';
    if (!c.pairs.containsKey(key) && c.pairs.length >= maxShadowPairs - 1) key = '*\u0000*';
    final p = c.pairs.putIfAbsent(key, () => key == '*\u0000*' ? _Pair('*', '*') : _Pair(a, b));
    p.count++;
  }

  /// The report (wire format of the `shadow` member of `POST /v1/events`).
  Map<String, Object?> report(String? version) {
    Map<String, Object?> rules(Map<String, int> r) {
      // JavaScript object key order: array-index keys ascending first, then the others in insertion order.
      final index = [for (final k in r.keys) if (_isIndex(k)) k]..sort((a, b) => int.parse(a).compareTo(int.parse(b)));
      return {for (final k in index) k: r[k], for (final k in r.keys) if (!_isIndex(k)) k: r[k]};
    }

    return {
      'sessionId': sessionId,
      'checksum': checksum,
      if (version != null) 'version': version,
      'flags': [
        for (final e in _flags.entries)
          {
            'flag': e.key,
            'samples': e.value.samples,
            'flips': e.value.flips,
            'pairs': [for (final p in e.value.pairs.values) {'live': p.live, 'shadow': p.shadow, 'count': p.count}],
            'rules': rules(e.value.rules),
          },
      ],
    };
  }
}

bool _isIndex(String k) => RegExp(r'^(0|[1-9][0-9]{0,8})$').hasMatch(k);

/// The verified shadow bundle in use and the flags it changes compared with the live bundle (recomputed per live bundle).
final class ShadowState {
  ShadowState(this.bundle, this.sessionId, this.checksum);
  final Map<String, Object?> bundle;
  final String sessionId;
  final String checksum;
  Map<String, Object?>? live;
  Set<String> changed = const {};
}
