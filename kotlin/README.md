# NanoFlags for Android and Kotlin

Feature flags evaluated **on the device**, kept current by a **live WebSocket**, verified with **Ed25519 signatures**
and stored for an **offline-first** start. Version 0.1.0, Apache-2.0.

| Artifact | What it is |
| --- | --- |
| `io.nanoflags:nanoflags-core` | Pure Kotlin/JVM: the evaluation engine (a port of `@nanoflags/engine`), signature verification, transport (live WebSocket → SSE → polling with ETag), the client. Runs on Android and any JVM. |
| `io.nanoflags:nanoflags-android` | Android wiring: `ProcessLifecycleOwner`, `ConnectivityManager` (offline, metered networks, Data Saver), storage in `noBackupFilesDir`, Jetpack Compose helpers. minSdk 21. |
| `io.nanoflags:nanoflags-openfeature` | Provider for the official OpenFeature Kotlin SDK (`dev.openfeature:kotlin-sdk` 0.9). |

Apps use **client keys only** (`nf_pub_…`): they receive the client view of the environment (client-exposed flags
and only the segments those flags reference). Server keys (`nf_srv_…`) are refused by the constructor.

## Quickstart (Android)

```kotlin
// build.gradle.kts
dependencies {
    implementation("io.nanoflags:nanoflags-android:0.1.0")
}
```

```kotlin
class App : Application() {
    lateinit var flags: NanoFlags

    override fun onCreate() {
        super.onCreate()
        flags = NanoFlagsAndroid.create(this, "nf_pub_…") {
            context = NanoFlagsContext("anonymous", mapOf("platform" to "android"))
        }
    }
}

// Anywhere: local and synchronous (no I/O). On any problem the default is returned.
if (flags.boolVariation("new-checkout", false)) showNewCheckout()
val accent = flags.stringVariation("accent", "blue")

// After sign-in: changes every evaluation at once, no network round trip.
flags.identify(NanoFlagsContext(user.id, mapOf("plan" to user.plan, "country" to user.country)))
```

Jetpack Compose:

```kotlin
setContent {
    ProvideNanoFlags(flags) {
        val newCheckout by rememberFlag("new-checkout", false) // recomposes on every new configuration or identify()
        if (newCheckout) NewCheckout() else OldCheckout()
    }
}
// or with any Flow API: flags.boolFlow("new-checkout", false).collectAsState(initial = false)
```

Wait for the first configuration (e.g. behind a splash screen):

```kotlin
lifecycleScope.launch {
    val ready = flags.waitUntilReady(timeoutMs = 3_000) // true when a configuration is in use (network, storage or bootstrap)
}
```

## API

| | |
| --- | --- |
| `boolVariation`, `stringVariation`, `doubleVariation`, `intVariation`, `jsonVariation` | Typed values; a value of another type returns the default with reason `error`. Each has a `…Detail` variant returning `EvaluationDetail` (`value`, `reason` — `rule_match`, `default`, `off`, `flag_not_found`, `error` —, `ruleIndex`, `ruleId`, `inRollout`, `bucket`, `revision`, `trace`, `error`). An optional last parameter evaluates for another context. |
| `evaluate(key, default)`, `allFlags()`, `allFlagsDetail()` | Untyped evaluation; every flag of the configuration. |
| `identify(context)` / `setContext(context)` / `context: StateFlow` | The client's evaluation context. `NanoFlagsContext(key, attributes)`; `key` is the bucketing identity for percentage rollouts. |
| `boolFlow`, `stringFlow`, `doubleFlow`, `intFlow`, `jsonFlow`, `allFlagsFlow` | Cold flows of a value for the current context, distinct, re-evaluated on every new configuration or context. |
| `changes: SharedFlow<ChangeEvent>` | Every adopted configuration (`revision`, `previousRevision`, `source` network/store/bootstrap, `transport`, `latencyMs` commit → device for pushed revisions). |
| `status: StateFlow<Status>` | `NOT_READY`, `READY` (known current), `STALE` (in use but not confirmed: offline, restored from storage, environment deleted). |
| `transport: StateFlow<Transport>` | `LIVE`, `STREAM`, `POLL`, `PAUSED` (background, offline or the network policy). |
| `errors: SharedFlow<NanoFlagsException>` | Background problems (`code`: network, http, unauthorized, invalid_bundle, signature, engine, store, environment_deleted). They never change the configuration in use. |
| `suspend waitUntilReady(timeoutMs)`, `suspend refresh()`, `suspend flush()`, `close()` | |
| `addChangeListener`, `addStatusListener`, `addErrorListener` | Callback alternatives for Java (background thread; close the returned handle to unregister). |
| `setForeground(Boolean)`, `setNetworkState(NetworkState)` | Platform signals (`nanoflags-android` calls them for you). |

### Options (`NanoFlagsOptions`)

`baseUrl` (default `https://edge.nanoflags.io`), `service` (Android: the application id), `context`, `bootstrap`
(bundle JSON shipped in the app, used until something newer is available), `store` (Android: a file in
`noBackupFilesDir`; `null` disables persistence), `verify` (`VerifyOptions`), `live` (WebSocket, default on),
`streaming` (realtime at all), `pollIntervalMs` (30 s without a socket), `livePollIntervalMs` (safety poll every
5 min while the socket is healthy), `meteredPolicy` (default `LIVE`), `dataSaverPolicy` (default `POLL`: no socket
while Data Saver restricts background data), `events { enabled, sampleRate, flushIntervalMs, reportIntervalMs,
redact }`, `httpClient` (an `OkHttpClient` to build on: proxies, pinning, interceptors), `requestTimeoutMs`,
`dispatcher`, `logger`.

## How it stays current

1. **Live WebSocket** `GET /v1/live` (subprotocol `nanoflags.v1`, key in the `Authorization` header — never in a URL).
   The edge pushes each revision with its signed bundle; the client verifies, swaps atomically and emits a
   `ChangeEvent`. Text `ping` every ~30 s (10 s pong timeout), the socket is replaced every ~50 min, reconnects use
   jittered exponential backoff (1 s · 2ⁿ, capped at 5 min, × 0.5–1.5). Close code **4004** (environment deleted):
   no reconnect, the last configuration stays in use, status `STALE`.
2. **SSE** `/v1/stream` while no socket can be opened; it only announces revisions, which are then fetched.
3. **Polling** `/v1/bundle` with `If-None-Match` (a `304` costs a few hundred bytes). A pushed revision is never
   replaced by an older HTTP answer.

**Mobile lifecycle** (`nanoflags-android`): in the background the socket is closed and polling stops (queued
telemetry is sent first); on return to the foreground the client reconnects and revalidates at once if the
configuration may be out of date. Without a network nothing is attempted; when the network returns, the client
revalidates. The bundle is persisted after every update and re-verified when loaded.

## Security

- Every bundle from the official edge must carry a valid **Ed25519** signature (by key id) over
  `nanoflags-bundle-v1\n<environment>\n<revision>\n<checksum>\n<sha256 of the exact bundle bytes>`; unsigned or
  tampered bundles are refused and the configuration in use is unchanged. The production keys are embedded
  (`OFFICIAL_SIGNING_KEYS`, kid `k1`); an unknown key id (a rotation) loads `GET /v1/keys` once, at most once a
  minute. The first verified environment id is pinned: a bundle signed for another environment is refused.
- The verifier is BouncyCastle's lightweight `Ed25519Signer` (works on API 21+; Android's JDK EdDSA provider only
  exists from API 33). After R8 only ~17 BouncyCastle classes remain in an app (measured with the sample's release
  build).
- Persisted bundles are outside the trust boundary: re-verified on load; with signatures required an unsigned copy
  is never used. The store holds a non-secret fingerprint of the key, never the key.
- Bundles needing a newer engine (`engine` > 1) are refused (`ErrorCode.ENGINE`).

## Telemetry

Like the other SDKs: a service report ("this app runs revision N") and sampled evaluation events (10 %) to
`POST /v1/events`, reported as `android/0.1.0` (or `kotlin/0.1.0`). Events carry the **names of the attributes the
flag's rules use and the type of their values — never values**. Sent only while the app is in the foreground and
online, every 30 s when events are queued, otherwise one report per minute. Opt out with `events { enabled = false }`.

## OpenFeature

```kotlin
implementation("io.nanoflags:nanoflags-openfeature:0.1.0")

OpenFeatureAPI.setProviderAndWait(NanoFlagsProvider(flags), initialContext = ImmutableContext("user-42"))
val on = OpenFeatureAPI.getClient().getBooleanValue("new-checkout", false)
```

`targetingKey` becomes `key`; reasons: `DISABLED` (off), `DEFAULT`, `TARGETING_MATCH` (fixed rule), `SPLIT` (rollout);
the variant is the rule id; `setEvaluationContext` calls `identify`; configuration changes and status changes are
provider events.

## Building and testing

JDK 17 and (for the Android modules) the Android SDK (`ANDROID_HOME`, platform 34).

```bash
./gradlew :nanoflags-core:test                       # parity (all fixtures), verification, fake-edge transport tests
./gradlew :nanoflags-android:testDebugUnitTest       # Robolectric: lifecycle, network, storage wiring
./gradlew :nanoflags-openfeature:test
./gradlew connectedAndroidTest                       # on a device / emulator (CI: ci/mobile-android.yml)
./gradlew -Pnanoflags.skipAndroid=true :nanoflags-core:test   # without an Android SDK
```

Production checks are opt-in (they toggle the public demo, which is rate limited — they restore the original value):

```bash
NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=<demo browser key> ./gradlew :nanoflags-core:test --tests '*ProductionTest*'
./gradlew connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.nanoflagsSdkKey=<demo browser key>
```

The parity suite reads `packages/engine/fixtures/parity.json` (21,998 cases generated from the TypeScript engine,
plus murmur3, bucket, `supportsEngine` and browser-view vectors) and the Go port's extra corner cases.

Publishing: [PUBLISHING.md](PUBLISHING.md).
