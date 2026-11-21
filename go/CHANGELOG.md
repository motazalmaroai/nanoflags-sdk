# Changelog

## 0.4.0 — unreleased

Additive, no breaking changes. Unreleased: TODO release date.

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

## 0.3.0 — 2026-11-20

Additive, no breaking changes; nothing changes unless an admin turned shadow evaluation on for the environment.

- Shadow evaluation of drafts (migration 0179), as in the JS SDK 0.7: when a fresh `/v1/bundle` answer carries
  `X-NanoFlags-Shadow`, the client loads the draft from `GET /v1/shadow`, verifies it (signature domain
  `nanoflags-shadow-v1`, marker inside the signed bytes matching the session, checksum and environment; with the keys
  of `/v1/keys` when verification is off) and, for a sample of the evaluations of the flags the draft changes, also
  evaluates the draft. Only aggregate counters are sent, in the `shadow` member of `POST /v1/events`, at most once a
  minute (always on `Flush`, `Close`, and before a session is replaced or withdrawn). Same wire format and limits as
  the JS SDK: 100 flags, 10 value pairs and 50 rule counters per flag, canonical JSON values of at most 100
  characters (longer: `#<murmur3>`), the app's own fallback reported as `"<fallback>"`, counts capped at 10^7.
  The app always gets the live value: any bundle with a `shadow` member is refused as configuration (poll, push,
  store, bootstrap, test sessions). Test-session evaluations are never shadowed. A failed fetch is not retried for the
  same announcement for 60 s.
- New options: `WithShadow(ShadowOptions{Disabled, SampleRate})` (default on, 0.1, while events are on) and
  `WithServiceVersion(v)` (labels the reports, at most 40 characters). New error code `ErrShadow` (`"shadow"`).

## 0.2.0 — 2026-11-18

- Test sessions (`x-nanoflags-session`), as in the JS and Python SDKs: `client.Session(ctx, token, opts...)` resolves a
  shared test session (`GET /v1/session`, cached until it expires; unknown tokens 15 s, failures 3 s; concurrent
  callers share one request) and returns a `*SessionEvaluator` that evaluates the session's pinned bundle with
  `{...session.context, ...ctx}` while active and behaves like the client otherwise. Sampled events carry `sessionId`.
  Request scope through `context.Context`: `SessionMiddleware(client)` (net/http), `WithSession`, `client.FlagsFor`,
  `CurrentSession`, `SessionHeaders` and `SessionTransport` (an `http.RoundTripper` that propagates the header).
  `SessionService(name)` sets `X-NanoFlags-Service`. New error code `ErrSession` (`"session"`).
