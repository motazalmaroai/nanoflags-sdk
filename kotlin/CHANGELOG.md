# Changelog

## 0.3.2 (2026-11-27)

- Verification hardening, no API change (refuses older signed revisions, reports rejected updates as stale)

## 0.3.1 — 2026-11-21

Security fix to the integrity of shadow reports; served flag values are not affected (shadow bundles are
never applied as configuration).

- A shadow bundle is only used once the environment of a verified live bundle is known, and only when it was signed
  for that environment. Before, a shadow bundle checked while no environment was pinned yet (the shadow fetch starts
  with the /v1/bundle answer and could finish before that answer's verification, or the answer failed verification)
  was not bound to an environment, so one validly signed for another environment of the same project could feed the
  shadow counters reported for change approvals. Without signature verification configured, nothing changes.

## 0.3.0 — 2026-11-21

Additive, no breaking changes. Applies to `nanoflags-core` and therefore `nanoflags-android` and `nanoflags-openfeature`.

- New condition operators: `semver_eq`, `semver_neq`, `semver_gt`, `semver_gte`, `semver_lt`, `semver_lte` compare
  semantic versions (SemVer 2.0 precedence: `4.10.0` > `4.9.0`, `1.0.0-alpha` < `1.0.0-alpha.1` < `1.0.0-beta` <
  `1.0.0-rc.1` < `1.0.0`, build metadata ignored; leniently, a leading `v` is allowed, missing minor / patch are 0 so
  `4.10` = `4.10.0`, and leading zeros are ignored); `before` / `after` compare points in time (`YYYY-MM-DD` as
  00:00 UTC, RFC 3339 timestamps with `Z` or an offset, or Unix time: seconds below 1e12, milliseconds from 1e12).
  A value that cannot be read on either side makes the condition false; evaluation never throws.
- `gt` / `gte` / `lt` / `lte` are unchanged (numeric), so existing rules evaluate exactly as before.
- Verified against the shared conformance vectors (`packages/engine/fixtures/operators.json`, embedded in
  `parity.json`) that every NanoFlags SDK passes. No bundle-format change (`engine` stays 1).
- Earlier releases evaluate conditions with these operators as not matching (they never fail on them): upgrade before
  publishing rules that use them.

## 0.2.0 — 2026-11-20

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

## 0.1.0 — 2026-11-14

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
