# Changelog

## 0.2.0 (2026-11-25)

Works with the current SDK: the peer range on `@nanoflags/sdk` is now `^0.8.0` (0.8.0 and 0.8.1 tested). 0.1.0
required `^0.3.0`, which no maintained SDK release satisfies.

- **Peer range.** `@nanoflags/sdk` `^0.8.0` (`>=0.8.0 <0.9.0`), written explicitly. 0.1.0 took its range from the
  workspace SDK version at publish time (`workspace:^`), so every new SDK minor fell outside it. Only versions the test
  suite runs against are included: the source SDK, and the published 0.8.0 (oldest in range) and 0.8.1 (newest). 0.8.0
  is the first SDK with the version (`semver_*`) and date (`before` / `after`) operators; with an older SDK, rules
  using them never match. The OpenFeature peer ranges are unchanged (`@openfeature/core` `^1.12.0`,
  `@openfeature/server-sdk` `^1.17.0`, `@openfeature/web-sdk` `^1.4.0`).
- **Tracking.** OpenFeature `track(name, context, details)` calls `client.track(name, value, ctx)` of the SDK (experiment
  metric events, SDK 0.6.0+): `details.value` (a finite number) is the metric value, the context is mapped like for
  evaluations (`targetingKey` → `key`). Other tracking details are not sent. Before, `track()` was ignored.
- **Client errors are no longer swallowed.** The provider listened to the client's `error` event permanently, which
  (since SDK 0.5.1) turns off the SDK's own `console.warn` for applications without an `error` listener, and only
  forwarded errors while no configuration was loaded: failed revalidations, rejected signatures, transparency-log /
  co-signature failures and invalid `track()` calls were then reported nowhere. The provider now listens only while
  no configuration is loaded (those errors are still `ERROR` events); with a configuration in use, errors are the
  SDK's again (logged, or delivered to your own `client.on("error", …)`).
- **The caller's default value is the SDK fallback.** Evaluations pass the OpenFeature default value to the SDK
  (before: `null`), so the SDK's sampled telemetry and evaluation trace show the value the application got when a flag
  is missing.
- `NanoFlagsLike` has an optional `track` member (clients without it are still accepted; tracking is then ignored).
- Tests run against the SDK sources and the published `@nanoflags/sdk` 0.8.0 and 0.8.1 (vitest projects), and the
  type check also runs against the 0.8.0 declarations. Also verified once against the oldest OpenFeature versions in
  range (core 1.12.0, server-sdk 1.17.0, web-sdk 1.4.0).

## 0.1.0 (2026-11-11)

First release: server (`@nanoflags/openfeature-provider/server`) and web (`/web`) providers, local synchronous
evaluation, reasons, variants, error codes, provider status and events.
