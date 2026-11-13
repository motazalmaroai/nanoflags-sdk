# Changelog

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
