# Changelog

## 0.1.2

- Allows `nanoflags` 0.3.x: the dependency is now `">=0.1.0 <0.4.0"` (was `<0.3.0`, which excluded 0.3.0), for
  the version and date operators (`semver_*`, `before` / `after`); no code changes; the provider is tested against `nanoflags` 0.3.0.

## 0.1.1

- Allows `nanoflags` 0.2.x: the dependency is now `">=0.1.0 <0.3.0"` (was `^0.1.0`, which excluded 0.2.0). No code
  changes; the provider is tested against `nanoflags` 0.2.0.

## 0.1.0

First release: `NanoFlagsOpenFeatureProvider` for `openfeature_dart_client_sdk` 0.0.x (typed
resolvers, reason / variant / metadata mapping, lifecycle and configuration events, local context
reconciliation).
