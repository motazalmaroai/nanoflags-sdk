# Changelog

## 0.1.0 — unreleased

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
