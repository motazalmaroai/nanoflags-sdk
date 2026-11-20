# Changelog

## 0.2.0 — unreleased

- Shadow evaluation of drafts (same rules and wire format as `@nanoflags/sdk` 0.7.1): while a change waits for
  approval in an environment with shadow evaluation on, the client fetches the signed shadow bundle announced by
  `X-NanoFlags-Shadow` (`GET /v1/shadow`, Ed25519 over `nanoflags-shadow-v1`, marker checked), evaluates the draft for
  a sample of the evaluations of the flags it changes (`shadow { sampleRate }`, default 0.1) and reports bounded
  counters only with the events report, at most once a minute (always on `flush()`, background and `close()`). The
  app always gets the live value; any bundle with a `shadow` member is refused as configuration (HTTP, push, store,
  bootstrap). New options `shadow { enabled, sampleRate }` and `serviceVersion` (Android default: the app's
  `versionName`); new error code `ErrorCode.SHADOW`. Off with `shadow { enabled = false }` or `events { enabled = false }`.
- Shadow reports always pass the edge's validation of `POST /v1/events`: flag keys over 63 characters (UTF-16
  code units) are not counted and a flag's counters stop at 10^7 samples until the next report.

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
