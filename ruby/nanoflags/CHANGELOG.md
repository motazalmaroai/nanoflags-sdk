# Changelog

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
