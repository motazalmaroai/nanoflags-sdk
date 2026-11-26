# Changelog

## 0.3.1 (2026-11-27)

- Verification hardening, no API change (refuses older signed revisions, reports rejected updates as stale)

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

- Live updates over the edge's WebSocket (`/v1/live`, subprotocol `nanoflags.v1`, the key in the `Authorization`
  header): the same protocol as the JavaScript, Python, Go and Java SDKs. `hello` / `rev` pushes are verified like
  fetched bundles before use, never move the client backwards, and set the ETag so the safety poll gets a 304. Text
  ping every ~30 s with a 10 s pong timeout, socket rotation after ~50 min, reconnects with jittered backoff up to
  5 min. Close code 4004 (environment deleted) keeps the last bundle, sets `stale`, reports
  `:environment_deleted` and stops reconnecting. While no socket can be opened the event stream and polling take
  over; while it is healthy the safety poll runs every `live_poll_interval` (300 s). New options `live:`,
  `live_poll_interval:`, `live_url:`; `transport` can be `:live`; `UpdateEvent#latency_ms` for pushes that carry their
  commit time. The WebSocket client is built in (`NanoFlags::WebSocket`, RFC 6455 over the standard library, HTTP
  proxies via CONNECT): still no runtime dependencies. Fork-safe: a child opens its own socket and never writes to
  the parent's.
- Test sessions: `Client#session(token, service:)` resolves `x-nanoflags-session` tokens (`GET /v1/session`, cached
  until expiry; unknown tokens 15 s, failures 3 s) and returns a `NanoFlags::SessionEvaluator` that evaluates against
  the session's pinned bundle with `session.context.merge(context)`; sampled events carry `sessionId`. Request-scoped
  helpers `NanoFlags.with_session`, `.flags_for`, `.current_session`, `.session_headers` and the Rack middleware
  `NanoFlags::SessionMiddleware` (sets `env["nanoflags.flags"]`). New error codes `:session` and
  `:environment_deleted`.

## 0.1.0 (2026-11-18)

First release of the NanoFlags server SDK for Ruby (gem `nanoflags`).

- Native port of the NanoFlags evaluation engine (engine version 1): identical results to the TypeScript engine on
  the shared parity fixtures (21 998 cases, MurmurHash3 and bucket vectors, `supportsEngine`, `clientBundle`) and on
  the 3 491 JavaScript corner cases of `go/internal/testdata/extra.json`, error messages included.
- `NanoFlags::Client`: typed getters (`bool_variation`, `string_variation`, `number_variation`, `json_variation`),
  detail variants with reason, rule, rollout bucket and trace, `evaluate`, `all_flags`. Accessors never raise.
- Background updates: `/v1/stream` server-sent events trigger conditional `/v1/bundle` requests (ETag), with polling
  and backoff as the safety net; served-stale bundles never move the client backwards.
- Signature verification (Ed25519, embedded production keys, key rotation via `/v1/keys`, environment pinning) on by
  default for the hosted edge. Bundles for a newer engine are refused.
- Persistence (`cache_path:` / `store:`, verified again on restore) and `bootstrap:`.
- Fork safety: forked children keep the inherited configuration and restart their threads on first use (or via
  `NanoFlags::Client.after_fork`).
- Sampled telemetry (`/v1/events`) with the default redaction of the other SDKs (attribute names and value types
  only) and the periodic service report.
