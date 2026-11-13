# nanoflags (Dart)

The NanoFlags client SDK for Dart and Flutter. Flags are evaluated **locally and synchronously**
against a signed configuration bundle that is kept current in the background: the edge pushes new
revisions over a live WebSocket, with SSE and polling (ETag) as fallbacks. Works in the Dart VM,
Flutter on Android / iOS / macOS / Windows / Linux, and Flutter web (dart2js and Wasm).

For Flutter widgets (`NanoFlagsProvider`, `FlagBuilder`, lifecycle handling, `shared_preferences`
persistence) use [`nanoflags_flutter`](../nanoflags_flutter). For OpenFeature use
[`nanoflags_openfeature`](../nanoflags_openfeature).

**Client keys only.** Apps ship to users, so this SDK takes browser/mobile keys (`nf_pub_…`). They
receive the *client view*: client-exposed flags and only the segments those flags reference. Server
keys (`nf_srv_…`) are refused with an `ArgumentError`.

## Install

```yaml
dependencies:
  nanoflags: ^0.1.0
```

## Quickstart

```dart
import 'package:nanoflags/nanoflags.dart';

final flags = NanoFlagsClient(const NanoFlagsOptions(
  sdkKey: 'nf_pub_…',
  service: 'android-app',
  context: {'key': 'user-42', 'plan': 'pro', 'country': 'DE'},
));

await flags.ready(timeout: const Duration(seconds: 5));

if (flags.boolVariation('new-checkout', false)) {
  // …
}
final accent = flags.stringVariation('accent', 'blue');
final limit = flags.numberVariation('upload-limit', 10);
final config = flags.jsonVariation('onboarding', const {'steps': 3});

// Detail: value + reason (rule_match, default, off, flag_not_found, error) + matched rule + revision.
final d = flags.boolVariationDetail('new-checkout', false);
print('${d.value} because ${d.reason} (rule ${d.ruleId}, r${d.revision})');

// Every flag at once (no telemetry recorded).
final all = flags.allFlags();

// The user signs in: change the context locally — no network round trip.
flags.identify('user-43', {'plan': 'free'});
flags.updateContext({'country': 'FR'}); // merge; a null value removes an attribute

// React to changes.
flags.updates.listen((e) => print('now r${e.revision} via ${e.transport.name}, ${e.latency?.inMilliseconds} ms after commit'));
flags.changes.listen((_) => rebuild()); // configuration, status or context changed
flags.errors.listen((e) => log(e)); // background problems; never thrown from accessors
```

Accessors never perform I/O and never throw: without a configuration (or for a missing flag, or a
value of another type) they return the fallback. The `context:` argument of every accessor merges
attributes over the current context for that one call.

## API

| | |
| --- | --- |
| `NanoFlagsClient(NanoFlagsOptions, {httpClient, webSocketConnector, random})` | starts loading immediately (stored bundle + edge in parallel) |
| `ready({timeout})` | completes once a configuration is loaded, or the first attempt finished without one; never fails |
| `status` | `notReady`, `ready`, `stale` (usable, not known to be current) |
| `revision`, `bundle`, `transport` (`live` / `stream` / `poll` / `paused`), `context`, `version` | state |
| `boolVariation`, `stringVariation`, `numberVariation`, `jsonVariation` | typed values |
| `…VariationDetail` → `EvaluationDetail<T>` | value, reason, ruleIndex, ruleId, inRollout, bucket, revision, error, trace |
| `evaluate(key, fallback)` → `Evaluation` | raw engine result |
| `allFlags()` | every flag's value for the current context |
| `setContext`, `identify`, `updateContext` | local context changes (fire `changes`) |
| `updates`, `changes`, `errors` | broadcast streams |
| `refresh()` | revalidate now (and reconnect the socket immediately if it is down) |
| `pause()` / `resume()` | background / foreground (the Flutter package calls these for you) |
| `setDataSaver(bool)` | metered / low-data networks |
| `flush()`, `close()` | telemetry, shutdown |

`package:nanoflags/engine.dart` exposes the engine alone (`evaluate`, `murmur3`, `bucketOf`,
`clientBundle`, `supportsEngine`); `package:nanoflags/verify.dart` the signature primitives;
`package:nanoflags/io.dart` the native `FileStore`.

## Options (defaults)

| Option | Default | |
| --- | --- | --- |
| `baseUrl` | `https://edge.nanoflags.io` | |
| `service` | `unknown` | shown in "which revision is this app running" |
| `pollInterval` | 60 s | while no socket is open; `Duration.zero` disables polling |
| `livePollInterval` | 5 min | safety poll while the socket is healthy |
| `streaming` / `live` | true / true | `/v1/live` WebSocket first, SSE `/v1/stream` when it cannot be opened |
| `bootstrap` | none | a bundle (map or JSON text) shipped with the app; used until something newer arrives |
| `store` | none (Flutter: `SharedPreferencesStore`) | persistence of the last verified bundle |
| `events` | sample 10 %, flush 30 s, report 5 min | `EventsOptions.off()` disables telemetry |
| `verify` | official edge: embedded keys, unsigned refused | see below |
| `dataSaver` / `dataSaverPollInterval` | false / 15 min | |

## Security: signed bundles

Every bundle is verified **before** it replaces the current one: Ed25519 over
`nanoflags-bundle-v1\n<environment>\n<revision>\n<checksum>\n<sha256 of the bundle text>`, where
the bundle text is the exact bytes the edge signed (the raw `"bundle"` member of `/v1/bundle`, or the
`bundle` string of a live message — never a re-serialisation). With the official edge the SDK uses
the embedded key list (`officialSigningKeys`, kid `k1`, the same keys as every NanoFlags SDK) and
refuses unsigned bundles; a bundle naming an unknown key id loads `GET /v1/keys` once (at most once
a minute). Tampered, unsigned (with `require`), wrong-environment or newer-engine bundles are refused:
the previous configuration stays and an error is emitted. A stored bundle is verified again when it
is loaded at startup. Other edges: pass `VerifyOptions(publicKeys: […])` (pinning, strongest) or
`VerifyOptions(fetchKeys: true)`.

## Transports and mobile lifecycle

* **Live** (`/v1/live`): the key travels in the `Authorization` header on native platforms and in the
  subprotocol list (`["nanoflags.v1", "key.<key>"]`) on the web — never in the URL. The edge pushes the
  signed bundle itself (no follow-up request). Ping every ~30 s (10 s pong timeout), replaced every
  ~50 min, reconnect with jittered backoff (1 s·2ⁿ, max 5 min, ×0.5–1.5). Close code **4004**
  (environment deleted): no reconnect, the last bundle is kept, status `stale`, error
  `environmentDeleted`.
* **SSE** (`/v1/stream`) when the socket cannot be opened, then **polling** with `If-None-Match`.
* **Background:** `pause()` closes the socket and stream, stops polling and flushes telemetry once;
  `resume()` reconnects (the socket's `hello` carries the current revision) and revalidates when the last
  check is older than 30 s. **Offline-first:** with a `store`, the last verified bundle is available at
  startup (status `stale` until the edge confirms it). **Data saver:** no socket, no stream, polling every
  15 min, telemetry held back — Flutter has no portable "metered network" signal, so the app decides
  (Android `ConnectivityManager.isActiveNetworkMetered`, iOS `NWPath.isConstrained`/`isExpensive`
  through a platform channel, or a user setting).
* Native requests send `User-Agent: nanoflags-dart/0.1.0 (<os>)` (the edge answers 403 to default
  library agents). Proxies from `HTTPS_PROXY` are honoured on native platforms.

## Telemetry

Like the other SDKs: a service report (`sdk: "dart/0.1.0"`, revision) and sampled evaluation events
whose context carries **attribute names and types only, never values** (e.g. `{"plan": "string"}`,
limited to attributes the flag's rules use). `EventsOptions.off()` opts out; `redact` customises it.

## Engine parity

The engine is a port of `@nanoflags/engine` with JavaScript semantics (number formatting,
`String()` coercions, `JSON.stringify` key order, `typeof`, loose property access on malformed
configuration, V8 error messages) and MurmurHash3 over the UTF-8 bytes of NFC-normalised
`seed:identity` (lone surrogates become U+FFFD, as `TextEncoder` does). Dart strings are UTF-16 like
JavaScript strings, so `contains` / `starts_with` / `ends_with` behave identically.

```
dart test                       # VM: 21 998/21 998 shared cases + 3 491/3 491 Go corner cases (error messages included)
dart test -p node test/web_parity_test.dart   # same suites compiled to JavaScript
NANOFLAGS_SDK_KEY=nf_pub_… NANOFLAGS_LIVE=1 dart test -t live   # production check (one demo toggle, restored)
NANOFLAGS_SDK_KEY=nf_pub_… dart run tool/live_verify.dart       # latency measurement
```

Measured (production, public demo key, Dart 3.14 VM behind an HTTPS proxy, Nov 13 2026, 4 toggles,
all delivered over `live`): toggle returned → `updates` event median 33 ms (22–48); commit → update as
the SDK reports it median 204 ms (192–227); toggle sent → update median 855 ms (includes the toggle
round trip).

## License

Apache-2.0 (see LICENSE and NOTICE).
