# Changelog

## 0.1.0 — unreleased

First release of the .NET server SDK. Nothing is on NuGet yet.

- `NanoFlags` (`netstandard2.0`, `net8.0`): engine port of `@nanoflags/engine` (engine version 1) passing all 21,998
  shared conformance cases, the murmur3 / bucket / `supportsEngine` / browser-view vectors and the Go port's 3,491 extra
  cases (V8 error messages included); exact, runtime-independent number parsing and formatting; server and browser keys;
  typed variations (`bool`, `string`, `double`, `int`, `long`, JSON) with details and traces, `AllFlags`;
  `Ready` / `WaitForReadyAsync`; `Changed`, `Error` and `StatusChanged` events; Ed25519 verification by key id with the
  embedded production keys and a rate-limited `/v1/keys` reload (self-contained RFC 8032 verifier); live WebSocket with
  SSE and ETag polling fallbacks, jittered backoff, ping/pong, ~50 min rotation, close code 4004; persistence with
  re-verification (`FileStore`), bootstrap; telemetry with attribute names and types only by default, custom redaction,
  opt-out.
- `NanoFlags.OpenFeature`: provider for `OpenFeature` 2.x (reasons, variants, metadata, provider events).
