# Changelog

## 0.4.0 (unreleased)

Built on the `@nanoflags/sdk` 0.8.0 core (compiled into this package). Additive, no breaking changes. Unreleased: TODO release date.

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

## 0.3.0 (2026-11-20)

Built on the `@nanoflags/sdk` 0.7.1 core (compiled into this package).

- **Shadow evaluation of drafts is on by default when `events` is on.** In an environment where an owner or admin turned
  shadow evaluation on, while a change waits for approval, the app loads the change's signed draft (browser view:
  client-exposed flags only) and, for a sample of evaluations of the flags it changes (default 0.1), evaluates the draft
  too and sends aggregate counters only with the telemetry report. The app always gets the live value; the draft is never
  applied; no context, attribute, identifier or fallback value is sent. Reports from client keys count only for
  client-exposed flags and are shown apart from server reports. **To turn it off, pass `shadow: false`** (or
  `events: false`, which turns all telemetry off). New options: `shadow` (`{ enabled?, sampleRate? }` or `false`) and
  `serviceVersion` (labels the reports).
- New `verifyLog` option: every update is checked against the environment's transparency log; a failure emits `error`
  with code `log` and keeps the configuration in use.
- New `coSignerKeys` and `allowEmergencyWithoutCosign` options: updates must carry a valid customer co-signature (error
  code `cosign`); kill-switch revisions that only turn flags off are accepted without it unless
  `allowEmergencyWithoutCosign: false`.
- The `experiments` option is now passed through (0.2.0 described `experiments: { enabled: true }` but did not accept it).
- `ExperimentsOptions` and `ShadowOptions` types are exported.

## 0.2.0 — 2026-11-18

- Experiments (from the core): exposures of flags with a running experiment are logged automatically, and
  `track(eventName, value?, ctx?)` records metric events; the identified context supplies the unit. Only SHA-256 unit
  hashes leave the device.
- `events: false` also turns exposures and `track()` off unless `experiments: { enabled: true }` is set.

## 0.1.0 — 2026-11-14

First release of `@nanoflags/react-native`.

- `createClient()` for React Native and Expo, built on the `@nanoflags/sdk` core (same evaluation engine, same
  verification and transports; compiled into this package): local, synchronous evaluation; `boolean` / `string` /
  `number` / `json`, `detail()` (value + reason + matched rule), `allFlags()`; a current context that `identify()`
  replaces without any request.
- Client (`nf_pub_`) keys only; server keys are refused before any request.
- Signed bundles verified by default against the embedded production keys of `https://edge.nanoflags.io`, with pure-JS
  SHA-256 / Ed25519 (`@noble/hashes` 2.4.0, `@noble/ed25519` 3.2.0, bundled) since Hermes has no WebCrypto; unknown
  key ids reload `/v1/keys` at most once a minute; an injectable `crypto`.
- Live updates over React Native's WebSocket (with a `User-Agent` header; key in the subprotocol list), SSE over
  `XMLHttpRequest`, then ETag polling; jittered reconnects; close code 4004 stops reconnecting and keeps the last
  configuration (`stale`).
- App lifecycle: the connection is paused in the background and revalidated on foreground (`AppState`); optional
  NetInfo: paused while offline, data saver (no socket) on metered connections.
- Offline-first persistence through a `StorageAdapter` (`asyncStorage(AsyncStorage)`, `memoryStorage()`); the stored
  bundle is verified again before use.
- React bindings: `<NanoFlagsProvider>`, `useFlag`, `useBoolFlag`, `useFlagDetail`, `useAllFlags`, `useNanoFlags`
  (loading state without Suspense, `identify`, `refresh`), `useFlagsStatus`.
- OpenFeature provider for `@openfeature/web-sdk` / `@openfeature/react-sdk` (`@nanoflags/react-native/openfeature`);
  OpenFeature's context drives `identify()`.
- Telemetry as the other SDKs (`sdk: "react-native/0.1.0"`; attribute names and types only), `events: false` opts out.
