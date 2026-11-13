// Comparison of Dart engine results with the TypeScript results recorded in the parity fixtures
// (platform independent: used by the VM test and the web/node test).
import 'dart:convert';

import 'package:nanoflags/engine.dart';

/// JSON deep equality with one number type (1 == 1.0) and no bool/number confusion.
bool jsonEquals(Object? a, Object? b) {
  if (a is num && b is num) return a.toDouble() == b.toDouble() || (a.isNaN && b.isNaN);
  if (a is bool || b is bool) return a == b;
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!jsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !jsonEquals(a[k], b[k])) return false;
    }
    return true;
  }
  return a == b;
}

/// Returns the differences between the Dart result and the recorded TypeScript result.
List<String> compareCase(Map<String, dynamic> doc, Map<String, dynamic> c, {required bool messages}) {
  final bundles = doc['bundles'] as List;
  final contexts = doc['contexts'] as List;
  final bi = c['bundle'] as int;
  // Every case gets a fresh copy (as JSON.parse would give the TypeScript engine).
  final bundle = bi == -1 ? null : jsonDecode(jsonEncode(bundles[bi]));
  final ctx = (jsonDecode(jsonEncode(contexts[c['context'] as int])) as Map).cast<String, Object?>();
  final e = evaluate(bundle, c['flag'] as String, ctx, c['fallback']);
  final x = c['expected'] as Map<String, dynamic>;
  final problems = <String>[];
  void check(String name, Object? actual, Object? expected) {
    if (!jsonEquals(actual, expected)) problems.add('$name: dart=${jsonEncode(actual)} ts=${jsonEncode(expected)}');
  }

  check('reason', e.reason, x['reason']);
  check('value', e.value, x['value']);
  check('revision', e.revision, x['revision']);
  check('ruleIndex', e.ruleIndex, x['ruleIndex']);
  check('ruleId', e.ruleId, x['ruleId']);
  check('inRollout', e.inRollout, x['inRollout']);
  check('bucket', e.bucket, x['bucket']);
  final xerr = x['error'];
  check('error', e.error != null, xerr != null && xerr != false);
  if (messages && x.containsKey('errorMessage')) check('errorMessage', e.error, x['errorMessage']);
  if (x.containsKey('trace')) {
    final mine = [for (final t in e.trace) t.toJson()];
    final theirs = [for (final t in x['trace'] as List) (t as Map).cast<String, Object?>()];
    if (!messages && xerr != null && xerr != false && mine.isNotEmpty && theirs.isNotEmpty) {
      // Error messages are engine-specific in the shared file; the steps before are not.
      mine.last = {...mine.last, 'detail': null};
      theirs.last = {...theirs.last, 'detail': null};
    }
    if (!jsonEquals(mine, theirs)) problems.add('trace: dart=${jsonEncode(mine)} ts=${jsonEncode(theirs)}');
  }
  return problems;
}

