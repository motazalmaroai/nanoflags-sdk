# Changelog

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
