// A fake signing edge for tests: /v1/bundle (ETag, signature headers), /v1/keys, /v1/live
// (WebSocket with hello / rev / ping-pong), /v1/stream (SSE) and /v1/events, signing with an Ed25519
// key generated at runtime (no private key material is stored anywhere).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:nanoflags/verify.dart';

const String testKey = 'nf_pub_test-key-for-the-fake-edge';
const String environmentId = '11111111-2222-3333-4444-555555555555';

String b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

final class SigningKey {
  SigningKey(this.kid, this.pair, this.publicX);
  final String kid;
  final SimpleKeyPair pair;
  final String publicX;

  Map<String, String> get jwk => {'kty': 'OKP', 'crv': 'Ed25519', 'x': publicX, 'kid': kid};

  static Future<SigningKey> generate(String kid) async {
    final pair = await Ed25519().newKeyPair();
    final pub = await pair.extractPublicKey();
    return SigningKey(kid, pair, b64url(pub.bytes));
  }

  Future<String> sign(String bundleText, int revision, String checksum, {String env = environmentId}) async {
    final data = utf8.encode(canonicalString(env, revision, checksum, sha256Hex(bundleText)));
    final sig = await Ed25519().sign(data, keyPair: pair);
    return b64url(sig.bytes);
  }
}

/// One published revision as the edge stores it.
final class Revision {
  Revision(this.revision, this.checksum, this.text, this.signature, this.kid, this.committedAt);
  final int revision;
  final String checksum;
  final String text;
  final String? signature;
  final String? kid;
  final int? committedAt;
}

Map<String, Object?> bundleDoc(int revision, Map<String, Object?> flags, {Map<String, Object?> segments = const {}, int? engine}) => {
      'schema': 1,
      'project': 'test',
      'environment': 'test',
      'revision': revision,
      'flags': flags,
      'segments': segments,
      if (engine != null) 'engine': engine,
    };

Map<String, Object?> boolFlag(bool value, {List<Object?> rules = const []}) =>
    {'type': 'boolean', 'enabled': true, 'rules': rules, 'default': value, 'off': false, 'clientExposed': true};

Map<String, Object?> stringFlag(String value, {List<Object?> rules = const []}) =>
    {'type': 'string', 'enabled': true, 'rules': rules, 'default': value, 'off': 'off', 'clientExposed': true};

class FakeEdge {
  FakeEdge._(this.server, this.key);

  final HttpServer server;
  SigningKey key;
  final List<SigningKey> extraKeys = [];
  Revision? current;
  final List<HttpRequest> requests = [];
  final List<Map<String, String>> requestHeaders = [];
  final List<Map<String, Object?>> events = [];
  final List<WebSocket> sockets = [];
  final List<HttpResponse> streams = [];
  int liveConnects = 0;
  int keysRequests = 0;
  int bundleRequests = 0;

  /// What /v1/bundle serves: `signed`, `unsigned`, or `tampered` (valid headers, altered text).
  String bundleMode = 'signed';

  /// /v1/live answers 503 when false (the SDK falls back to SSE + polling).
  bool liveEnabled = true;

  /// Every request answers 503 when true (edge unreachable).
  bool down = false;
  bool staleHeader = false;
  final List<String> pongs = [];

  String get baseUrl => 'http://127.0.0.1:${server.port}';

  static Future<FakeEdge> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final edge = FakeEdge._(server, await SigningKey.generate('t1'));
    server.listen(edge._handle);
    return edge;
  }

  Future<void> close() async {
    for (final s in [...sockets]) {
      await s.close(1001);
    }
    for (final r in [...streams]) {
      try {
        await r.close();
      } catch (_) {}
    }
    await server.close(force: true);
  }

  List<Map<String, String>> get publicKeys => [key.jwk];

  int _seq = 0;

  /// Publishes [bundle] (its `revision` member is the revision) and pushes it to live sockets.
  Future<Revision> publish(Map<String, Object?> bundle, {bool push = true, bool sign = true, SigningKey? signWith, int? committedAt, bool tamperPush = false}) async {
    final text = jsonEncode(bundle);
    final revision = bundle['revision'] as int;
    final checksum = 'c${revision}x${_seq++}'.padRight(32, '0');
    final k = signWith ?? key;
    final signature = sign ? await k.sign(text, revision, checksum) : null;
    final rev = Revision(revision, checksum, text, signature, sign ? k.kid : null, committedAt ?? DateTime.now().millisecondsSinceEpoch);
    current = rev;
    if (push) {
      for (final s in [...sockets]) {
        s.add(jsonEncode(_message('rev', rev, tamper: tamperPush)));
      }
      for (final r in [...streams]) {
        r.write('event: revision\ndata: ${jsonEncode({'revision': revision, 'checksum': checksum})}\n\n');
        await r.flush();
      }
    }
    return rev;
  }

  Map<String, Object?> _message(String t, Revision? rev, {bool tamper = false}) => {
        't': t,
        'revision': rev?.revision ?? 0,
        'checksum': rev?.checksum,
        'signature': rev?.signature,
        'kid': rev?.kid,
        'environmentId': environmentId,
        'bundle': rev == null ? null : (tamper ? rev.text.replaceFirst('true', 'false') : rev.text),
        'committedAt': rev?.committedAt,
        'sentAt': DateTime.now().millisecondsSinceEpoch,
      };

  /// Closes every live socket with [code].
  Future<void> closeSockets(int code, [String reason = '']) async {
    for (final s in [...sockets]) {
      await s.close(code, reason);
    }
  }

  bool _authorized(HttpRequest req) => req.headers.value('authorization') == 'Bearer $testKey';

  Future<void> _handle(HttpRequest req) async {
    requests.add(req);
    final h = <String, String>{};
    req.headers.forEach((name, values) => h[name] = values.join(','));
    requestHeaders.add({...h, ':path': req.uri.toString(), ':method': req.method});
    final res = req.response;
    if (down) {
      res.statusCode = 503;
      await res.close();
      return;
    }
    switch (req.uri.path) {
      case '/v1/keys':
        keysRequests++;
        res.headers.contentType = ContentType.json;
        res.write(jsonEncode({'keys': [key.jwk, for (final k in extraKeys) k.jwk]}));
        await res.close();
      case '/v1/bundle':
        bundleRequests++;
        if (!_authorized(req)) {
          res.statusCode = 401;
          await res.close();
          return;
        }
        final rev = current;
        if (rev == null) {
          res.statusCode = 503;
          await res.close();
          return;
        }
        final etag = '"${rev.checksum}-client"';
        res.headers.set('ETag', etag);
        res.headers.set('X-NanoFlags-Environment-Id', environmentId);
        if (staleHeader) res.headers.set('X-NanoFlags-Stale', 'true');
        final signed = bundleMode != 'unsigned' && rev.signature != null;
        res.headers.set('X-NanoFlags-Signed', signed ? 'true' : 'false');
        if (signed) {
          res.headers.set('X-NanoFlags-Signature', rev.signature!);
          res.headers.set('X-NanoFlags-Key-Id', rev.kid!);
        }
        if (req.headers.value('if-none-match') == etag) {
          res.statusCode = 304;
          await res.close();
          return;
        }
        final text = bundleMode == 'tampered' ? rev.text.replaceFirst('true', 'false') : rev.text;
        res.headers.contentType = ContentType.json;
        // Exactly the edge's shape: the stored text embedded byte-for-byte.
        res.write('{"revision":${rev.revision},"checksum":"${rev.checksum}","bundle":$text}');
        await res.close();
      case '/v1/live':
        liveConnects++;
        if (!liveEnabled || !_authorized(req) || req.uri.hasQuery) {
          res.statusCode = liveEnabled ? 401 : 503;
          await res.close();
          return;
        }
        final ws = await WebSocketTransformer.upgrade(req, protocolSelector: (protocols) => protocols.contains('nanoflags.v1') ? 'nanoflags.v1' : null);
        sockets.add(ws);
        ws.add(jsonEncode(_message('hello', current)));
        ws.listen((data) {
          if (data == 'ping') {
            pongs.add('ping');
            ws.add('pong');
          }
        }, onDone: () => sockets.remove(ws));
      case '/v1/stream':
        if (!_authorized(req)) {
          res.statusCode = 401;
          await res.close();
          return;
        }
        res.headers.set('Content-Type', 'text/event-stream');
        res.bufferOutput = false;
        streams.add(res);
        final rev = current;
        if (rev != null) res.write('event: revision\ndata: ${jsonEncode({'revision': rev.revision, 'checksum': rev.checksum})}\n\n');
        await res.flush();
        unawaited(res.done.catchError((_) {}).whenComplete(() => streams.remove(res)));
      case '/v1/events':
        final body = await utf8.decoder.bind(req).join();
        events.add((jsonDecode(body) as Map).cast<String, Object?>());
        res.statusCode = 202;
        res.write('{"accepted":1,"capped":false}');
        await res.close();
      default:
        res.statusCode = 404;
        await res.close();
    }
  }
}

/// Waits until [condition] holds (polling every 10 ms), or fails after [timeout].
Future<void> until(bool Function() condition, {Duration timeout = const Duration(seconds: 5), String? reason}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw TimeoutException('condition not met${reason == null ? '' : ': $reason'}', timeout);
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
