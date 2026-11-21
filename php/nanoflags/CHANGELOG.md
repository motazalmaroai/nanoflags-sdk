# Changelog

## 0.3.0 (2026-11-21)

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

## 0.2.0 (2026-11-18)

- Test sessions: `Client::session($token, $service)` and `Client::sessionFromGlobals()` resolve `x-nanoflags-session`
  tokens (`GET /v1/session` with `X-NanoFlags-Session` / `X-NanoFlags-Service`) and return a `SessionEvaluator` that
  evaluates against the session's pinned bundle with `session context + your context`; `headers()` propagates the
  token to downstream calls; sampled events carry `sessionId`. Never throws (new error code `session`). Active
  sessions are cached until expiry in the client and in the shared cache under their own key (a hash of service and
  token, never the token; the bundle entry is never touched; TTL at most 1 h); unknown tokens (15 s) and failures (3 s)
  only in the client. PSR-15 `NanoFlags\SessionMiddleware` (request attribute `nanoflags.flags`);
  `psr/http-server-middleware` is suggested, not required.

## 0.1.0 (2026-11-18)

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
