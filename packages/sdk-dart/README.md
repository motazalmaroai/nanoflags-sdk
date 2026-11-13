# NanoFlags Dart / Flutter SDK

| Package | What | Platforms |
| --- | --- | --- |
| [`nanoflags`](nanoflags) | Engine port, signature verification, transports (live WebSocket → SSE → polling), client | Dart VM, Flutter (Android, iOS, desktop), web (dart2js, Wasm) |
| [`nanoflags_flutter`](nanoflags_flutter) | `NanoFlagsProvider`, `FlagBuilder`, lifecycle, `SharedPreferencesStore`; example app + device test | Flutter |
| [`nanoflags_openfeature`](nanoflags_openfeature) | Provider for the official `openfeature_dart_client_sdk` | Dart ≥ 3.10, Flutter |

Client (`nf_pub_…`) keys only. Quickstarts are in each package's README; publishing in
[PUBLISHING.md](PUBLISHING.md); device CI in [ci/mobile-flutter.yml](ci/mobile-flutter.yml).

```
cd nanoflags && dart pub get && dart test                 # parity suite + unit tests (fake signing edge)
dart test -p node test/web_parity_test.dart               # parity compiled to JavaScript
cd ../nanoflags_openfeature && dart pub get && dart test
cd ../nanoflags_flutter && flutter pub get && flutter analyze && flutter test
```
