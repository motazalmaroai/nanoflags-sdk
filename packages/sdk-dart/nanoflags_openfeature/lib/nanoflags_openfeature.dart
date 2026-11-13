/// OpenFeature provider for NanoFlags (`openfeature_dart_client_sdk`, static-context paradigm).
///
/// ```dart
/// final provider = NanoFlagsOpenFeatureProvider(const NanoFlagsOptions(sdkKey: 'nf_pub_…'));
/// await OpenFeatureAPI.instance.setProviderAndWait(provider);
/// await OpenFeatureAPI.instance.setEvaluationContextAndWait(EvaluationContext(targetingKey: 'user-42', attributes: {'plan': 'pro'}));
/// final enabled = OpenFeatureAPI.instance.getClient().getBooleanValue('new-checkout', false);
/// ```
///
/// Mapping (as the JS, Go and Python providers): the OpenFeature targeting key becomes the NanoFlags
/// `key` (the bucketing identity) and wins over an attribute called "key"; reason off → DISABLED,
/// default → DEFAULT, a fixed-value rule → TARGETING_MATCH, a percentage rollout → SPLIT; the
/// variant is the matching rule's id (`default` / `off` otherwise); flag metadata carries the
/// revision. Missing flags are FLAG_NOT_FOUND (PROVIDER_NOT_READY while nothing is loaded), values of
/// another type TYPE_MISMATCH.
library;

import 'dart:async';
import 'dart:convert';

import 'package:nanoflags/nanoflags.dart';
import 'package:openfeature_dart_client_sdk/openfeature_dart_client_sdk.dart';

/// NanoFlags as an OpenFeature [FeatureProvider]. Evaluations are local and synchronous.
final class NanoFlagsOpenFeatureProvider
    implements FeatureProvider, InitializableProvider, ContextReconciliationProvider, ShutdownProvider, ProviderEventSource, DomainScopedProvider {
  /// Creates a client from [options] (closed on shutdown).
  NanoFlagsOpenFeatureProvider(NanoFlagsOptions options, {this.initTimeout = const Duration(seconds: 10)})
      : _options = options,
        _owned = true;

  /// Uses an existing [client] (left open on shutdown unless [closeClient]).
  NanoFlagsOpenFeatureProvider.withClient(NanoFlagsClient client, {this.initTimeout = const Duration(seconds: 10), bool closeClient = false})
      : _client = client,
        _options = null,
        _owned = closeClient;

  final NanoFlagsOptions? _options;
  final bool _owned;

  /// How long [initialize] waits for the first configuration.
  final Duration initTimeout;

  NanoFlagsClient? _client;
  final StreamController<ProviderEvent> _events = StreamController<ProviderEvent>.broadcast(sync: true);
  final List<StreamSubscription<Object?>> _subs = [];
  Map<String, Object?>? _last;
  NanoFlagsStatus? _lastStatus;

  /// The NanoFlags client behind this provider (null before [initialize] when created from options).
  NanoFlagsClient? get client => _client;

  @override
  ProviderMetadata get metadata => const ProviderMetadata(name: 'nanoflags');

  @override
  Stream<ProviderEvent> get events => _events.stream;

  static Map<String, Object?> contextOf(EvaluationContext ctx) => {
        ...ctx.attributes,
        if (ctx.targetingKey != null) 'key': ctx.targetingKey,
      };

  void _emit(ProviderEventType type, {String? message, ErrorCode? errorCode, Iterable<String> flagsChanged = const []}) {
    if (!_events.isClosed) _events.add(ProviderEvent(type: type, message: message, errorCode: errorCode, flagsChanged: flagsChanged));
  }

  static List<String> _changedFlags(Map<String, Object?>? before, Map<String, Object?>? after) {
    final a = (before?['flags'] as Map?) ?? const {};
    final b = (after?['flags'] as Map?) ?? const {};
    final keys = {...a.keys, ...b.keys}.map((k) => '$k').toList()..sort();
    return [for (final k in keys) if (jsonEncode(a[k]) != jsonEncode(b[k])) k];
  }

  @override
  Future<void> initialize(EvaluationContext context, {String? domain}) async {
    final options = _options;
    final client = _client ??= NanoFlagsClient(options!.copyWith(context: {...options.context, ...contextOf(context)}));
    if (options == null) client.setContext({...client.context, ...contextOf(context)});
    _last = client.bundle == null ? null : {...client.bundle!};
    _lastStatus = client.status;
    _subs.add(client.updates.listen((e) {
      final prev = _last;
      _last = client.bundle == null ? null : {...client.bundle!};
      if (prev != null) _emit(ProviderEventType.configurationChanged, message: 'Revision ${e.revision} is now in use.', flagsChanged: _changedFlags(prev, _last));
    }));
    _subs.add(client.changes.listen((_) {
      final s = client.status;
      if (s == _lastStatus) return;
      _lastStatus = s;
      if (s == NanoFlagsStatus.ready) _emit(ProviderEventType.ready, message: 'The configuration is current.');
      if (s == NanoFlagsStatus.stale) _emit(ProviderEventType.stale, message: 'The configuration in use is not known to be current.');
    }));
    await client.ready(timeout: initTimeout);
    _lastStatus = client.status;
    // The terminal lifecycle event of initialization.
    switch (client.status) {
      case NanoFlagsStatus.ready:
        _emit(ProviderEventType.ready, message: 'Revision ${client.revision} loaded.');
      case NanoFlagsStatus.stale:
        _emit(ProviderEventType.ready, message: 'Revision ${client.revision} loaded from the device; not yet confirmed by the edge.');
        _emit(ProviderEventType.stale, message: 'The configuration in use is not known to be current.');
      case NanoFlagsStatus.notReady:
        _emit(ProviderEventType.error, message: 'No configuration could be loaded yet.', errorCode: ErrorCode.providerNotReady);
    }
  }

  @override
  Future<void> onContextChanged(EvaluationContext previousContext, EvaluationContext newContext) async {
    // Local only: evaluation is synchronous against the bundle in memory, so nothing is fetched.
    final client = _client;
    if (client != null) {
      final next = {...client.context};
      for (final k in contextOf(previousContext).keys) {
        next.remove(k);
      }
      client.setContext({...next, ...contextOf(newContext)});
    }
    _emit(ProviderEventType.contextChanged, message: 'Context applied locally.');
  }

  @override
  Future<void> shutdown() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    if (_owned) await _client?.close();
    await _events.close();
  }

  @override
  ResolutionDetails<bool> resolveBooleanValue(String flagKey, bool defaultValue, EvaluationContext context) =>
      _resolve(flagKey, defaultValue, context, (v) => v is bool ? v : null);

  @override
  ResolutionDetails<String> resolveStringValue(String flagKey, String defaultValue, EvaluationContext context) =>
      _resolve(flagKey, defaultValue, context, (v) => v is String ? v : null);

  @override
  ResolutionDetails<int> resolveIntegerValue(String flagKey, int defaultValue, EvaluationContext context) =>
      _resolve(flagKey, defaultValue, context, (v) => v is num && v.isFinite && v == v.truncate() ? v.toInt() : null);

  @override
  ResolutionDetails<double> resolveDoubleValue(String flagKey, double defaultValue, EvaluationContext context) =>
      _resolve(flagKey, defaultValue, context, (v) => v is num && v.isFinite ? v.toDouble() : null);

  @override
  ResolutionDetails<Map<String, Object?>> resolveStructureValue(String flagKey, Map<String, Object?> defaultValue, EvaluationContext context) =>
      _resolve(flagKey, defaultValue, context, (v) => v is Map ? v.cast<String, Object?>() : null);

  ResolutionDetails<T> _resolve<T>(String flagKey, T defaultValue, EvaluationContext context, T? Function(Object? v) convert) {
    final client = _client;
    if (client == null || client.revision == null) {
      return ResolutionDetails<T>(value: defaultValue, reason: 'ERROR', errorCode: ErrorCode.providerNotReady, errorMessage: 'No configuration is loaded yet.');
    }
    // The static context was applied with onContextChanged; the resolver's context is the same one.
    final e = client.evaluate(flagKey, null, context: contextOf(context));
    final metadata = <String, Object>{'revision': client.revision!};
    switch (e.reason) {
      case Reasons.flagNotFound:
        return ResolutionDetails<T>(value: defaultValue, reason: 'ERROR', errorCode: ErrorCode.flagNotFound, errorMessage: 'Flag "$flagKey" is not in this configuration.', flagMetadata: metadata);
      case Reasons.error:
        return ResolutionDetails<T>(value: defaultValue, reason: 'ERROR', errorCode: ErrorCode.general, errorMessage: e.error ?? 'Evaluation error.', flagMetadata: metadata);
    }
    final value = convert(e.value);
    if (value == null) {
      return ResolutionDetails<T>(
          value: defaultValue,
          reason: 'ERROR',
          errorCode: ErrorCode.typeMismatch,
          errorMessage: 'Flag "$flagKey" has a ${e.value == null ? 'null' : e.value.runtimeType} value, which does not match the requested type.',
          flagMetadata: metadata);
    }
    if (e.ruleIndex != null) metadata['ruleIndex'] = e.ruleIndex!;
    if (e.ruleId is String) metadata['ruleId'] = e.ruleId as String;
    if (e.inRollout != null) metadata['inRollout'] = e.inRollout!;
    final (reason, variant) = switch (e.reason) {
      Reasons.off => ('DISABLED', 'off'),
      Reasons.ruleMatch => (e.inRollout != null ? 'SPLIT' : 'TARGETING_MATCH', e.ruleId is String ? e.ruleId as String : 'rule-${e.ruleIndex}'),
      _ => ('DEFAULT', 'default'),
    };
    return ResolutionDetails<T>(value: value, reason: reason, variant: variant, flagMetadata: metadata);
  }
}
