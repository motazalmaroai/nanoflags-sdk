// LIVE check against the production edge with the public demo browser key.
//
//   NANOFLAGS_SDK_KEY=<demo browser key> NANOFLAGS_LIVE=1 dart test -t live
//
// Toggles `demo-accent` once through POST /v1/demo/toggle (rate limited: run it rarely), expects the
// signed revision over the live socket, and restores the original value. tool/live_verify.dart does the
// same with several toggles and prints latencies.
@TestOn('vm')
@Tags(['live'])
library;

import 'dart:convert';
import 'dart:io';

import 'package:nanoflags/nanoflags.dart';
import 'package:test/test.dart';

Future<Map<String, Object?>> _toggle(String flag, Object value) async {
  final c = HttpClient()
    ..userAgent = 'nanoflags-dart-test/$sdkVersion'
    ..findProxy = HttpClient.findProxyFromEnvironment;
  try {
    final req = await c.postUrl(Uri.parse('$officialEdgeUrl/v1/demo/toggle'));
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode({'flag': flag, 'value': value}));
    final res = await req.close();
    return {...(jsonDecode(await res.transform(utf8.decoder).join()) as Map).cast<String, Object?>(), 'httpStatus': res.statusCode};
  } finally {
    c.close();
  }
}

void main() {
  final key = Platform.environment['NANOFLAGS_SDK_KEY'];
  final enabled = key != null && key.startsWith('nf_pub_') && Platform.environment['NANOFLAGS_LIVE'] == '1';

  test('production: verified bundle, live push after a demo toggle, restore', () async {
    final flags = NanoFlagsClient(NanoFlagsOptions(sdkKey: key!, service: 'dart-sdk-test', events: const EventsOptions.off()));
    addTearDown(flags.close);
    final updates = <UpdateEvent>[];
    flags.updates.listen(updates.add);
    await flags.ready(timeout: const Duration(seconds: 15));
    final deadline = DateTime.now().add(const Duration(seconds: 15));
    while ((flags.transport != NanoFlagsTransport.live || flags.revision == null) && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(flags.transport, NanoFlagsTransport.live);
    expect(flags.status, NanoFlagsStatus.ready);
    final original = flags.stringVariation('demo-accent', '?');
    expect(['blue', 'orange', 'green'], contains(original));
    final next = original == 'blue' ? 'green' : 'blue';
    final r = await _toggle('demo-accent', next);
    expect(r['status'], 'published', reason: jsonEncode(r));
    final returned = DateTime.now();
    final wait = DateTime.now().add(const Duration(seconds: 10));
    while (flags.stringVariation('demo-accent', '?') != next && DateTime.now().isBefore(wait)) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    final ms = DateTime.now().difference(returned).inMilliseconds;
    expect(flags.stringVariation('demo-accent', '?'), next);
    final u = updates.lastWhere((e) => e.revision == r['revision']);
    expect(u.transport, NanoFlagsTransport.live);
    print('toggle returned → update $ms ms; commit → update (SDK) ${u.latency?.inMilliseconds} ms; r${u.revision}');
    // Restore (the toggle endpoint is rate limited per client: wait as told and retry).
    var restored = await _toggle('demo-accent', original);
    for (var i = 0; i < 3 && restored['httpStatus'] == 429; i++) {
      await Future<void>.delayed(Duration(milliseconds: ((restored['retryAfterMs'] as num?) ?? 5000).toInt() + 250));
      restored = await _toggle('demo-accent', original);
    }
    expect(restored['status'], anyOf('published', 'unchanged'), reason: jsonEncode(restored));
  }, skip: enabled ? false : 'set NANOFLAGS_SDK_KEY (demo browser key) and NANOFLAGS_LIVE=1', timeout: const Timeout(Duration(seconds: 60)));
}
