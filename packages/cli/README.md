# @nanoflags/cli

Command line for NanoFlags: export a project, create flags, evaluate flags locally, run scenario checks in CI,
publish, upload flag code references, and remove resolved flags from code.

```sh
npx @nanoflags/cli --help        # or: npm install -g @nanoflags/cli && nanoflags --help
# from this repository:
pnpm install && pnpm --filter @nanoflags/cli build
node packages/cli/dist/bin.js --help
```

Node 20 or newer. The only runtime dependency is `typescript` (used to read source files for
`refs scan` and `cleanup`; it is loaded only by those commands). Releases are published to npm from
[motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk) by its release
workflow (`.github/workflows/release.yml`, tag `cli-v<version>`).

## Authentication

| | |
| --- | --- |
| `NANOFLAGS_KEY` / `--key` | A **CI key** (`nf_ci_…`: export, scenarios, code references) or an **admin key** (`nf_adm_…`: all of that, plus `flags create` and publish). SDK keys are refused by these endpoints. Prefer the environment variable — arguments are visible in process lists and shell history. |
| `NANOFLAGS_BASE_URL` / `--base-url` | Edge URL. Default `https://edge.nanoflags.io`. Must be `https` (plain `http` only for `localhost`). |
| `NANOFLAGS_API_TOKEN` / `--token` | Only for `flags kill` / `flags restore`: a **Management API token** (`nf_api_…`) with the `flags:kill` scope. |
| `NANOFLAGS_SDK_KEY` / `--sdk-key` | Optional, only for `eval --source published`: a server SDK key; reads `/v1/bundle` instead of `/v1/ci/published`. |

A key belongs to one environment of one project; commands act on that environment. The key is sent
only as an `Authorization` header to the base URL and is never printed.

Use a CI key in CI. It cannot publish, so a leaked CI key cannot change what your users get.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | A check failed: a scenario failed, or a publish was refused |
| 2 | Usage, configuration or key problem (missing/rejected key, wrong key kind, bad arguments, refused cleanup) |
| 3 | NanoFlags could not be reached or answered with a server error |

## Commands

### `nanoflags export [--out <file>]`

`GET /v1/admin/export`. Prints the project as JSON: flags (with `permanent`, `archived`, …), segments,
environments, and the **draft** configuration of every environment. `--out` writes a file instead.
The saved file can be passed to other commands with `--export <file>` to work offline.

### `nanoflags flags list [--json]`

Table of the project's flags: key, type, purpose, lifetime (permanent/temporary), client exposure, and
on/off in the draft of the key's environment.

### `nanoflags flags create <key> --type boolean|string|number|json [--default <json>] [--description <text>] [--name <text>] [--json]`

`POST /v1/admin/flags` — creates a flag in the key's project. **Admin key only** (a CI key is refused
before any request). Nothing is published: every environment's **draft** starts with the default value,
and the flag reaches SDKs only with the next publish.

```sh
nanoflags flags create new-checkout --description "New checkout flow"            # boolean, default false
nanoflags flags create theme --type string --default blue --name "Theme"         # bare word = string
nanoflags flags create search-limit --type number --default 25
nanoflags flags create ranker --type json --default '{"model":"v2","weights":[1,2]}'
```

- `--type` defaults to `boolean`; `--default` defaults to `false` for boolean flags and is required otherwise.
- `--default` is JSON and must match the type. For string flags a value that is not JSON is taken as the
  string itself (`--default blue` = `--default '"blue"'`).
- The key follows the dashboard rules: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 63.
- `--name` defaults to the key. Purpose, owner, review date and client exposure are set in the dashboard.
- The creation is recorded in the project's activity log with the key's name.

| Refusal (exit 1) | Meaning |
| --- | --- |
| `CONFLICT` | A flag with this key already exists in the project. |
| `INVALID_VALUE` | The default does not match the flag type. |

### `nanoflags flags kill <key> (--env <key> | --all-environments) --reason <text> [--project <key>] [--json]`

Emergency kill switch (`POST /api/v1/projects/{p}/flags/{f}/kill`, scope `flags:kill`). Publishes a new revision
in which only this flag is off, so SDKs serve its published off value within about a second — without a change,
approvals or scenario checks. Needs the organization's kill-switch role (owners and admins by default) for the token's
creator. `--reason` (8–1000 characters) is required; every owner and admin is e-mailed. Each run sends a fresh
`Idempotency-Key`. `--project` is needed only when the token sees more than one project.

```sh
export NANOFLAGS_API_TOKEN=nf_api_…
nanoflags flags kill new-checkout --env production --reason "Checkout errors spiking since the 14:00 release"
```

| Refusal | Exit | Meaning |
| --- | --- | --- |
| `FORBIDDEN`, `MFA_REQUIRED`, `INSUFFICIENT_SCOPE` | 2 | Role, two-step verification or token scope. |
| `ALREADY_KILLED`, `NO_CHANGES` | 1 | Already killed, or not published / already off there. |
| `RATE_LIMITED` | 1 | 5 kills per person per 10 minutes, 20 per organization per hour. |

### `nanoflags flags restore <key> --env <key> [--title <text>] [--reason <text>] [--project <key>] [--json]`

`POST /api/v1/projects/{p}/flags/{f}/restore`. Turns the killed flag back on in the environment's draft and opens
(or returns) a change for it. Nothing is published: publish the change through the normal reviewed path.

### `nanoflags eval <flag> [--context <json>] [--source draft|published] [--fallback <json>] [--environment <key>] [--json]`

Evaluates one flag **locally** with the NanoFlags engine — the same code the SDKs and the edge run —
and prints the value, the reason and the trace.

```sh
nanoflags eval checkout-v2 --context '{"key":"u1","signedIn":true,"region":"US"}'
# checkout-v2 = false
# reason: rule_match · rule r1 (#1) · outside rollout (bucket 95.27)
# source: draft of staging
# trace: …
```

- `--source draft` (default): the draft from the export. `--environment` picks another environment's draft.
- `--source published`: the published revision of the key's environment. With the CI or admin key
  (`NANOFLAGS_KEY`) it is read from `GET /v1/ci/published`; when `NANOFLAGS_SDK_KEY` / `--sdk-key` (a server
  SDK key) is set, the CLI instead reads exactly what SDKs receive (`GET /v1/bundle`). Same revision either way.
- An unknown flag is not an error: the fallback (`--fallback`, default `null`) is printed with reason `flag_not_found`.

### `nanoflags scenarios run [--source draft|revision] [--commit <sha>] [--run-url <url>] [--json]`

`POST /v1/ci/scenarios/run`. NanoFlags evaluates every scenario marked "include in CI" against the
draft (default) or the published revision, records the run, and returns the results. The command prints
a table and exits **1 when any scenario fails**.

In GitHub Actions, `--commit` and `--run-url` default from `GITHUB_SHA` and the run's URL, and a Markdown
summary is appended to `GITHUB_STEP_SUMMARY`. See [`integrations/github-action`](../../integrations/github-action).

### `nanoflags publish --expected-revision <n> [--note <text>] [--cosign <file> [--change <id>]]`

`POST /v1/admin/publish` — publishes the draft of the key's environment. Admin key only.
`--expected-revision` is the revision you believe is published now; if someone else published in the
meantime nothing happens.

| Refusal (exit 1) | Meaning |
| --- | --- |
| `DESTINATION_CHANGED` | The environment is at another revision than expected. Review, then retry with the new number. |
| `NO_CHANGES` | The draft equals the published configuration. |
| `CHANGE_REQUIRED` | The draft needs a reviewed change (required approval, or work proposed by an AI agent). Publish from the dashboard; keys cannot bypass review. On a co-signed environment, publish the approved change with `--change`. |
| `APPROVAL_REQUIRED` | `--change`: the change has no independent approval of the current draft yet (or the draft changed since). |
| `SCENARIOS_REQUIRED` | The environment requires passing scenarios on the current draft: run `nanoflags scenarios run --source draft` first. |
| `COSIGN_REQUIRED` | The environment requires your co-signature: `nanoflags sign`, then `publish --cosign <file>`. |
| `COSIGN_INVALID` | The co-signature does not match the current draft or a registered key. Sign again. |

`--cosign <file>` sends the co-signature written by `nanoflags sign` (co-signed environments, Scale and Enterprise).

`--change <id>` (with `--cosign` only) publishes through that change, as the dashboard's publish button does: the
change must be open and meet the environment's publish requirements (independent approval of the current draft,
scenarios). Co-signed environments cannot be published from the dashboard, so this is how they publish work that needs
an approval, such as a draft with edits proposed by an AI agent: approve the change in the dashboard, then sign and
publish from CI. The change is marked published with the new revision.

### `nanoflags keygen --out <file> [--kid <id>]`

Creates an Ed25519 co-signing key: the private JWK goes to `--out` (mode 600, never overwritten; keep it in your CI's
secret store), the public JWK is printed. Register the public key (`x`) for the environment in the dashboard
(environment → Security → Co-signing) and give the same public JWK to SDKs as `coSignerKeys`.

### `nanoflags sign --key <private key file> [--kid <id>] [--expect <bundle.json>] [--expect-checksum <md5>] [--out <file>] [--bundle-out <file>] [--json]`

Co-signs the revision the next publish would create. Here `--key` is the path of **your** private key (JWK or
PKCS#8 PEM; `--signing-key` is an alias); the NanoFlags admin key is read from `NANOFLAGS_KEY`. The CLI downloads the
draft (`GET /v1/admin/cosign/preview`), computes the exact bundle texts the publisher will sign (server and browser
view) on this machine, checks that the key matches the one registered under its `kid`, and signs both canonical
strings. `--bundle-out` saves the server bundle text for review or a diff against your configuration as code.

**Check what you sign.** The draft comes from NanoFlags, and co-signing exists for the case where NanoFlags cannot be
trusted, so the signer must pin the content it expects:

- `--expect <bundle.json>`: a JSON object with the `flags` (and optionally `segments`) your pipeline reviewed — from
  your configuration as code, or a `--bundle-out` file of a reviewed run. Compared flag by flag (key order does not
  matter; segments only when the file has `segments`).
- `--expect-checksum <md5>`: the checksum of the draft your pipeline reviewed.

When the draft differs, `sign` refuses (exit 1), writes nothing and prints a per-flag diff (`-` expected but missing,
`+` not expected, `~` different).

```sh
NANOFLAGS_KEY=$ADMIN_KEY nanoflags sign --key ci-cosign.jwk --expect reviewed-bundle.json --out cosign.json
NANOFLAGS_KEY=$ADMIN_KEY nanoflags publish --expected-revision 41 --cosign cosign.json
# work that needs an approval (e.g. proposed by an AI agent): publish the approved change
NANOFLAGS_KEY=$ADMIN_KEY nanoflags publish --expected-revision 41 --cosign cosign.json --change 0b6f0c4e-9a43-4a0e-8f43-3f0d3c1b2a10
```

### `nanoflags log verify [--env <id>] [--state <file>] [--public-keys <file>] [--json]`

Downloads the environment's transparency log (`/v1/log/head`, `/v1/log/entries`) with any key of the environment
(`NANOFLAGS_SDK_KEY` or `NANOFLAGS_KEY`) and verifies the whole history locally: the tree head is signed by NanoFlags
(built-in keys for the hosted edge, `--public-keys` to pin your own copy, else `GET /v1/keys`), every entry is
well-formed and belongs to the environment, and the entries hash to the signed root. With `--state`, the head saved by
the previous run must be a prefix of the current one (checked from the entries and with `/v1/log/consistency`); the new
head is saved. Lists co-signed and emergency (kill switch without co-signature) revisions. Exit 1 on any mismatch.

### `nanoflags log monitor --state <file> [--env <id>] [--public-keys <file>] [--json]`

The light, one-shot check for a scheduled CI job: verifies the signed head and that it extends the head in `--state`
(consistency proof), then saves it. Cache the state file between runs. Exit 1 when the log forked, shrank or was
rewritten.

### `nanoflags refs scan [dir] --repo <owner/name> [--commit <sha>] [--dry-run] [--json] [--max-file-size <bytes>]`

Finds flag references in `.ts .tsx .js .jsx .mjs .cjs` files under `dir` (default `.`) and uploads them
with `PUT /v1/ci/code-refs`, **replacing** the references previously stored for that repository.

A reference is a call

- whose callee name is `boolean`, `string`, `number`, `json`, `evaluate`, `useFlag`, `getBooleanValue`,
  `getStringValue`, `getNumberValue`, `getObjectValue` or a `…Details` variant
  (`flags.boolean(…)`, `client.getStringDetails(…)`, `useFlag(…)`), **and**
- whose first argument is a string literal equal to a flag key of the project.

Files are parsed with the TypeScript compiler; nothing is executed. Not found: keys built at run time,
keys passed through variables or constants, wrappers with other names. Skipped: `node_modules`, `dist`,
`build`, `.next`, `.git`, `.d.ts` files, symbolic links, and files above 1 MB (`--max-file-size`). At most
5000 references are uploaded. Uploaded per reference: flag key, relative path, line, and the source line
(up to 240 characters) — check that this is acceptable for your code before enabling it.

`--dry-run` prints the references and uploads nothing. `--repo`/`--commit` default from
`GITHUB_REPOSITORY`/`GITHUB_SHA`.

### `nanoflags cleanup <flag> --value <json> [dir] [--write]`

For a flag that is **permanently resolved to one value**, rewrites the code that still reads it.
The default is a dry run that prints a unified diff; `--write` edits the files in place.

```sh
nanoflags cleanup checkout-v2 --value true src        # show the diff
nanoflags cleanup checkout-v2 --value true src --write
```

What it does, for value-returning reads (`flags.boolean/string/number/json("key", …)`,
`useFlag("key", <literal fallback>)`, awaited `getBooleanValue/…("key", …)`):

| Pattern | Result |
| --- | --- |
| `if (<read>) A else B`, also negated, in `else if` chains, combined with `&&`/`\|\|` | the branch that runs; the other one is removed |
| `<read> ? a : b` | `a` or `b` |
| `<read> && x`, `<read> \|\| x`, `x && <read>` / `x \|\| <read>` in a condition | `x`, or the constant |
| `<read> === "literal"` / `!==` | folded, then simplified as above |
| `const on = <read>;` followed by uses of `on` | every use is treated like the read itself, then the declaration is removed (kept when exported) |
| anything else (`let`, arguments, object properties, JSX attributes, loops) | the read is replaced with the literal |

Limits, by design:

- It **never commits, pushes, opens a pull request or merges**, and runs no other program. Review the
  diff, run your tests, commit yourself.
- It **refuses flags marked `permanent`** (kill switches, long-lived configuration) and values whose type
  does not match the flag.
- It prints every reference it did **not** transform, with the reason:
  `evaluate()` / `…Details()` (they return an object), un-awaited `get…Value()` (may be a promise),
  optional calls (`flags?.boolean(…)`), reads whose callee or arguments contain calls (dropping them
  could drop a side effect), accessors of another type than the value (such a read returns its fallback
  today), `useFlag` with a non-literal fallback.
- Only literal flag keys are recognised — the same rule as `refs scan`. A flag read through a wrapper
  or a constant is invisible to it.
- It does not delete code that became unreachable after a `return`/`throw`; those places are listed.
  It does not remove imports, variables or helpers that became unused, and it does not reformat: run
  your linter and formatter afterwards.
- A block's braces are kept when unwrapping it could change what a name refers to.
- If a rewrite would leave a file with new syntax errors, that file is left untouched and reported.
- It works on syntax, one file at a time, without type information. It is a proposal for a person to
  review, not a proof.

### `nanoflags import <file> --project <key> [--env-map src=target,…] [--format …] [--conflict skip|rename|overwrite] [--rename-suffix <s>] [--label <text>] [--dry-run] [--json]`

`POST /api/v1/projects/{project}/imports` (Management API). Converts a flag file into the project's **drafts**: an
OpenFeature flagd definition, the NanoFlags import format (JSON or CSV), a NanoFlags export, or another tool's export
(`--format`, default `auto`; `.csv` files are read as CSV). Needs a Management API token in `NANOFLAGS_API_TOKEN`
(or `--token`) with `flags:write`, and `segments:write` when the file has segments. CI and admin keys are not used here.

- `--dry-run` prints what would be created, conflicts with existing keys, warnings (unsupported features) and the
  fidelity report, and writes nothing.
- `--env-map default=development,prod=production` maps source environments to the project's (flagd files have one
  source environment, `default`). Without it the server suggests a mapping (same key, common aliases).
- `--conflict` for keys that exist: `skip` (default), `rename` (`<key>-imported`), `overwrite` (replaces the drafts of
  the mapped environments; never a flag's type).

Nothing is published. Applying sends an `Idempotency-Key` derived from the file and options, so re-running the same
command answers with the first import instead of importing twice. Exit code 1 when some items failed. Format reference:
https://nanoflags.io/docs/import

### `nanoflags import verify <file> --contexts <file.jsonl> --project <key> [--env-map …] [--format …] [--flags a,b] [--json]`

Side-by-side comparison before you switch: a dry run (nothing is written) that also sends your sample contexts (JSON
Lines, one context object per line, or a JSON array; at most 1000). Each context is evaluated for every imported flag
and mapped environment with the source's semantics and with the NanoFlags engine on the drafts that importing this
file would produce, and every context whose value would differ is listed. The comparison is against this file's
conversion, not against drafts already stored in the project; because nothing is written, `--conflict` defaults to
`overwrite` here, so flags that already exist (for example after an earlier import) are compared too. Differences
decided by a percentage on both sides are counted separately (the bucketing hash differs, the shares do not).
`--flags` limits the comparison to some flags. Contexts in the shape `{ "userID", "custom", "customIDs" }` are
flattened (`userID` becomes `key`). Exit code 1 when a context differs, when nothing could be compared (formats whose
semantics are not re-implemented), or when some flag/environment pairs were not compared because of the evaluation
budget (narrow `--flags` or use fewer contexts); 0 otherwise.

## Development

```sh
pnpm --filter @nanoflags/cli test        # mocked fetch + fixtures in test/fixtures
pnpm --filter @nanoflags/cli typecheck
pnpm --filter @nanoflags/cli build       # dist/bin.js
UPDATE_FIXTURES=1 pnpm --filter @nanoflags/cli test   # re-record cleanup fixtures after an intended change
```
