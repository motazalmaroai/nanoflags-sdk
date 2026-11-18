# Changelog

## 0.2.0 — 2026-11-18

- Test sessions (`x-nanoflags-session`), as in the JS and Python SDKs: `client.Session(ctx, token, opts...)` resolves a
  shared test session (`GET /v1/session`, cached until it expires; unknown tokens 15 s, failures 3 s; concurrent
  callers share one request) and returns a `*SessionEvaluator` that evaluates the session's pinned bundle with
  `{...session.context, ...ctx}` while active and behaves like the client otherwise. Sampled events carry `sessionId`.
  Request scope through `context.Context`: `SessionMiddleware(client)` (net/http), `WithSession`, `client.FlagsFor`,
  `CurrentSession`, `SessionHeaders` and `SessionTransport` (an `http.RoundTripper` that propagates the header).
  `SessionService(name)` sets `X-NanoFlags-Service`. New error code `ErrSession` (`"session"`).
