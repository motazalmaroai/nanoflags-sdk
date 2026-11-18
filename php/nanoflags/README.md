# nanoflags/nanoflags (PHP)

Server SDK for [NanoFlags](https://nanoflags.io) feature flags, built for the way PHP runs: one request at a time,
nothing kept between requests. Flags are evaluated **locally** against a signed configuration bundle that is shared
between requests through a cache (APCu, a directory, or any PSR-16 cache) and revalidated with a cheap conditional
request (`If-None-Match` → `304 Not Modified`). A variation call never throws.

- PHP 8.1+. Framework-agnostic (Laravel, Symfony, Slim, WordPress, plain PHP), PSR-16 caches and PSR-18 HTTP
  clients plug in; the built-in transport uses ext-curl (or PHP streams).
- Native port of the NanoFlags engine, checked against the TypeScript engine with the shared parity fixtures
  (~22 000 cases in `packages/engine/fixtures/parity.json`, plus ~3 500 JavaScript corner cases with V8's error
  messages in `go/internal/testdata/extra.json`): same values, reasons, rollout buckets and traces as every other SDK.
- Signature verification **on by default** for the hosted edge (Ed25519 via ext-sodium or
  paragonie/sodium_compat); unsigned or tampered bundles are refused, also when read back from the cache.
- Sampled telemetry with the same default redaction as the other SDKs: attribute **values never leave the process**.
- Optional sync daemon (`vendor/bin/nanoflags-sync`) for fleets that should never wait for the edge.

## Install

```sh
composer require nanoflags/nanoflags
composer require nanoflags/openfeature-provider   # optional: OpenFeature
```

Recommended extensions: `sodium` (signature verification; bundled with most PHP builds), `curl`, `apcu` (the
default shared cache under PHP-FPM) and `intl` (faster Unicode normalisation; a polyfill is used otherwise).

## Quickstart

```php
use NanoFlags\Client;

$flags = new Client(
    getenv('NANOFLAGS_SDK_KEY'),   // nf_srv_… (server view) or nf_pub_… (client-exposed flags only)
    service: 'checkout-api',       // shown in "which revision is each service running"
);

$user = ['key' => $userId, 'plan' => 'beta', 'country' => 'DE'];

if ($flags->boolVariation('new-checkout', false, $user)) {
    // …
}
$accent = $flags->stringVariation('accent', 'blue', $user);
$limit  = $flags->numberVariation('rate-limit', 100, $user);    // int for whole numbers, else float
$layout = $flags->jsonVariation('layout', ['cols' => 3], $user);  // associative arrays

$d = $flags->boolVariationDetail('new-checkout', false, $user);
echo $d->value, $d->reason, $d->ruleId, $d->revision;           // true rule_match beta 57
```

Each variation takes the flag key, the value to serve when the flag cannot be evaluated (nothing loaded yet,
unknown flag, value of another type), and the context: an associative array of JSON-like attributes. `key` is the
stable identity used for percentage rollouts. Constructing a client does no I/O; the first evaluation loads the
configuration.

## How it works in PHP

| Situation | What happens |
| --- | --- |
| First evaluation of a request, bundle in the cache revalidated less than `cacheTtl` (30 s) ago | No network: the cached bundle is used (status `ready`). |
| Bundle older than `cacheTtl` | One conditional `GET /v1/bundle` with the cached ETag (timeout `timeout`, 3 s). Usually `304`; a new revision is verified, cached and used. |
| Edge unreachable, slow or failing | The cached bundle keeps serving (status `stale`); the edge is asked again after `retryInterval` (5 s), not on every request. |
| Nothing cached and the edge unreachable | `bootstrap` if given, otherwise your defaults (status `not-ready`). |
| Long-running PHP (Octane, RoadRunner, Swoole, queue workers) | Reuse one client; it revalidates by itself once `cacheTtl` has passed. Call `flush()` after each job or request to send telemetry. |

The cache entry holds the exact signed bytes; every read verifies the signature again (the cache is outside the
trust boundary), with the parsed result memoised per process. Within one client, the configuration does not change
during a request.

### Choosing the cache

```php
use NanoFlags\Store\{ApcuStore, FileStore, Psr16Store};

new Client($key);                                              // default: APCu when enabled, else a private dir in sys_get_temp_dir()
new Client($key, cache: new FileStore('/var/cache/nanoflags')); // shared by every process of the machine
new Client($key, cache: Cache::store('redis'));                 // Laravel: any PSR-16 cache, shared by all servers
new Client($key, cache: new Symfony\Component\Cache\Psr16Cache($pool));
new Client($key, cache: false);                                 // no cache: every client fetches (CLI scripts)
```

APCu is per PHP-FPM pool and machine; a Redis or Memcached PSR-16 cache shares one bundle (and one revalidation)
across a fleet. Directories are created with mode 0700 and files written atomically with mode 0600.

### Sync daemon (relay mode)

With the daemon, web requests never wait for the edge: it keeps the shared cache current, over the edge's event
stream (`/v1/stream`) with a safety poll, and the web workers only read the cache.

```php
// config/nanoflags.php — the same key, base URL and cache as the web workers
return new NanoFlags\Client(getenv('NANOFLAGS_SDK_KEY'), service: 'web', cache: new NanoFlags\Store\FileStore('/var/cache/nanoflags'));
```

```sh
vendor/bin/nanoflags-sync config/nanoflags.php              # runs until stopped (systemd, supervisord, a sidecar)
vendor/bin/nanoflags-sync config/nanoflags.php --once       # one revalidation (cron), exit code 1 when not current
```

```php
// web workers: never fetch, read what the daemon cached
$flags = new Client(getenv('NANOFLAGS_SDK_KEY'), service: 'web', cache: new FileStore('/var/cache/nanoflags'), refresh: false);
```

APCu is not shared with a CLI process; use a directory or a networked PSR-16 cache with the daemon. Without
`refresh: false`, workers still revalidate on their own whenever the daemon falls behind.

### Laravel

```php
// app/Providers/AppServiceProvider.php
$this->app->scoped(NanoFlags\Client::class, fn () => new NanoFlags\Client(
    config('services.nanoflags.key'),
    service: config('app.name'),
    cache: Cache::store(),          // any configured store
    logger: Log::channel(),
));
// usage: app(NanoFlags\Client::class)->boolVariation('new-checkout', false, ['key' => (string) auth()->id()])
```

Under Octane use `scoped` as above (a fresh client per request, one cache) or a singleton plus `flush()` in a
terminating callback.

### Symfony

```yaml
# config/services.yaml
services:
    nanoflags.cache:
        class: Symfony\Component\Cache\Psr16Cache
        arguments: ['@cache.app']
    NanoFlags\Client:
        arguments:
            $sdkKey: '%env(NANOFLAGS_SDK_KEY)%'
            $service: 'checkout-api'
            $cache: '@nanoflags.cache'
            $logger: '@logger'
```

### PSR-18 HTTP client

```php
new Client($key, http: $psr18Client, requestFactory: $psr17Factory, streamFactory: $psr17Factory);
```

Configure the client's own timeout (short: a bundle request can run on the request path) and disable redirects.
The built-in curl transport honours `HTTPS_PROXY` / `NO_PROXY` and `CURL_CA_BUNDLE` / `SSL_CERT_FILE`.

### Test sessions (`x-nanoflags-session`)

A test session, created in the dashboard (**Scenarios → Shared test session**), pins a configuration snapshot and a
synthetic context to a token (`nf_ts_…`). A service that receives the token in the `x-nanoflags-session` header
evaluates against that snapshot, with the context `session context + your context` (yours wins), for that request
only. Sampled events from a session carry its id. Shared test sessions are part of the Scale plan.

```php
// Plain PHP / Laravel / Symfony: the header of the current request
$f = $flags->sessionFromGlobals();              // or $flags->session($request->headers->get('x-nanoflags-session'))
$f->boolVariation('checkout-v2', false, ['key' => $userId]); // session-scoped while the session is active
$f->isActive(); $f->id(); $f->expiresAt(); $f->revision();
$http->request('GET', $pricingUrl, ['headers' => $f->headers()]); // the next service joins the session ([] outside one)

// PSR-15 (Slim, Mezzio, …): the evaluator becomes the request attribute "nanoflags.flags"
$app->add(new NanoFlags\SessionMiddleware($flags));
$f = $request->getAttribute(NanoFlags\SessionMiddleware::ATTRIBUTE);
```

- `session($token, $service = null)` asks the edge once per token and service (`GET /v1/session`, the token in
  `X-NanoFlags-Session`, `$service` — default: the client's `service` — in `X-NanoFlags-Service`). It **never throws**:
  an unknown, expired, revoked or not permitted session (or a failed lookup, reported as a `session` error) gives an
  evaluator that behaves exactly like the client, so one code path serves normal traffic and tests. When a session
  expires mid-request, `isActive()` turns false and evaluations continue on the published configuration.
- **Caching.** An active session is kept until it expires: in the client and in the shared cache, under its own key
  (`nanoflags.session.<hash>.<client>`, a hash of service and token — the token itself is never stored, and the
  bundle entry that every other request uses is never touched), with the session's expiry as TTL (at most 1 h, then
  it is asked for again). Unknown tokens are remembered for 15 s and failed lookups for 3 s **in the client only**, so
  arbitrary header values cannot fill the shared cache. `offline: true` resolves nothing; with `refresh: false` sessions
  are still fetched on demand (the sync daemon cannot know the tokens).
- `NanoFlags\SessionMiddleware` implements PSR-15's `MiddlewareInterface`, which every PSR-15 framework already
  installs (`psr/http-server-middleware`); it is not a dependency of this package, so do not load the class without it.
- A session changes which snapshot and context an evaluation uses. It grants no data access and must not be used for
  authorization. Client keys only receive client-exposed flags, in sessions too. Session bundles are not signed;
  verification does not apply to them. A revoked session keeps working where it is cached until it expires.

### OpenFeature

```php
use NanoFlags\OpenFeature\NanoFlagsProvider;
use OpenFeature\OpenFeatureAPI;
use OpenFeature\implementation\flags\EvaluationContext;

$api = OpenFeatureAPI::getInstance();
$api->setProvider(new NanoFlagsProvider(new NanoFlags\Client(getenv('NANOFLAGS_SDK_KEY'), service: 'web')));
$api->getClient()->getBooleanValue('new-checkout', false, new EvaluationContext($userId));
```

See [`nanoflags/openfeature-provider`](../openfeature-provider/README.md).

## API

| | |
| --- | --- |
| `new Client($sdkKey, baseUrl:, service:, cache:, cacheTtl:, refresh:, offline:, timeout:, retryInterval:, bootstrap:, verify:, events:, http:, requestFactory:, streamFactory:, logger:, onError:)` | the client (named arguments) |
| `boolVariation` / `stringVariation` / `numberVariation` / `jsonVariation($key, $default, $context = null)` | typed value |
| `*VariationDetail(...)` → `EvaluationDetail` | `value`, `reason` (`rule_match`, `default`, `off`, `flag_not_found`, `error`), `ruleIndex`, `ruleId`, `inRollout`, `bucket`, `revision`, `trace`, `error`, `json()`, `typeName()` |
| `evaluate($key, $default, $context)` | engine result without a type check |
| `allFlags($context)` / `allFlagsDetail($context)` | every flag of the configuration (no telemetry) |
| `status()` (`not-ready` / `ready` / `stale`), `revision()`, `source()` (`network` / `cache` / `bootstrap`), `isReady()`, `bundleJson()` | state |
| `onError(callable)` → unsubscribe, `lastError()` | errors (`NanoFlagsException` with `errorCode`) |
| `refresh()`, `flush()`, `run($pollInterval, $stream, $duration)` | revalidate now, send telemetry now, sync loop (daemon) |
| `session($token, $service = null)`, `sessionFromGlobals($service = null)` → `SessionEvaluator` | test session: the typed variations, `evaluate`, `isActive()`, `id()`, `expiresAt()`, `revision()`, `headers()` |
| `SessionMiddleware`, `Client::SESSION_HEADER`, `Client::isSessionToken($v)` | PSR-15 middleware, header name, token check |

`baseUrl` defaults to the hosted edge `https://edge.nanoflags.io`. Error codes: `network`, `unauthorized`, `http`,
`invalid_bundle`, `store`, `config`, `signature`, `engine`, `session`. Nothing is ever thrown from a variation call; without a
listener or logger, errors are only visible through `lastError()`.

## Behaviour

- **Signature verification.** Every bundle (from the edge and from the cache) is checked (Ed25519 over the
  canonical string, by `kid`) before it is used. With the hosted edge this is on by default with the embedded
  production keys (`Keys::OFFICIAL_SIGNING_KEYS`) and unsigned bundles are refused; a bundle naming an unknown
  `kid` (key rotation) loads `GET /v1/keys` once (at most once a minute, shared through the cache). For a
  self-hosted edge pass `verify: ['publicKeys' => [$jwk], 'require' => true]` (or `verify: true` to use the edge's
  `/v1/keys`); `verify: false` turns it off. Once a bundle of one environment was accepted, bundles signed for
  another environment are refused. The raw signed bytes are hashed exactly as served, never a re-serialisation.
  Without ext-sodium or paragonie/sodium_compat, verified mode refuses every bundle (a `config` error says so).
- **Served stale.** When the edge itself serves its last-known-good copy (`X-NanoFlags-Stale`), the client never
  goes back to an older revision than the one it has.
- **Engine version.** Bundles produced for a newer evaluation engine (`bundle.engine` > `Client::SUPPORTED_ENGINE_VERSION`)
  are refused (`engine` error); the cached configuration stays in use: upgrade the SDK.
- **Telemetry.** A sampled 10 % of evaluations are recorded. Context **values never leave the process** by default:
  only the names (and value types) of the attributes the flag's rules use, e.g. `{"plan": "string"}`. Events are
  buffered in the cache and sent at most once per `flushInterval` (10 s) at the end of a request, with the service
  report at least every `reportInterval` (60 s). `events: ['redact' => fn (array $ctx) => [...]]` customises the
  context, `events: false` turns telemetry off. Telemetry is best effort: never retried, and concurrent requests can
  drop some buffered events.
- **Offline.** `offline: true` never touches the network (bootstrap and cache only, no telemetry), for tests and
  air-gapped builds. `bootstrap:` takes a bundle (JSON text or a decoded array) used when nothing better is available.
- **Not included:** the live WebSocket (`/v1/live`); request-scoped PHP revalidates per request instead, and the sync
  daemon uses the event stream.

## Development

```sh
composer install
vendor/bin/phpunit                       # unit, parity and local HTTP tests (no key, no network)
NANOFLAGS_LIVE=1 vendor/bin/phpunit --group live   # read-only check against the hosted edge (public demo key)
```

`tests/ParityTest.php` runs the shared engine fixtures (`../../packages/engine/fixtures/parity.json` and
`../../go/internal/testdata/extra.json`, or `NANOFLAGS_PARITY_FIXTURES` / `NANOFLAGS_EXTRA_FIXTURES`).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The NanoFlags name and logo are not covered by
the license.
