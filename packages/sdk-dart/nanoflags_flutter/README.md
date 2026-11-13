# nanoflags_flutter

Flutter bindings for [NanoFlags](https://nanoflags.io) feature flags, on top of the
[`nanoflags`](../nanoflags) Dart SDK (re-exported):

- `NanoFlagsProvider` — an `InheritedWidget`-based provider that rebuilds dependents when a flag can
  have changed (new configuration, status or context).
- `FlagBuilder<T>` / `FlagDetailBuilder<T>` — build from one flag's value (accessor chosen by the type
  of the fallback: `bool`, `String`, `int`, `double`, `num`, or any JSON value).
- App lifecycle through `WidgetsBindingObserver`: in the background (`hidden` / `paused` / `detached`)
  the live connection is closed and polling stops; on `resumed` the client reconnects and revalidates.
  `inactive` (dialogs, app switcher, calls) keeps the connection.
- `SharedPreferencesStore` — the last verified bundle on the device (re-verified at startup), so the
  app starts with the right flags offline.

## Install

```yaml
dependencies:
  nanoflags_flutter: ^0.1.0
```

## Quickstart

```dart
import 'package:flutter/material.dart';
import 'package:nanoflags_flutter/nanoflags_flutter.dart';

void main() {
  runApp(NanoFlagsProvider.create(
    options: const NanoFlagsOptions(
      sdkKey: 'nf_pub_…', // a client key; server keys are refused
      service: 'ios-app',
      context: {'key': 'anonymous-device-id'},
    ),
    child: const MyApp(),
  ));
}

class CheckoutButton extends StatelessWidget {
  const CheckoutButton({super.key});

  @override
  Widget build(BuildContext context) => FlagBuilder<bool>(
        flagKey: 'new-checkout',
        fallback: false,
        builder: (context, enabled) => enabled ? const NewCheckout() : const OldCheckout(),
      );
}

// After sign-in (local, no network round trip):
NanoFlagsProvider.read(context)!.identify(user.id, {'plan': user.plan});

// Anywhere in build methods (rebuilds on changes):
final accent = context.nanoFlags.stringVariation('accent', 'blue');
```

`NanoFlagsProvider(client: …)` provides a client you created yourself (it is not closed by the
provider); `NanoFlagsProvider.create(options: …)` owns its client and persists with
`SharedPreferencesStore` unless `options.store` is set. Pass `handleLifecycle: false` to drive
`pause()` / `resume()` yourself.

**Metered networks.** Flutter exposes no portable "metered / low-data" signal, so the SDK offers
`client.setDataSaver(true)` (no socket, no stream, polling every 15 min, telemetry held back) and
leaves the decision to the app (e.g. Android `ConnectivityManager.isActiveNetworkMetered`, iOS
`NWPath.isConstrained` through a platform channel, or a user setting).

## Example and device test

`example/` is a small app on the public live demo, with `integration_test/live_demo_test.dart`
(loads the demo flags, toggles `demo-accent` through the public demo endpoint, asserts the widget
updates live, restores the value):

```
cd example
flutter run --dart-define=NANOFLAGS_SDK_KEY=nf_pub_…
flutter test integration_test --dart-define=NANOFLAGS_SDK_KEY=nf_pub_…
```

## License

Apache-2.0 (see LICENSE and NOTICE).
