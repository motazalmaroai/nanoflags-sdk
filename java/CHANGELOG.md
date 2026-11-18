# Changelog

## 0.1.0 — 2026-11-18

First release of the Java server SDK. Nothing is on Maven Central yet.

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
