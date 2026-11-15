# nanoflags (Ruby)

Server SDK for [NanoFlags](https://nanoflags.io) feature flags. Flags are evaluated **locally and synchronously**
against a signed, in-memory configuration bundle; a variation call never does I/O and never raises. Background
threads keep the bundle current: the edge's event stream (`/v1/stream`) announces each new revision, which is then
fetched with ETag revalidation, with polling as the safety net.

- Ruby 3.1+. No runtime dependencies (Net::HTTP, OpenSSL and JSON from the standard library).
- Native port of the NanoFlags engine, checked against the TypeScript engine with the shared parity fixtures
  (~22 000 cases in `packages/engine/fixtures/parity.json`, plus ~3 500 JavaScript corner cases with V8's error
  messages in `go/internal/testdata/extra.json`): same values, reasons, rollout buckets and traces as every other SDK.
- Signature verification **on by default** for the hosted edge's embedded key list; unsigned or tampered bundles
  are refused and the last good configuration stays in use.
- Thread-safe and fork-safe (Puma, Unicorn, Passenger, Resque, Sidekiq Swarm); an OpenFeature provider ships as
  [`nanoflags-openfeature`](../nanoflags-openfeature/README.md).

## Install

```ruby
# Gemfile
gem "nanoflags"
gem "nanoflags-openfeature" # optional: OpenFeature
```

## Quickstart

```ruby
require "nanoflags"

FLAGS = NanoFlags::Client.new(
  ENV.fetch("NANOFLAGS_SDK_KEY"), # nf_srv_… (server view) or nf_pub_… (client-exposed flags only)
  service: "checkout-api"         # shown in "which revision is each service running"
)
FLAGS.on_error { |e| Rails.logger.warn("nanoflags #{e.code}: #{e.message}") } # before the first load completes
FLAGS.wait_until_ready(5) # never raises; true once a configuration is in use

user = { key: current_user.id.to_s, plan: current_user.plan, country: "DE" }
if FLAGS.bool_variation("new-checkout", false, user)
  # …
end
accent = FLAGS.string_variation("accent", "blue", user)
limit  = FLAGS.number_variation("rate-limit", 100, user)        # Integer for whole numbers, else Float
layout = FLAGS.json_variation("layout", { "cols" => 3 }, user)  # Hash with String keys

d = FLAGS.bool_variation_detail("new-checkout", false, user)
puts d.value, d.reason, d.rule_id, d.revision # true rule_match beta 57

FLAGS.on_change { |e| puts "now on r#{e.revision} via #{e.transport}" }
```

Create **one client per process** and share it between threads. Each variation takes the flag key, the value to
serve when the flag cannot be evaluated (no configuration yet, unknown flag, value of another type), and the
context: a Hash of JSON-like attributes (String or Symbol keys; Time and Date become ISO 8601 strings). `key` is the
stable identity used for percentage rollouts.

### Rails

```ruby
# config/initializers/nanoflags.rb
Rails.application.config.after_initialize do
  NANOFLAGS = NanoFlags::Client.new(
    Rails.application.credentials.nanoflags_sdk_key,
    service: "web",
    cache_path: Rails.root.join("tmp/nanoflags.json"), # optional: start from the last good bundle
    logger: Rails.logger
  )
end
```

### Puma, Unicorn, Passenger and other forking servers

The client is fork-safe: a forked worker keeps the configuration it inherited (it can evaluate immediately) and
restarts its own background threads on its first call; events queued before the fork are sent by the parent only.
To start the threads as soon as a worker boots, call `NanoFlags::Client.after_fork` from the server's hook:

```ruby
# config/puma.rb
on_worker_boot { NanoFlags::Client.after_fork }
```

With `preload_app!`, creating the client in the master is fine; pass `start: false` there if the master should not
open any connection, and the workers start it on first use.

### Sidekiq and other threaded workers

Use the same process-wide client from every job; evaluations are lock-free reads of the current bundle. Call
`FLAGS.close` on shutdown only if you need the final telemetry flush synchronously (an `at_exit` hook does it too).

## API

| | |
| --- | --- |
| `NanoFlags::Client.new(sdk_key, base_url:, service:, poll_interval:, streaming:, bootstrap:, cache_path:, store:, events:, verify:, on_change:, on_error:, logger:, start:, http:, request_timeout:)` | the client |
| `bool_variation` / `string_variation` / `number_variation` / `json_variation(key, default, context = nil)` | typed value |
| `*_variation_detail(...)` → `NanoFlags::EvaluationDetail` | `value`, `reason` (`rule_match`, `default`, `off`, `flag_not_found`, `error`), `rule_index`, `rule_id`, `in_rollout`, `bucket`, `revision`, `trace`, `error`, `json`, `type_name` |
| `evaluate(key, default, context)` | engine result without a type check |
| `all_flags(context)` / `all_flags_detail(context)` | every flag of the loaded configuration (no telemetry) |
| `wait_until_ready(timeout)` → `true`/`false` | blocks until a configuration is in use or the first load failed |
| `status` (`"not-ready"` / `"ready"` / `"stale"`), `revision`, `transport` (`:stream` / `:poll`), `initialized?`, `last_error` | state |
| `on(:change \| :error \| :status) { … }`, `on_change { … }`, `on_error { … }` → unsubscribe lambda | listeners |
| `refresh`, `flush`, `close`, `start`, `NanoFlags::Client.after_fork` | revalidate now, send telemetry now, stop, start, restart after fork |

`base_url` defaults to the hosted edge `https://edge.nanoflags.io`. Errors are delivered to `on_error` as
`NanoFlags::Error` with a `code`: `:network`, `:unauthorized`, `:http`, `:invalid_bundle`, `:store`, `:config`,
`:signature`, `:engine`. Nothing is ever raised from a variation call.

## Behaviour

- **Fallbacks and staleness.** Until a configuration loads, variations return your default. Once loaded, the last
  good configuration stays in use through network failures (`status` becomes `"stale"`).
- **Updates.** The client keeps `GET /v1/stream` open (key in the `Authorization` header, never in the URL); each
  `revision` event makes it fetch `/v1/bundle` with `If-None-Match`, verify and swap the bundle atomically. A
  `revoked` event stops the stream (the poll keeps reporting the key as rejected). Polling every `poll_interval`
  (30 s; `0` disables it) catches anything the stream misses; after failures it retries after 1 s, 2 s, 4 s … up to
  the poll interval. Stream reconnects back off up to 30 s. HTTP honours `HTTPS_PROXY` / `NO_PROXY` and
  `SSL_CERT_FILE`. The live WebSocket (`/v1/live`) used by the JavaScript, Python and Go SDKs is not implemented yet;
  with the event stream a new revision arrives after one extra conditional request.
- **Signature verification.** Every bundle is checked (Ed25519 over the canonical string, by `kid`) before it can
  replace the current one. With the hosted edge this is on by default with the embedded production keys
  (`NanoFlags::OFFICIAL_SIGNING_KEYS`) and unsigned bundles are refused; a bundle naming an unknown `kid` (key
  rotation) loads `GET /v1/keys` once (at most once a minute). For a self-hosted edge pass
  `verify: { public_keys: [jwk], require: true }` (or `verify: true` to use the edge's `/v1/keys`); `verify: false`
  turns it off. Bundles signed for another environment than the first accepted one are refused. The raw signed bytes
  are hashed exactly as served, never a re-serialisation.
- **Persistence and bootstrap.** `cache_path: "tmp/flags.json"` keeps the last good bundle (atomic write, mode 0600)
  and restores it on start as `"stale"` until the edge confirms it; a restored copy is verified again and ignored if
  it does not verify. `store:` takes any object with `get` / `set(text)` (`NanoFlags::Store::Cache.new(Rails.cache)`
  shares it through an ActiveSupport cache). `bootstrap:` takes a bundle (Hash or JSON text) to serve immediately.
- **Engine version.** Bundles produced for a newer evaluation engine (`bundle.engine` > `NanoFlags::Engine::VERSION`)
  are refused (`:engine`) and the current configuration stays in use: upgrade the gem.
- **Telemetry.** A sampled 10 % of evaluations are sent every 10 s, plus a service report every 60 s. Context
  **values never leave the process** by default: only the names (and value types) of the attributes the flag's rules
  use, e.g. `{"plan" => "string"}`. `events: { redact: ->(ctx) { … } }` customises this; `events: false` turns it off.
- **Threads.** The bundle is replaced as a single reference, so concurrent evaluations always see one consistent
  revision. Listeners run on the client's background threads. `close` stops everything after a final flush.
- **Not included yet:** the live WebSocket and test sessions (`x-nanoflags-session`).

## Development

```sh
bundle install
bundle exec rake                       # unit, parity and local HTTP tests (no key, no network)
NANOFLAGS_LIVE=1 bundle exec rake      # adds a read-only check against the hosted edge (public demo key)
```

`test/test_parity.rb` runs the shared engine fixtures (`../../packages/engine/fixtures/parity.json` and
`../../go/internal/testdata/extra.json`, or `NANOFLAGS_PARITY_FIXTURES` / `NANOFLAGS_EXTRA_FIXTURES`).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The NanoFlags name and logo are not covered by
the license.
