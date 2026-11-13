import 'engine/engine.dart';
import 'store.dart';
import 'keys.dart';

/// Version of this SDK (sent as `sdk: "dart/<version>"` with telemetry and in the User-Agent).
const String sdkVersion = '0.1.0';

/// WebSocket close code of the edge for an environment that was deleted: the SDK stops reconnecting.
const int closeEnvironmentDeleted = 4004;

/// WebSocket subprotocol of `/v1/live`.
const String liveProtocol = 'nanoflags.v1';

/// Whether the configuration in use is known to be current.
enum NanoFlagsStatus {
  /// No configuration yet: every accessor returns its fallback.
  notReady,

  /// The configuration is current (confirmed by the edge).
  ready,

  /// A usable configuration that is not known to be current (restored from storage, offline,
  /// served stale by the edge, or the environment was deleted).
  stale,
}

/// How updates currently reach the client.
enum NanoFlagsTransport {
  /// Pushed over the live WebSocket (`/v1/live`): the signed bundle arrives with the message.
  live,

  /// Announced over server-sent events (`/v1/stream`), then fetched.
  stream,

  /// Polled (`/v1/bundle` with ETag).
  poll,

  /// Paused: the app is in the background (or [NanoFlagsClient.pause] was called).
  paused,
}

/// What kind of problem an [NanoFlagsException] reports.
enum NanoFlagsErrorCode { network, unauthorized, http, invalidBundle, store, config, signature, engine, environmentDeleted }

/// Errors are reported on [NanoFlagsClient.errors]; accessors never throw.
final class NanoFlagsException implements Exception {
  const NanoFlagsException(this.message, this.code, [this.httpStatus]);
  final String message;
  final NanoFlagsErrorCode code;
  final int? httpStatus;
  @override
  String toString() => 'NanoFlagsException(${code.name}${httpStatus == null ? '' : ', HTTP $httpStatus'}): $message';
}

/// Where a configuration came from.
enum UpdateSource { network, store, bootstrap }

/// Emitted on [NanoFlagsClient.updates] whenever a different configuration is adopted.
final class UpdateEvent {
  const UpdateEvent({required this.revision, required this.previousRevision, required this.checksum, required this.source, required this.transport, required this.latency});
  final int revision;
  final int? previousRevision;
  final String? checksum;
  final UpdateSource source;

  /// How the bundle arrived (`live`, `stream`, or `poll` for anything else).
  final NanoFlagsTransport transport;

  /// Commit in the database → this event, for revisions pushed over the live socket with a commit
  /// time; otherwise null. Compares the database's clock with this device's clock.
  final Duration? latency;

  @override
  String toString() => 'UpdateEvent(r$revision from ${previousRevision == null ? 'none' : 'r$previousRevision'}, ${source.name}/${transport.name}'
      '${latency == null ? '' : ', ${latency!.inMilliseconds} ms'})';
}

/// Typed result of a `*VariationDetail` accessor.
final class EvaluationDetail<T> {
  const EvaluationDetail({required this.flagKey, required this.value, required this.reason, required this.revision, this.ruleIndex, this.ruleId, this.inRollout, this.bucket, this.error, this.trace = const []});

  /// Builds a detail from an engine [Evaluation] whose value already has type [T].
  factory EvaluationDetail.fromEvaluation(Evaluation e, T value) => EvaluationDetail<T>(
        flagKey: e.flagKey,
        value: value,
        reason: e.reason,
        revision: e.revision is int ? e.revision as int : 0,
        ruleIndex: e.ruleIndex,
        ruleId: e.ruleId is String ? e.ruleId as String : null,
        inRollout: e.inRollout,
        bucket: e.bucket,
        error: e.error,
        trace: e.trace,
      );

  final String flagKey;
  final T value;

  /// `rule_match`, `default`, `off`, `flag_not_found` or `error` (see [Reasons]).
  final String reason;
  final int revision;
  final int? ruleIndex;
  final String? ruleId;
  final bool? inRollout;
  final double? bucket;

  /// Why the fallback was served (reason `error`: evaluation error or wrong type).
  final String? error;
  final List<TraceStep> trace;

  @override
  String toString() => 'EvaluationDetail($flagKey = $value, $reason, r$revision${ruleId == null ? '' : ', rule $ruleId'}${error == null ? '' : ', $error'})';
}

/// Signature verification settings.
final class VerifyOptions {
  /// Default: with the official edge, verify against the embedded keys ([officialSigningKeys], plus
  /// `GET /v1/keys` once when a bundle names an unknown key id) and refuse unsigned bundles.
  /// With another `baseUrl`, keys come from that edge's `/v1/keys` and unsigned bundles are accepted.
  const VerifyOptions({this.publicKeys, this.fetchKeys = false, this.require}) : _off = false;

  /// Verification switched off (not recommended; only for self-hosted edges without signing).
  const VerifyOptions.off()
      : publicKeys = null,
        fetchKeys = false,
        require = false,
        _off = true;

  /// Public Ed25519 JWKs (`{kty: OKP, crv: Ed25519, x, kid}`) to verify with. Pinning keys in the
  /// app is stronger than fetching them.
  final List<Map<String, Object?>>? publicKeys;

  /// Load keys from `GET /v1/keys` of the configured edge (implied when [publicKeys] is null and the
  /// edge is not the official one).
  final bool fetchKeys;

  /// Refuse bundles the edge marks as unsigned. Default: true for the official edge.
  final bool? require;
  final bool _off;

  bool get isOff => _off;
}

/// Telemetry settings: a periodic service report ("this app runs revision N") and sampled
/// evaluation events that carry attribute NAMES and types only, never values.
final class EventsOptions {
  const EventsOptions({this.enabled = true, this.sampleRate = 0.1, this.flushInterval = const Duration(seconds: 30), this.reportInterval = const Duration(minutes: 5), this.redact});

  /// Telemetry switched off entirely (nothing is sent to `/v1/events`).
  const EventsOptions.off()
      : enabled = false,
        sampleRate = 0,
        flushInterval = const Duration(seconds: 30),
        reportInterval = const Duration(minutes: 5),
        redact = null;

  final bool enabled;

  /// Fraction of evaluations reported, 0–1.
  final double sampleRate;

  /// How often queued events are sent (mobile default 30 s; the JS SDK uses 10 s).
  final Duration flushInterval;

  /// While nothing is queued, the service report goes out this often (mobile default 5 min).
  final Duration reportInterval;

  /// Decides what part of the context leaves the device with a sampled event. Default: the names of
  /// the attributes the flag's rules reference and that were present, mapped to the value's type
  /// (e.g. `{"plan": "string"}`) — never values.
  final Map<String, Object?> Function(Map<String, Object?> context)? redact;
}

/// Configuration of a [NanoFlagsClient]. See the README for the defaults.
final class NanoFlagsOptions {
  const NanoFlagsOptions({
    required this.sdkKey,
    this.baseUrl = officialEdgeUrl,
    this.context = const {},
    this.service = 'unknown',
    this.pollInterval = const Duration(seconds: 60),
    this.livePollInterval = const Duration(minutes: 5),
    this.streaming = true,
    this.live = true,
    this.bootstrap,
    this.store,
    this.events = const EventsOptions(),
    this.verify = const VerifyOptions(),
    this.dataSaver = false,
    this.dataSaverPollInterval = const Duration(minutes: 15),
    this.userAgent,
  });

  /// A client (browser / mobile) key, `nf_pub_…`. Server keys are refused: they would expose
  /// server-only flags and segments to anyone who unpacks the app.
  final String sdkKey;

  /// Base URL of the NanoFlags edge.
  final String baseUrl;

  /// Initial evaluation context (`key` is the identity used for percentage rollouts).
  final Map<String, Object?> context;

  /// Name shown in "which revision is this app running" (e.g. `ios-app`).
  final String service;

  /// Poll interval while no live socket is open. `Duration.zero` disables polling.
  final Duration pollInterval;

  /// Safety-poll interval while the live socket is healthy.
  final Duration livePollInterval;

  /// Receive updates without polling (live WebSocket, else SSE). `false` polls only.
  final bool streaming;

  /// Use the live WebSocket (`/v1/live`). `false`: SSE + polling.
  final bool live;

  /// A bundle obtained elsewhere (shipped with the app): a decoded map or its JSON text. Used until
  /// something newer arrives; it is trusted as given (not signature-checked).
  final Object? bootstrap;

  /// Persistence of the last verified bundle. Null: none (the Flutter package defaults to
  /// `SharedPreferencesStore`).
  final NanoFlagsStore? store;
  final EventsOptions events;
  final VerifyOptions verify;

  /// Start in data-saver mode (metered / low-data network): see [NanoFlagsClient.setDataSaver].
  final bool dataSaver;

  /// Poll interval in data-saver mode (no socket, no stream).
  final Duration dataSaverPollInterval;

  /// Appended to the SDK's User-Agent (`nanoflags-dart/0.1.0 (<platform>)`) on native platforms.
  final String? userAgent;

  /// A copy with the given members replaced.
  NanoFlagsOptions copyWith({
    String? sdkKey,
    String? baseUrl,
    Map<String, Object?>? context,
    String? service,
    Duration? pollInterval,
    Duration? livePollInterval,
    bool? streaming,
    bool? live,
    Object? bootstrap,
    NanoFlagsStore? store,
    EventsOptions? events,
    VerifyOptions? verify,
    bool? dataSaver,
    Duration? dataSaverPollInterval,
    String? userAgent,
  }) =>
      NanoFlagsOptions(
        sdkKey: sdkKey ?? this.sdkKey,
        baseUrl: baseUrl ?? this.baseUrl,
        context: context ?? this.context,
        service: service ?? this.service,
        pollInterval: pollInterval ?? this.pollInterval,
        livePollInterval: livePollInterval ?? this.livePollInterval,
        streaming: streaming ?? this.streaming,
        live: live ?? this.live,
        bootstrap: bootstrap ?? this.bootstrap,
        store: store ?? this.store,
        events: events ?? this.events,
        verify: verify ?? this.verify,
        dataSaver: dataSaver ?? this.dataSaver,
        dataSaverPollInterval: dataSaverPollInterval ?? this.dataSaverPollInterval,
        userAgent: userAgent ?? this.userAgent,
      );
}
