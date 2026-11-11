# @nanoflags/sdk

JavaScript/TypeScript SDK for NanoFlags. Flags are evaluated **locally and synchronously** against an
in-memory configuration bundle. The network is used only in the background — to load the bundle, to
learn about new revisions, and to send sampled telemetry. An accessor never performs I/O and never throws.

- ESM and CommonJS builds, TypeScript types included, no runtime dependencies (the evaluation engine is
  bundled). Node 18 or newer; `react` (18 or newer) is an optional peer dependency, needed only for
  `@nanoflags/sdk/react`.
- Entry points: `@nanoflags/sdk` (Node, browsers, edge runtimes), `@nanoflags/sdk/react`, and
  `@nanoflags/sdk/node` (test-session propagation with `AsyncLocalStorage`).
- v2 adds [signature verification](#signature-verification) and [test sessions](#test-sessions).
- **0.4** verifies signatures **by default** when `baseUrl` is the hosted edge (`https://edge.nanoflags.io`), with
  the production public keys embedded in the SDK, and refuses unsigned bundles there (see
  [Signature verification](#signature-verification)). It also refuses bundles produced for a newer evaluation engine
  (`bundle.engine`, see [Engine version](#engine-version)) and stops reconnecting when the edge reports that the
  environment was deleted. Self-hosted edges (any other `baseUrl`) behave as in 0.3 unless `verify` is set.

## Install

```sh
npm install @nanoflags/sdk
```

Releases are published to npm from [motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk)
by its release workflow (`.github/workflows/release.yml`, tag `sdk-v<version>`).

## Quickstart

### Node

```ts
import { createClient } from "@nanoflags/sdk";

const flags = createClient({
  sdkKey: process.env.NANOFLAGS_SDK_KEY!, // nf_srv_…
  baseUrl: "https://flags.example.com",
  service: "checkout-api",
});

await flags.ready(); // never rejects — see "Fallbacks and staleness"

const enabled = flags.boolean("checkout-v2", false, { key: user.id, signedIn: true, region: "US" });
```

Create one client per process and reuse it. Call `flags.close()` on shutdown. Background timers are
`unref`'d, but the live connection (WebSocket, or the SSE stream it falls back to) keeps a Node process
alive until `close()`; in short-lived scripts and serverless functions either call `close()` or pass
`streaming: false`. The live socket needs a global `WebSocket` (Node ≥ 22, browsers, Deno, Bun); on
older Node versions pass one (`webSocket: require("ws")`) or the SDK uses SSE + polling. Node has no default
persistence (safe for read-only and ephemeral file systems); pass `store` if you want one.

### Browser

```ts
import { createClient } from "@nanoflags/sdk";

const flags = createClient({
  sdkKey: "nf_pub_…", // browser key: only client-exposed flags are delivered
  baseUrl: "https://flags.example.com",
  service: "web",
});

await flags.ready();
const ranking = flags.string("search-ranking", "relevance-v2", { key: user.id });
flags.on("update", ({ revision }) => console.log("now on revision", revision));
```

Never ship an `nf_srv_` key to a browser. Rules of client-exposed flags are visible to anyone who has
the browser key, and evaluation runs on the user's device — do not use browser flags for authorization.

### React

```tsx
import { createClient } from "@nanoflags/sdk";
import { NanoFlagsProvider, useFlag, useFlagsStatus } from "@nanoflags/sdk/react";

const client = createClient({ sdkKey: "nf_pub_…", baseUrl: "https://flags.example.com" });

export function App({ user }) {
  return (
    <NanoFlagsProvider client={client} context={{ key: user.id, plan: user.plan }}>
      <Search />
    </NanoFlagsProvider>
  );
}

function Search() {
  const ranking = useFlag("search-ranking", "relevance-v2");       // string accessor (from the fallback's type)
  const compact = useFlag("compact-results", false, { device: "mobile" }); // context override, shallow-merged
  const { status, revision } = useFlagsStatus();                    // "not-ready" | "ready" | "stale"
  …
}
```

Hooks use `useSyncExternalStore`: components re-render when a new revision arrives or the status
changes. Until a bundle is loaded they return the fallback. For server rendering, pass the bundle you
evaluated with on the server as `bootstrap` so the first client render matches.

## API

```ts
createClient({
  sdkKey, baseUrl,
  service?: string,                 // shown in "which revision is this service running"
  pollIntervalMs?: number,          // 30000; 0 disables polling
  streaming?: boolean,              // true; false = polling only (no WebSocket, no SSE)
  live?: boolean,                   // true; false = SSE + polling as in 0.2 (no WebSocket)
  livePollIntervalMs?: number,      // 300000: safety poll while the live socket is healthy
  webSocket?: WebSocketConstructor, // default: the global WebSocket
  bootstrap?: Bundle,
  store?: { get(): Promise<string | null>; set(v: string): Promise<void> } | false,
  events?: { enabled?: boolean /* true */, sampleRate?: number /* 0.1 */, flushIntervalMs?: number /* 10000 */, reportIntervalMs?: number /* 60000 */, redact?: (ctx) => object } | false,
  verify?: { publicKeys?: JsonWebKey[] | "fetch", require?: boolean } | false, // default: see Signature verification
  fetch?: typeof fetch,
})
```

| Member | |
| --- | --- |
| `ready(): Promise<void>` | Resolves when a usable bundle is loaded (network, store or bootstrap) — or when the first load attempt finished without one. **Never rejects.** Check `status`. |
| `status` | `"not-ready"` · `"ready"` · `"stale"` |
| `revision` | Revision of the bundle in use, `null` without one. |
| `transport` | How updates reach this client right now: `"live"` (WebSocket open) · `"stream"` (SSE) · `"poll"`. |
| `boolean / string / number / json (key, fallback, ctx?)` | The value, or `fallback`. |
| `evaluate(key, fallback, ctx?)` | The engine `Evaluation`: `value`, `reason`, `ruleIndex`, `ruleId`, `inRollout`, `bucket`, `revision`, `trace`. No type check. |
| `session(token, { service? })` | `Promise<SessionEvaluator>` for a test session. Never rejects. See [Test sessions](#test-sessions). |
| `useSession(token \| null)` / `sessionHeaders()` | Browser only: join or leave a test session for this page session; headers for downstream calls. |
| `on("update" \| "error", cb)` | Returns an unsubscribe function. `update` receives `{ revision, previousRevision, checksum, source, transport, latencyMs }` (see [Updates](#updates)). `error` receives a `NanoFlagsError` with `code`: `network`, `unauthorized`, `http`, `invalid_bundle`, `store`, `config`, `signature`, `session`, `engine` (bundle for a newer engine, refused), `environment_deleted`. |
| `refresh()` / `flush()` / `close()` | Revalidate now / send queued telemetry now / stop all background work. |

## Fallbacks and staleness

The `fallback` argument is what your application does when NanoFlags cannot answer. It is returned when:

| Situation | `reason` |
| --- | --- |
| No bundle loaded yet (`status: "not-ready"`) | `flag_not_found` |
| The flag is not in the bundle (unknown, archived, or server-only with a browser key) | `flag_not_found` |
| The flag's value has a different type than the accessor (`boolean()` on a string flag) | `error` |
| The configuration is malformed | `error` |

A **disabled** flag is not a fallback case: it returns the flag's configured `off` value (`reason: "off"`).

`status` describes the bundle, not individual flags:

- `not-ready` — no bundle. Every accessor returns its fallback.
- `ready` — the bundle was confirmed by the edge on the last attempt (or was supplied as `bootstrap`
  and no attempt has failed yet).
- `stale` — a bundle is in use but is **not known to be current**: it was restored from the store and
  not yet revalidated, the last revalidation failed (offline, edge error, rejected key), or the edge
  itself served its last-known-good copy because its origin was unreachable. Evaluations continue on
  that bundle; the SDK keeps retrying (after a failure: 1 s, 2 s, 4 s … up to the poll interval).

The SDK never discards a working bundle because of an error, and never replaces a bundle with an older
one served as last-known-good. If the environment is deleted, the edge closes the live socket with code `4004`: the client reports
`error` (`code: "environment_deleted"`), turns `stale`, keeps evaluating the last bundle and stops reconnecting
(only the regular poll continues, which then reports the key as rejected). If a key is revoked, the client reports `error` (`code: "unauthorized"`)
and keeps evaluating the last bundle as `stale` — revocation stops updates, it does not erase
configuration that already reached a process.

## Updates

1. **Live push (default)** — one WebSocket to `GET /v1/live`. The moment a revision is published the
   edge sends a `rev` message that carries the signed bundle itself, so the SDK applies it **without
   any further request**; on (re)connect a `hello` message carries the current revision, so a client
   that was offline catches up in one message. The key travels in the WebSocket subprotocol list
   (`["nanoflags.v1", "key.<sdk key>"]`), never in the URL. Server and browser keys both use it;
   browser keys receive the client view. The SDK pings every ~30 s (answered by the edge without
   waking anything), replaces the socket every ~50 minutes so the key is validated again, and
   reconnects with jittered exponential backoff (1 s, 2 s, 4 s … capped at 5 min, each × 0.5–1.5).
   While the socket is healthy, SSE is not opened and polling drops to `livePollIntervalMs` (5 min).
2. **Stream (fallback)** — when the socket cannot be established (no `WebSocket` in the runtime, a
   proxy that does not pass upgrades, the edge answering `503` because an environment reached its
   connection cap) the SDK opens a server-sent-events connection that carries only
   `{ revision, checksum }` and fetches the bundle conditionally (`GET /v1/bundle`, `If-None-Match`).
   Browser keys use `EventSource` (`?key=`, browser keys only); everything else a `fetch` stream with
   the `Authorization` header. It keeps retrying the live socket in the background and closes the
   stream once a socket opens.
3. **Polling (safety net)** — the conditional request every `pollIntervalMs` ± 20 % jitter. Hidden
   tabs do not poll and catch up when they become visible.

`live: false` keeps the 0.2 behaviour (2 + 3); `streaming: false` leaves polling only.

A new bundle replaces the old one in a single assignment: an evaluation sees either the old or the new
revision in full, never a mixture. The SDK never moves to an older revision than one it was pushed.

The `update` event says how the bundle arrived: `transport` is `"live"` (pushed), `"stream"` (fetched
after an SSE notification) or `"poll"` (everything else, including the initial load, the store and
`bootstrap`). For pushed revisions `latencyMs` is the time from the commit in the database to the
event (`Date.now() - committedAt`); it is `null` when the commit time is not known (other transports,
the `hello` of an environment whose last revision was distributed by the fallback path). It compares
the database's clock with yours, so read it as accurate to within the clock difference of the two
machines. Measured on the hosted edge: typically 140–180 ms with the live socket; with SSE up to ~10 s;
with polling up to one poll interval. This is propagation, not a guarantee.

With `verify`, a pushed bundle is verified exactly like a fetched one before it is used (the message
carries the signature, key id and environment id). A push that does not verify changes nothing, emits
`error` (`code: "signature"`), and makes the SDK ask the edge over HTTP what is current.

## Signature verification

Published bundles are signed by the NanoFlags publisher with Ed25519. The SDK checks the signature **before** a new
bundle replaces the one in use.

**Default (0.4):**

| `baseUrl` | `verify` not set | |
| --- | --- | --- |
| `https://edge.nanoflags.io` | verified against the embedded production keys (`OFFICIAL_SIGNING_KEYS`), `require: true` | pushed (WebSocket) and fetched bundles must be signed and verify |
| any other edge | not verified (as in 0.3) | configure `verify` for a self-hosted edge |

`verify: false` turns verification off explicitly. To configure it yourself:

```ts
const flags = createClient({
  sdkKey, baseUrl,
  verify: {
    publicKeys: [{ kty: "OKP", crv: "Ed25519", x: "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", kid: "k1" }],
    require: true,
  },
});
```

- A response with `X-NanoFlags-Signed: true` (and every pushed bundle) is verified against the canonical string
  `nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<sha256 hex of the bundle JSON text>`
  (the bundle text exactly as the edge sent it), using WebCrypto, with the key whose `kid` the edge names
  (`X-NanoFlags-Key-Id`, or `kid` in the push).
- **Bad signature → the update is rejected.** The previous bundle stays in use, `status` does not
  change, and `error` fires with `code: "signature"`. The SDK retries on its normal schedule.
- **Unsigned bundles** (the edge sends `X-NanoFlags-Signed: false` while the publisher is catching up,
  typically for well under a minute after a publish) are rejected when `require` is true — the default on the hosted
  edge: the bundle in use stays, `error` (`signature`) fires, and the SDK fetches again with a short backoff (1 s,
  2 s, 4 s … up to the poll interval) until the signed revision is there. With `require: false` (the default for
  other edges) they are accepted; then someone who can alter responses can also strip the signature.
- **Keys and rotation.** Keys are selected by `kid` and cached. With the embedded keys, a bundle signed with a key id
  the SDK does not know (the hosted edge rotated its key after this SDK version was built) makes the SDK load
  `GET /v1/keys` once and verify against those keys as well; an id that is still unknown is rejected, and the reload
  is not repeated within a minute. `publicKeys: "fetch"` loads all keys from `GET /v1/keys` (again when an unknown
  key id appears, at most once a minute) — this detects corruption and tampering in storage and caches, but fetched
  keys are only as trustworthy as the edge that served them. Explicitly pinned `publicKeys` are never extended from
  the network: **pin the keys in your build** if the edge itself is in your threat model, and add the new key before
  a rotation (the edge lists the old key as `status: "retiring"` during the overlap).
- After the first verified bundle the client remembers the environment id and rejects bundles signed
  for a different environment.
- A persisted bundle (see below) is stored with its signature and verified again when restored; with
  `require`, an unsigned stored copy is ignored. A `bootstrap` bundle is trusted as given.
  With `publicKeys: "fetch"` a stored copy can only be verified once the keys were loaded, so an
  offline start does not restore it; pinned and embedded keys do not have this limitation.
- Only public keys are accepted. A JWK with a private part (`d`) is ignored and reported as a `config`
  error. Private signing keys and admin keys never belong in an application.
- Requires Ed25519 in WebCrypto: Node 20+, current Chrome, Firefox and Safari, Cloudflare Workers,
  Deno, Bun. Where it is missing, signed bundles are rejected (they cannot be checked) — on the hosted edge pass
  `verify: false` for such runtimes (Node 18) if you accept that.

Not covered: test-session bundles (`GET /v1/session`) are not signed, and verification says nothing
about *freshness* — it does not stop an attacker from withholding updates.

## Engine version

Bundles produced by the publisher carry `engine`, the version of the evaluation engine they were produced for
(`1` today; `SUPPORTED_ENGINE_VERSION` is what this SDK evaluates). A bundle with a **newer** `engine` — a rule format
this SDK does not understand — is refused wherever it comes from (fetch, push, store, `bootstrap`): the bundle in use
stays, `status` does not change, and `error` fires with `code: "engine"`. Upgrade the SDK to receive it. Bundles
without the field (older revisions, the edge's unsigned fallback) are evaluated as engine 1.

## Test sessions

A test session pins a configuration snapshot and a synthetic context to a token (`nf_ts_…`, created in
the dashboard). Services that receive the token in the `x-nanoflags-session` header evaluate against
that snapshot instead of the published configuration — for that request only.

```ts
const s = await flags.session(req.headers["x-nanoflags-session"], { service: "checkout-api" });
s.boolean("checkout-v2", false, { key: user.id }); // session bundle, context { ...session.context, key }
s.active;     // false when the session is unknown, expired, revoked or not permitted for this service
s.id;         // session id (null when not resolved)
s.expiresAt;  // ISO timestamp (null when not resolved)
```

- `session()` asks the edge once per token and service (`GET /v1/session`) and caches the answer until
  the session expires. Unknown tokens are remembered for 15 s, failed lookups for 3 s.
- It **never throws and never rejects**. Without an active session the evaluator behaves exactly like
  the client, so the same code path serves normal traffic. When a session expires mid-flight,
  `active` turns false and evaluations continue on the published configuration.
- Sampled events from a session carry `sessionId`.
- A session changes which snapshot and context an evaluation uses. It grants no data access and
  must not be used for authorization. A revoked session keeps working in a process that already
  cached it until its expiry time.

### Node: per-request propagation

```ts
import { sessionMiddleware, flagsFor, sessionHeaders, withSession, currentSession, withSessionHandler } from "@nanoflags/sdk/node";

app.use(sessionMiddleware(flags));               // Express / Connect
app.get("/cart", async (req, res) => {
  const v2 = req.flags.boolean("checkout-v2", false, { key: req.user.id }); // or flagsFor(flags)
  const prices = await fetch(PRICING_URL, { headers: { ...sessionHeaders() } }); // next service joins the session
  …
});

export default { fetch: withSessionHandler(flags, async (request) => { … flagsFor(flags) … }) }; // fetch-style handlers

await withSession(token, async () => { … currentSession() … }); // queues, jobs, tests
```

The current session lives in `AsyncLocalStorage`: it follows one request through awaits and callbacks
and is invisible to every other request. Nothing is stored on the client or in module state.
`sessionFlags(client)` is the async variant of `flagsFor` for code that runs outside the middleware.
`sessionHeaders()` returns `{}` outside a session, so it is always safe to spread.

### Browser

```ts
await flags.useSession(token); // the nf_ts_… token your test tooling hands to the page; null leaves the session
fetch("/api/cart", { headers: { ...flags.sessionHeaders() } });
```

`useSession` keeps the token in `sessionStorage` (this tab, until it is closed; reloads resume it) and
routes the client's own accessors — and therefore the React hooks — through the session while it is
active. Browser keys only ever receive client-exposed flags, in sessions too. On a server
`useSession` is refused (one client serves many requests); use `session()` or `@nanoflags/sdk/node`.

## Persistence

- Browser: IndexedDB when available; otherwise none. Node/edge runtimes: none by default.
- `store` accepts any async string store (`get`/`set`), `false` disables persistence.
- The stored value contains the bundle (flag rules), never the SDK key. It is bound to the key and
  `baseUrl`, so a copy written for another environment is ignored.

## Telemetry: what is sent

While evaluations are being sampled, every `flushIntervalMs` (10 s) the SDK sends one request to
`POST /v1/events`; while nothing is queued it sends the service report alone every
`reportIntervalMs` (60 s). A request carries:

- a **service report** — `{ service, sdk: "js/<version>", revision }`, and
- up to 50 **sampled evaluation events** (`sampleRate`, default 10 %): flag key, value, reason, rule
  index, revision, time, and a redacted context.

**Default redaction sends no attribute values.** For each sampled event the SDK sends only the *names* of
the context attributes that the evaluated flag's rules reference (conditions, segments, the rollout's
bucketing attribute) and that were present, each mapped to the value's *type* — for example
`{ "region": "string", "signedIn": "boolean", "key": "string" }`. Attributes no rule uses are dropped
entirely. To send more (or less), provide `events.redact(ctx)`; its return value is sent as is, so
anything you return leaves the process. Flag *values* are sent (truncated above 1 KB); do not put secrets
in flag values.

Telemetry is off the evaluation path: an evaluation appends to a bounded in-memory queue (500 entries,
then dropped). Batches that fail to send are dropped, never retried. Disable with `events: false`.

### What a reported signal does and does not prove

- A service report proves that **a process using this SDK key, naming itself `service`, had revision N
  loaded when it flushed**. It does not prove that every instance of the service is on that revision,
  that the service is healthy, or that it is still running — only "last seen". A missing report proves
  nothing either: telemetry may be disabled, blocked, sampled out, or dropped.
- `service` is self-declared and unauthenticated beyond the SDK key. With a browser key, anyone can
  send reports and events. Treat them as observability, not as an audit trail.
- A sampled event proves that an evaluation with that result happened in some process. It does not
  prove the user saw the feature, and absence of events does not prove a flag is unused: with the
  default 10 % sampling, rarely evaluated flags can go unseen for a long time.
- Counts are estimates. Sampling is per evaluation, events are dropped under back-pressure or network
  failure, and React components may evaluate once per relevant change rather than once per user action.

## Development

```sh
pnpm --filter @nanoflags/sdk test
pnpm --filter @nanoflags/sdk typecheck
pnpm --filter @nanoflags/sdk build      # dist/: ESM + CJS + .d.ts/.d.cts (tsdown, engine bundled in)
# SDK → edge → your environment (key from the environment only; base URL defaults to https://edge.nanoflags.io)
NANOFLAGS_SDK_KEY=nf_srv_… pnpm --filter @nanoflags/sdk smoke
```
