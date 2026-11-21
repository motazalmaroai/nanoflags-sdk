# Changelog

## 0.8.1 (2026-11-21)

Security fix to the integrity of shadow reports; served flag values are not affected (shadow bundles are
never applied as configuration).

- A shadow bundle is only used once the environment of a verified live bundle is known, and only when it was signed
  for that environment. Before, a shadow bundle checked while no environment was pinned yet (the shadow fetch starts
  with the /v1/bundle answer and could finish before that answer's verification, or the answer failed verification)
  was not bound to an environment, so one validly signed for another environment of the same project could feed the
  shadow counters reported for change approvals. Without signature verification configured, nothing changes.

## 0.8.0 (2026-11-21)

Additive, no breaking changes.

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

## 0.7.1 (2026-11-20)

Bug fix, no API changes.

- Shadow reports always pass the edge's validation of the `shadow` member of `POST /v1/events`: flag keys over 63 characters (UTF-16 code units) are no longer counted, and a flag's counters stop at 10^7 samples until the next report. Before, one such flag made the edge refuse the whole events request with 400, dropping that report's telemetry and shadow counters. Same rules as Python 0.2.0, Go 0.3.0, Kotlin/Android 0.2.0, Swift 0.2.0 and Dart 0.2.0.

## 0.7.0 (2026-11-19)

Additive, no breaking changes; nothing changes unless the new options are set (shadow evaluation only acts when an admin turned it on for the environment).

- Shadow evaluation of drafts (migration 0179): when the edge announces a shadow bundle (`X-NanoFlags-Shadow` on `/v1/bundle`), the client loads it from `/v1/shadow`, checks its signature (shadow domain `nanoflags-shadow-v1`, marker inside the signed bytes) and, for a sample of evaluations of the flags the draft changes (`shadow.sampleRate`, default 0.1), evaluates the draft too. Only aggregate counters are sent, with the telemetry report at most once a minute (`shadow` member of `POST /v1/events`). The app always gets the live value; a shadow bundle is never applied (any bundle with a `shadow` member is refused as configuration). `shadow: false` turns it off; it is off when `events` is off. New `serviceVersion` option labels the reports. A shadow bundle that does not verify emits `error` with code `shadow`. The app's own fallback value is never reported (a side that used it is sent as `"<fallback>"`); flags affected through segments inside segments are shadowed too; value changes are compared independently of object key order.

- `verifyLog` option: every update is checked against the environment's transparency log (RFC 9162 inclusion proof, tree head signed by NanoFlags, consistency with the last head seen). Failures emit `error` with code `log` and keep the configuration in use.
- `coSignerKeys` option: updates must carry a valid customer co-signature (`X-NanoFlags-Cosignature`, or `cosignature` on live messages); failures emit `error` with code `cosign`.
- `allowEmergencyWithoutCosign` option (default `true`): kill-switch revisions that only turn flags off are accepted without the co-signature.
- Exports the log verifiers (`verifyInclusion`, `verifyConsistency`, `leafHash`, `parseLeaf`, `headText`, `onlyTurnsFlagsOff`).

## 0.6.0 (2026-11-18)

- `events: false` (telemetry off) also turns experiment exposures and `track()` off, unless `experiments: { enabled: true }` is set explicitly.

Additive, no breaking changes.

- Experiments: the SDK logs an **exposure** the first time a unit evaluates a flag through the rule of a running
  experiment (bundles carry the experiment's metadata on the flag). Exposures are never sampled, de-duplicated per unit
  in the process and sent to `POST /v1/exposures`; failed batches (network, 429, 5xx) are retried.
- `track(eventName, value?, ctx?)`: records a metric event for experiments (`POST /v1/track`, at most once).
- Only a SHA-256 unit hash scoped to project, environment and unit attribute leaves the process
  (`unitHash()`, `sha256Hex()` are exported); never the context, other attributes or values.
- `experiments` option: `{ enabled?: boolean, flushIntervalMs?: number }` or `false` (both features off).
- `flush()` also sends queued exposures and track events; `close()` sends them best effort.
- `ExperimentMeta` type re-exported from the engine (`FlagConfig.experiment`).

## 0.5.1 (2026-11-14)

- An `error` emitted while no `error` listener is attached is logged with `console.warn` (prefixed `[nanoflags]`), once per error code per client, instead of being dropped silently. Attaching a listener with `on("error", …)` turns this off.
- In a browser (`window` and `document` defined), a server key (`nf_srv_…`) logs a `console.warn` once per page: server keys are secrets and must not be shipped to browsers; use a client key (`nf_pub_…`).
- README: the quickstart attaches the `error` listener before `await ready()`.

## 0.5.0 (2026-11-13)

Additive, no breaking changes. These options let platform SDKs (the React Native SDK, `@nanoflags/react-native`) build on the core client.

- `allFlags(ctx?)`: values of every flag in the bundle in use for a context (`{}` while no bundle is loaded).
- `crypto` option: SHA-256 + Ed25519 implementation for signature verification where WebCrypto lacks them. Default: WebCrypto.
- `openStream` option: how the SSE fallback is opened, for runtimes whose `fetch` cannot stream. Default: `fetch` with a streamed body.
- `lifecycle` option: receives a `LifecycleControl` (`pause()`, `resume()`, `setRealtime()`, `paused`) so app-lifecycle and connectivity integrations can stop and restart background network activity.
- `sdkLabel` option: the `sdk` label of telemetry reports (default `js/<version>`).
- The live socket is torn down synchronously when the client drops the live connection.
- `subscribe()` listeners (and so the React hooks) are notified when `transport` changes (socket opened or lost, SSE started or stopped); before, a hook showed the transport of its last re-render.
- `TextEncoder` / `atob` fallbacks for runtimes that lack them.

## 0.4.0

- Signatures are verified by default on the official edge, against a multi-key list with key-list refresh on an unknown `kid`.
- Engine version check; `environment_deleted` close code (4004).
