// The parity suite compiled to JavaScript (dart2js), where every number is a JavaScript double and
// integers lose their separate type: `dart test -p node` (or `-p chrome`). The fixture text comes from
// a hybrid isolate on the VM, since the web has no file system.
@TestOn('node || browser')
library;

import 'dart:convert';

import 'package:nanoflags/engine.dart';
import 'package:test/test.dart';

import 'support/parity_compare.dart';

Future<Map<String, dynamic>?> _load(String which) async {
  final channel = spawnHybridUri('support/fixture_loader.dart', message: which);
  final text = await channel.stream.first as String?;
  return text == null ? null : jsonDecode(text) as Map<String, dynamic>;
}

void main() {
  test('parity fixtures on the web', () async {
    final doc = await _load('parity');
    if (doc == null) return markTestSkipped('parity.json not found');
    for (final c in (doc['murmur3'] as List).cast<Map<String, dynamic>>()) {
      expect(murmur3(c['input'] as String, c['seed'] as int), c['hash'], reason: jsonEncode(c));
    }
    for (final c in (doc['buckets'] as List).cast<Map<String, dynamic>>()) {
      expect(bucketOf(c['seed'] as String, c['identity'] as String), (c['bucket'] as num).toDouble());
    }
    final cases = (doc['cases'] as List).cast<Map<String, dynamic>>();
    final failures = <String>[];
    for (final c in cases) {
      final p = compareCase(doc, c, messages: false);
      if (p.isNotEmpty) failures.add('${c['name']}: ${p.join('; ')}');
    }
    expect(failures, isEmpty, reason: '${failures.length} of ${cases.length} differ, e.g. ${failures.take(5).join('\n')}');
    print('web parity: ${cases.length - failures.length}/${cases.length} evaluation cases identical');
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('extra corner cases on the web (error messages included)', () async {
    final doc = await _load('extra');
    if (doc == null) return markTestSkipped('extra.json not found');
    final cases = (doc['cases'] as List).cast<Map<String, dynamic>>();
    final failures = <String>[];
    for (final c in cases) {
      final p = compareCase(doc, c, messages: true);
      if (p.isNotEmpty) failures.add('${c['name']}: ${p.join('; ')}');
    }
    expect(failures, isEmpty, reason: '${failures.length} of ${cases.length} differ, e.g. ${failures.take(5).join('\n')}');
    print('web extra: ${cases.length - failures.length}/${cases.length} cases identical');
  }, timeout: const Timeout(Duration(minutes: 5)));
}
