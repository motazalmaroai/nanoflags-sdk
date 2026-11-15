# Changelog

## 0.1.0 (unreleased)

First release of the NanoFlags server SDK for PHP (`nanoflags/nanoflags`).

- Native port of the NanoFlags evaluation engine (engine version 1): identical results to the TypeScript engine on
  the shared parity fixtures (21 998 cases, MurmurHash3 and bucket vectors, `supportsEngine`, `clientBundle`) and on
  the 3 491 JavaScript corner cases of `go/internal/testdata/extra.json`, error messages included.
- `NanoFlags\Client`: typed getters (`boolVariation`, `stringVariation`, `numberVariation`, `jsonVariation`), detail
  variants with reason, rule, rollout bucket and trace, `evaluate`, `allFlags`. Accessors never throw.
- Request-scoped design: the bundle is shared between requests through a cache (APCu, a directory, or any PSR-16
  cache), used without network for `cacheTtl` seconds, then revalidated with `If-None-Match`. The last good bundle
  keeps serving through edge failures (`stale`), with a retry interval instead of a request per page view.
- Signature verification (Ed25519, embedded production keys, key rotation via `/v1/keys`, environment pinning) on by
  default for the hosted edge; cached bundles are verified again. Bundles for a newer engine are refused.
- Sampled telemetry (`/v1/events`) with the default redaction of the other SDKs (attribute names and value types
  only), buffered in the cache and sent at most once per flush interval; the periodic service report.
- `vendor/bin/nanoflags-sync`: a sync daemon that keeps the shared cache current over the edge's event stream
  (`/v1/stream`) with a safety poll; web workers can then run with `refresh: false`.
- Transports: ext-curl (proxy and CA bundle from the environment), PHP streams, or any PSR-18 client.
