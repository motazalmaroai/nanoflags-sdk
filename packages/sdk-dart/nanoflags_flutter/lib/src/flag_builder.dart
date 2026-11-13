import 'package:flutter/widgets.dart';
import 'package:nanoflags/nanoflags.dart';

import 'provider.dart';

/// Builds a widget from one flag's value and rebuilds when it can have changed.
///
/// The accessor follows the type of [fallback]: `bool`, `String`, `int` / `double` / `num`, or any
/// other JSON value. A value of another type (or a missing flag, or no configuration yet) yields
/// [fallback].
///
/// ```dart
/// FlagBuilder<bool>(
///   flagKey: 'new-checkout',
///   fallback: false,
///   builder: (context, enabled) => enabled ? const NewCheckout() : const OldCheckout(),
/// )
/// ```
class FlagBuilder<T> extends StatelessWidget {
  const FlagBuilder({super.key, required this.flagKey, required this.fallback, required this.builder, this.context});

  final String flagKey;
  final T fallback;
  final Widget Function(BuildContext context, T value) builder;

  /// Attributes merged over the client's context for this evaluation only.
  final Map<String, Object?>? context;

  @override
  Widget build(BuildContext context) => builder(context, flagValue<T>(NanoFlagsProvider.of(context), flagKey, fallback, this.context));
}

/// Like [FlagBuilder], with the full [EvaluationDetail] (reason, matched rule, revision).
class FlagDetailBuilder<T> extends StatelessWidget {
  const FlagDetailBuilder({super.key, required this.flagKey, required this.fallback, required this.builder, this.context});

  final String flagKey;
  final T fallback;
  final Widget Function(BuildContext context, EvaluationDetail<T> detail) builder;
  final Map<String, Object?>? context;

  @override
  Widget build(BuildContext context) => builder(context, flagDetail<T>(NanoFlagsProvider.of(context), flagKey, fallback, this.context));
}

/// The value of [key] typed after [fallback] (see [FlagBuilder]).
T flagValue<T>(NanoFlagsClient client, String key, T fallback, [Map<String, Object?>? context]) => flagDetail<T>(client, key, fallback, context).value;

/// The detail of [key] typed after [fallback] (see [FlagBuilder]).
EvaluationDetail<T> flagDetail<T>(NanoFlagsClient client, String key, T fallback, [Map<String, Object?>? context]) {
  final Object? f = fallback;
  if (f is bool) return _retype(client.boolVariationDetail(key, f, context: context), fallback);
  if (f is String) return _retype(client.stringVariationDetail(key, f, context: context), fallback);
  if (f is int) {
    final d = client.numberVariationDetail(key, f, context: context);
    final v = d.value;
    // JSON has one number type: whole doubles become ints; fractions do not fit an int flag.
    final asInt = v is int ? v : (v.toDouble() == v.toDouble().truncateToDouble() ? v.toInt() : null);
    if (asInt == null) return _withValue(d, fallback, 'Flag "$key" has a fractional value; an int was requested.');
    return _withValue(d, asInt as T, null);
  }
  if (f is double) {
    final d = client.numberVariationDetail(key, f, context: context);
    return _withValue(d, d.value.toDouble() as T, null);
  }
  if (f is num) return _retype(client.numberVariationDetail(key, f, context: context), fallback);
  final d = client.jsonVariationDetail(key, f, context: context);
  final v = d.value;
  if (v is T) return _withValue(d, v, null);
  return _withValue(d, fallback, 'Flag "$key" has a value of another type than ${T.toString()}.');
}

EvaluationDetail<T> _retype<T, S>(EvaluationDetail<S> d, T fallback) {
  final v = d.value;
  return v is T ? _withValue(d, v as T, null) : _withValue(d, fallback, 'Flag "${d.flagKey}" does not match ${T.toString()}.');
}

EvaluationDetail<T> _withValue<T>(EvaluationDetail<Object?> d, T value, String? error) => EvaluationDetail<T>(
      flagKey: d.flagKey,
      value: value,
      reason: error == null ? d.reason : Reasons.error,
      revision: d.revision,
      ruleIndex: error == null ? d.ruleIndex : null,
      ruleId: error == null ? d.ruleId : null,
      inRollout: error == null ? d.inRollout : null,
      bucket: error == null ? d.bucket : null,
      error: error ?? d.error,
      trace: d.trace,
    );
