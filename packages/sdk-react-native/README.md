# @nanoflags/react-native

NanoFlags for **React Native and Expo**. Flags are evaluated **locally and synchronously** on the device against a
signed configuration bundle; the network is only used in the background to receive new revisions (pushed over a live
WebSocket) and to send sampled telemetry. An accessor never performs I/O and never throws.

- Same evaluation engine and client core as [`@nanoflags/sdk`](../sdk) (compiled into this package): identical results
  on every platform — checked against the shared parity fixtures (21,998 cases) through the built package.
- **Signed bundles, verified on the device** (pure-JS Ed25519, since Hermes has no WebCrypto), unsigned or tampered
  bundles refused. **Offline-first**: the last verified bundle is stored on the device and verified again at launch.
- **Mobile lifecycle**: the live connection is paused while the app is in the background and revalidated when it
  returns; with NetInfo, paused while offline and no live socket on metered connections.
- React hooks (no Suspense needed), `identify()` to switch users without a network round trip, an OpenFeature
  provider, TypeScript types. No runtime dependencies.

Requires React Native 0.76+ (Expo SDK 52+), Hermes or JSC, React 18+.

## Install

```sh
npx expo install @nanoflags/react-native @react-native-async-storage/async-storage @react-native-community/netinfo
# or: npm install @nanoflags/react-native @react-native-async-storage/async-storage @react-native-community/netinfo
```

AsyncStorage (persistence) and NetInfo (connectivity) are optional peer dependencies: leave them out and the SDK keeps
the bundle in memory only and does not react to connectivity changes. No native code of its own: works in Expo Go.

## Quickstart

```ts
// flags.ts — one client per app, created at module scope
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { asyncStorage, createClient } from "@nanoflags/react-native";

export const flags = createClient({
  sdkKey: "nf_pub_…", // a browser/client key: only client-exposed flags are delivered
  storage: asyncStorage(AsyncStorage),
  netInfo: NetInfo,
  context: { key: deviceId }, // anonymous until sign-in
});
```

```tsx
// App.tsx
import { NanoFlagsProvider, useBoolFlag, useFlag, useNanoFlags } from "@nanoflags/react-native";
import { flags } from "./flags";

export default function App() {
  return (
    <NanoFlagsProvider client={flags}>
      <Checkout />
    </NanoFlagsProvider>
  );
}

function Checkout() {
  const { loading, identify } = useNanoFlags();
  const newCheckout = useBoolFlag("new-checkout");     // false until loaded / if missing
  const accent = useFlag("accent", "blue");             // typed by the fallback
  if (loading) return <Spinner />;                      // optional: the first load attempt is still running
  return <CheckoutScreen variant={newCheckout ? "new" : "classic"} accent={accent} onSignIn={(user) => identify({ key: user.id, plan: user.plan })} />;
}
```

Outside React:

```ts
await flags.ready(); // never rejects; check flags.status
flags.boolean("new-checkout", false);
flags.identify({ key: user.id, plan: "pro", country: "SA" }); // local and synchronous: no request
flags.detail("accent", "blue"); // { value, reason: "rule_match" | "default" | "off" | "flag_not_found" | "error", ruleId, ruleIndex, revision, … }
flags.allFlags(); // { "new-checkout": true, accent: "orange", … }
```

A runnable Expo app is in [`example/`](./example).

## Keys

Mobile apps can be unpacked by anyone, so only **browser/client keys** (`nf_pub_…`) are accepted: the edge delivers
them the client view (flags marked *client-exposed* and only the segments those flags reference). A server key
(`nf_srv_…`) makes `createClient` throw before any request is made. Never put a server key in an app.

## API

```ts
createClient({
  sdkKey,                          // nf_pub_… (required)
  baseUrl?: string,                // default "https://edge.nanoflags.io"
  context?: Context,               // initial context; identify() replaces it
  service?: string,                // service-report name, default "react-native"
  bootstrap?: Bundle,              // bundle shipped with the app, used until a newer one is loaded
  storage?: StorageAdapter | false,// default: memory only. asyncStorage(AsyncStorage), memoryStorage(), or your own
  netInfo?: NetInfo,               // @react-native-community/netinfo default export (optional)
  appState?: AppState | null,      // default React Native's AppState; null = no lifecycle handling
  pauseInBackground?: boolean,     // true
  dataSaver?: boolean,             // true: no live socket on metered connections (ETag polling only)
  pollIntervalMs?: number,         // 30000 while the socket is not in use; 0 disables polling
  livePollIntervalMs?: number,     // 300000 safety poll while the socket is healthy
  streaming?: boolean,             // true; false = polling only
  live?: boolean,                  // true; false = SSE + polling
  events?: EventsOptions | false,  // telemetry, see below; false opts out
  verify?: VerifyOptions | false,  // default: embedded keys + required for the official edge
  crypto?: SignatureCrypto,        // default: bundled pure-JS SHA-256 / Ed25519
  userAgent?: string,              // default "nanoflags-react-native/0.1.0"
  fetch?, webSocket?, xmlHttpRequest?, // default: the React Native globals
})
```

| Member | |
| --- | --- |
| `ready()` | Resolves once a usable bundle is loaded (network, storage or bootstrap) or the first load attempt finished without one. Never rejects. |
| `status` / `settled` | `"not-ready"` · `"ready"` · `"stale"` (last known bundle: offline, paused, or the update was refused) / first load attempt finished. |
| `revision` / `transport` | Revision in use (`null` without one) / `"live"` · `"stream"` · `"poll"`. |
| `context` / `identify(ctx)` | Current context / replace it. Evaluations without an explicit context use it; an explicit context is merged over it. |
| `boolean / string / number / json(key, fallback, ctx?)` | The value, or `fallback` (no bundle, missing flag, other type). |
| `detail(key, fallback, ctx?)` | Value plus `reason`, `ruleId`, `ruleIndex`, `inRollout`, `revision`, `trace`, typed by `fallback`. |
| `evaluate(key, fallback, ctx?)` | Raw engine result, no type check. |
| `allFlags(ctx?)` | Values of every flag delivered to this key. |
| `lifecycle` | `{ background, offline, metered, paused, realtime }`. |
| `on("update" \| "error", cb)` | `update`: `{ revision, previousRevision, source, transport, latencyMs }`. `error`: `NanoFlagsError` with `code` (`signature`, `network`, `unauthorized`, `store`, `engine`, `environment_deleted`, …). |
| `subscribe(cb)` / `version` | External-store hooks (used by the React bindings). |
| `refresh()` / `flush()` / `close()` | Revalidate now / send telemetry now / stop everything (evaluations keep working). |

### React

| Hook | |
| --- | --- |
| `<NanoFlagsProvider client context?>` | Makes the client available; `context` (optional) is merged over the client's context. |
| `useFlag(key, fallback, ctx?)` | Typed by `fallback` (boolean, string, number, otherwise JSON). Re-renders on new revisions and `identify()`. |
| `useBoolFlag(key, fallback = false, ctx?)` | Boolean shorthand. |
| `useFlagDetail(key, fallback, ctx?)` | `detail()` as a hook. |
| `useAllFlags(ctx?)` | `allFlags()` as a hook. |
| `useNanoFlags()` | `{ client, loading, status, revision, hasBundle, transport, lifecycle, context, identify, refresh }`. `loading` is true until the first load attempt (storage + network) has finished — no Suspense involved. |
| `useFlagsStatus()` | `{ status, revision, hasBundle }`. |

### OpenFeature

```ts
import { OpenFeature, OpenFeatureProvider, useBooleanFlagValue } from "@openfeature/react-sdk";
import { NanoFlagsReactNativeProvider } from "@nanoflags/react-native/openfeature";

await OpenFeature.setProviderAndWait(new NanoFlagsReactNativeProvider({ client: flags }));
await OpenFeature.setContext({ targetingKey: user.id, plan: "pro" }); // → flags.identify({ key: user.id, plan: "pro" })
```

A provider for the static-context paradigm (`@openfeature/web-sdk`, `@openfeature/react-sdk`, both of which run in
React Native), the same mapping as `@nanoflags/openfeature-provider/web`: `targetingKey` → `key`; reasons
`TARGETING_MATCH` / `SPLIT` / `DEFAULT` / `DISABLED` / `ERROR`; variant = rule id; `flagMetadata.revision`; events
`READY` / `STALE` / `ERROR` / `CONFIGURATION_CHANGED`. OpenFeature's context becomes the client's context
(`syncContext: false` turns that off). Install `@openfeature/web-sdk` (and `@openfeature/react-sdk` for hooks).

## How updates arrive

1. **Live WebSocket** (`wss://…/v1/live`): the edge pushes each new signed bundle the moment it is published (≈ 0.2 s
   from commit to the app, measured below). React Native's WebSocket sends the SDK's `User-Agent`; the key travels in
   the subprotocol list, never in the URL. Ping every ~30 s, replaced every ~50 min, jittered backoff 1 s · 2ⁿ (≤ 5 min).
2. **SSE** (`/v1/stream`) over `XMLHttpRequest` (React Native's `fetch` cannot stream) when no socket can be opened.
3. **Polling** `/v1/bundle` with `If-None-Match` (a `304` is a few hundred bytes): every 30 s without a socket, every 5
   min as a safety net with one.

Close code **4004** (environment deleted): no reconnect, no fallback; the last configuration stays in use, `status`
becomes `stale`, an `environment_deleted` error is emitted.

## App lifecycle and battery

| Event | What the SDK does |
| --- | --- |
| App goes to the background (`AppState` `"background"`) | Closes the socket, stops polling, sends queued telemetry once. Evaluations keep working from memory. |
| Back to the foreground (`"active"`) | One conditional request right away (catches up on anything published meanwhile), then the socket again. |
| `"inactive"` (iOS app switcher, incoming call) | Nothing. |
| Offline (NetInfo) / back online | Pause / revalidate and reconnect. |
| Metered connection (NetInfo `isConnectionExpensive`) with `dataSaver` (default) | No socket: ETag polling only. |
| Started in the background (headless task) | Loads the stored bundle; no network until the app becomes active. |

## Signature verification

With the default `baseUrl` every bundle — fetched, pushed or loaded from storage — must carry a valid Ed25519 signature
by one of the official signing keys (embedded; `GET /v1/keys` is loaded once when a bundle names an unknown key id, at
most once a minute). Unsigned (the edge's fallback while a revision is still being distributed) or tampered bundles
are refused: the previous bundle stays in use and an `error` with `code: "signature"` is emitted. Verification runs in
pure JavaScript (`@noble/ed25519` 3.2.0 and `@noble/hashes` 2.4.0, audited, MIT, pinned and compiled into this package —
a private copy, so your app's own copies are never reconfigured): about one SHA-256 over the bundle plus one Ed25519
verification per new revision. Pass `crypto` to use a native implementation instead (e.g. one backed by
`react-native-quick-crypto`). Self-hosted edges: `verify: { publicKeys: [...], require: true }`.

## Persistence

`storage` takes any `{ getItem, setItem }` object (sync or async). One key per SDK key and edge:
`nanoflags:bundle:<fingerprint>` holding the bundle and the signature it was accepted with. At launch the stored
bundle is verified again before it is used (status `stale` until the edge confirms it); a modified or unsigned copy is
ignored. Note that Android's AsyncStorage refuses values above ~2 MB by default.

```ts
// e.g. with an MMKV instance `mmkv` from react-native-mmkv:
createClient({ sdkKey, storage: { getItem: (k) => mmkv.getString(k) ?? null, setItem: (k, v) => mmkv.set(k, v) } });
```

## Telemetry

As in every NanoFlags SDK: a service report (`sdk: "react-native/0.1.0"`, the revision in use) and a sample (default
10 %) of evaluations with the flag, value, reason and revision. **Context values are never sent** — only the names
of the attributes the flag's rules use and their types (e.g. `{ "plan": "string" }`). `events: { sampleRate }` tunes
it, `events: false` turns it off. Telemetry is flushed when the app goes to the background.

## Notes

- `User-Agent`: requests and the socket send `nanoflags-react-native/<version>` (Cloudflare in front of the edge
  answers `403` to some default library agents).
- Test sessions (`x-nanoflags-session`) are a server/browser feature; `session(token)` works, `useSession` does not
  apply to apps.
- The evaluation engine is also exported for tooling: `@nanoflags/react-native/engine`.

## Development

```sh
pnpm --filter @nanoflags/react-native test        # builds, then unit tests + parity through dist/
pnpm --filter @nanoflags/react-native typecheck
# live check against production (public demo key; see scripts/live-check.mjs):
NANOFLAGS_SDK_KEY=nf_pub_… node --use-env-proxy --import ./scripts/rn-env.mjs scripts/live-check.mjs
```

The example app has a Jest suite (`cd example && npm install && npm test`) and Maestro device flows
(`example/.maestro/`, `maestro test .maestro` with the app installed on an emulator or simulator); CI for both is in
`ci/mobile-react-native.yml`.

Measured against production (Nov 13, 2026; the built package in a React-Native-like Node environment without
WebCrypto, behind an HTTPS proxy, public demo key, live transport): commit → `update` as reported by the SDK median
≈ 215 ms; demo toggle returned → `update` in the app median ≈ 15–25 ms; background → foreground caught up in ≈ 0.6 s.

License: Apache-2.0 (see LICENSE and NOTICE).
