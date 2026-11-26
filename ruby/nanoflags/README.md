# nanoflags (Ruby)

Server SDK for [NanoFlags](https://nanoflags.io) feature flags. Flags are evaluated **locally and synchronously**
against a signed, in-memory configuration bundle; a variation call never does I/O and never raises. Background
threads keep the bundle current: the edge pushes each new revision over its live WebSocket (`/v1/live`); while no
socket can be opened, its event stream (`/v1/stream`) announces revisions that are then fetched with ETag
revalidation, with polling as the safety net. Test sessions (`x-nanoflags-session`) are resolved per request.

- Ruby 3.1+. No runtime dependencies (Net::HTTP, sockets, OpenSSL and JSON from the standard library; the WebSocket
  client is a small built-in RFC 6455 implementation).
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
restarts its own background threads (and opens its own live socket; the parent's connection is never touched) on its
first call; events queued before the fork are sent by the parent only. Cached test sessions are inherited.
To start the threads as soon as a worker boots, call `NanoFlags::Client.after_fork` from the server's hook:

```ruby
# config/puma.rb
on_worker_boot { NanoFlags::Client.after_fork }
```

With `preload_app!`, creating the client in the master is fine; pass `start: false` there if the master should not
open any connection, and start it in each worker: `on_worker_boot { FLAGS.start }` (a client created with
`start: false` does not start by itself).

### Test sessions (`x-nanoflags-session`)

A test session, created in the dashboard (**Scenarios → Shared test session**), pins a configuration snapshot and a
synthetic context to a token (`nf_ts_…`). A service that receives the token in the `x-nanoflags-session` header
evaluates against that snapshot, with the context `session.context.merge(your_context)`, for that request only.
Sampled events from a session carry its id. Shared test sessions are part of the Scale plan.

```ruby
# config/application.rb (any Rack app: `use NanoFlags::SessionMiddleware, FLAGS`)
config.middleware.use NanoFlags::SessionMiddleware, FLAGS # reads x-nanoflags-session, resolves it once per request

# a controller
flags = request.env["nanoflags.flags"]            # or NanoFlags.flags_for(FLAGS) where there is no request
flags.bool_variation("checkout-v2", false, { key: current_user.id }) # session-scoped while the session is active
flags.active?                                    # false when unknown, expired, revoked or not permitted here

# downstream calls join the session ({} outside one, always safe to merge)
Faraday.get(PRICING_URL, nil, NanoFlags.session_headers)

# jobs: pass the token along and resolve it in the worker
PriceJob.perform_async(order.id, NanoFlags.current_session)
NanoFlags.with_session(token) { NanoFlags.flags_for(FLAGS).bool_variation("checkout-v2", false, { key: user_id }) }

# or directly
s = FLAGS.session(request.headers["x-nanoflags-session"], service: "checkout-api")
s.id; s.expires_at; s.revision
```

- `FLAGS.session(token, service:)` asks the edge once per token and service (`GET /v1/session`, the token in
  `X-NanoFlags-Session`, `service` in `X-NanoFlags-Service`, default: the client's `service`) and caches the answer
  until the session expires. Unknown tokens are remembered for 15 s, failed lookups for 3 s (`:session` errors).
  Concurrent requests with the same new token wait for one lookup.
- It **never raises**. Without an active session the evaluator behaves exactly like the client, so one code path
  serves normal traffic and tests. When a session expires mid-flight, `active?` turns false and evaluations continue on
  the published configuration.
- The current session lives in fiber storage (`Fiber[]`, inherited by threads and fibers started inside it on Ruby
  3.2+; fiber-local on 3.1). Nothing is stored on the client. The middleware's session ends when `call` returns.
- A session changes which snapshot and context an evaluation uses. It grants no data access and must not be used for
  authorization. Client keys only receive client-exposed flags, in sessions too. Session bundles are not signed;
  verification does not apply to them. A revoked session keeps working in a process that cached it until it expires.

### Sidekiq and other threaded workers

Use the same process-wide client from every job; evaluations are lock-free reads of the current bundle. Call
`FLAGS.close` on shutdown only if you need the final telemetry flush synchronously (an `at_exit` hook does it too).

## API

| | |
| --- | --- |
| `NanoFlags::Client.new(sdk_key, base_url:, service:, poll_interval:, streaming:, live:, live_poll_interval:, live_url:, bootstrap:, cache_path:, store:, events:, verify:, on_change:, on_error:, logger:, start:, http:, request_timeout:)` | the client |
| `bool_variation` / `string_variation` / `number_variation` / `json_variation(key, default, context = nil)` | typed value |
| `*_variation_detail(...)` → `NanoFlags::EvaluationDetail` | `value`, `reason` (`rule_match`, `default`, `off`, `flag_not_found`, `error`), `rule_index`, `rule_id`, `in_rollout`, `bucket`, `revision`, `trace`, `error`, `json`, `type_name` |
| `evaluate(key, default, context)` | engine result without a type check |
| `all_flags(context)` / `all_flags_detail(context)` | every flag of the loaded configuration (no telemetry) |
| `wait_until_ready(timeout)` → `true`/`false` | blocks until a configuration is in use or the first load failed |
| `status` (`"not-ready"` / `"ready"` / `"stale"`), `revision`, `transport` (`:live` / `:stream` / `:poll`), `initialized?`, `last_error` | state |
| `session(token, service: nil)` → `NanoFlags::SessionEvaluator` | test session: the typed variations, `evaluate`, `active?`, `id`, `expires_at`, `revision` |
| `NanoFlags::SessionMiddleware`, `NanoFlags.with_session(token) { }`, `.flags_for(client)`, `.current_session`, `.session_headers`, `NanoFlags::SESSION_HEADER` | request-scoped test sessions |
| `on(:change \| :error \| :status) { … }`, `on_change { … }`, `on_error { … }` → unsubscribe lambda | listeners |
| `refresh`, `flush`, `close`, `start`, `NanoFlags::Client.after_fork` | revalidate now, send telemetry now, stop, start, restart after fork |

`base_url` defaults to the hosted edge `https://edge.nanoflags.io`. Errors are delivered to `on_error` as
`NanoFlags::Error` with a `code`: `:network`, `:unauthorized`, `:http`, `:invalid_bundle`, `:store`, `:config`,
`:signature`, `:rollback`, `:engine`, `:session`, `:environment_deleted`. Nothing is ever raised from a variation call.

## Behaviour

- **Fallbacks and staleness.** Until a configuration loads, variations return your default. Once loaded, the last
  good configuration stays in use through network failures (`status` becomes `"stale"`).
- **Live updates.** The client keeps one WebSocket to `/v1/live` open (subprotocol `nanoflags.v1`, the key in the
  `Authorization` header, never in the URL), the same protocol as the JavaScript, Python, Go and Java SDKs. The edge
  sends the current bundle on connect (`hello`) and every new revision as it is published (`rev`); each pushed bundle
  is verified exactly like a fetched one before it is used (a push that does not verify changes nothing and triggers
  a regular request). A text `ping` every ~30 s detects dead connections; sockets are replaced after ~50 min.
  Reconnects back off 1 s, 2 s, 4 s … up to 5 min. While the socket is healthy, polling only runs every
  `live_poll_interval` (300 s) as a safety net. Close code **4004** means the environment was deleted: the last
  bundle stays in use, `status` becomes `"stale"`, an `:environment_deleted` error is reported and the client stops
  reconnecting (the poll keeps reporting the key). `live: false` skips the socket.
- **Fallback.** While no socket can be opened (a proxy that refuses upgrades, an older edge), the client keeps
  `GET /v1/stream` open; each `revision` event makes it fetch `/v1/bundle` with `If-None-Match`, verify and swap the
  bundle atomically. A `revoked` event stops the stream (the poll keeps reporting the key as rejected). Polling every
  `poll_interval` (30 s; `0` disables it) catches anything both miss; after failures it retries after 1 s, 2 s, 4 s …
  up to the poll interval. Stream reconnects back off up to 30 s. HTTP and the WebSocket honour `HTTPS_PROXY` /
  `NO_PROXY` (a CONNECT tunnel) and `SSL_CERT_FILE`. `streaming: false` uses polling only.
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

## Development

```sh
bundle install
bundle exec rake                       # unit, parity and local HTTP tests (no key, no network)
NANOFLAGS_LIVE=1 bundle exec rake      # adds read-only checks against the hosted edge (public demo key): bundle, live socket, stream
```

`test/test_parity.rb` runs the shared engine fixtures (`../../packages/engine/fixtures/parity.json` and
`../../go/internal/testdata/extra.json`, or `NANOFLAGS_PARITY_FIXTURES` / `NANOFLAGS_EXTRA_FIXTURES`).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The NanoFlags name and logo are not covered by
the license.
