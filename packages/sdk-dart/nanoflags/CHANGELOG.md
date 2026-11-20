# Changelog

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
