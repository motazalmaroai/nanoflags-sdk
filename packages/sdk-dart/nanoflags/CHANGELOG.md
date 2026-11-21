# Changelog

## 0.3.0 (unreleased)

Additive, no breaking changes. Unreleased: TODO release date.

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

## 0.2.0

- Shadow evaluation of drafts (same rules and wire format as `@nanoflags/sdk` 0.7.1): while a change waits for
  approval in an environment with shadow evaluation on, the client loads the signed shadow bundle announced by
  `X-NanoFlags-Shadow` (`GET /v1/shadow`, Ed25519 over `nanoflags-shadow-v1`, marker checked), evaluates the draft
  for a sample of the evaluations of the flags it changes (`ShadowOptions(sampleRate:)`, default 0.1) and reports
  bounded counters only with the events report, at most once a minute (always on `flush()`, `pause()` and
  `close()`). The app always gets the live value; any bundle with a `shadow` member is refused as configuration
  (HTTP, push, store, bootstrap). New options `shadow` (`ShadowOptions`, `ShadowOptions.off()`) and
  `serviceVersion`; new error code `NanoFlagsErrorCode.shadow`. Off with `ShadowOptions.off()` or
  `EventsOptions.off()`. Not published yet.
- Shadow reports always pass the edge's validation of `POST /v1/events`: flag keys over 63 characters (UTF-16
  code units) are not counted and a flag's counters stop at 10^7 samples until the next report.

## 0.1.1

- An error emitted while nothing listens on `client.errors` is printed once per error code (prefixed `[nanoflags]`)
  instead of being dropped silently. Listening on `client.errors` turns this off.

## 0.1.0

First release.

- Dart port of the NanoFlags engine (engine version 1), identical to the TypeScript engine on all
  21 998 shared parity cases (Dart VM and dart2js) plus the Go port's 3 491 corner cases.
- `NanoFlagsClient` for client (`nf_pub_`) keys: typed variations and details, `allFlags`,
  `identify` / `setContext` / `updateContext` without a network round trip.
- Ed25519 bundle verification against the embedded official keys (kid `k1`), unsigned bundles refused
  on the official edge, `/v1/keys` reload on an unknown kid (at most once a minute), stored bundles
  re-verified on load.
- Live WebSocket transport (`/v1/live`) with SSE and ETag polling fallbacks, jittered backoff, ping /
  pong, ~50 min socket rotation, close code 4004 handling.
- Mobile lifecycle: `pause` / `resume`, offline-first persistence (`NanoFlagsStore`, `MemoryStore`,
  `FileStore`), bootstrap bundles, data-saver mode.
- Telemetry (service report + sampled events with attribute names and types only), opt-out.
