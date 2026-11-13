// Client behaviour against a fake signing edge: verification, transports, lifecycle, persistence,
// telemetry. Everything runs over real sockets on 127.0.0.1.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';

import 'package:nanoflags/nanoflags.dart';
import 'package:test/test.dart';

import 'support/fake_edge.dart';

void main() {
  late FakeEdge edge;
  final clients = <NanoFlagsClient>[];

  setUp(() async {
    edge = await FakeEdge.start();
  });

  tearDown(() async {
    for (final c in clients) {
      await c.close();
    }
    clients.clear();
    await edge.close();
  });

  NanoFlagsClient client({
    Map<String, Object?> context = const {'key': 'user-1'},
    bool live = true,
    bool streaming = true,
    Duration pollInterval = const Duration(seconds: 60),
    NanoFlagsStore? store,
    Object? bootstrap,
    EventsOptions events = const EventsOptions.off(),
    VerifyOptions? verify,
    bool dataSaver = false,
  }) {
    final c = NanoFlagsClient(NanoFlagsOptions(
      sdkKey: testKey,
      baseUrl: edge.baseUrl,
      context: context,
      live: live,
      streaming: streaming,
      pollInterval: pollInterval,
      store: store,
      bootstrap: bootstrap,
      events: events,
      verify: verify ?? VerifyOptions(publicKeys: edge.publicKeys, require: true),
      dataSaver: dataSaver,
      service: 'test-app',
    ));
    clients.add(c);
    return c;
  }

  group('keys', () {
    test('server keys and other non-client keys are refused', () {
      expect(() => NanoFlagsClient(const NanoFlagsOptions(sdkKey: 'nf_srv_secret')), throwsArgumentError);
      expect(() => NanoFlagsClient(const NanoFlagsOptions(sdkKey: 'nf_ci_secret')), throwsArgumentError);
    });
  });

  group('loading and verification', () {
    test('loads a signed bundle, evaluates locally, typed accessors and detail', () async {
      await edge.publish(bundleDoc(3, {
        'checkout': boolFlag(true),
        'accent': stringFlag('blue', rules: [
          {
            'id': 'pro',
            'match': 'all',
            'conditions': [
              {'attribute': 'plan', 'op': 'eq', 'value': 'pro'}
            ],
            'serve': {'type': 'fixed', 'value': 'orange'}
          }
        ]),
        'limit': {'type': 'number', 'enabled': true, 'rules': [], 'default': 5, 'off': 0, 'clientExposed': true},
        'config': {'type': 'json', 'enabled': true, 'rules': [], 'default': {'a': [1, 2]}, 'off': null, 'clientExposed': true},
      }));
      final c = client(live: false, streaming: false);
      await c.ready();
      expect(c.status, NanoFlagsStatus.ready);
      expect(c.revision, 3);
      expect(c.boolVariation('checkout', false), isTrue);
      expect(c.stringVariation('accent', 'none'), 'blue');
      expect(c.stringVariation('accent', 'none', context: {'plan': 'pro'}), 'orange');
      expect(c.numberVariation('limit', 1), 5);
      expect(c.jsonVariation('config', null), {'a': [1, 2]});
      // wrong type → fallback with reason error
      final d = c.boolVariationDetail('accent', false);
      expect(d.value, isFalse);
      expect(d.reason, Reasons.error);
      expect(d.error, contains('does not match the requested type'));
      final m = c.stringVariationDetail('accent', 'none', context: {'plan': 'pro'});
      expect(m.reason, Reasons.ruleMatch);
      expect(m.ruleId, 'pro');
      expect(m.ruleIndex, 0);
      expect(c.stringVariationDetail('missing', 'x').reason, Reasons.flagNotFound);
      expect(c.allFlags(), {'checkout': true, 'accent': 'blue', 'limit': 5, 'config': {'a': [1, 2]}});
      // custom User-Agent, key in the Authorization header
      final bundleReq = edge.requestHeaders.firstWhere((h) => h[':path'] == '/v1/bundle');
      expect(bundleReq['user-agent'], startsWith('nanoflags-dart/$sdkVersion'));
      expect(bundleReq['authorization'], 'Bearer $testKey');
    });

    test('an unsigned bundle is refused with require (nothing adopted, error code signature)', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      edge.bundleMode = 'unsigned';
      final c = client(live: false, streaming: false);
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      expect(c.status, NanoFlagsStatus.notReady);
      expect(c.boolVariation('checkout', false), isFalse);
      expect(errors.map((e) => e.code), contains(NanoFlagsErrorCode.signature));
    });

    test('unsigned bundles are accepted when require is false', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      edge.bundleMode = 'unsigned';
      final c = client(live: false, streaming: false, verify: VerifyOptions(publicKeys: edge.publicKeys, require: false));
      await c.ready();
      expect(c.boolVariation('checkout', false), isTrue);
    });

    test('a tampered bundle is refused and the previous configuration stays', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client(live: false, streaming: false);
      await c.ready();
      expect(c.boolVariation('checkout', false), isTrue);
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(true)}), push: false);
      edge.bundleMode = 'tampered';
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.refresh();
      await pump();
      expect(c.revision, 1);
      expect(c.boolVariation('checkout', false), isTrue);
      expect(errors.single.code, NanoFlagsErrorCode.signature);
      expect(c.status, NanoFlagsStatus.ready); // a rejected update changes nothing
    });

    test('a bundle signed with a key that is not trusted is refused', () async {
      final other = await SigningKey.generate('t1'); // same kid, different key
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}), signWith: other);
      final c = client(live: false, streaming: false);
      await c.ready();
      expect(c.revision, isNull);
    });

    test('unknown kid loads /v1/keys once (rate limited) and accepts the rotated key', () async {
      final rotated = await SigningKey.generate('t2');
      edge.extraKeys.add(rotated);
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}), signWith: rotated);
      final c = client(live: false, streaming: false, verify: VerifyOptions(publicKeys: edge.publicKeys, fetchKeys: true, require: true));
      await c.ready();
      expect(c.revision, 1);
      expect(edge.keysRequests, 1);
      // another unknown kid within the minute: no second /v1/keys request
      final unknown = await SigningKey.generate('t9');
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}), signWith: unknown, push: false);
      await c.refresh();
      expect(c.revision, 1);
      expect(edge.keysRequests, 1);
      // /v1/keys is never sent the SDK key
      final keysReq = edge.requestHeaders.firstWhere((h) => h[':path'] == '/v1/keys');
      expect(keysReq.containsKey('authorization'), isFalse);
    });

    test('a bundle for a newer engine is refused', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client(live: false, streaming: false);
      await c.ready();
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}, engine: 99), push: false);
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.refresh();
      await pump();
      expect(c.revision, 1);
      expect(errors.single.code, NanoFlagsErrorCode.engine);
    });

    test('polling revalidates with If-None-Match (304 keeps the bundle)', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client(live: false, streaming: false);
      await c.ready();
      await c.refresh();
      final last = edge.requestHeaders.lastWhere((h) => h[':path'] == '/v1/bundle');
      expect(last['if-none-match'], '"${edge.current!.checksum}-client"');
      expect(c.status, NanoFlagsStatus.ready);
      expect(c.revision, 1);
    });

    test('the edge serving a stale copy marks the client stale and never goes backwards', () async {
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(true)}));
      final c = client(live: false, streaming: false);
      await c.ready();
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(false)}), push: false);
      edge.staleHeader = true;
      await c.refresh();
      expect(c.revision, 2);
      expect(c.status, NanoFlagsStatus.stale);
    });
  });

  group('live transport', () {
    test('connects with the key in Authorization (never the URL), applies pushes, reports latency', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(false)}));
      final c = client();
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live, reason: 'live socket');
      final upgrade = edge.requestHeaders.firstWhere((h) => h[':path'] == '/v1/live');
      expect(upgrade['authorization'], 'Bearer $testKey');
      expect(upgrade['sec-websocket-protocol'], 'nanoflags.v1');
      expect(upgrade['user-agent'], startsWith('nanoflags-dart/'));
      final updates = <UpdateEvent>[];
      c.updates.listen(updates.add);
      final bundleRequestsBefore = edge.bundleRequests;
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(true)}), committedAt: DateTime.now().millisecondsSinceEpoch - 40);
      await until(() => c.revision == 2);
      expect(c.boolVariation('checkout', false), isTrue);
      expect(updates.single.transport, NanoFlagsTransport.live);
      expect(updates.single.latency!.inMilliseconds, greaterThanOrEqualTo(40));
      expect(edge.bundleRequests, bundleRequestsBefore, reason: 'a push needs no request');
    });

    test('a pushed bundle with a bad signature is refused (and the request path is asked)', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client();
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live);
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(true)}), tamperPush: true);
      await until(() => errors.isNotEmpty);
      expect(errors.first.code, NanoFlagsErrorCode.signature);
      // The follow-up request fetches the genuine r2.
      await until(() => c.revision == 2);
      expect(c.boolVariation('checkout', false), isTrue);
    });

    test('close code 4004: no reconnect, last bundle kept, status stale, environment_deleted', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client();
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live);
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await edge.closeSockets(4004, 'environment deleted');
      await until(() => errors.any((e) => e.code == NanoFlagsErrorCode.environmentDeleted));
      expect(c.status, NanoFlagsStatus.stale);
      expect(c.boolVariation('checkout', false), isTrue);
      final connects = edge.liveConnects;
      await Future<void>.delayed(const Duration(milliseconds: 2500));
      expect(edge.liveConnects, connects, reason: 'no reconnect after 4004');
      expect(c.transport, NanoFlagsTransport.poll);
    });

    test('a dropped socket reconnects with backoff and catches up from hello', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client();
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live);
      await edge.closeSockets(1011);
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}), push: false);
      await until(() => edge.liveConnects >= 2 && c.revision == 2, timeout: const Duration(seconds: 8));
      expect(c.boolVariation('checkout', true), isFalse);
    });

    test('without /v1/live the SDK falls back to SSE, then fetches on announcements', () async {
      edge.liveEnabled = false;
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client();
      await c.ready();
      await until(() => edge.streams.isNotEmpty, reason: 'SSE connection');
      expect(c.transport, NanoFlagsTransport.stream);
      final updates = <UpdateEvent>[];
      c.updates.listen(updates.add);
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}));
      await until(() => c.revision == 2);
      expect(updates.single.transport, NanoFlagsTransport.stream);
    });
  });

  group('mobile lifecycle', () {
    test('pause closes the socket and stops polling; resume reconnects and catches up', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client(pollInterval: const Duration(milliseconds: 300));
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live);
      c.pause();
      expect(c.transport, NanoFlagsTransport.paused);
      await until(() => edge.sockets.isEmpty, reason: 'socket closed on pause');
      final before = edge.bundleRequests;
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}));
      await Future<void>.delayed(const Duration(milliseconds: 900));
      expect(edge.bundleRequests, before, reason: 'no polling in the background');
      expect(c.revision, 1);
      c.resume();
      await until(() => c.revision == 2 && c.transport == NanoFlagsTransport.live);
      expect(c.boolVariation('checkout', true), isFalse);
    });

    test('data saver: no socket, no stream; leaving it reconnects', () async {
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client(dataSaver: true);
      await c.ready();
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(edge.liveConnects, 0);
      expect(edge.streams, isEmpty);
      expect(c.transport, NanoFlagsTransport.poll);
      c.setDataSaver(false);
      await until(() => c.transport == NanoFlagsTransport.live);
      c.setDataSaver(true);
      await until(() => edge.sockets.isEmpty);
      expect(c.transport, NanoFlagsTransport.poll);
    });

    test('identify / setContext change evaluations without a network round trip', () async {
      await edge.publish(bundleDoc(1, {
        'beta': boolFlag(false, rules: [
          {
            'id': 'r',
            'match': 'all',
            'conditions': [
              {'attribute': 'key', 'op': 'in', 'value': ['vip-1']}
            ],
            'serve': {'type': 'fixed', 'value': true}
          }
        ])
      }));
      final c = client(live: false, streaming: false);
      await c.ready();
      final requests = edge.requests.length;
      var changes = 0;
      c.changes.listen((_) => changes++);
      expect(c.boolVariation('beta', false), isFalse);
      c.identify('vip-1', {'plan': 'pro'});
      expect(c.context, {'plan': 'pro', 'key': 'vip-1'});
      expect(c.boolVariation('beta', false), isTrue);
      c.updateContext({'plan': null, 'country': 'DE'});
      expect(c.context, {'key': 'vip-1', 'country': 'DE'});
      c.setContext({'key': 'someone'});
      expect(c.boolVariation('beta', false), isFalse);
      await Future<void>.delayed(Duration.zero);
      expect(changes, 3);
      expect(edge.requests.length, requests);
    });

    test('persists the verified bundle and starts offline from it (re-verified, status stale)', () async {
      final store = RecordingStore();
      await edge.publish(bundleDoc(4, {'checkout': boolFlag(true)}));
      final first = client(live: false, streaming: false, store: store);
      await first.ready();
      await first.close();
      edge.down = true;
      final second = client(live: false, streaming: false, store: store);
      final updates = <UpdateEvent>[];
      second.updates.listen(updates.add);
      await second.ready();
      await pump();
      expect(second.revision, 4);
      expect(second.status, NanoFlagsStatus.stale);
      expect(second.boolVariation('checkout', false), isTrue);
      expect(updates.single.source, UpdateSource.store);
      // back online: confirmed by the edge (304) → ready
      edge.down = false;
      await second.refresh();
      expect(second.status, NanoFlagsStatus.ready);
    });

    test('a tampered stored bundle is ignored', () async {
      final store = RecordingStore();
      await edge.publish(bundleDoc(4, {'checkout': boolFlag(true)}));
      final first = client(live: false, streaming: false, store: store);
      await first.ready();
      await first.close();
      final key = await _onlyKey(store);
      final saved = jsonDecode((await store.read(key))!) as Map<String, Object?>;
      saved['raw'] = (saved['raw'] as String).replaceFirst('true', 'false');
      await store.write(key, jsonEncode(saved));
      edge.down = true;
      final second = client(live: false, streaming: false, store: store);
      final errors = <NanoFlagsException>[];
      second.errors.listen(errors.add);
      await second.ready();
      expect(second.revision, isNull);
      expect(errors.map((e) => e.code), contains(NanoFlagsErrorCode.signature));
    });

    test('a pushed revision is persisted too', () async {
      final store = RecordingStore();
      await edge.publish(bundleDoc(1, {'checkout': boolFlag(true)}));
      final c = client(store: store);
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live);
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}));
      await until(() => c.revision == 2);
      await c.close();
      final saved = jsonDecode((await store.read(await _onlyKey(store)))!) as Map<String, Object?>;
      expect((jsonDecode(saved['raw'] as String) as Map)['revision'], 2);
      expect((saved['sig'] as Map)['kid'], 't1');
    });

    test('bootstrap is used until the edge answers', () async {
      final c = client(live: false, streaming: false, bootstrap: bundleDoc(1, {'checkout': boolFlag(true)}));
      expect(c.status, NanoFlagsStatus.ready);
      expect(c.boolVariation('checkout', false), isTrue);
      await edge.publish(bundleDoc(2, {'checkout': boolFlag(false)}));
      await c.refresh();
      expect(c.boolVariation('checkout', true), isFalse);
    });
  });

  group('telemetry', () {
    test('sampled events carry attribute names and types, never values; service report', () async {
      await edge.publish(bundleDoc(1, {
        'beta': boolFlag(false, rules: [
          {
            'id': 'r',
            'match': 'all',
            'conditions': [
              {'attribute': 'email', 'op': 'ends_with', 'value': '@example.com'}
            ],
            'serve': {'type': 'fixed', 'value': true}
          }
        ])
      }));
      final c = client(live: false, streaming: false, events: const EventsOptions(sampleRate: 1), context: {'key': 'u', 'email': 'a@example.com', 'secret': 'x'});
      await c.ready();
      expect(c.boolVariation('beta', false), isTrue);
      await c.flush();
      final payload = edge.events.single;
      expect(payload['sdk'], 'dart/$sdkVersion');
      expect(payload['service'], 'test-app');
      expect(payload['revision'], 1);
      final ev = (payload['events'] as List).single as Map;
      expect(ev['flagKey'], 'beta');
      expect(ev['context'], {'email': 'string'});
      expect(jsonEncode(payload), isNot(contains('a@example.com')));
      expect(ev['sampleRate'], 1);
    });

    test('opt-out sends nothing', () async {
      await edge.publish(bundleDoc(1, {'beta': boolFlag(true)}));
      final c = client(live: false, streaming: false, events: const EventsOptions.off());
      await c.ready();
      c.boolVariation('beta', false);
      await c.flush();
      await c.close();
      expect(edge.events, isEmpty);
    });
  });
}

/// Lets broadcast-stream events that were already added reach their listeners.
Future<void> pump() => Future<void>.delayed(const Duration(milliseconds: 1));

Future<String> _onlyKey(RecordingStore store) async => store.values.keys.single;

/// A store whose entries the test can inspect.
final class RecordingStore implements NanoFlagsStore {
  final Map<String, String> values = {};
  @override
  Future<String?> read(String id) async => values[id];
  @override
  Future<void> write(String id, String value) async => values[id] = value;
}
