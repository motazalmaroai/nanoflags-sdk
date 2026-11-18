# Changelog

## Unreleased

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
