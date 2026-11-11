# @nanoflags/openfeature-provider

[OpenFeature](https://openfeature.dev) provider for NanoFlags, for the JavaScript server SDK
(`@openfeature/server-sdk`) and the web SDK (`@openfeature/web-sdk`). It wraps a `@nanoflags/sdk`
client: evaluation stays local and synchronous inside the provider, the NanoFlags client keeps doing
the loading, streaming and polling.

```sh
npm install @nanoflags/openfeature-provider @nanoflags/sdk @openfeature/server-sdk   # or @openfeature/web-sdk
```

ESM and CommonJS, types included, Node 18 or newer. `@nanoflags/sdk`, `@openfeature/core` and the
OpenFeature SDK you use are peer dependencies. Releases are published to npm from
[motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk) by its release workflow
(`.github/workflows/release.yml`, tag `openfeature-v<version>`).

## Server

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createClient } from "@nanoflags/sdk";
import { NanoFlagsProvider } from "@nanoflags/openfeature-provider/server";

const nanoflags = createClient({ sdkKey: process.env.NANOFLAGS_SDK_KEY!, baseUrl: "https://flags.example.com", service: "checkout-api" });
await OpenFeature.setProviderAndWait(new NanoFlagsProvider({ client: nanoflags }));

const client = OpenFeature.getClient();
const enabled = await client.getBooleanValue("checkout-v2", false, { targetingKey: user.id, signedIn: true, region: "US" });
```

## Web

```ts
import { OpenFeature } from "@openfeature/web-sdk";
import { createClient } from "@nanoflags/sdk";
import { NanoFlagsWebProvider } from "@nanoflags/openfeature-provider/web";

const nanoflags = createClient({ sdkKey: "nf_pub_…", baseUrl: "https://flags.example.com" });
await OpenFeature.setContext({ targetingKey: user.id, plan: user.plan });
await OpenFeature.setProviderAndWait(new NanoFlagsWebProvider({ client: nanoflags }));

const ranking = OpenFeature.getClient().getStringValue("search-ranking", "relevance-v2");
```

Options: `{ client, closeClient?: boolean, evaluator?: () => { evaluate } }`. `closeClient` (default
false) closes the NanoFlags client when the provider shuts down. `evaluator` redirects evaluations,
for example to the current request's test session:
`new NanoFlagsProvider({ client, evaluator: () => flagsFor(client) })` with `flagsFor` from `@nanoflags/sdk/node`.

## What is supported

| OpenFeature | NanoFlags |
| --- | --- |
| `resolveBoolean/String/Number/ObjectEvaluation` | `boolean`, `string`, `number`, `json` flags. Object resolution accepts any JSON value (a `json` flag may hold a string or a number). |
| `targetingKey` | Context attribute `key` — the identity used for rollout bucketing. It overrides an attribute named `key`. |
| Other context attributes | Passed through. `Date` values become ISO strings. Non-finite numbers and `undefined` are dropped. |
| `reason` | `TARGETING_MATCH` — a fixed-value rule matched · `SPLIT` — a rollout rule matched (in or out of the allocation) · `DEFAULT` — no rule matched, the flag's default was served · `DISABLED` — the flag is off, its off value was served · `ERROR` — see below. |
| `variant` | The id of the matching rule, when a rule matched. Otherwise absent. |
| `flagMetadata` | `{ revision }` — the revision the value came from. |
| Errors (the caller's default value is returned, `reason: ERROR`) | `FLAG_NOT_FOUND` — the flag is not in the loaded configuration (unknown, archived, or server-only with a browser key) · `TYPE_MISMATCH` — the flag's value has another type than requested · `GENERAL` — malformed configuration · `PROVIDER_NOT_READY` — no configuration has been loaded yet. |
| Provider status and events | `READY` when a current bundle is in use · `STALE` when the bundle in use is not known to be current (failed revalidation, restored from storage, edge serving last-known-good) — evaluations continue · `ERROR` when initialization ends without any configuration; `READY` follows as soon as one arrives · `CONFIGURATION_CHANGED` for every new revision, with `metadata.revision`. |
| Web SDK context changes | Evaluation is local, so a new context applies to the next evaluation without a network round trip; the SDK emits its usual context-changed events. |
| Hooks, domains, global/client/invocation context merging, evaluation details | Provided by the OpenFeature SDK and unaffected. |

## What is not supported

- **Named variants.** NanoFlags rules serve values, not named variants; `variant` carries the rule id
  and is absent for `DEFAULT` and `DISABLED`.
- **`flagsChanged`** on `CONFIGURATION_CHANGED`: the event says that a new revision is in use, not
  which flags differ.
- **Tracking** (`track`) is not implemented; calls are ignored by the SDK. NanoFlags' own sampled
  evaluation telemetry is configured on the `@nanoflags/sdk` client.
- **Provider hooks**, **`PROVIDER_FATAL`** and **`RECONCILING`**: not emitted. A revoked or wrong SDK
  key surfaces as `ERROR` (no configuration) or `STALE` (a configuration was already loaded).
- **Reasons `STATIC`, `CACHED`, `TARGETING_KEY_MISSING`**: not used. A rollout evaluated without a
  targeting key is treated as outside the allocation and reported as `SPLIT`.
- **Other languages.** This package covers JavaScript/TypeScript only.
- The `STALE` and `ERROR` states describe the client's configuration, not individual flags; a
  flag evaluated while `STALE` reports its normal reason.

The tests exercise the provider through the real OpenFeature SDKs for the surface listed above. This
is not a claim of conformance beyond that surface, nor of equivalence with other vendors' providers.

## Development

```sh
pnpm --filter @nanoflags/openfeature-provider test
pnpm --filter @nanoflags/openfeature-provider typecheck
pnpm --filter @nanoflags/openfeature-provider build   # dist/: ESM + CJS + .d.ts/.d.cts (tsdown)
```
