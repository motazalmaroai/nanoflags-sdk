# nanoflags_openfeature

[OpenFeature](https://openfeature.dev) provider for NanoFlags, for the official OpenFeature Dart
client SDK [`openfeature_dart_client_sdk`](https://pub.dev/packages/openfeature_dart_client_sdk)
(publisher `openfeature.dev`, static-context paradigm, Dart ≥ 3.10). Evaluation is local and
synchronous through the [`nanoflags`](../nanoflags) SDK.

```dart
import 'package:nanoflags/nanoflags.dart';
import 'package:nanoflags_openfeature/nanoflags_openfeature.dart';
import 'package:openfeature_dart_client_sdk/openfeature_dart_client_sdk.dart';

final provider = NanoFlagsOpenFeatureProvider(const NanoFlagsOptions(sdkKey: 'nf_pub_…', service: 'android-app'));
await OpenFeatureAPI.instance.setProviderAndWait(provider);
await OpenFeatureAPI.instance.setEvaluationContextAndWait(
  EvaluationContext(targetingKey: 'user-42', attributes: {'plan': 'pro'}),
);
final enabled = OpenFeatureAPI.instance.getClient().getBooleanValue('new-checkout', false);
```

Or wrap an existing client: `NanoFlagsOpenFeatureProvider.withClient(client)`.

Mapping (same as the JS, Go and Python providers): the targeting key becomes the NanoFlags `key`
(bucketing identity) and wins over an attribute named `key`. Reasons: off → `DISABLED`, default →
`DEFAULT`, fixed-value rule → `TARGETING_MATCH`, percentage rollout → `SPLIT`. Variant: the rule id
(`default` / `off` otherwise). Metadata: `revision`, `ruleIndex`, `ruleId`, `inRollout`. Errors:
`PROVIDER_NOT_READY` (nothing loaded yet), `FLAG_NOT_FOUND`, `TYPE_MISMATCH` (also a fractional value
for an integer request), `GENERAL`. Events: `ready`, `stale`, `error` (nothing could be loaded),
`configurationChanged` with the changed flag keys, `contextChanged` (context changes are applied
locally, no network round trip).

Apache-2.0.
