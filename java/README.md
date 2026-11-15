# NanoFlags for Java

Server-side feature flags for Java. Flags are evaluated **locally, in microseconds, without I/O**, against an
in-memory copy of your environment's configuration that the SDK keeps current in the background: the NanoFlags edge
pushes every published revision over a WebSocket, already signed, typically within ~100–250 ms of the publish.

| Artifact | What it is |
| --- | --- |
| `io.nanoflags:nanoflags-java` | The client: engine (a port of `@nanoflags/engine`), Ed25519 signature verification, live WebSocket → SSE → ETag polling, persistence, telemetry. Java 11+, **no runtime dependencies** (JDK `java.net.http` only). |
| `io.nanoflags:nanoflags-java-openfeature` | [OpenFeature](https://openfeature.dev) provider for the official Java SDK (`dev.openfeature:sdk` 1.x). |

Version 0.1.0 (unreleased, not on Maven Central yet — build from source, see [Building and testing](#building-and-testing)).
Apache-2.0. Android apps use the Kotlin SDK in [`kotlin/`](../kotlin) instead (client keys, lifecycle, Compose).

## Quickstart

```kotlin
// build.gradle.kts
dependencies { implementation("io.nanoflags:nanoflags-java:0.1.0") }
```

```java
import io.nanoflags.server.NanoFlagsClient;
import io.nanoflags.server.NanoFlagsOptions;

NanoFlagsClient flags = NanoFlagsClient.create(
    System.getenv("NANOFLAGS_SDK_KEY"),                         // nf_srv_… (server view)
    NanoFlagsOptions.builder().service("checkout-api").build()); // shown in "which revision is each service running"

if (!flags.waitForReady(Duration.ofSeconds(5))) {
    log.warn("flags not loaded yet ({}): evaluations return their fallbacks", flags.lastError());
}

Map<String, Object> user = Map.of("key", "user-42", "plan", "pro", "country", "SA");
if (flags.boolVariation("new-checkout", user, false)) {
    // ...
}

flags.close(); // on shutdown (it is AutoCloseable)
```

Create **one client per SDK key** at startup and share it: it is thread-safe. Use a server key (`nf_srv_…`); browser
keys (`nf_pub_…`) work too but only see client-exposed flags.

## Evaluating flags

| Method | Returns |
| --- | --- |
| `boolVariation(key, context, fallback)` | the flag's boolean value |
| `stringVariation`, `doubleVariation`, `intVariation`, `longVariation` | string / finite number / whole number values |
| `jsonVariation(key, context, fallback)` | plain Java data (`null`, `Boolean`, `Double`, `String`, `List`, `Map` in configuration order) |
| `jsonValueVariation` | the same as a JavaScript-typed `JsonValue` |
| `…VariationDetail(key, context, fallback)` | an `EvaluationDetail<T>`: `value()`, `reason()` (`RULE_MATCH`, `DEFAULT`, `OFF`, `FLAG_NOT_FOUND`, `ERROR`), `ruleIndex()`, `ruleId()`, `inRollout()`, `bucket()`, `revision()`, `trace()`, `error()` |
| `evaluate(key, context, fallback)` | the engine result without a type check |
| `allFlags(context)` / `allFlagsDetail(context)` | every flag of the configuration (records no telemetry) |

Evaluations never throw and never block: without a configuration, for a missing flag, or when a flag serves another
type than requested, they return your fallback (reason `FLAG_NOT_FOUND` or `ERROR`). The context is a
`Map<String, ?>`; `"key"` is the identity used for percentage rollouts. Values may be strings, booleans, any `Number`,
`null`, collections, arrays and maps.

`trace()` explains the decision step by step, exactly as the dashboard shows it:

```
config     Configuration loaded — r63
rule       Rule 01 matched — plan = pro
allocation Allocation evaluated — 25% rollout · key inside allocation (bucket 12.34)
result     Returned true — Inside the 25% allocation.
```

## Updates and lifecycle

- `ready()` (`CompletableFuture<Boolean>`) — completes once the first load attempt has finished: `true` when a
  configuration is in use. `waitForReady(Duration)` blocks at most that long. Neither throws on failure;
  `lastError()` says why.
- Listeners (run one at a time, in order, on a thread of the client; a throwing listener never breaks the client;
  each returns a `Subscription` to close): `onChange(ChangeEvent)` (`revision`, `previousRevision`, `source`
  network/store/bootstrap, `transport` live/stream/poll, `latency` from the database commit for pushed revisions),
  `onError(NanoFlagsException)` (with `code()`), `onStatus(Status)`.
- `status()` — `NOT_READY`, `READY` or `STALE` (a configuration is in use but is not known to be current). `revision()`,
  `transport()`, `bundle()`.
- `refresh()`, `flush()`, `close()` (idempotent; evaluations keep working on the last configuration).

Transports, best first: the live WebSocket `GET /v1/live` (subprotocol `nanoflags.v1`, key in the `Authorization`
header — never in a URL; text `ping` every ~30 s, 10 s pong timeout, replaced every ~50 min, reconnect backoff
1 s · 2ⁿ capped at 5 min × 0.5–1.5); server-sent events `GET /v1/stream` while no socket can be opened; polling
`GET /v1/bundle` with `ETag` (every 30 s, every 5 min as a safety net while the socket is healthy). A pushed revision
is never replaced by an older HTTP answer, and an edge answer marked `X-NanoFlags-Stale` never moves the client backwards.

When the edge closes the socket with **4004** (environment deleted), the client stops reconnecting, keeps evaluating
its last configuration, reports `STALE` and an error with code `ENVIRONMENT_DELETED`.

## Trust and resilience

- **Signatures, on by default.** With the default base URL (`https://edge.nanoflags.io`) every bundle's Ed25519
  signature is verified against the embedded production keys (`NanoFlagsOptions.OFFICIAL_SIGNING_KEYS`) before it is
  used — over polling, the live socket and the persisted copy alike — and unsigned bundles are refused. The canonical
  string is `nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>`, hashed
  over the exact bytes the edge served. An unknown key id (a rotation) makes the client load `GET /v1/keys` once, at
  most once a minute. Bundles are pinned to the first environment they were signed for. Verification uses the JDK's
  Ed25519 provider on Java 15+ and a self-contained RFC 8032 verifier on Java 11–14, so no crypto dependency is needed.
- **Engine version.** A bundle whose `engine` is newer than `SUPPORTED_ENGINE_VERSION` is refused (code `ENGINE`).
- **Last good configuration.** Failed requests keep the current configuration (`STALE`). `store(new FileStore(path))`
  persists it (atomically, owner-only permissions where POSIX permissions exist) so a restart can evaluate before
  reaching the edge; the persisted copy is verified again on load. `bootstrap(Bundle)` / `bootstrapJson(String)` start
  from a configuration you ship.

## Options (`NanoFlagsOptions.builder()`)

| Option | Default |
| --- | --- |
| `baseUrl(url)` | `https://edge.nanoflags.io` |
| `service(name)` | `"unknown"` |
| `httpClient(HttpClient)` | a client using `ProxySelector.getDefault()` (honours `https.proxyHost`) |
| `pollInterval(d)` / `livePollInterval(d)` | 30 s / 5 min (`Duration.ZERO` disables polling) |
| `live(bool)` / `streaming(bool)` | `true` / `true` |
| `verify(VerifyOptions.builder().publicKey(…).fetchKeys(…).require(…).build())` / `withoutVerification()` | official edge: embedded keys, signatures required; other edges: off |
| `store(Store)`, `bootstrap(Bundle)`, `bootstrapJson(String)` | none |
| `events(EventsOptions.builder().sampleRate(…).flushInterval(…).reportInterval(…).redact(…).build())` / `EventsOptions.disabled()` | 10 % of evaluations, flushed every 10 s; service report every 60 s |
| `requestTimeout(d)` / `liveConnectTimeout(d)` | 10 s / 10 s |
| `logger(System.Logger)` | `System.getLogger("io.nanoflags.server")` (debug level only) |

**Telemetry never sends attribute values by default**: a sampled event carries the names of the attributes the flag's
rules use, mapped to their type (`{"plan": "string"}`), like every other NanoFlags SDK. `redact` replaces that with your
own function; `EventsOptions.disabled()` turns telemetry (including the service report) off.

## OpenFeature

```kotlin
dependencies { implementation("io.nanoflags:nanoflags-java-openfeature:0.1.0") }
```

```java
NanoFlagsClient flags = NanoFlagsClient.create(System.getenv("NANOFLAGS_SDK_KEY"));
OpenFeatureAPI api = OpenFeatureAPI.getInstance();
api.setProviderAndWait(NanoFlagsProvider.builder(flags).closeClient(true).build());
Client client = api.getClient();
boolean on = client.getBooleanValue("new-checkout", false, new ImmutableContext("user-42", Map.of("plan", new Value("pro"))));
```

The targeting key becomes the NanoFlags `key` (and wins over an attribute called `key`). Reasons: `DISABLED`,
`DEFAULT`, `TARGETING_MATCH`, `SPLIT` (percentage rollouts), `ERROR` with `FLAG_NOT_FOUND`, `PROVIDER_NOT_READY`,
`TYPE_MISMATCH` or `GENERAL`; the variant is the rule id; flag metadata carries `revision` and `ruleIndex`. The
provider emits `PROVIDER_READY`, `PROVIDER_STALE`, `PROVIDER_ERROR` and `PROVIDER_CONFIGURATION_CHANGED` with the keys of
the flags that changed.

## The engine

Package `io.nanoflags.server.engine` is a port of the TypeScript engine `@nanoflags/engine` that the dashboard, the
edge and every other SDK run — MurmurHash3 x86 32-bit bucketing over NFC-normalised UTF-8, rules, segments (nested up
to depth 4), all operators and their coercions, rollouts, traces. Configuration is JSON with JavaScript semantics, so
the port models JavaScript values exactly (`Number()`, `String()`, `JSON.stringify` order and number formatting,
truthiness), including for malformed configurations.

It is verified against the cross-language conformance fixtures generated from the TypeScript engine
(`packages/engine/fixtures/parity.json`: 21,998 evaluations, 340 hash vectors, 370 buckets, `supportsEngine` and
browser-view vectors) plus the Go port's `go/internal/testdata/extra.json` (3,491 further JavaScript corner cases,
compared including V8's error messages). Results are compared as canonical JSON text: value, reason, rule, bucket,
revision and the full trace.

### Why a standalone Java SDK and not a wrapper over `nanoflags-core` (Kotlin)

`io.nanoflags:nanoflags-core` is a mobile client SDK: it accepts client keys only (it refuses `nf_srv_…`), keeps one
evaluation context per app (`identify`), and brings the Kotlin standard library, kotlinx-coroutines, OkHttp and
BouncyCastle. A server SDK needs server keys, a context per call, and should not impose a Kotlin runtime or an HTTP
stack on Java services. This SDK is plain Java 11 with no runtime dependencies; it shares the specification
(the conformance fixtures, wire protocol and signature format) rather than code.

## Building and testing

JDK 11 or newer (CI tests 11, 17 and 21). The Gradle wrapper is included.

```sh
cd java
./gradlew test                                   # conformance (all fixtures), verification, fake-edge transport tests, OpenFeature
./gradlew publishAllPublicationsToStagingRepository   # Maven layout in build/staging-deploy (unsigned without a key; nothing is uploaded)
```

Opt-in, read-only check against the real edge (loads and verifies a signed bundle, opens the live socket):

```sh
NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_pub_… ./gradlew :nanoflags-java:test --tests '*ProductionTest*'
```

Publishing: [PUBLISHING.md](PUBLISHING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
