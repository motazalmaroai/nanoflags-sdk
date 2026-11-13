# Changelog

## 0.1.0 — unreleased

First release of the Android / Kotlin SDK.

- `nanoflags-core`: engine port of `@nanoflags/engine` (engine version 1) passing all 21,998 shared parity cases,
  the murmur3 / bucket / `supportsEngine` / browser-view vectors and the Go port's 3,491 extra cases (V8 error messages
  included); client keys only; typed variations with details, `allFlags`, runtime context (`identify`); Ed25519
  verification by key id with the embedded production keys and a rate-limited `/v1/keys` reload; live WebSocket with
  SSE and ETag polling fallbacks, jittered backoff, ping/pong, ~50 min rotation, close code 4004; persistence with
  re-verification, bootstrap; coroutines / Flow API; telemetry (attribute names and types only), opt-out.
- `nanoflags-android`: `ProcessLifecycleOwner` (pause in the background, refresh in the foreground),
  `ConnectivityManager` (offline, metered, Data Saver policies), storage in `noBackupFilesDir`, Compose helpers
  (`rememberFlag`, `ProvideNanoFlags`, `collectStatusAsState`). minSdk 21.
- `nanoflags-openfeature`: provider for `dev.openfeature:kotlin-sdk` 0.9.0.
