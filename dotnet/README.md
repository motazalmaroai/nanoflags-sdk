# NanoFlags for .NET

Server-side feature flags for .NET. Flags are evaluated **locally, in microseconds, without I/O**, against an
in-memory copy of your environment's configuration that the SDK keeps current in the background: the NanoFlags edge
pushes every published revision over a WebSocket, already signed, typically within ~100–250 ms of the publish.

| Package | What it is |
| --- | --- |
| `NanoFlags` | The client: engine (a port of `@nanoflags/engine`), Ed25519 signature verification, live WebSocket → SSE → ETag polling, persistence, telemetry. `netstandard2.0` and `net8.0`. Depends only on `Microsoft.Extensions.Logging.Abstractions`. |
| `NanoFlags.OpenFeature` | [OpenFeature](https://openfeature.dev) provider for the official .NET SDK (`OpenFeature` 2.x). |

Version 0.1.0 on [NuGet](https://www.nuget.org/packages/NanoFlags): `dotnet add package NanoFlags` (OpenFeature: `dotnet add package NanoFlags.OpenFeature`).
Apache-2.0.

## Quickstart

```csharp
using NanoFlags;

var flags = NanoFlagsClient.Create(
    Environment.GetEnvironmentVariable("NANOFLAGS_SDK_KEY")!,      // nf_srv_… (server view)
    new NanoFlagsOptions { Service = "checkout-api" });            // shown in "which revision is each service running"

if (!await flags.WaitForReadyAsync(TimeSpan.FromSeconds(5)))
    Console.WriteLine($"flags not loaded yet ({flags.LastError?.Message}): evaluations return their fallbacks");

var user = new Dictionary<string, object?> { ["key"] = "user-42", ["plan"] = "pro", ["country"] = "SA" };
if (flags.BoolVariation("new-checkout", user, false))
{
    // ...
}

await flags.CloseAsync(); // on shutdown (or Dispose())
```

Create **one client per SDK key** at startup and share it (it is thread-safe) — with ASP.NET Core, register it as a
singleton: `builder.Services.AddSingleton(_ => NanoFlagsClient.Create(key, options));`. Use a server key
(`nf_srv_…`); browser keys (`nf_pub_…`) work too but only see client-exposed flags.

## Evaluating flags

| Method | Returns |
| --- | --- |
| `BoolVariation(key, context, fallback)` | the flag's boolean value |
| `StringVariation`, `DoubleVariation`, `IntVariation`, `LongVariation` | string / finite number / whole number values |
| `JsonVariation(key, context, fallback)` | plain .NET data (`null`, `bool`, `double`, `string`, `List<object?>`, `Dictionary<string, object?>` in configuration order) |
| `JsonValueVariation` | the same as a JavaScript-typed `JsonValue` |
| `…VariationDetail(key, context, fallback)` | an `EvaluationDetail<T>`: `Value`, `Reason` (`RuleMatch`, `Default`, `Off`, `FlagNotFound`, `Error`), `RuleIndex`, `RuleId`, `InRollout`, `Bucket`, `Revision`, `Trace`, `Error` |
| `Evaluate(key, context, fallback)` | the engine result without a type check |
| `AllFlags(context)` / `AllFlagsDetail(context)` | every flag of the configuration (records no telemetry) |

Evaluations never throw and never block: without a configuration, for a missing flag, or when a flag serves another
type than requested, they return your fallback (reason `FlagNotFound` or `Error`). The context is an
`IReadOnlyDictionary<string, object?>` (a `Dictionary<string, object?>` works); `"key"` is the identity used for
percentage rollouts. Values may be strings, booleans, any numeric type, `null`, sequences and dictionaries.

`Trace` explains the decision step by step, exactly as the dashboard shows it:

```
config     Configuration loaded — r63
rule       Rule 01 matched — plan = pro
allocation Allocation evaluated — 25% rollout · key inside allocation (bucket 12.34)
result     Returned true — Inside the 25% allocation.
```

## Updates and lifecycle

- `Ready` (`Task<bool>`) — completes once the first load attempt has finished: `true` when a configuration is in use.
  `WaitForReadyAsync(timeout)` / `WaitForReady(timeout)` bound the wait. They never throw on failure; `LastError` says why.
- Events (handlers run one at a time, in order, on a thread of the client; a throwing handler never breaks the client):
  `Changed` (`ChangeEvent`: `Revision`, `PreviousRevision`, `Source` network/store/bootstrap, `Transport` live/stream/poll,
  `Latency` from the database commit for pushed revisions), `Error` (`NanoFlagsException` with `Code`), `StatusChanged`.
- `Status` — `NotReady`, `Ready` or `Stale` (a configuration is in use but is not known to be current). `Revision`,
  `Transport`, `Bundle`.
- `RefreshAsync()`, `FlushAsync()`, `CloseAsync()` / `Dispose()` (idempotent; evaluations keep working on the last
  configuration).

Transports, best first: the live WebSocket `GET /v1/live` (subprotocol `nanoflags.v1`, key in the `Authorization`
header — never in a URL; text `ping` every ~30 s, 10 s pong timeout, replaced every ~50 min, reconnect backoff
1 s · 2ⁿ capped at 5 min × 0.5–1.5); server-sent events `GET /v1/stream` while no socket can be opened; polling
`GET /v1/bundle` with `ETag` (every 30 s, every 5 min as a safety net while the socket is healthy). A pushed revision
is never replaced by an older HTTP answer, and an edge answer marked `X-NanoFlags-Stale` never moves the client backwards.

When the edge closes the socket with **4004** (environment deleted), the client stops reconnecting, keeps evaluating
its last configuration, reports `Stale` and an error with code `EnvironmentDeleted`.

## Trust and resilience

- **Signatures, on by default.** With the default base URL (`https://edge.nanoflags.io`) every bundle's Ed25519
  signature is verified against the embedded production keys (`NanoFlagsOptions.OfficialSigningKeys`) before it is
  used — over polling, the live socket and the persisted copy alike — and unsigned bundles are refused. The canonical
  string is `nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>`, hashed
  over the exact bytes the edge served. An unknown key id (a rotation) makes the client load `GET /v1/keys` once, at
  most once a minute. Bundles are pinned to the first environment they were signed for. The verifier is a
  self-contained RFC 8032 implementation (.NET has no built-in Ed25519), so no native or third-party crypto is needed.
- **Engine version.** A bundle whose `engine` is newer than `SupportedEngineVersion` is refused (code `Engine`).
- **Last good configuration.** Failed requests keep the current configuration (`Stale`). `Store = new FileStore(path)`
  persists it (atomically, owner-only permissions on Unix) so a restart can evaluate before reaching the edge; the
  persisted copy is verified again on load. `Bootstrap` / `BootstrapJson` start from a configuration you ship.

## Options (`NanoFlagsOptions`)

| Option | Default |
| --- | --- |
| `BaseUrl` | `https://edge.nanoflags.io` |
| `Service` | `"unknown"` |
| `HttpClient` | one created by the SDK (system proxy settings, e.g. `HTTPS_PROXY`) |
| `PollInterval` / `LivePollInterval` | 30 s / 5 min (`TimeSpan.Zero` disables polling) |
| `Live` / `Streaming` | `true` / `true` |
| `Verify` (`VerifyOptions { PublicKeys, FetchKeys, Require }`) / `DisableVerification` | official edge: embedded keys, signatures required; other edges: off |
| `Store`, `Bootstrap`, `BootstrapJson` | none |
| `Events` (`EventsOptions { Enabled, SampleRate, FlushInterval, ReportInterval, Redact }`) | 10 % of evaluations, flushed every 10 s; service report every 60 s |
| `RequestTimeout` / `LiveConnectTimeout` | 10 s / 10 s |
| `Logger` (`ILogger`) | none |

**Telemetry never sends attribute values by default**: a sampled event carries the names of the attributes the flag's
rules use, mapped to their type (`{"plan": "string"}`), like every other NanoFlags SDK. `Redact` replaces that with your
own function; `EventsOptions.Disabled` turns telemetry (including the service report) off.

## OpenFeature

```csharp
using NanoFlags;
using NanoFlags.OpenFeature;
using OpenFeature;
using OpenFeature.Model;

var flags = NanoFlagsClient.Create(Environment.GetEnvironmentVariable("NANOFLAGS_SDK_KEY")!);
await Api.Instance.SetProviderAsync(new NanoFlagsProvider(flags, closeClient: true));
var client = Api.Instance.GetClient();
var on = await client.GetBooleanValueAsync("new-checkout", false,
    EvaluationContext.Builder().SetTargetingKey("user-42").Set("plan", "pro").Build());
```

The targeting key becomes the NanoFlags `key` (and wins over an attribute called `key`). Reasons: `DISABLED`,
`DEFAULT`, `TARGETING_MATCH`, `SPLIT` (percentage rollouts), `ERROR` with `FLAG_NOT_FOUND`, `PROVIDER_NOT_READY`,
`TYPE_MISMATCH` or `GENERAL`; the variant is the rule id; flag metadata carries `revision` and `ruleIndex`. The
provider emits `PROVIDER_READY`, `PROVIDER_STALE`, `PROVIDER_ERROR` and `PROVIDER_CONFIGURATION_CHANGED` with the keys of
the flags that changed.

## The engine

`NanoFlags.Engine` is a port of the TypeScript engine `@nanoflags/engine` that the dashboard, the edge and every other
SDK run — MurmurHash3 x86 32-bit bucketing over NFC-normalised UTF-8, rules, segments (nested up to depth 4), all
operators and their coercions, rollouts, traces. Configuration is JSON with JavaScript semantics, so the port models
JavaScript values exactly (`Number()`, `String()`, `JSON.stringify` order and number formatting, truthiness), including
for malformed configurations. Number parsing and formatting use exact big-integer arithmetic, so results do not depend
on the runtime's own floating-point formatting (which differs on .NET Framework).

It is verified against the cross-language conformance fixtures generated from the TypeScript engine
(`packages/engine/fixtures/parity.json`: 21,998 evaluations, 340 hash vectors, 370 buckets, `supportsEngine` and
browser-view vectors) plus the Go port's `go/internal/testdata/extra.json` (3,491 further JavaScript corner cases,
compared including V8's error messages). Results are compared as canonical JSON text: value, reason, rule, bucket,
revision and the full trace.

## Building and testing

.NET SDK 8.

```sh
cd dotnet
dotnet test                              # conformance (all fixtures), verification, fake-edge transport tests, OpenFeature
dotnet pack -c Release -o artifacts      # NanoFlags and NanoFlags.OpenFeature .nupkg + .snupkg (release-dotnet.yml publishes them)
```

Opt-in, read-only check against the real edge (loads and verifies a signed bundle, opens the live socket):

```sh
NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_pub_… dotnet test --filter ProductionTests
```

Publishing: [PUBLISHING.md](PUBLISHING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
