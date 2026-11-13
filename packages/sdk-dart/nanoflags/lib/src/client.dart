import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'engine/engine.dart';
import 'engine/engine.dart' as engine show evaluate;
import 'engine/js.dart';
import 'keys.dart';
import 'platform/platform.dart' as platform;
import 'sse.dart';
import 'types.dart';
import 'verify.dart';

/// Opens a WebSocket (injectable for tests). [headers] is empty on the web, where the key travels
/// in [protocols] instead.
typedef WebSocketConnector = WebSocketChannel Function(Uri uri, List<String> protocols, Map<String, String> headers);

const int _maxQueue = 500;
const int _maxBatch = 50;
const int _maxEventValueChars = 1024;
const Duration _requestTimeout = Duration(seconds: 10);
const Duration _keysRefetch = Duration(minutes: 1);
const Duration _liveConnectTimeout = Duration(seconds: 10);
const Duration _livePing = Duration(seconds: 30);
const Duration _livePongTimeout = Duration(seconds: 10);
const Duration _liveMaxBackoff = Duration(minutes: 5);

/// A healthy socket is replaced after about this long, so the edge validates the key again.
const Duration _liveRotate = Duration(minutes: 50);

final class _QueuedEvent {
  _QueuedEvent(this.json);
  final Map<String, Object?> json;
}

final class _VerifyConfig {
  _VerifyConfig(this.keys, {required this.fetchOnly, required this.require, required this.refetch});
  final List<ImportedKey> keys;
  final bool fetchOnly;
  final bool require;
  final bool refetch;
}

final class _Checked {
  _Checked(this.bundle, this.sig, this.raw);
  final Map<String, Object?> bundle;
  final SignatureInfo? sig;
  final String raw;
}

bool _usable(Object? v) => isBundle(v) && jsIsInteger((v as Map)['revision']);

int _revisionOf(Map<String, Object?> b) => (b['revision'] as num).toInt();

/// Converts application values to the JSON data the engine evaluates.
Object? _normalize(Object? v) {
  if (v == null || v is bool || v is String) return v;
  if (v is num) return v;
  if (v is Map) return {for (final e in v.entries) jsString(e.key is String ? e.key : '${e.key}'): _normalize(e.value)};
  if (v is Iterable) return [for (final x in v) _normalize(x)];
  if (v is DateTime) return v.toUtc().toIso8601String();
  if (v is Enum) return v.name;
  return v.toString();
}

Map<String, Object?> _normalizeContext(Map<String, Object?> ctx) => (_normalize(ctx) as Map).cast<String, Object?>();

/// The NanoFlags client: evaluates flags locally and synchronously against the last verified
/// configuration, and keeps that configuration current in the background.
///
/// ```dart
/// final flags = NanoFlagsClient(const NanoFlagsOptions(sdkKey: 'nf_pub_…', context: {'key': 'user-42'}));
/// await flags.ready();
/// if (flags.boolVariation('new-checkout', false)) { … }
/// ```
///
/// Accessors never perform I/O and never throw: without a configuration they return the fallback.
/// Updates arrive over the live WebSocket (`/v1/live`, the signed bundle is pushed), else over SSE
/// (`/v1/stream`) or polling (`/v1/bundle` with ETag). Every bundle is verified (Ed25519) before it
/// replaces the current one; on the official edge unsigned bundles are refused.
class NanoFlagsClient {
  /// Creates the client and starts loading: the stored bundle (re-verified) and the edge, in parallel.
  ///
  /// Throws [ArgumentError] for a server key (`nf_srv_…`) or any key that is not a client key.
  NanoFlagsClient(NanoFlagsOptions options, {http.Client? httpClient, WebSocketConnector? webSocketConnector, math.Random? random})
      : _options = options,
        _baseUrl = options.baseUrl.replaceFirst(RegExp(r'/+$'), ''),
        _random = random ?? math.Random(),
        _context = _normalizeContext(options.context),
        _dataSaver = options.dataSaver {
    if (!options.sdkKey.startsWith('nf_pub_')) {
      throw ArgumentError.value(
          options.sdkKey.startsWith('nf_srv_') ? 'nf_srv_…' : '…', 'sdkKey', 'Mobile and web apps take a client key (nf_pub_…). Server keys must never ship inside an app.');
    }
    if (_baseUrl.isEmpty) throw ArgumentError.value(options.baseUrl, 'baseUrl', 'must not be empty');
    _userAgent = 'nanoflags-dart/$sdkVersion (${platform.platformName()})${options.userAgent == null ? '' : ' ${options.userAgent}'}';
    _ownsHttp = httpClient == null;
    _http = httpClient ?? platform.createHttpClient(_userAgent);
    _connect = webSocketConnector ??
        (uri, protocols, headers) => platform.connectWebSocket(uri, protocols: protocols, headers: headers, userAgent: _userAgent, connectTimeout: _liveConnectTimeout);
    _id = murmur3('$_baseUrl|${options.sdkKey}').toRadixString(16).padLeft(8, '0');
    _liveUri = RegExp(r'^https?://', caseSensitive: false).hasMatch(_baseUrl) ? Uri.parse('ws${_baseUrl.substring(4)}/v1/live') : null;
    _verify = _verifyConfig();
    _start();
  }

  final NanoFlagsOptions _options;
  final String _baseUrl;
  final math.Random _random;
  late final String _userAgent;
  late final http.Client _http;
  late final bool _ownsHttp;
  late final WebSocketConnector _connect;
  late final String _id;
  late final Uri? _liveUri;
  late final _VerifyConfig? _verify;

  // ---- state. `_bundle` is only ever replaced as a whole, so every evaluation sees one consistent revision.
  Map<String, Object?> _context;
  Map<String, Object?>? _bundle;
  String? _etag;
  String? _checksum;
  SignatureInfo? _sig;
  String? _rawText;
  String? _pinnedEnvironment;
  NanoFlagsStatus _status = NanoFlagsStatus.notReady;
  int _version = 0;
  bool _closed = false;
  bool _paused = false;
  bool _dataSaver;
  int _failures = 0;
  DateTime _lastSyncAt = DateTime.fromMillisecondsSinceEpoch(0);
  Timer? _pollTimer;
  Timer? _flushTimer;
  Future<void>? _inFlight;
  bool _streamTriggered = false;

  // SSE
  int _streamGen = 0;
  bool _streamActive = false;
  Completer<void>? _streamAbort;
  Timer? _streamWait;
  Completer<void>? _streamWaitDone;

  // live socket
  WebSocketChannel? _socket;
  void Function({bool rotating})? _endSocket;
  bool _liveOpen = false;
  int _liveAttempt = 0;
  Timer? _liveTimer;
  bool _environmentDeleted = false;
  int _liveRevision = 0;
  Future<void> _pushChain = Future.value();

  // keys
  List<ImportedKey> _fetchedKeys = const [];
  DateTime? _keysFetchedAt;
  Future<void>? _keysFetching;

  // telemetry
  final List<_QueuedEvent> _queue = [];
  DateTime _lastReportAt = DateTime.fromMillisecondsSinceEpoch(0);
  final Expando<Map<String, List<String>>> _usedAttrs = Expando();

  Future<void> _storeChain = Future.value();
  final Completer<void> _ready = Completer<void>();
  final StreamController<UpdateEvent> _updates = StreamController<UpdateEvent>.broadcast();
  final StreamController<NanoFlagsException> _errors = StreamController<NanoFlagsException>.broadcast();
  final StreamController<void> _changes = StreamController<void>.broadcast();

  /* ======================= public API ======================= */

  /// Completes once a usable configuration is loaded, or once the first load attempt has finished
  /// without one (check [status]). Never fails. With [timeout], completes after it at the latest.
  Future<void> ready({Duration? timeout}) => timeout == null ? _ready.future : _ready.future.timeout(timeout, onTimeout: () {});

  NanoFlagsStatus get status => _status;

  /// Revision of the configuration in use, or null when none is loaded.
  int? get revision => _bundle == null ? null : _revisionOf(_bundle!);

  /// The configuration bundle in use (read-only view of the verified document), or null.
  Map<String, Object?>? get bundle => _bundle == null ? null : UnmodifiableMapView(_bundle!);

  /// How updates reach this client right now.
  NanoFlagsTransport get transport => _paused
      ? NanoFlagsTransport.paused
      : _liveOpen
          ? NanoFlagsTransport.live
          : _streamActive
              ? NanoFlagsTransport.stream
              : NanoFlagsTransport.poll;

  /// True while the app is in the background ([pause]).
  bool get isPaused => _paused;

  /// True in data-saver mode ([setDataSaver]).
  bool get dataSaver => _dataSaver;

  /// The current evaluation context (normalised to JSON data).
  Map<String, Object?> get context => Map.unmodifiable(_context);

  /// Monotonic counter that changes whenever [changes] fires.
  int get version => _version;

  /// A different configuration was adopted.
  Stream<UpdateEvent> get updates => _updates.stream;

  /// Something went wrong in the background (network, rejected signature, …). The configuration in
  /// use is unchanged by any error.
  Stream<NanoFlagsException> get errors => _errors.stream;

  /// Fires on every change that can change a flag value: configuration, status or context.
  Stream<void> get changes => _changes.stream;

  /// Replaces the evaluation context (e.g. after sign-in). Local only: no network round trip.
  void setContext(Map<String, Object?> context) {
    _context = _normalizeContext(context);
    _changed();
  }

  /// Sets the context to [attributes] with `key` = [key] (the identity for percentage rollouts).
  void identify(String key, [Map<String, Object?> attributes = const {}]) => setContext({...attributes, 'key': key});

  /// Merges [attributes] into the current context (`null` values remove an attribute).
  void updateContext(Map<String, Object?> attributes) {
    final next = {..._context};
    attributes.forEach((k, v) => v == null ? next.remove(k) : next[k] = v);
    setContext(next);
  }

  /// The boolean value of [key], or [fallback] (missing flag, no configuration, or not a boolean).
  /// [context] is merged over the current context for this call only.
  bool boolVariation(String key, bool fallback, {Map<String, Object?>? context}) => _run(key, fallback, context, (v) => v is bool).value as bool;

  String stringVariation(String key, String fallback, {Map<String, Object?>? context}) => _run(key, fallback, context, (v) => v is String).value as String;

  /// Finite numbers only (JSON has one number type: an `int` comes back for whole numbers on native platforms).
  num numberVariation(String key, num fallback, {Map<String, Object?>? context}) => _run(key, fallback, context, (v) => v is num && v.isFinite).value as num;

  /// Any JSON value (maps, lists, strings, numbers, booleans, null).
  Object? jsonVariation(String key, Object? fallback, {Map<String, Object?>? context}) => _run(key, fallback, context, (_) => true).value;

  EvaluationDetail<bool> boolVariationDetail(String key, bool fallback, {Map<String, Object?>? context}) {
    final e = _run(key, fallback, context, (v) => v is bool);
    return EvaluationDetail.fromEvaluation(e, e.value as bool);
  }

  EvaluationDetail<String> stringVariationDetail(String key, String fallback, {Map<String, Object?>? context}) {
    final e = _run(key, fallback, context, (v) => v is String);
    return EvaluationDetail.fromEvaluation(e, e.value as String);
  }

  EvaluationDetail<num> numberVariationDetail(String key, num fallback, {Map<String, Object?>? context}) {
    final e = _run(key, fallback, context, (v) => v is num && v.isFinite);
    return EvaluationDetail.fromEvaluation(e, e.value as num);
  }

  EvaluationDetail<Object?> jsonVariationDetail(String key, Object? fallback, {Map<String, Object?>? context}) {
    final e = _run(key, fallback, context, (_) => true);
    return EvaluationDetail.fromEvaluation(e, e.value);
  }

  /// The full engine result (value, reason, matched rule, trace) without a type check.
  Evaluation evaluate(String key, Object? fallback, {Map<String, Object?>? context}) => _run(key, fallback, context, null);

  /// Every flag's value for the current context (flags that fail to evaluate map to null). No
  /// telemetry is recorded.
  Map<String, Object?> allFlags({Map<String, Object?>? context}) {
    final b = _bundle;
    if (b == null) return {};
    final ctx = context == null ? _context : {..._context, ..._normalizeContext(context)};
    final flags = b['flags'] as Map;
    return {
      for (final key in flags.keys)
        '$key': (() {
          final e = engine.evaluate(b, '$key', ctx, null);
          return e.reason == Reasons.error ? null : e.value;
        })(),
    };
  }

  /// Revalidates now (and reconnects the live socket right away if it is down). Completes when the
  /// request finished, successfully or not.
  Future<void> refresh() async {
    if (_closed) return;
    if (_socket == null && _liveTimer != null && !_paused && !_dataSaver) {
      _liveTimer!.cancel();
      _liveTimer = null;
      _liveAttempt = 0;
      _connectLive();
    }
    if (_inFlight != null) await _inFlight;
    await _sync();
  }

  /// Sends queued telemetry now.
  Future<void> flush() => _flush();

  /// The app went to the background: closes the live socket and the stream, stops polling, and
  /// sends queued telemetry once. Evaluations keep working on the last configuration.
  void pause() {
    if (_paused || _closed) return;
    _paused = true;
    _pollTimer?.cancel();
    _pollTimer = null;
    _liveTimer?.cancel();
    _liveTimer = null;
    _dropLive();
    _stopStream();
    _flushTimer?.cancel();
    _flushTimer = null;
    if (!_dataSaver) unawaited(_flush());
    _changed();
  }

  /// The app is in the foreground again: reconnects (the live socket's greeting carries the
  /// current revision) and revalidates when the last check is older than 30 s or failed.
  void resume() {
    if (!_paused || _closed) return;
    _paused = false;
    _liveAttempt = 0;
    final interval = _options.pollInterval > Duration.zero && _options.pollInterval < const Duration(seconds: 30) ? _options.pollInterval : const Duration(seconds: 30);
    if (DateTime.now().difference(_lastSyncAt) >= interval || _failures > 0 || _status != NanoFlagsStatus.ready) {
      unawaited(_sync().then((_) => _schedulePoll()));
    } else {
      _schedulePoll();
    }
    _startRealtime();
    _scheduleFlush();
    _changed();
  }

  /// Data-saver mode for metered or low-data networks: no live socket and no stream, polling at
  /// `dataSaverPollInterval`, telemetry held back. Flutter has no portable "metered" signal, so the
  /// app decides (e.g. from a platform channel or a user setting).
  void setDataSaver(bool enabled) {
    if (_dataSaver == enabled || _closed) return;
    _dataSaver = enabled;
    if (enabled) {
      _liveTimer?.cancel();
      _liveTimer = null;
      _dropLive();
      _stopStream();
    } else if (!_paused) {
      _liveAttempt = 0;
      _startRealtime();
      _scheduleFlush();
    }
    if (!_paused) _schedulePoll();
  }

  /// Stops timers, the socket, the stream and telemetry (after one last flush). Evaluations keep
  /// working on the last configuration.
  Future<void> close() async {
    if (_closed) return;
    final last = _flush();
    _closed = true;
    _pollTimer?.cancel();
    _flushTimer?.cancel();
    _liveTimer?.cancel();
    _dropLive();
    _stopStream();
    if (!_ready.isCompleted) _ready.complete();
    try {
      await last.timeout(const Duration(seconds: 2), onTimeout: () {});
      await _storeChain.timeout(const Duration(seconds: 2), onTimeout: () {});
    } catch (_) {}
    if (_ownsHttp) _http.close();
    await _updates.close();
    await _errors.close();
    await _changes.close();
  }

  /* ======================= internals ======================= */

  void _changed() {
    _version++;
    if (!_changes.isClosed) _changes.add(null);
  }

  void _setStatus(NanoFlagsStatus next) {
    if (_status == next) return;
    _status = next;
    _changed();
  }

  void _emitError(NanoFlagsException e) {
    if (!_errors.isClosed) _errors.add(e);
  }

  _VerifyConfig? _verifyConfig() {
    final v = _options.verify;
    if (v.isOff) return null;
    final official = _baseUrl == officialEdgeUrl;
    final pinned = v.publicKeys;
    if (pinned != null && pinned.any((k) => !isPublicEd25519Jwk(k))) {
      scheduleMicrotask(() => _emitError(const NanoFlagsException(
          '`verify.publicKeys` must contain public Ed25519 JWKs only. Other entries (including private keys) were ignored.', NanoFlagsErrorCode.config)));
    }
    if (pinned != null) return _VerifyConfig(importPublicKeys(pinned), fetchOnly: false, require: v.require ?? official, refetch: v.fetchKeys);
    if (v.fetchKeys) return _VerifyConfig(const [], fetchOnly: true, require: v.require ?? official, refetch: true);
    if (official) return _VerifyConfig(importPublicKeys(officialSigningKeys), fetchOnly: false, require: v.require ?? true, refetch: true);
    // Another edge without configuration: nothing is verified unless asked (as the JS SDK does).
    return null;
  }

  Map<String, String> _headers({bool auth = true}) => {
        if (auth) 'Authorization': 'Bearer ${_options.sdkKey}',
        if (!platform.keyInSubprotocol) 'User-Agent': _userAgent,
      };

  Future<http.Response> _request(String method, String path, {Map<String, String> headers = const {}, String? body, bool auth = true}) async {
    final abort = Completer<void>();
    final timer = Timer(_requestTimeout, () {
      if (!abort.isCompleted) abort.complete();
    });
    try {
      final req = http.AbortableRequest(method, Uri.parse('$_baseUrl$path'), abortTrigger: abort.future);
      req.headers.addAll({..._headers(auth: auth), ...headers});
      if (body != null) req.body = body;
      final streamed = await _http.send(req);
      return await http.Response.fromStream(streamed);
    } finally {
      timer.cancel();
      if (!abort.isCompleted) abort.complete();
    }
  }

  void _start() {
    final boot = _options.bootstrap;
    if (boot != null) {
      Object? parsed = boot;
      String? text;
      if (boot is String) {
        text = boot;
        try {
          parsed = jsonDecode(boot);
        } on FormatException {
          parsed = null;
        }
      }
      if (_usable(parsed) && !supportsEngine(parsed)) {
        final err = _engineError(parsed as Map);
        scheduleMicrotask(() => _emitError(err));
      } else if (_usable(parsed)) {
        final b = (parsed as Map).cast<String, Object?>();
        _rawText = text ?? jsonEncode(b);
        _adopt(b, etag: null, checksum: null, status: NanoFlagsStatus.ready, source: UpdateSource.bootstrap);
      } else {
        scheduleMicrotask(() => _emitError(const NanoFlagsException('The bootstrap bundle is invalid and was ignored.', NanoFlagsErrorCode.invalidBundle)));
      }
    }
    Future.wait([_restore(), _sync()]).whenComplete(() {
      if (!_ready.isCompleted) _ready.complete(); // even without a bundle: callers must not hang
      if (_closed) return;
      if (!_paused) {
        _schedulePoll();
        _scheduleFlush();
        _startRealtime();
      }
    });
  }

  NanoFlagsException _engineError(Map<dynamic, dynamic> b) => NanoFlagsException(
      'Bundle r${jsString(b['revision'])} needs evaluation engine ${jsStringify(b['engine'])}; this SDK supports up to $engineVersion. '
      'Upgrade nanoflags. The configuration in use is unchanged.',
      NanoFlagsErrorCode.engine);

  void _adopt(Map<String, Object?> next,
      {required String? etag, required String? checksum, required NanoFlagsStatus status, required UpdateSource source, NanoFlagsTransport transport = NanoFlagsTransport.poll, Duration? latency}) {
    final previous = _bundle == null ? null : _revisionOf(_bundle!);
    final rev = _revisionOf(next);
    final isNew = _bundle == null || previous != rev || _checksum != checksum;
    _bundle = next; // single assignment: the swap is atomic for synchronous evaluations
    _etag = etag;
    _checksum = checksum;
    _status = status;
    _changed();
    if (!_ready.isCompleted) _ready.complete();
    if (isNew && !_updates.isClosed) {
      _updates.add(UpdateEvent(revision: rev, previousRevision: previous, checksum: checksum, source: source, transport: transport, latency: latency));
    }
  }

  void _persist() {
    final store = _options.store;
    final raw = _rawText;
    if (store == null || _bundle == null || raw == null) return;
    final payload = jsonEncode({
      'v': 1,
      'id': _id,
      'etag': _etag,
      'checksum': _checksum,
      'savedAt': DateTime.now().toUtc().toIso8601String(),
      'raw': raw,
      if (_sig != null) 'sig': _sig!.toJson(),
    });
    // Writes are serialised so an older bundle can never overwrite a newer one.
    _storeChain = _storeChain.then((_) => store.write(_id, payload)).catchError((Object _) {
      _emitError(const NanoFlagsException('Could not persist the bundle.', NanoFlagsErrorCode.store));
    });
  }

  Future<void> _restore() async {
    final store = _options.store;
    if (store == null) return;
    try {
      final text = await store.read(_id);
      if (text == null || _closed) return;
      final p = jsonDecode(text);
      if (p is! Map || p['v'] != 1 || p['id'] != _id || p['raw'] is! String) return;
      final raw = p['raw'] as String;
      final parsed = jsonDecode(raw);
      if (!_usable(parsed)) return;
      final b = (parsed as Map).cast<String, Object?>();
      if (!supportsEngine(b)) return _emitError(_engineError(b));
      // Never replace something newer (network result or a newer bootstrap) with the stored copy.
      if (_bundle != null && _revisionOf(_bundle!) >= _revisionOf(b)) return;
      SignatureInfo? sig;
      final verify = _verify;
      if (verify != null) {
        // The device's storage is outside the trust boundary: a signed copy must verify again, and with
        // `require` an unsigned copy is not used at all.
        sig = SignatureInfo.fromJson(p['sig']);
        if (sig != null && sig.revision == _revisionOf(b)) {
          var ok = false;
          try {
            ok = await verifyBundleText(await _loadKeys(sig.kid), sig, raw);
          } catch (_) {
            ok = false;
          }
          if (!ok) return _emitError(const NanoFlagsException('The persisted bundle failed signature verification and was ignored.', NanoFlagsErrorCode.signature));
        } else {
          sig = null;
          if (verify.require) return;
        }
        if (_closed || (_bundle != null && _revisionOf(_bundle!) >= _revisionOf(b))) return;
      }
      _sig = sig;
      _rawText = raw;
      if (sig != null) _pinnedEnvironment ??= sig.environmentId;
      final etag = p['etag'], checksum = p['checksum'];
      // A restored bundle is usable but not known to be current: stale until the edge confirms it.
      _adopt(b, etag: etag is String ? etag : null, checksum: checksum is String ? checksum : null, status: NanoFlagsStatus.stale, source: UpdateSource.store);
    } catch (_) {
      _emitError(const NanoFlagsException('Could not read the persisted bundle.', NanoFlagsErrorCode.store));
    }
  }

  /* ---------------- signing keys ---------------- */

  Future<List<ImportedKey>> _fetchKeys() async {
    final res = await _request('GET', '/v1/keys', auth: false); // public endpoint: the SDK key is not sent
    if (res.statusCode != 200) throw NanoFlagsException('Signing keys request failed with HTTP ${res.statusCode}.', NanoFlagsErrorCode.signature, res.statusCode);
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    final keys = importPublicKeys(body is Map && body['keys'] is List ? body['keys'] as List : const []);
    if (keys.isEmpty) throw const NanoFlagsException('The edge returned no usable signing keys.', NanoFlagsErrorCode.signature);
    return keys;
  }

  /// Keys to verify a signature by `kid` with: the pinned / embedded keys plus those fetched from
  /// `/v1/keys`. With `refetch`, a key id none of them has (rotation) loads `/v1/keys` once — again
  /// at most once a minute.
  Future<List<ImportedKey>> _loadKeys(String? kid) async {
    final verify = _verify;
    if (verify == null) return const [];
    final base = verify.keys;
    List<ImportedKey> all() => [...base, ..._fetchedKeys];
    if (!verify.refetch) return base;
    final known = all();
    if (known.isNotEmpty && (kid == null || known.any((k) => k.kid == kid))) return known;
    final at = _keysFetchedAt;
    if (at != null && DateTime.now().difference(at) < _keysRefetch) return known;
    _keysFetching ??= _fetchKeys().then((keys) {
      _fetchedKeys = keys;
      _keysFetchedAt = DateTime.now();
    }).whenComplete(() => _keysFetching = null);
    try {
      await _keysFetching;
    } catch (e) {
      // Without any key the bundle cannot be checked (the next bundle tries again). With embedded keys the
      // failed reload counts as this minute's reload, so a bad key id cannot make every poll ask for keys.
      if (base.isEmpty) rethrow;
      _keysFetchedAt = DateTime.now();
    }
    return all();
  }

  Future<_Checked> _checkSignature(Map<String, String> headers, String text, Map<dynamic, dynamic> body) async {
    final bundle = (body['bundle'] as Map).cast<String, Object?>();
    final rev = _revisionOf(bundle);
    final raw = rawMember(text, 'bundle');
    final verify = _verify;
    if (verify == null) return _Checked(bundle, null, raw ?? jsonEncode(bundle));
    NanoFlagsException reject(String why) =>
        NanoFlagsException('Bundle r$rev was rejected: $why The configuration in use is unchanged.', NanoFlagsErrorCode.signature);
    if (headers['x-nanoflags-signed'] != 'true') {
      if (verify.require) throw reject('it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.');
      return _Checked(bundle, null, raw ?? jsonEncode(bundle));
    }
    final signature = headers['x-nanoflags-signature'];
    final environmentId = headers['x-nanoflags-environment-id'];
    final kid = headers['x-nanoflags-key-id'];
    final checksum = body['checksum'];
    if (signature == null || signature.isEmpty || environmentId == null || environmentId.isEmpty || checksum is! String) {
      throw reject('the signature headers are incomplete.');
    }
    final signedRevision = body['revision'] is num ? body['revision'] as num : rev;
    if (signedRevision != rev) throw reject('the signed revision does not match the bundle.');
    if (_pinnedEnvironment != null && _pinnedEnvironment != environmentId) throw reject('it was signed for a different environment.');
    if (raw == null) throw reject('the signed bundle text could not be located in the answer.');
    final info = SignatureInfo(signature: signature, kid: kid, environmentId: environmentId, revision: rev, checksum: checksum);
    List<ImportedKey> keys;
    try {
      keys = await _loadKeys(kid);
    } catch (e) {
      throw reject('the signing keys could not be loaded (${e is NanoFlagsException ? e.message : e}).');
    }
    // The edge embeds the stored bundle text byte-for-byte: that exact text is what was signed.
    if (!await verifyBundleText(keys, info, raw)) throw reject('its signature does not verify.');
    _pinnedEnvironment = environmentId;
    return _Checked(bundle, info, raw);
  }

  /* ---------------- HTTP: /v1/bundle ---------------- */

  Future<void> _syncOnce() async {
    _lastSyncAt = DateTime.now();
    final transport = _streamTriggered ? NanoFlagsTransport.stream : NanoFlagsTransport.poll;
    _streamTriggered = false;
    try {
      final res = await _request('GET', '/v1/bundle', headers: {if (_etag != null) 'If-None-Match': _etag!});
      if (_closed) return;
      final servedStale = res.headers['x-nanoflags-stale'] == 'true';
      if (res.statusCode == 304) {
        _failures = 0;
        if (_bundle != null) _setStatus(servedStale ? NanoFlagsStatus.stale : NanoFlagsStatus.ready);
        return;
      }
      if (res.statusCode == 401 || res.statusCode == 403) {
        throw NanoFlagsException('The SDK key was rejected (unknown or revoked).', NanoFlagsErrorCode.unauthorized, res.statusCode);
      }
      if (res.statusCode < 200 || res.statusCode > 299) throw NanoFlagsException('Bundle request failed with HTTP ${res.statusCode}.', NanoFlagsErrorCode.http, res.statusCode);
      Object? body;
      String text;
      try {
        text = utf8.decode(res.bodyBytes);
        body = jsonDecode(text);
      } on FormatException {
        throw const NanoFlagsException('The edge returned an invalid bundle.', NanoFlagsErrorCode.invalidBundle);
      }
      if (body is! Map || !_usable(body['bundle'])) throw const NanoFlagsException('The edge returned an invalid bundle.', NanoFlagsErrorCode.invalidBundle);
      final checked = await _checkSignature(res.headers, text, body);
      if (_closed) return;
      final next = checked.bundle;
      if (!supportsEngine(next)) throw _engineError(next);
      _failures = 0;
      final rev = _revisionOf(next);
      // The edge is serving its last-known-good copy: never go backwards because of it.
      if (servedStale && _bundle != null && _revisionOf(_bundle!) >= rev) return _setStatus(NanoFlagsStatus.stale);
      // A revision that was pushed while this request was under way (or that KV does not point at yet) wins.
      if (_bundle != null && rev < _liveRevision && _revisionOf(_bundle!) >= _liveRevision) return;
      _sig = checked.sig;
      _rawText = checked.raw;
      final checksum = body['checksum'];
      _adopt(next,
          etag: res.headers['etag'],
          checksum: checksum is String ? checksum : null,
          status: servedStale ? NanoFlagsStatus.stale : NanoFlagsStatus.ready,
          source: UpdateSource.network,
          transport: transport);
      _persist();
    } catch (e) {
      if (_closed) return;
      final err = e is NanoFlagsException ? e : NanoFlagsException('Could not reach the NanoFlags edge: $e', NanoFlagsErrorCode.network);
      // A bundle for a newer engine: nothing to retry quickly; the edge answers the same until the app updates.
      if (err.code == NanoFlagsErrorCode.engine) return _emitError(err);
      _failures++;
      // A rejected update changes nothing: same bundle, same status. Polling retries with backoff.
      if (err.code == NanoFlagsErrorCode.signature) return _emitError(err);
      // A rejected key must not keep a socket.
      if (err.code == NanoFlagsErrorCode.unauthorized) _dropLive();
      if (_bundle != null) _setStatus(NanoFlagsStatus.stale);
      _emitError(err);
    }
  }

  /// Single-flight: concurrent triggers (poll, stream, resume) share one request.
  Future<void> _sync() {
    if (_closed) return Future.value();
    return _inFlight ??= _syncOnce().whenComplete(() => _inFlight = null);
  }

  Duration _nextDelay() {
    final poll = _options.pollInterval;
    final jitter = 0.8 + 0.4 * _random.nextDouble();
    Duration interval;
    if (_dataSaver) {
      interval = _options.dataSaverPollInterval;
    } else if (_liveOpen) {
      interval = poll > _options.livePollInterval ? poll : _options.livePollInterval;
    } else {
      interval = poll;
    }
    // After failures, catch up quickly (1 s, 2 s, 4 s … capped at the interval).
    final base = _failures > 0 ? Duration(milliseconds: math.min(interval.inMilliseconds, 1000 * (1 << math.min(_failures - 1, 10)))) : interval;
    return Duration(milliseconds: math.max(250, (base.inMilliseconds * jitter).round()));
  }

  void _schedulePoll() {
    if (_closed || _paused || _options.pollInterval <= Duration.zero) return;
    _pollTimer?.cancel();
    _pollTimer = Timer(_nextDelay(), () {
      _pollTimer = null;
      if (_paused) return;
      unawaited(_sync().then((_) => _schedulePoll()));
    });
  }

  void _startRealtime() {
    if (_closed || _paused || _dataSaver || !_options.streaming) return;
    if (_liveWanted) {
      _connectLive();
    } else {
      _startStream();
    }
  }

  /* ---------------- SSE: /v1/stream ---------------- */

  void _onRevision(String data) {
    try {
      final m = jsonDecode(data);
      if (m is! Map) return;
      final b = _bundle;
      if (b == null || m['revision'] != _revisionOf(b) || m['checksum'] != _checksum || _status != NanoFlagsStatus.ready) {
        _streamTriggered = true;
        unawaited(_sync());
      }
    } on FormatException {
      // ignore malformed notifications
    }
  }

  void _startStream() {
    if (_closed || _paused || _dataSaver || !_options.streaming || _streamActive || _environmentDeleted) return;
    _streamActive = true;
    unawaited(_streamLoop(++_streamGen));
  }

  void _stopStream() {
    _streamGen++;
    _streamActive = false;
    final abort = _streamAbort;
    if (abort != null && !abort.isCompleted) abort.complete();
    _streamAbort = null;
    _streamWait?.cancel();
    final done = _streamWaitDone;
    if (done != null && !done.isCompleted) done.complete();
  }

  Future<void> _streamLoop(int gen) async {
    var attempt = 0;
    bool current() => !_closed && gen == _streamGen;
    while (current()) {
      final abort = Completer<void>();
      _streamAbort = abort;
      final startedAt = DateTime.now();
      var stop = false;
      final connectTimer = Timer(_requestTimeout, () {
        if (!abort.isCompleted) abort.complete();
      });
      try {
        final req = http.AbortableRequest('GET', Uri.parse('$_baseUrl/v1/stream'), abortTrigger: abort.future)
          ..headers.addAll({..._headers(), 'Accept': 'text/event-stream'});
        final res = await _http.send(req);
        connectTimer.cancel();
        if (res.statusCode == 401 || res.statusCode == 403) {
          stop = true; // polling keeps reporting the error
          unawaited(res.stream.drain<void>().catchError((_) {}));
        } else if (res.statusCode == 200) {
          await readSse(res.stream, (event, data) {
            if (!current()) return;
            if (event == 'revision') {
              _onRevision(data);
            } else if (event == 'revoked') {
              stop = true;
              if (!abort.isCompleted) abort.complete();
              unawaited(_sync());
            }
          });
        } else {
          unawaited(res.stream.drain<void>().catchError((_) {}));
        }
      } catch (_) {
        // reconnect below
      } finally {
        connectTimer.cancel();
      }
      if (!current()) return;
      if (stop) {
        _streamActive = false;
        return;
      }
      attempt = DateTime.now().difference(startedAt) > const Duration(seconds: 30) ? 0 : attempt + 1;
      final wait = math.min(30000, 1000 * (1 << math.min(attempt, 5))) * (0.5 + _random.nextDouble());
      final done = Completer<void>();
      _streamWaitDone = done;
      _streamWait = Timer(Duration(milliseconds: wait.round()), () {
        if (!done.isCompleted) done.complete();
      });
      await done.future;
    }
  }

  /* ---------------- live socket: /v1/live ---------------- */

  bool get _liveWanted => _options.streaming && _options.live && _liveUri != null;

  /// Applies one `rev` / `hello` message. Never throws; a message that cannot be trusted changes nothing.
  Future<void> _applyPush(Map<dynamic, dynamic> m) async {
    if (_closed || (m['t'] != 'rev' && m['t'] != 'hello')) return;
    final revision = m['revision'];
    // Revision 0 / no bundle: the environment has nothing published yet.
    if (revision is! int || revision < 1 || m['bundle'] is! String) return;
    if (_bundle != null && revision < _revisionOf(_bundle!)) return; // never backwards
    final text = m['bundle'] as String;
    final pushedChecksum = m['checksum'] is String ? m['checksum'] as String : null;
    SignatureInfo? info;
    final verify = _verify;
    if (verify != null) {
      void reject(String why) {
        _emitError(NanoFlagsException('Pushed bundle r$revision was rejected: $why The configuration in use is unchanged.', NanoFlagsErrorCode.signature));
        // Whatever sent this, the regular (verified) request path says what is really current.
        unawaited(_sync());
      }

      final signature = m['signature'], environmentId = m['environmentId'];
      if (signature is! String || environmentId is! String || pushedChecksum == null) return reject('it carries no complete signature.');
      if (_pinnedEnvironment != null && _pinnedEnvironment != environmentId) return reject('it was signed for a different environment.');
      info = SignatureInfo(signature: signature, kid: m['kid'] is String ? m['kid'] as String : null, environmentId: environmentId, revision: revision, checksum: pushedChecksum);
      var ok = false;
      try {
        ok = await verifyBundleText(await _loadKeys(info.kid), info, text);
      } catch (_) {
        ok = false;
      }
      if (_closed) return;
      if (!ok) return reject('its signature does not verify.');
    }
    Object? parsed;
    try {
      parsed = jsonDecode(text);
    } on FormatException {
      parsed = null;
    }
    if (!_usable(parsed) || _revisionOf((parsed as Map).cast<String, Object?>()) != revision) {
      return _emitError(const NanoFlagsException('The edge pushed an invalid bundle; it was ignored.', NanoFlagsErrorCode.invalidBundle));
    }
    final next = parsed.cast<String, Object?>();
    if (!supportsEngine(next)) return _emitError(_engineError(next));
    if (_bundle != null && revision < _revisionOf(_bundle!)) return;
    _failures = 0;
    if (_bundle != null && revision == _revisionOf(_bundle!)) {
      // Already in use: the push only confirms that it is current.
      if (_checksum == null || _checksum == pushedChecksum) _setStatus(NanoFlagsStatus.ready);
      return;
    }
    if (info != null) _pinnedEnvironment = info.environmentId;
    _sig = info;
    _rawText = text;
    _liveRevision = revision;
    final committedAt = m['committedAt'];
    _adopt(next,
        // What `/v1/bundle` would send as ETag for this revision, so the safety poll gets a 304.
        etag: pushedChecksum != null ? '"$pushedChecksum-client"' : null,
        checksum: pushedChecksum,
        status: NanoFlagsStatus.ready,
        source: UpdateSource.network,
        transport: NanoFlagsTransport.live,
        latency: committedAt is num && committedAt.isFinite ? Duration(milliseconds: DateTime.now().millisecondsSinceEpoch - committedAt.round()) : null);
    _persist();
  }

  /// Closes the current socket; its end handler decides whether to reconnect.
  void _dropLive() {
    final end = _endSocket;
    if (end != null) end();
  }

  void _connectLive() {
    if (_closed || _paused || _dataSaver || !_liveWanted || _socket != null || _environmentDeleted) return;
    final protocols = platform.keyInSubprotocol ? [liveProtocol, 'key.${_options.sdkKey}'] : [liveProtocol];
    final headers = platform.keyInSubprotocol ? <String, String>{} : _headers();
    WebSocketChannel ws;
    try {
      ws = _connect(_liveUri!, protocols, headers);
    } catch (_) {
      return _liveEnded(false, Duration.zero, false);
    }
    _socket = ws;
    var opened = false;
    var done = false;
    var openedAt = DateTime.now();
    Timer? pingTimer, pongTimer, rotateTimer, connectTimer;
    StreamSubscription<dynamic>? sub;
    void end({bool rotating = false}) {
      if (done) return;
      done = true;
      connectTimer?.cancel();
      pingTimer?.cancel();
      pongTimer?.cancel();
      rotateTimer?.cancel();
      unawaited(sub?.cancel());
      try {
        unawaited(ws.sink.close(1000, 'bye').catchError((_) {}));
      } catch (_) {}
      if (identical(_socket, ws)) {
        _socket = null;
        _endSocket = null;
      }
      final wasOpen = _liveOpen;
      _liveOpen = false;
      _liveEnded(opened, opened ? DateTime.now().difference(openedAt) : Duration.zero, rotating);
      if (wasOpen && !_closed) _changed();
    }

    _endSocket = end;
    connectTimer = Timer(_liveConnectTimeout, end);
    void ping() {
      final jitter = 0.9 + 0.2 * _random.nextDouble();
      pingTimer = Timer(Duration(milliseconds: (_livePing.inMilliseconds * jitter).round()), () {
        try {
          ws.sink.add('ping');
        } catch (_) {
          return end();
        }
        // The edge answers `pong` without waking anything up; silence means the connection is dead.
        pongTimer ??= Timer(_livePongTimeout, end);
        ping();
      });
    }

    ws.ready.then((_) {
      if (done) return;
      opened = true;
      openedAt = DateTime.now();
      _liveOpen = true;
      connectTimer?.cancel();
      _stopStream(); // SSE is not used while the socket is healthy
      _schedulePoll(); // the poll becomes a safety net
      ping();
      final jitter = 0.9 + 0.2 * _random.nextDouble();
      rotateTimer = Timer(Duration(milliseconds: (_liveRotate.inMilliseconds * jitter).round()), () => end(rotating: true));
      _changed();
    }, onError: (Object _) => end());
    sub = ws.stream.listen((data) {
      if (done || data is! String) return;
      pongTimer?.cancel();
      pongTimer = null;
      if (data == 'pong') return;
      Object? m;
      try {
        m = jsonDecode(data);
      } on FormatException {
        return;
      }
      if (m is! Map) return;
      // One at a time, in arrival order: verification is asynchronous.
      _pushChain = _pushChain.then((_) => _applyPush(m as Map)).catchError((Object _) {});
    }, onDone: () {
      if (ws.closeCode == closeEnvironmentDeleted) _environmentDeleted = true;
      end();
    }, onError: (Object _) => end(), cancelOnError: true);
  }

  void _liveEnded(bool opened, Duration openFor, bool rotating) {
    if (_closed) return;
    if (_environmentDeleted) {
      // Keep evaluating the last bundle; it can no longer be updated. No socket, no stream; the regular
      // poll stays (it reports the key as rejected, and recovers if the environment exists after all).
      _stopStream();
      if (_bundle != null) _setStatus(NanoFlagsStatus.stale);
      _emitError(const NanoFlagsException(
          'The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated.', NanoFlagsErrorCode.environmentDeleted));
      _schedulePoll();
      return;
    }
    if (_paused || _dataSaver) return; // deliberate: resume / leaving data-saver reconnects
    if (rotating) return _connectLive(); // planned replacement: no fallback, no backoff
    _liveAttempt = opened && openFor > const Duration(seconds: 30) ? 1 : _liveAttempt + 1;
    // Never got through (socket cap, no WebSocket path) or lost it and the reconnect failed too:
    // SSE + polling take over until a socket opens again.
    if (!opened) {
      _startStream();
    } else {
      _schedulePoll();
    }
    final base = math.min(_liveMaxBackoff.inMilliseconds, 1000 * (1 << math.min(_liveAttempt - 1, 10)));
    final wait = base * (0.5 + _random.nextDouble());
    _liveTimer?.cancel();
    _liveTimer = Timer(Duration(milliseconds: wait.round()), () {
      _liveTimer = null;
      _connectLive();
    });
  }

  /* ---------------- telemetry ---------------- */

  List<String> _attrsUsedBy(Map<String, Object?>? b, String flagKey) {
    if (b == null) return const [];
    final cache = _usedAttrs[b] ??= <String, List<String>>{};
    final hit = cache[flagKey];
    if (hit != null) return hit;
    final names = <String>{};
    final flags = b['flags'];
    final segments = b['segments'];
    final flag = flags is Map ? flags[flagKey] : null;
    void visit(Object? conditions, int depth) {
      if (conditions is! List) return;
      for (final c in conditions) {
        if (c is! Map) continue;
        if (c['op'] == 'segment' || c['op'] == 'not_segment') {
          final seg = segments is Map && c['value'] is String ? segments[c['value']] : null;
          if (seg is Map && depth < 4) visit(seg['conditions'], depth + 1);
        } else if (c['attribute'] is String && (c['attribute'] as String).isNotEmpty) {
          names.add(c['attribute'] as String);
        }
      }
    }

    if (flag is Map && flag['rules'] is List) {
      for (final r in flag['rules'] as List) {
        if (r is! Map) continue;
        visit(r['conditions'], 0);
        final serve = r['serve'];
        if (serve is Map && serve['type'] == 'rollout') names.add(serve['bucketBy'] is String ? serve['bucketBy'] as String : 'key');
      }
    }
    return cache[flagKey] = names.toList(growable: false);
  }

  Map<String, Object?> _defaultRedact(Map<String, Object?>? b, String flagKey, Map<String, Object?> ctx) => {
        for (final name in _attrsUsedBy(b, flagKey))
          if (ctx.containsKey(name)) name: typeName(ctx[name]),
      };

  void _record(Evaluation e, Map<String, Object?> ctx, Map<String, Object?>? b) {
    final ev = _options.events;
    if (!ev.enabled || _closed || ev.sampleRate <= 0 || _random.nextDouble() >= ev.sampleRate) return;
    if (_queue.length >= _maxQueue) return; // bounded: drop instead of growing
    try {
      final rate = ev.sampleRate > 1 ? 1.0 : ev.sampleRate;
      _queue.add(_QueuedEvent({
        'flagKey': e.flagKey,
        'value': e.value,
        'reason': e.reason,
        if (e.ruleIndex != null) 'ruleIndex': e.ruleIndex,
        'revision': e.revision,
        'context': ev.redact != null ? ev.redact!({...ctx}) : _defaultRedact(b, e.flagKey, ctx),
        'at': DateTime.now().toUtc().toIso8601String(),
        'sampleRate': rate,
      }));
    } catch (_) {
      // telemetry must never affect evaluation
    }
  }

  Future<void> _flush() async {
    if (!_options.events.enabled) return;
    // One request per interval: the service report plus up to one batch. Anything beyond that waits.
    final n = math.min(_queue.length, _maxBatch);
    final batch = [
      for (final q in _queue.take(n))
        () {
          final e = {...q.json};
          var value = e['value'];
          try {
            if ((value is Map || value is List) && (jsStringify(value)?.length ?? 0) > _maxEventValueChars) {
              value = null;
            } else if (value is String && value.length > _maxEventValueChars) {
              value = value.substring(0, _maxEventValueChars);
            }
          } catch (_) {
            value = null;
          }
          final key = e['flagKey'] as String;
          e['flagKey'] = key.length > 63 ? key.substring(0, 63) : key;
          e['value'] = value;
          return e;
        }(),
    ];
    _queue.removeRange(0, n);
    _lastReportAt = DateTime.now();
    final service = _options.service.length > 60 ? _options.service.substring(0, 60) : _options.service;
    try {
      final res = await _request('POST', '/v1/events',
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'service': service, 'sdk': 'dart/$sdkVersion', 'revision': revision ?? 0, 'events': batch}));
      if (res.statusCode >= 400 && res.statusCode != 429) {
        // dropped by design: telemetry is never retried
      }
    } catch (_) {
      // dropped on failure, by design: telemetry is never retried
    }
  }

  void _scheduleFlush() {
    final ev = _options.events;
    if (_closed || _paused || !ev.enabled || ev.flushInterval <= Duration.zero) return;
    _flushTimer?.cancel();
    _flushTimer = Timer(ev.flushInterval, () {
      _flushTimer = null;
      if (_paused || _closed) return;
      // Data saver: nothing is sent; the queue stays bounded.
      if (_dataSaver) return _scheduleFlush();
      // Nothing queued: the service report alone goes out once per report interval.
      if (_queue.isEmpty && DateTime.now().difference(_lastReportAt) < ev.reportInterval) return _scheduleFlush();
      unawaited(_flush().then((_) => _scheduleFlush()));
    });
  }

  /* ---------------- evaluation ---------------- */

  Evaluation _run(String key, Object? fallback, Map<String, Object?>? extra, bool Function(Object? v)? accepts) {
    final b = _bundle;
    final ctx = extra == null ? _context : {..._context, ..._normalizeContext(extra)};
    var result = engine.evaluate(b, key, ctx, fallback);
    if (accepts != null && result.reason != Reasons.flagNotFound && result.reason != Reasons.error && !accepts(result.value)) {
      final error = 'Flag "$key" has a ${typeName(result.value)} value, which does not match the requested type.';
      result = Evaluation(
          flagKey: key, value: fallback, reason: Reasons.error, revision: result.revision, trace: [...result.trace, TraceStep('result', 'Returned the fallback', error)], error: error);
    }
    _record(result, ctx, b);
    return result;
  }
}
