// Verification hardening: rollback protection, status after a rejected update, the official edge address.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
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

  NanoFlagsClient client({bool live = false, bool streaming = false, NanoFlagsStore? store, Object? bootstrap, VerifyOptions? verify, Duration pollInterval = const Duration(seconds: 60)}) {
    final c = NanoFlagsClient(NanoFlagsOptions(
      sdkKey: testKey,
      baseUrl: edge.baseUrl,
      live: live,
      streaming: streaming,
      pollInterval: pollInterval,
      store: store,
      bootstrap: bootstrap,
      events: const EventsOptions.off(),
      verify: verify ?? VerifyOptions(publicKeys: edge.publicKeys, require: true),
    ));
    clients.add(c);
    return c;
  }

  Map<String, Object?> doc(int revision) => bundleDoc(revision, {'accent': stringFlag('blue-r$revision')});

  group('rollback protection', () {
    test('a validly signed older revision is refused as rollback, the config stays, the client turns stale', () async {
      await edge.publish(doc(5));
      final c = client();
      final errors = <NanoFlagsException>[];
      final revisions = <int>[];
      c.errors.listen(errors.add);
      c.updates.listen((u) => revisions.add(u.revision));
      await c.ready();
      expect(c.revision, 5);

      await edge.publish(doc(4), push: false);
      await c.refresh();
      await pump();
      expect(c.revision, 5);
      expect(c.stringVariation('accent', 'fb'), 'blue-r5');
      expect(errors.map((e) => e.code), [NanoFlagsErrorCode.rollback]);
      expect(errors.single.message, contains('older than r5'));
      expect(c.status, NanoFlagsStatus.stale);

      // The edge confirms the current revision: ready again; newer revisions are adopted as usual.
      await edge.publish(doc(5), push: false);
      await c.refresh();
      expect(c.status, NanoFlagsStatus.ready);
      await edge.publish(doc(6), push: false);
      await c.refresh();
      await pump();
      expect(c.revision, 6);
      // The edge confirming r5 again may emit once more; what matters is that nothing older than r5 was ever announced.
      expect(revisions.toSet(), {5, 6});
      expect(revisions.last, 6);
    });

    test('stripping the signature does not get around it (require: false)', () async {
      await edge.publish(doc(5));
      final c = client(verify: VerifyOptions(publicKeys: edge.publicKeys, require: false));
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      await edge.publish(doc(4), push: false);
      edge.bundleMode = 'unsigned';
      await c.refresh();
      await pump();
      expect(c.revision, 5);
      expect(errors.map((e) => e.code), [NanoFlagsErrorCode.rollback]);
      // An unsigned newer answer is still accepted with require: false.
      await edge.publish(doc(6), push: false);
      await c.refresh();
      expect(c.revision, 6);
      expect(c.status, NanoFlagsStatus.ready);
    });

    test('an older copy the edge marks as stale is refused silently: stale, no error', () async {
      await edge.publish(doc(5));
      final c = client();
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      await edge.publish(doc(4), push: false);
      edge.staleHeader = true;
      await c.refresh();
      await pump();
      expect(c.revision, 5);
      expect(c.status, NanoFlagsStatus.stale);
      expect(errors, isEmpty);
    });

    test('a bootstrap is not a verified revision: it never blocks an update', () async {
      await edge.publish(doc(5));
      final c = client(bootstrap: doc(9));
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      await c.refresh();
      await pump();
      expect(c.revision, 5);
      expect(errors, isEmpty);
    });

    test('a revision restored from the store is the floor after a restart', () async {
      final store = MemoryStore();
      await edge.publish(doc(5));
      final first = client(store: store);
      await first.ready();
      await first.close();

      await edge.publish(doc(4), push: false);
      final second = client(store: store);
      final errors = <NanoFlagsException>[];
      final revisions = <int>[];
      second.errors.listen(errors.add);
      second.updates.listen((u) => revisions.add(u.revision));
      await second.ready();
      await until(() => errors.any((e) => e.code == NanoFlagsErrorCode.rollback));
      expect(second.revision, 5);
      expect(revisions, [5]);
      expect(second.status, NanoFlagsStatus.stale);
    });

    test('a pushed older revision is refused as rollback; the request path then confirms the current one', () async {
      await edge.publish(doc(5));
      final c = client(live: true, streaming: true);
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      await until(() => c.transport == NanoFlagsTransport.live);
      await edge.publish(doc(6));
      await until(() => c.revision == 6);
      // A replayed push of the previous revision, genuinely signed.
      final replay = await edge.publish(doc(5), push: false);
      for (final s in [...edge.sockets]) {
        s.add(jsonEncode({
          't': 'hello',
          'revision': replay.revision,
          'checksum': replay.checksum,
          'signature': replay.signature,
          'kid': replay.kid,
          'environmentId': environmentId,
          'bundle': replay.text,
          'sentAt': DateTime.now().millisecondsSinceEpoch,
        }));
      }
      await until(() => errors.any((e) => e.code == NanoFlagsErrorCode.rollback));
      expect(c.revision, 6);
    });
  });

  group('status after a rejected update', () {
    test('a tampered update: stale until a bundle verifies', () async {
      await edge.publish(doc(3));
      final c = client();
      await c.ready();
      await edge.publish(doc(4), push: false);
      edge.bundleMode = 'tampered';
      await c.refresh();
      expect(c.revision, 3);
      expect(c.status, NanoFlagsStatus.stale);
      edge.bundleMode = 'signed';
      await c.refresh();
      expect(c.revision, 4);
      expect(c.status, NanoFlagsStatus.ready);
    });

    test('the edge\'s own unsigned marker (publisher still signing) is an error only: status unchanged', () async {
      await edge.publish(doc(3));
      final c = client();
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      await edge.publish(doc(4), push: false);
      edge.bundleMode = 'unsigned';
      await c.refresh();
      await pump();
      expect(c.status, NanoFlagsStatus.ready);
      expect(errors.map((e) => e.code), [NanoFlagsErrorCode.signature]);
    });
  });

  group('the official edge address', () {
    Future<(List<String>, NanoFlagsClient, List<NanoFlagsException>)> official(String baseUrl) async {
      final seen = <String>[];
      final mock = MockClient((req) async {
        seen.add(req.url.toString());
        return http.Response(jsonEncode({'revision': 1, 'checksum': 'c1', 'bundle': doc(1)}), 200, headers: {'content-type': 'application/json', 'x-nanoflags-signed': 'false'});
      });
      final c = NanoFlagsClient(NanoFlagsOptions(sdkKey: testKey, baseUrl: baseUrl, live: false, streaming: false, pollInterval: Duration.zero, events: const EventsOptions.off()), httpClient: mock);
      clients.add(c);
      final errors = <NanoFlagsException>[];
      c.errors.listen(errors.add);
      await c.ready();
      await pump();
      return (seen, c, errors);
    }

    for (final url in ['https://edge.nanoflags.io', 'https://edge.nanoflags.io/', 'https://EDGE.nanoflags.io:443', 'https://edge.nanoflags.io./', 'https://edge.nanoflags.io///']) {
      test('$url verifies like the canonical spelling', () async {
        final (seen, c, errors) = await official(url);
        expect(seen.first, 'https://edge.nanoflags.io/v1/bundle');
        expect(c.revision, isNull);
        expect(errors.map((e) => e.code), contains(NanoFlagsErrorCode.signature));
      });
    }

    for (final url in ['http://edge.nanoflags.io', 'https://edge.nanoflags.io.example.com', 'https://edge.nanoflags.io:8443', 'https://edge.nanoflags.io/v1', 'https://user@edge.nanoflags.io', 'https://edge.nanoflags.io?x=1', 'https://other.test']) {
      test('$url is not the official edge: unverified default', () async {
        // Another edge without configuration verifies nothing: the unsigned answer is accepted.
        final (_, c, _) = await official(url);
        expect(c.revision, 1);
      });
    }
  });
}

Future<void> pump() => Future<void>.delayed(const Duration(milliseconds: 1));
