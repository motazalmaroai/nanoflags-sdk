// Shadow evaluation of drafts (migration 0179): the draft of a change waiting for approval is evaluated next to the
// live bundle for a sample of evaluations; only counters leave the device; the shadow bundle is never applied. Same
// cases as the JS SDK's test/shadow.test.ts.
@TestOn('vm')
library;

import 'dart:convert';

import 'package:nanoflags/nanoflags.dart';
import 'package:nanoflags/src/shadow.dart';
import 'package:test/test.dart';

import 'support/fake_edge.dart';

const session = '6f1c2a4e-8b1d-4c3e-9f00-1234567890ab';
const draftSum = '0123456789abcdef0123456789abcdef';

Map<String, Object?> liveFlags() => {
      'checkout-v2': boolFlag(false, rules: [
        {
          'id': 'pro',
          'match': 'all',
          'conditions': [
            {'attribute': 'plan', 'op': 'eq', 'value': 'pro'}
          ],
          'serve': {'type': 'fixed', 'value': true},
        }
      ]),
      'accent': stringFlag('blue'),
      'limit': {'type': 'number', 'enabled': true, 'rules': <Object?>[], 'default': 3, 'off': 0, 'clientExposed': true},
    };

Map<String, Object?> live() => bundleDoc(3, liveFlags());

/// The draft: checkout-v2 is on by default (live: off by default, on for plan "pro"). Everything else as live.
Map<String, Object?> draft() => bundleDoc(3, {...liveFlags(), 'checkout-v2': {...liveFlags()['checkout-v2']! as Map<String, Object?>, 'default': true}});

Map<String, Object?> free([int i = 0]) => {'key': 'u$i', 'plan': 'free', 'email': 'person$i@example.test', 'region': 'DE'};
const pro = {'key': 'u', 'plan': 'pro'};

List<Map<String, Object?>> flagsOf(Map<String, Object?>? report) => [for (final f in (report?['flags'] as List? ?? const [])) (f as Map).cast<String, Object?>()];

void main() {
  late FakeEdge edge;
  final clients = <NanoFlagsClient>[];

  setUp(() async {
    edge = await FakeEdge.start();
    await edge.publish(live());
  });

  tearDown(() async {
    for (final c in clients) {
      await c.close();
    }
    clients.clear();
    await edge.close();
  });

  NanoFlagsClient client({ShadowOptions shadow = const ShadowOptions(sampleRate: 1), EventsOptions? events, VerifyOptions? verify}) {
    final c = NanoFlagsClient(NanoFlagsOptions(
      sdkKey: testKey,
      baseUrl: edge.baseUrl,
      live: false,
      streaming: false,
      pollInterval: Duration.zero,
      service: 'checkout-service',
      serviceVersion: '3.1.0',
      events: events ?? const EventsOptions(sampleRate: 0, flushInterval: Duration(hours: 1)),
      shadow: shadow,
      verify: verify ?? VerifyOptions(publicKeys: edge.publicKeys, require: true),
    ));
    clients.add(c);
    return c;
  }

  List<NanoFlagsException> errorsOf(NanoFlagsClient c) {
    final out = <NanoFlagsException>[];
    c.errors.listen(out.add);
    return out;
  }

  Future<void> settle() => until(() => edge.shadowRequests > 0).then((_) => Future<void>.delayed(const Duration(milliseconds: 100)));

  test('evaluates the draft next to the live bundle, never applies it, and reports only counters', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client();
    final errors = errorsOf(c);
    await c.ready();
    await settle();
    expect(edge.shadowRequests, 1);

    // Zero behaviour change: the app always gets the live value.
    for (var i = 0; i < 30; i++) {
      expect(c.boolVariation('checkout-v2', true, context: free(i)), isFalse);
    }
    for (var i = 0; i < 10; i++) {
      expect(c.boolVariation('checkout-v2', false, context: pro), isTrue);
    }
    expect(c.stringVariation('accent', 'x'), 'blue'); // unchanged flag: not shadowed
    expect(c.revision, 3);
    expect(errors, isEmpty);

    await c.flush();
    expect(jsonEncode(edge.lastShadow),
        '{"sessionId":"$session","checksum":"$draftSum","version":"3.1.0","flags":[{"flag":"checkout-v2","samples":40,"flips":30,"pairs":[{"live":"false","shadow":"true","count":30}],"rules":{"0":10,"default":30}}]}');
    // No context, attribute or identifier leaves the device with the shadow report.
    final text = jsonEncode(edge.lastShadow);
    for (final s in ['example.test', 'person', 'u1', 'plan', 'free', 'region', 'DE', 'email']) {
      expect(text, isNot(contains(s)));
    }

    // Counters restart after a report: the next flush carries no shadow member.
    await c.flush();
    expect(edge.lastShadow, isNull);
  });

  test('samples at the configured rate and only the flags the draft changes', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    var n = 0;
    var draws = 0;
    final c = client(
        shadow: ShadowOptions(
            sampleRate: 0.25,
            random: () {
              draws++;
              return (n++ % 4) / 4;
            }));
    await c.ready();
    await settle();
    for (var i = 0; i < 100; i++) {
      c.boolVariation('checkout-v2', false, context: free());
    }
    for (var i = 0; i < 50; i++) {
      c.numberVariation('limit', 0);
    }
    expect(draws, 100); // unchanged flags never draw
    await c.flush();
    expect(jsonEncode(edge.lastShadow!['flags']), '[{"flag":"checkout-v2","samples":25,"flips":25,"pairs":[{"live":"false","shadow":"true","count":25}],"rules":{"default":25}}]');
  });

  test('a tampered shadow bundle is ignored: no evaluation, no report, an error with code shadow', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum, tamper: (t) => t.replaceFirst('"default":true', '"default":"evil"'));
    final c = client();
    final errors = errorsOf(c);
    await c.ready();
    await until(() => errors.isNotEmpty);
    for (var i = 0; i < 5; i++) {
      expect(c.boolVariation('checkout-v2', true, context: free()), isFalse);
    }
    await c.flush();
    expect(edge.lastShadow, isNull);
    expect(errors.map((e) => e.code), [NanoFlagsErrorCode.shadow]);
    expect(c.revision, 3);
  });

  group('rejects a shadow bundle', () {
    const otherEnv = '6f0c7c1e-0000-4000-8000-000000000999';
    final cases = <String, Future<void> Function()>{
      'signed by an unknown key': () async => edge.serveShadow(draft(), sessionId: session, checksum: draftSum, signWith: await SigningKey.generate('t1')),
      'signed as a normal bundle (no domain separation abuse)': () => edge.serveShadow(draft(), sessionId: session, checksum: draftSum, bundleDomain: true),
      'marker of another session inside the signed bytes': () =>
          edge.serveShadow(draft(), sessionId: session, checksum: draftSum, markerSession: '11111111-2222-4333-8444-555555555555'),
      'marker of another environment': () => edge.serveShadow(draft(), sessionId: session, checksum: draftSum, markerEnv: otherEnv),
      'signed for another environment': () => edge.serveShadow(draft(), sessionId: session, checksum: draftSum, env: otherEnv),
    };
    for (final e in cases.entries) {
      test(e.key, () async {
        await e.value();
        final c = client();
        final errors = errorsOf(c);
        await c.ready();
        await until(() => errors.isNotEmpty);
        c.boolVariation('checkout-v2', true, context: free());
        await c.flush();
        expect(edge.lastShadow, isNull);
        expect(errors.map((e) => e.code), [NanoFlagsErrorCode.shadow]);
      });
    }
  });

  test('a shadow bundle is bound to the environment of the first verified live bundle, even when it arrives first', () async {
    // The first live bundle fails verification, so nothing is pinned while the shadow bundle (validly signed, but
    // for another environment) is checked. It must wait for a verified live bundle and then be refused.
    await edge.publish(live(), signWith: await SigningKey.generate('t1'));
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum, env: '6f0c7c1e-0000-4000-8000-000000000999',
        markerEnv: '6f0c7c1e-0000-4000-8000-000000000999');
    final c = client();
    final errors = errorsOf(c);
    await until(() => edge.shadowRequests >= 1 && errors.any((e) => e.code == NanoFlagsErrorCode.signature));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    await edge.publish(live());
    await c.refresh();
    await c.ready();
    await until(() => errors.any((e) => e.code == NanoFlagsErrorCode.shadow));
    c.boolVariation('checkout-v2', true, context: free());
    await c.flush();
    expect(edge.lastShadow, isNull);
    expect(errors.where((e) => e.code == NanoFlagsErrorCode.shadow), hasLength(1));
  });

  test('a shadow bundle is never applied as configuration, even when served (validly signed) as a bundle', () async {
    final c = client();
    final errors = errorsOf(c);
    await c.ready();
    expect(c.revision, 3);
    // An attacker (or a bug) serves the shadow bundle on /v1/bundle with a valid bundle signature over its bytes.
    final shadowBundle = {...bundleDoc(4, {...draft()['flags']! as Map<String, Object?>}), 'shadow': {'sessionId': session, 'checksum': draftSum, 'environmentId': environmentId, 'baseRevision': 3}};
    await edge.publish(shadowBundle, push: false);
    await c.refresh();
    expect(c.revision, 3);
    expect(c.boolVariation('checkout-v2', true, context: free()), isFalse);
    await until(() => errors.isNotEmpty);
    expect(errors.map((e) => e.code), [NanoFlagsErrorCode.invalidBundle]);
    // Nor as a bootstrap.
    final c2 = NanoFlagsClient(NanoFlagsOptions(sdkKey: testKey, baseUrl: edge.baseUrl, bootstrap: jsonEncode(shadowBundle), live: false, streaming: false, events: const EventsOptions.off()));
    clients.add(c2);
    c2.errors.listen((_) {});
    expect(c2.revision, isNot(4));
  });

  test('is withdrawn when the edge stops announcing it; pending counters are sent first', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client();
    await c.ready();
    await settle();
    c.boolVariation('checkout-v2', false, context: free());
    edge.shadowHeader = null;
    await c.refresh(); // 304 without the header
    await until(() => edge.lastShadow != null);
    expect(flagsOf(edge.lastShadow).single['samples'], 1);
    final before = edge.events.length;
    c.boolVariation('checkout-v2', false, context: free());
    await c.flush();
    expect(edge.events.length, before + 1);
    expect(edge.lastShadow, isNull);
  });

  test('a 404 from /v1/shadow drops the session', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client();
    await c.ready();
    await settle();
    c.boolVariation('checkout-v2', false, context: free());
    edge.shadowAnswer = null;
    edge.shadowHeader = '$session.${'f' * 32}';
    await c.refresh();
    await until(() => edge.shadowRequests == 2);
    await until(() => edge.lastShadow != null); // the counters of the dropped session went out
    c.boolVariation('checkout-v2', false, context: free());
    await c.flush();
    expect(edge.lastShadow, isNull);
  });

  test('a new draft (new announcement) replaces the session; the old counters go out first', () async {
    final next = 'f' * 32;
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client();
    await c.ready();
    await settle();
    c.boolVariation('checkout-v2', false, context: free());
    await edge.serveShadow(draft(), sessionId: session, checksum: next);
    await c.refresh();
    await until(() => edge.lastShadow != null);
    expect(edge.lastShadow!['checksum'], draftSum);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    c.boolVariation('checkout-v2', false, context: free());
    await c.flush();
    expect(edge.lastShadow!['checksum'], next);
    expect(flagsOf(edge.lastShadow).single['samples'], 1);
  });

  test('counters ride with timer flushes at most once a minute', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client(events: const EventsOptions(sampleRate: 1, flushInterval: Duration(milliseconds: 20)));
    await c.ready();
    await settle();
    c.boolVariation('checkout-v2', false, context: free());
    await until(() => edge.events.isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(edge.events.every((e) => e['shadow'] == null), isTrue);
    await c.flush();
    expect(flagsOf(edge.lastShadow).single['samples'], 1);
  });

  test('pause() (the app goes to the background) sends pending counters', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client();
    await c.ready();
    await settle();
    c.boolVariation('checkout-v2', false, context: free());
    c.pause();
    await until(() => edge.events.any((e) => e['shadow'] != null));
  });

  test('close() sends pending counters', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client();
    await c.ready();
    await settle();
    c.boolVariation('checkout-v2', false, context: free());
    await c.close();
    expect(edge.events.any((e) => e['shadow'] != null), isTrue);
  });

  test('ShadowOptions.off() and EventsOptions.off() never fetch the shadow bundle', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    for (final c in [client(shadow: const ShadowOptions.off()), client(events: const EventsOptions.off())]) {
      await c.ready();
      await c.refresh();
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(edge.shadowRequests, 0);
  });

  test('without verification configured the shadow bundle is still checked, with /v1/keys', () async {
    await edge.serveShadow(draft(), sessionId: session, checksum: draftSum);
    final c = client(verify: const VerifyOptions.off());
    await c.ready();
    await settle();
    expect(edge.keysRequests, 1);
    c.boolVariation('checkout-v2', false, context: free());
    await c.flush();
    expect(flagsOf(edge.lastShadow).single['samples'], 1);
    // The SDK key is never sent to the public keys endpoint.
    expect(edge.requestHeaders.lastWhere((h) => h[':path'] == '/v1/keys')['authorization'], isNull);
  });

  test("the app's own fallback never leaves the device: a flag only in the draft, a wrong type", () async {
    final d = draft();
    d['flags'] = {
      ...d['flags']! as Map<String, Object?>,
      'brand-new': stringFlag('x'),
      'accent': {...stringFlag('blue'), 'default': 42},
    };
    await edge.serveShadow(d, sessionId: session, checksum: draftSum);
    final c = client();
    await c.ready();
    await settle();
    expect(c.stringVariation('brand-new', 'alice@example.test'), 'alice@example.test');
    expect(c.stringVariation('accent', 'bob@example.test'), 'blue');
    await c.flush();
    final report = edge.lastShadow!;
    expect(jsonEncode(report), isNot(contains('example.test')));
    final flags = {for (final f in flagsOf(report)) f['flag']: f};
    expect(jsonEncode(flags['brand-new']!['pairs']), r'[{"live":"<fallback>","shadow":"\"x\"","count":1}]');
    expect(jsonEncode(flags['accent']!['pairs']), r'[{"live":"\"blue\"","shadow":"<fallback>","count":1}]');
  });

  group('helpers', () {
    test('parses the announcement header', () {
      expect(parseShadowHeader('$session.$draftSum'), (sessionId: session, checksum: draftSum));
      expect(parseShadowHeader(' ${session.toUpperCase()}.${draftSum.toUpperCase()} '), (sessionId: session, checksum: draftSum));
      for (final bad in [null, '', 'x.y', session, '$session.${draftSum}x', 'not-a-uuid-not-a-uuid-not-a-uuid-xxx.$draftSum']) {
        expect(parseShadowHeader(bad), isNull, reason: bad);
      }
    });

    test('changed flags: configuration differences and changed segments, whatever the key order', () {
      final l = live();
      expect(changedFlags(l, l), isEmpty);
      final reordered = jsonDecode(jsonEncode({for (final k in l.keys.toList().reversed) k: l[k]})) as Map;
      final rf = reordered['flags'] as Map;
      rf['accent'] = {for (final k in (rf['accent'] as Map).keys.toList().reversed) k: (rf['accent'] as Map)[k]};
      expect(changedFlags(l, reordered), isEmpty);
      expect(changedFlags(l, draft()), {'checkout-v2'});
      final added = {...l, 'flags': {...l['flags']! as Map<String, Object?>, 'brand_new': boolFlag(true)}};
      expect(changedFlags(l, added), {'brand_new'});
    });

    test('changed flags: segments inside segments and removed segments count (same cases as supabase/tests/shadow_eval.sql)', () {
      Map<String, Object?> flag(String op, String value) => boolFlag(false, rules: [
            {
              'id': 'r',
              'match': 'all',
              'conditions': [
                {'attribute': '', 'op': op, 'value': value}
              ],
              'serve': {'type': 'fixed', 'value': true},
            }
          ]);
      final g = boolFlag(false);
      Map<String, Object?> nested(int v) => bundleDoc(1, {'f': flag('segment', 'a'), 'g': g}, segments: {
            'a': {
              'match': 'all',
              'conditions': [
                {'attribute': '', 'op': 'segment', 'value': 'b'}
              ]
            },
            'b': {
              'match': 'all',
              'conditions': [
                {'attribute': 'x', 'op': 'eq', 'value': v}
              ]
            },
          });
      expect(changedFlags(nested(1), nested(2)), {'f'});
      expect(changedFlags(nested(1), nested(1)), isEmpty);
      final a = {
        'match': 'any',
        'conditions': [
          {'attribute': '', 'op': 'segment', 'value': 'c'}
        ]
      };
      final withC = bundleDoc(1, {'f': flag('not_segment', 'a'), 'g': g}, segments: {'a': a, 'c': {'match': 'all', 'conditions': <Object?>[]}});
      final withoutC = bundleDoc(1, {'f': flag('not_segment', 'a'), 'g': g}, segments: {'a': a});
      expect(changedFlags(withC, withoutC), {'f'});
      // A cycle terminates.
      Map<String, Object?> cyc(bool extra) => bundleDoc(1, {'f': flag('segment', 'a'), 'g': g}, segments: {
            'a': {
              'match': 'all',
              'conditions': [
                {'attribute': '', 'op': 'segment', 'value': 'b'}
              ]
            },
            'b': {
              'match': 'all',
              'conditions': [
                {'attribute': '', 'op': 'segment', 'value': 'a'},
                if (extra) {'attribute': 'x', 'op': 'eq', 'value': 1},
              ]
            },
          });
      expect(changedFlags(cyc(false), cyc(true)), {'f'});
    });

    test('flips are decided independently of object key order', () {
      final c = ShadowCounters(session, draftSum);
      c.add('cfg', {'a': 1, 'b': 2}, {'b': 2, 'a': 1}, null);
      c.add('cfg', {
        'a': 1,
        'b': {'d': 1, 'c': 2}
      }, {
        'b': {'c': 2, 'd': 1},
        'a': 1
      }, null);
      expect(jsonEncode((c.report(null)['flags']! as List).single), '{"flag":"cfg","samples":2,"flips":0,"pairs":[],"rules":{"default":2}}');
      expect(reprValue({'b': 2, 'a': 1}), '{"a":1,"b":2}');
    });

    test('values: JSON text up to 100 characters, longer ones hashed (same hashes as the JS SDK)', () {
      expect(reprValue(true), 'true');
      expect(reprValue('blue'), '"blue"');
      expect(reprValue({'a': 1}), '{"a":1}');
      expect(reprValue(1.5), '1.5');
      expect(reprValue(1.0), '1');
      expect(reprValue(null), 'null');
      expect(reprValue('x' * 200), '#6685751d');
      expect(reprValue({'long': 'é' * 120, 'a': 1}), '#e30d3d0f');
    });

    test('counters are bounded (flags, value pairs, rules)', () {
      final c = ShadowCounters(session, draftSum);
      for (var i = 0; i < maxShadowFlags + 20; i++) {
        c.add('f$i', false, true, 0);
      }
      expect(c.size, maxShadowFlags);
      final p = ShadowCounters(session, draftSum);
      for (var i = 0; i < 50; i++) {
        p.add('color', 'a', 'b$i', i);
      }
      final r = (p.report(null)['flags']! as List).single as Map;
      expect(r['samples'], 50);
      expect(r['flips'], 50);
      final pairs = r['pairs'] as List;
      expect(pairs, hasLength(maxShadowPairs));
      expect(pairs.last, {'live': '*', 'shadow': '*', 'count': 50 - (maxShadowPairs - 1)});
      expect(pairs.fold<int>(0, (a, x) => a + ((x as Map)['count'] as int)), 50);
      expect((r['rules'] as Map).length, 50);
      expect(p.report(null).containsKey('version'), isFalse);
    });

    test("skips flag keys the edge would refuse and stops a flag's counters at 10^7 samples", () {
      expect(maxShadowFlagKey, 63);
      expect(maxShadowCount, 10000000);
      final c = ShadowCounters(session, draftSum);
      c.add('k' * 64, false, true, 0);
      c.add('', false, true, 0);
      expect(c.size, 0);
      c.add('k' * 63, false, true, 0);
      // Counted in UTF-16 code units, as the edge does: 31 emoji (surrogate pairs) + 1 = 63; 32 emoji = 64.
      c.add('${'\u{1F600}' * 31}x', false, true, 0);
      c.add('\u{1F600}' * 32, false, true, 0);
      expect(c.size, 2);
      final big = ShadowCounters(session, draftSum);
      big.add('big', false, true, 0);
      for (var i = 1; i < maxShadowCount; i++) {
        big.add('big', true, true, 0);
      }
      big.add('big', false, true, 0);
      big.add('big', true, true, 1);
      expect((big.report(null)['flags']! as List).single, {
        'flag': 'big',
        'samples': maxShadowCount,
        'flips': 1,
        'pairs': [
          {'live': 'false', 'shadow': 'true', 'count': 1},
        ],
        'rules': {'0': maxShadowCount},
      });
    });
  });
}
