# nanoflags (Python)

Server SDK for [NanoFlags](https://nanoflags.io) feature flags. Flags are evaluated **locally and synchronously**
against a signed, in-memory configuration bundle; a variation call never does I/O and never raises. Background
threads keep the bundle current over the edge's live WebSocket (`/v1/live`), falling back to SSE and polling.

- Python 3.9+, fully typed (`py.typed`). Dependencies: `cryptography` (Ed25519) and `websockets`.
- Pure-Python port of the NanoFlags engine, checked against the TypeScript engine with ~22 000 shared parity
  fixtures (`packages/engine/fixtures/parity.json`).
- Signature verification **on by default** against the hosted edge's embedded key list; unsigned or tampered
  bundles are refused and the last good configuration stays in use.
- Thread-safe; an `asyncio` wrapper and an OpenFeature provider (`nanoflags[openfeature]`) are included.

## Install

```sh
pip install nanoflags
pip install "nanoflags[openfeature]"   # with the OpenFeature provider
```

## Quickstart

```python
import os
from nanoflags import NanoFlags

flags = NanoFlags(
    os.environ["NANOFLAGS_SDK_KEY"],      # nf_srv_… (server view) or nf_pub_… (client-exposed flags only)
    service="checkout-api",               # shown in "which revision is each service running"
)
flags.wait_until_ready(timeout=5)         # never raises; True once a configuration is in use

user = {"key": "user-42", "plan": "beta", "region": "DE"}
if flags.bool_variation("new-checkout", False, user):
    ...
accent = flags.string_variation("accent", "blue", user)
limit = flags.number_variation("rate-limit", 100, user)
layout = flags.json_variation("layout", {"cols": 3}, user)

detail = flags.bool_variation_detail("new-checkout", False, user)
print(detail.value, detail.reason, detail.rule_id, detail.revision)   # True rule_match beta 57

flags.on_change(lambda e: print(f"now on r{e.revision} via {e.transport}, {e.latency_ms} ms after commit"))

flags.close()   # on shutdown (or use `with NanoFlags(...) as flags:`)
```

Create **one client per process** and share it between threads. Each variation takes the flag key, the value to
serve when the flag cannot be evaluated (no configuration yet, unknown flag, value of another type), and the
context: a dict of JSON-like attributes. `key` is the stable identity used for percentage rollouts.

### asyncio

```python
from nanoflags.aio import AsyncNanoFlags

async with AsyncNanoFlags(sdk_key, service="api") as flags:
    await flags.wait_until_ready(5)
    enabled = flags.bool_variation("new-checkout", False, {"key": user_id})   # local, no await needed
```

`on_change` accepts coroutine functions; they run on the event loop that created the client.

### OpenFeature

```python
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from nanoflags import NanoFlags
from nanoflags.openfeature import NanoFlagsProvider

provider = NanoFlagsProvider(NanoFlags(sdk_key), close_client=True)
api.set_provider_and_wait(provider)   # openfeature-sdk >= 0.9; on 0.8 use api.set_provider(provider)
client = api.get_client()
client.get_boolean_value("new-checkout", False, EvaluationContext(targeting_key="user-42"))
```

`targeting_key` becomes `key`. Reasons: disabled flag → `DISABLED`, no rule matched → `DEFAULT`, fixed rule →
`TARGETING_MATCH`, rollout → `SPLIT` (variant = rule id). Unknown flags → `FLAG_NOT_FOUND`, wrong type →
`TYPE_MISMATCH`. The float accessor accepts whole numbers. New revisions emit `PROVIDER_CONFIGURATION_CHANGED`;
status changes emit `PROVIDER_READY` / `PROVIDER_STALE`.

## API

| | |
| --- | --- |
| `NanoFlags(sdk_key, *, base_url, service, poll_interval, streaming, live, live_poll_interval, bootstrap, cache_path, store, events, verify, on_change, on_error, start)` | the client |
| `bool_variation` / `string_variation` / `number_variation` / `json_variation(key, default, context=None)` | typed value |
| `*_variation_detail(...)` → `Evaluation` | `value`, `reason` (`rule_match`, `default`, `off`, `flag_not_found`, `error`), `rule_index`, `rule_id`, `in_rollout`, `bucket`, `revision`, `trace`, `error` |
| `evaluate(key, default, context)` | engine result without a type check |
| `all_flags(context)` → `dict` | every flag of the loaded configuration |
| `wait_until_ready(timeout)` / `ready(timeout)` → `bool` | blocks until a configuration is in use or the first load failed |
| `status` (`not-ready` / `ready` / `stale`), `revision`, `transport` (`live` / `stream` / `poll`) | state |
| `on_change(cb)`, `on_error(cb)`, `on("update" \| "error" \| "status", cb)` → unsubscribe | listeners |
| `refresh()`, `flush()`, `close()` | revalidate now, send telemetry now, stop |
| `session(token, service=None)` → `SessionEvaluator` | test-session override (below) |

`base_url` defaults to the hosted edge `https://edge.nanoflags.io`. Errors are delivered to `on_error` as
`NanoFlagsError` with a `code`: `network`, `unauthorized`, `http`, `invalid_bundle`, `store`, `config`, `signature`,
`session`, `engine`, `environment_deleted`. Nothing is ever raised from a variation call.

## Behaviour

- **Fallbacks and staleness.** Until a configuration loads, variations return your default. Once loaded, the
  last good configuration stays in use through network failures (`status` becomes `stale`).
- **Live updates.** The client opens `wss://<edge>/v1/live` (key in the `Authorization` header, never in the URL).
  The edge pushes each signed revision; it is verified and swapped atomically. Pings every ~30 s, a socket is
  replaced every ~50 min (the edge drops sockets older than 2 h), reconnects back off 1 s · 2ⁿ × 0.5–1.5 up to 5 min.
  While the socket is healthy the safety poll runs every 5 minutes; without it, SSE (`/v1/stream`) plus polling
  every 30 s take over. HTTP and WebSocket honour `HTTPS_PROXY` and `SSL_CERT_FILE`.
- **Signature verification.** Every bundle is checked (Ed25519 over the canonical string, by `kid`) before it can
  replace the current one. With the hosted edge this is on by default with the embedded production keys
  (`OFFICIAL_SIGNING_KEYS`) and unsigned bundles are refused; a bundle naming an unknown `kid` (key rotation) loads
  `GET /v1/keys` once (at most once a minute). For a self-hosted edge pass
  `verify=VerifyOptions(public_keys=[jwk], require=True)` (or `public_keys="fetch"`); `verify=False` turns it off.
  The raw signed bytes are hashed exactly as served — never a re-serialisation.
- **Persistence and bootstrap.** `cache_path="/var/cache/app/flags.json"` keeps the last good bundle (atomic
  write, mode 0600) and restores it on start as `stale` until the edge confirms it; a restored copy is verified
  again and ignored if it does not verify. `bootstrap=` takes a bundle (dict or JSON text) to serve immediately.
- **Engine version.** Bundles produced for a newer evaluation engine (`bundle.engine` > `ENGINE_VERSION`) are
  refused (`code="engine"`) and the current configuration stays in use: upgrade the SDK.
- **Deleted environment.** When the edge closes the socket with `4004 environment_deleted`, the client stops
  reconnecting (no SSE fallback either), keeps the last configuration as `stale`, and reports
  `code="environment_deleted"`. The regular poll continues and reports the key as rejected.
- **Telemetry.** A sampled 10 % of evaluations are sent every 10 s, plus a service report every 60 s. Context
  **values never leave the process** by default: only the names (and value types) of the attributes the flag's
  rules use. `events=EventsOptions(redact=...)` customises this; `events=False` turns it off.
- **Test sessions.** `flags.session(request.headers.get("x-nanoflags-session"))` returns an evaluator pinned to the
  session's configuration and context while the session is active (resolved once per token, cached until it
  expires), and behaves like the client otherwise.
- **Threads.** The bundle is replaced as a single reference, so concurrent evaluations always see one consistent
  revision. Background work runs on daemon threads; call `close()` to stop it and flush telemetry.

## Development

```sh
pip install -e ".[openfeature,test]"
pytest
```

`tests/test_parity.py` runs the shared engine fixtures (`../engine/fixtures/parity.json`, or
`NANOFLAGS_PARITY_FIXTURES=<path>`); regenerate them with `node packages/engine/fixtures/generate-parity.mjs`.
`scripts/live_verify.py` checks a client against the hosted edge with the public demo (see the script).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
