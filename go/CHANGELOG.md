# Changelog

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
