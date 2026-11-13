// Verifies the Dart SDK against the hosted edge with the public live demo (Dart VM).
//
//   NANOFLAGS_SDK_KEY=<demo browser key> dart run tool/live_verify.dart [--toggles 4] [--gap 4]
//
// 1. Starts a client with default settings (official edge: signatures verified against the embedded
//    key, unsigned bundles refused) and waits for the live socket.
// 2. Checks offline that a tampered copy of the real signed bundle does not verify.
// 3. Toggles `demo-accent` through POST /v1/demo/toggle (public and rate limited: keep it gentle) and
//    measures toggle returned → `updates` event in Dart, and the commit → update latency the SDK reports.
// 4. Restores the original value.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:nanoflags/nanoflags.dart';
import 'package:nanoflags/verify.dart';

const colors = ['blue', 'orange', 'green'];
const userAgent = 'nanoflags-dart-live-verify/$sdkVersion';

HttpClient _client() => HttpClient()
  ..userAgent = userAgent
  ..findProxy = HttpClient.findProxyFromEnvironment;

Future<(int, String, Map<String, String>)> _http(String method, String url, {Map<String, String> headers = const {}, String? body}) async {
  final c = _client();
  try {
    final req = await c.openUrl(method, Uri.parse(url));
    headers.forEach(req.headers.set);
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(body);
    }
    final res = await req.close();
    final h = <String, String>{};
    res.headers.forEach((k, v) => h[k] = v.join(','));
    return (res.statusCode, await res.transform(utf8.decoder).join(), h);
  } finally {
    c.close();
  }
}

Future<Map<String, Object?>> toggle(String flag, Object value) async {
  final (status, body, _) = await _http('POST', '$officialEdgeUrl/v1/demo/toggle', body: jsonEncode({'flag': flag, 'value': value}));
  final m = (jsonDecode(body.isEmpty ? '{}' : body) as Map).cast<String, Object?>();
  return {...m, 'httpStatus': status};
}

double _median(List<int> xs) {
  final s = [...xs]..sort();
  return s.isEmpty ? double.nan : (s.length.isOdd ? s[s.length ~/ 2].toDouble() : (s[s.length ~/ 2 - 1] + s[s.length ~/ 2]) / 2);
}

Future<void> main(List<String> args) async {
  int arg(String name, int dflt) {
    final i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? int.parse(args[i + 1]) : dflt;
  }

  final toggles = arg('--toggles', 4);
  final gap = Duration(seconds: arg('--gap', 4));
  final key = Platform.environment['NANOFLAGS_SDK_KEY'];
  if (key == null || key.isEmpty) {
    stderr.writeln('set NANOFLAGS_SDK_KEY');
    exitCode = 2;
    return;
  }

  final updates = <(DateTime, UpdateEvent)>[];
  final errors = <NanoFlagsException>[];
  final sw = Stopwatch()..start();
  final flags = NanoFlagsClient(NanoFlagsOptions(sdkKey: key, service: 'dart-sdk-verify', context: const {'key': 'dart-verify'}, events: const EventsOptions.off()));
  flags.updates.listen((e) => updates.add((DateTime.now(), e)));
  flags.errors.listen((e) {
    errors.add(e);
    print('error event at ${sw.elapsedMilliseconds} ms: ${e.code.name}: ${e.message}');
  });
  await flags.ready(timeout: const Duration(seconds: 15));
  print('ready in ${sw.elapsedMilliseconds} ms: status=${flags.status.name} revision=${flags.revision}');
  final deadline = DateTime.now().add(const Duration(seconds: 15));
  while (flags.transport != NanoFlagsTransport.live && DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  print('transport=${flags.transport.name} (live socket open after ${sw.elapsedMilliseconds} ms)');
  print('values: ${flags.allFlags()}');
  final d = flags.stringVariationDetail('demo-accent', 'none');
  print('detail demo-accent: $d');

  // Offline tamper check against the real signed text: the /v1/bundle answer when it is signed,
  // otherwise the `hello` greeting of a raw /v1/live socket (which always carries the signed bundle).
  final (status, body, headers) = await _http('GET', '$officialEdgeUrl/v1/bundle', headers: {'Authorization': 'Bearer $key'});
  if (status != 200) throw StateError('GET /v1/bundle answered $status');
  print('GET /v1/bundle: HTTP $status, X-NanoFlags-Signed: ${headers['x-nanoflags-signed']}, revision ${(jsonDecode(body) as Map)['revision']}');
  SignatureInfo info;
  String raw;
  String source;
  if (headers['x-nanoflags-signed'] == 'true') {
    raw = rawMember(body, 'bundle')!;
    final parsed = jsonDecode(body) as Map;
    info = SignatureInfo(
        signature: headers['x-nanoflags-signature']!, kid: headers['x-nanoflags-key-id'], environmentId: headers['x-nanoflags-environment-id']!, revision: parsed['revision'] as int, checksum: parsed['checksum'] as String);
    source = '/v1/bundle';
  } else {
    final ws = await WebSocket.connect('${officialEdgeUrl.replaceFirst('https', 'wss')}/v1/live',
        protocols: [liveProtocol], headers: {'Authorization': 'Bearer $key'}, customClient: _client());
    final hello = jsonDecode(await ws.first as String) as Map;
    await ws.close();
    raw = hello['bundle'] as String;
    info = SignatureInfo(signature: hello['signature'] as String, kid: hello['kid'] as String?, environmentId: hello['environmentId'] as String, revision: hello['revision'] as int, checksum: hello['checksum'] as String);
    source = '/v1/live hello';
  }
  final keys = importPublicKeys(officialSigningKeys);
  final genuine = await verifyBundleText(keys, info, raw);
  final tampered = await verifyBundleText(keys, info, raw.replaceFirst('"enabled":true', '"enabled":false'));
  print('signature check ($source) on r${info.revision} (kid ${info.kid}): genuine=$genuine tampered=$tampered');

  final original = flags.stringVariation('demo-accent', 'blue');
  final perToggle = <int>[];
  final reported = <int>[];
  final sentToUpdate = <int>[];
  var current = original;
  for (var i = 0; i < toggles; i++) {
    final next = colors[(colors.indexOf(current) + 1) % colors.length];
    final before = updates.length;
    final sent = DateTime.now();
    final r = await toggle('demo-accent', next);
    final returned = DateTime.now();
    if (r['status'] != 'published') {
      print('toggle $i → $next: ${jsonEncode(r)}');
      if (r['httpStatus'] == 429) await Future<void>.delayed(Duration(milliseconds: ((r['retryAfterMs'] as num?) ?? 5000).toInt() + 500));
      continue;
    }
    final wait = DateTime.now().add(const Duration(seconds: 10));
    while (DateTime.now().isBefore(wait) && !updates.skip(before).any((u) => u.$2.revision >= (r['revision'] as int))) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    final hit = updates.skip(before).where((u) => u.$2.revision >= (r['revision'] as int)).firstOrNull;
    if (hit == null) {
      print('toggle $i → $next: r${r['revision']} published, NO update within 10 s');
    } else {
      final ms = hit.$1.difference(returned).inMilliseconds;
      perToggle.add(ms);
      sentToUpdate.add(hit.$1.difference(sent).inMilliseconds);
      if (hit.$2.latency != null) reported.add(hit.$2.latency!.inMilliseconds);
      print('toggle $i → $next: r${r['revision']} via ${hit.$2.transport.name}; toggle returned → update $ms ms; '
          'commit → update (SDK) ${hit.$2.latency?.inMilliseconds} ms; toggle sent → update ${sentToUpdate.last} ms; '
          'value now ${flags.stringVariation('demo-accent', '?')}');
      current = next;
    }
    await Future<void>.delayed(gap);
  }
  if (current != original) {
    final r = await toggle('demo-accent', original);
    print('restored demo-accent=$original: ${r['status']} r${r['revision']}');
    final wait = DateTime.now().add(const Duration(seconds: 10));
    while (DateTime.now().isBefore(wait) && flags.stringVariation('demo-accent', '?') != original) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }
  print('summary: ${perToggle.length}/$toggles updates received; toggle returned → update median ${_median(perToggle)} ms '
      '(${perToggle.isEmpty ? '-' : '${perToggle.reduce((a, b) => a < b ? a : b)}–${perToggle.reduce((a, b) => a > b ? a : b)}'}); '
      'commit → update (SDK) median ${_median(reported)} ms; toggle sent → update median ${_median(sentToUpdate)} ms');
  print('final: demo-accent=${flags.stringVariation('demo-accent', '?')} revision=${flags.revision} status=${flags.status.name} '
      'transport=${flags.transport.name} errors=${errors.map((e) => e.code.name).toList()}');
  await flags.close();
  exitCode = genuine && !tampered && perToggle.isNotEmpty ? 0 : 1;
}
