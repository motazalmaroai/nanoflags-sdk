# Changelog

## 0.3.0 — unreleased

- `NanoFlagsOptions.Builder.onError(Consumer<NanoFlagsException>)` attaches an error listener before the client starts
  loading, so it also receives the errors of the first load and the configuration errors reported while the client is
  created (for example an invalid bootstrap bundle), which a listener added afterwards with `NanoFlagsClient.onError`
  can miss. It can be called more than once; builder listeners run in the order added, before those added later.

## 0.2.0 — 2026-11-18

- Test sessions (`x-nanoflags-session`), as in the JS and Python SDKs: `NanoFlagsClient.session(token[, service])` /
  `sessionAsync(...)` resolve a shared test session (`GET /v1/session`, cached until it expires; unknown tokens 15 s,
  failures 3 s; concurrent callers share one request) and return a `SessionEvaluator` that evaluates the session's
  pinned bundle with `{...session.context, ...context}` while active and behaves like the client otherwise. Sampled
  events carry `sessionId`. `TestSessions` holds the current request's session per thread (`open` / `withSession`,
  `flagsFor`, `currentSession`, `sessionHeaders`, `propagate` for `java.net.http`, `wrap` for executors); the README
  shows a servlet filter. New error code `ErrorCode.SESSION` (`"session"`).

## 0.1.0 — 2026-11-18

First release of the Java server SDK, on Maven Central.

- `nanoflags-java` (Java 11+, no runtime dependencies): engine port of `@nanoflags/engine` (engine version 1) passing
  all 21,998 shared conformance cases, the murmur3 / bucket / `supportsEngine` / browser-view vectors and the Go port's
  3,491 extra cases (V8 error messages included); server and browser keys; typed variations (`boolean`, `String`,
  `double`, `int`, `long`, JSON) with details and traces, `allFlags`; `ready()` / `waitForReady`; change, error and
  status listeners; Ed25519 verification by key id with the embedded production keys and a rate-limited `/v1/keys`
  reload (JDK provider on Java 15+, built-in RFC 8032 verifier on 11–14); live WebSocket (`java.net.http`) with SSE and
  ETag polling fallbacks, jittered backoff, ping/pong, ~50 min rotation, close code 4004; persistence with
  re-verification (`FileStore`), bootstrap; telemetry with attribute names and types only by default, custom redaction,
  opt-out.
- `nanoflags-java-openfeature`: provider for `dev.openfeature:sdk` 1.22 (reasons, variants, metadata, provider events).
