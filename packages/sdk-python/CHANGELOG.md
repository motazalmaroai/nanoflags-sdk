# Changelog

## 0.2.0 — 2026-11-20

Additive, no breaking changes; nothing changes unless an admin turned shadow evaluation on for the environment.

- Shadow evaluation of drafts (migration 0179), as in the JS SDK 0.7: when a fresh `/v1/bundle` answer carries
  `X-NanoFlags-Shadow`, the client loads the draft from `GET /v1/shadow`, verifies it (signature domain
  `nanoflags-shadow-v1`, marker inside the signed bytes matching the session, checksum and environment; with the keys
  of `/v1/keys` when `verify` is off) and, for a sample of the evaluations of the flags the draft changes, also
  evaluates the draft. Only aggregate counters are sent, in the `shadow` member of `POST /v1/events`, at most once a
  minute (always on `flush()`, `close()`, and before a session is replaced or withdrawn). Same wire format and limits
  as the JS SDK: 100 flags, 10 value pairs and 50 rule counters per flag, canonical JSON values of at most 100
  characters (longer: `#<murmur3>`), the app's own default reported as `"<fallback>"`, counts capped at 10^7. The
  app always gets the live value: any bundle with a `shadow` member is refused as configuration (poll, push, file
  cache, bootstrap, test sessions). Test-session evaluations are never shadowed. A failed fetch is not retried for the
  same announcement for 60 s.
- New keyword arguments: `shadow=ShadowOptions(enabled, sample_rate)` or `shadow=False` (default on, 0.1, while
  `events` are on) and `service_version="3.1.0"` (labels the reports, at most 40 characters). `ShadowOptions` is
  exported from `nanoflags`. New error code `shadow`.

## 0.1.0 — 2026-11-12 (not published)

- First version: local evaluation with the shared engine, signed live updates and sampled telemetry (see README).
