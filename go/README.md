# NanoFlags Go SDK

Server-side feature flags for Go. Flags are evaluated **locally, in microseconds, without I/O**, against
an in-memory copy of your environment's configuration that the SDK keeps current in the background:
the NanoFlags edge pushes every published revision over a WebSocket, already signed, typically within
~100–250 ms of the publish.

```sh
go get github.com/motazalmaroai/nanoflags-sdk/go
```

Requires Go 1.22 or newer. Dependencies: `github.com/coder/websocket` (live updates) and
`golang.org/x/text` (Unicode normalisation for percentage rollouts). Everything else is the standard
library, including Ed25519.

## Quickstart

```go
package main

import (
	"context"
	"log"
	"os"
	"time"

	nanoflags "github.com/motazalmaroai/nanoflags-sdk/go"
)

func main() {
	client, err := nanoflags.New(os.Getenv("NANOFLAGS_SDK_KEY"), nanoflags.WithService("checkout-api"))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.WaitForReady(ctx); err != nil {
		log.Printf("flags not loaded yet (%v): evaluations return their fallbacks", err)
	}

	user := nanoflags.Context{"key": "user-42", "plan": "pro", "country": "SA"}
	if client.BoolVariation("new-checkout", user, false) {
		// ...
	}
}
```

Create one client per SDK key at startup and share it: it is safe for concurrent use. Use a server
key (`nf_srv_…`); browser keys (`nf_pub_…`) work too but only see client-exposed flags.

Runnable examples: [`examples/quickstart`](examples/quickstart) and [`examples/live`](examples/live)
(watches the public demo and measures the time from a publish to the SDK's update).

## Evaluating flags

| Method | Returns |
| --- | --- |
| `BoolVariation(key, ctx, fallback bool) bool` | the flag's boolean value |
| `StringVariation(key, ctx, fallback string) string` | the flag's string value |
| `Float64Variation(key, ctx, fallback float64) float64` | the flag's number value |
| `JSONVariation(key, ctx, fallback any) any` | plain Go data (`nil`, `bool`, `float64`, `string`, `[]any`, `map[string]any`) |
| `…VariationDetail(key, ctx, fallback)` | the value plus a `Detail`: `Reason`, `RuleIndex`, `RuleID`, `InRollout`, `Bucket`, `Revision`, `Trace`, `Error` |
| `Evaluate(key, ctx, fallback any) Detail` | the engine result without a type check |
| `AllFlags(ctx) map[string]any` / `AllFlagsDetail(ctx)` | every flag of the configuration (records no telemetry) |

Evaluations never fail and never block: without a configuration, for a missing flag, or when a flag
serves another type than requested, they return your fallback (`Reason` `flag_not_found` or `error`).
`Context` is a `map[string]any`; `"key"` is the identity used for percentage rollouts.

`Detail.Trace` explains the decision step by step, exactly as the dashboard shows it:

```
config     Configuration loaded — r63
rule       Rule 01 matched — plan = pro
allocation Allocation evaluated — 25% rollout · key inside allocation (bucket 12.34)
result     Returned true — Inside the 25% allocation.
```

## Updates and lifecycle

- `WaitForReady(ctx) error` — returns once the first load has finished: `nil` when a configuration is
  in use, otherwise why not (`*nanoflags.Error`, or `ErrNotReady`).
- `OnChange(func(ChangeEvent))` — every newly adopted revision, with `Transport` (`live`, `stream`,
  `poll`), `Source` (`network`, `store`, `bootstrap`) and, for pushed revisions, `Latency` from the
  database commit. `OnError(func(error))`, `OnStatus(func(Status))`. Callbacks run in order on one
  goroutine of the client; each returns an unsubscribe function.
- `Status()` — `StatusNotReady`, `StatusReady` or `StatusStale` (a configuration is in use but is not
  known to be current). `Revision()`, `Transport()`, `Bundle()`.
- `Refresh(ctx)`, `Flush(ctx)`, `Close()` (idempotent; waits for every goroutine; evaluations keep
  working on the last configuration).

Transports, best first: the live WebSocket `GET /v1/live` (the edge pushes the signed bundle itself;
ping every ~30 s, 10 s pong timeout, replaced every ~50 min, reconnect backoff 1 s · 2ⁿ capped at
5 min × 0.5–1.5); server-sent events `GET /v1/stream` while no socket can be opened; polling
`GET /v1/bundle` with `ETag` (every 30 s, every 5 min as a safety net while the socket is healthy). A
pushed revision is never replaced by an older HTTP answer.

When the edge closes the socket with **4004** (environment deleted), the client stops reconnecting,
keeps evaluating its last configuration, reports `StatusStale` and an error with code
`environment_deleted`.

## Trust and resilience

- **Signatures, on by default.** With the default base URL (`https://edge.nanoflags.io`) every bundle's
  Ed25519 signature is verified against the embedded production keys (`OfficialSigningKeys`) before it
  is used — over polling, the live socket and the persisted copy alike — and unsigned bundles are
  refused. The canonical string is
  `nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>`, hashed
  over the exact bytes the edge served. A bundle signed with an unknown key id (a key rotation) makes
  the client load `GET /v1/keys` once, at most once a minute. Bundles are pinned to the first
  environment they were signed for. A bundle that fails verification never replaces the one in use.
- **Engine version.** A bundle whose `engine` is newer than `SupportedEngineVersion` is refused (error
  code `engine`); the configuration in use stays. Upgrade the SDK.
- **Last good configuration.** Failed requests keep the current configuration (`StatusStale`).
  `WithStore(nanoflags.FileStore(path))` persists it (atomically, mode 0600) so a restart can evaluate
  before reaching the edge; the persisted copy is verified again on load. `WithBootstrap(bundle)` /
  `WithBootstrapJSON(data)` start from a configuration you ship.

## Options

| Option | Default |
| --- | --- |
| `WithBaseURL(url)` | `https://edge.nanoflags.io` |
| `WithService(name)` | `"unknown"` — shown in "which revision is each service running" |
| `WithHTTPClient(*http.Client)` | default transport (honours `HTTPS_PROXY`) |
| `WithPollInterval(d)` / `WithLivePollInterval(d)` | 30 s / 5 min (`0` disables polling) |
| `WithLive(bool)` / `WithStreaming(bool)` | `true` / `true` |
| `WithVerification(VerifyOptions{PublicKeys, FetchKeys, Require})` / `WithoutVerification()` | official edge: embedded keys, `Require` true; other edges: off |
| `WithStore(Store)`, `WithBootstrap(*engine.Bundle)`, `WithBootstrapJSON([]byte)` | none |
| `WithEvents(EventsOptions{Disabled, SampleRate, FlushInterval, ReportInterval, Redact})` | 10 % of evaluations, flushed every 10 s; service report every 60 s |
| `WithLogger(*slog.Logger)` | discard |

Telemetry never sends attribute values by default: a sampled event carries the names of the
attributes the flag's rules use, mapped to their type (`{"plan": "string"}`).

## OpenFeature

```sh
go get github.com/motazalmaroai/nanoflags-sdk/go/ofprovider
```

```go
client, _ := nanoflags.New(os.Getenv("NANOFLAGS_SDK_KEY"))
_ = openfeature.SetProviderAndWait(ofprovider.New(client, ofprovider.WithCloseClient()))
of := openfeature.NewDefaultClient()
on, _ := of.BooleanValue(ctx, "new-checkout", false, openfeature.NewEvaluationContext("user-42", map[string]any{"plan": "pro"}))
```

The targeting key becomes the NanoFlags `key`. Reasons: `DISABLED`, `DEFAULT`, `TARGETING_MATCH`, `SPLIT`
(percentage rollouts), `ERROR` with `FLAG_NOT_FOUND`, `PROVIDER_NOT_READY`, `TYPE_MISMATCH` or `GENERAL`;
the variant is the rule id; flag metadata carries `revision`. The provider emits `PROVIDER_READY`,
`PROVIDER_STALE`, `PROVIDER_ERROR` and `PROVIDER_CONFIGURATION_CHANGED` with the keys of the flags that
changed. It is a separate module (Go 1.24, `github.com/open-feature/go-sdk` v1.17), so the SDK itself
does not depend on OpenFeature.

## The engine

Package [`engine`](engine) is a port of the TypeScript engine `@nanoflags/engine` that the dashboard,
the edge and every other SDK run — MurmurHash3 x86 32-bit bucketing over NFC-normalised UTF-8, rules,
segments (nested up to depth 4), all operators and their coercions, rollouts, traces. Configuration is
JSON with JavaScript semantics, so the port models JavaScript values exactly (`Number()`, `String()`,
`JSON.stringify` order and number formatting, truthiness), including for malformed configurations.

It is verified against the cross-language parity fixtures generated from the TypeScript engine
(`packages/engine/fixtures/parity.json`: 21 998 evaluations, 340 hash vectors, 370 buckets) plus
`internal/testdata/extra.json` (3 491 further JavaScript corner cases and fuzz cases, compared
including V8's error messages). Results are compared as canonical JSON text: value, reason, rule,
bucket, revision and the full trace.

## Development

```sh
go vet ./... && go test -race ./...
(cd ofprovider && go vet ./... && go test -race ./...)
node internal/testdata/generate-extra.mjs --check   # extra fixtures in sync with the TypeScript engine (Node ≥ 22.18)
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
