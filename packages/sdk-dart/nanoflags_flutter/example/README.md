# nanoflags_example

The public NanoFlags live demo in Flutter: the screen colour follows the `demo-accent` flag and
changes within a fraction of a second when the flag is toggled (pushed over the live WebSocket).

```
flutter run --dart-define=NANOFLAGS_SDK_KEY=<public demo browser key>
flutter test integration_test --dart-define=NANOFLAGS_SDK_KEY=<public demo browser key>
```

The integration test toggles `demo-accent` through `POST https://edge.nanoflags.io/v1/demo/toggle`
(public, rate limited), asserts the widget updates live, and restores the original value. CI:
`../../ci/mobile-flutter.yml` (Android emulator API 34 and iOS simulator).
