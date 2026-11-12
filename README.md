# NanoFlags client packages

NanoFlags is a feature-flag service: you configure, test, review and publish flags in the dashboard, and your services evaluate them locally.
This repository holds the open-source (Apache-2.0) client side: the evaluation engine, the JavaScript/TypeScript SDK, the OpenFeature provider, the CLI and the GitHub Action.

Documentation: https://nanoflags.io/docs · Dashboard: https://app.nanoflags.io

## Packages

| Package | Path | Install | |
| --- | --- | --- | --- |
| [`@nanoflags/sdk`](packages/sdk) | `packages/sdk` | `npm install @nanoflags/sdk` | Local, synchronous evaluation for Node, browsers, edge runtimes and React; live updates, last-known-good, signature verification, test sessions |
| [`@nanoflags/openfeature-provider`](packages/openfeature) | `packages/openfeature` | `npm install @nanoflags/openfeature-provider @nanoflags/sdk @openfeature/server-sdk` (or `@openfeature/web-sdk`) | [OpenFeature](https://openfeature.dev) provider wrapping the SDK |
| [`@nanoflags/cli`](packages/cli) | `packages/cli` | `npx @nanoflags/cli --help` or `npm install -g @nanoflags/cli` | Export, local evaluation, CI scenario checks, publishing, code references, flag cleanup |
| [`nanoflags` (Python)](packages/sdk-python) | `packages/sdk-python` | `pip install nanoflags` (OpenFeature: `pip install "nanoflags[openfeature]"`) | Native Python 3.9+ server SDK: same engine results (shared parity fixtures), live updates, signature verification, asyncio wrapper |
| [Go SDK](go) | `go` | `go get github.com/motazalmaroai/nanoflags-sdk/go` (OpenFeature: `.../go/ofprovider`) | Native Go 1.22+ server SDK: same engine results (shared parity fixtures), live updates, signature verification |
| [GitHub Action](integrations/github-action) | `integrations/github-action` | `uses: motazalmaroai/nanoflags-sdk/integrations/github-action@<ref>` | Runs scenario checks for a commit and optionally uploads code references |
| `@nanoflags/engine` | `packages/engine` | not published | Deterministic evaluation engine (MurmurHash3 bucketing), bundled into the SDK and the CLI |

The SDK talks to the NanoFlags edge at `https://edge.nanoflags.io` by default.

## Develop

Requirements: Node 22.18 or newer to build (the published packages run on Node 18+ / 20+), pnpm 10
(`corepack enable` picks up the version pinned in `package.json`). CI type-checks and tests on Node 20 and 22.

```sh
pnpm install
pnpm build       # pnpm -r build: dist/ for sdk, openfeature-provider and cli
pnpm typecheck   # pnpm -r typecheck
pnpm test        # pnpm -r test (unit tests mock the network; no key needed)
```

One package only: `pnpm --filter @nanoflags/sdk test`.

Optional smoke test of the SDK against a real environment (the key is read from the environment only;
never commit it):

```sh
NANOFLAGS_SDK_KEY=nf_srv_… pnpm --filter @nanoflags/sdk smoke   # NANOFLAGS_BASE_URL defaults to https://edge.nanoflags.io
```

## Release process

Releases are published to npm by [`.github/workflows/release.yml`](.github/workflows/release.yml) with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

1. Bump `version` in the package's `package.json` (and its README if needed) in a pull request; merge it once CI is green.
2. Either push a tag — `sdk-v<version>`, `openfeature-v<version>` or `cli-v<version>` (the tag's version must equal
   `package.json`) — or run the workflow manually (**Actions → Release → Run workflow**) and choose `package`
   (`sdk`, `openfeature` or `cli`); a manual run publishes the version currently in that `package.json`.
3. The workflow checks that the version is not on npm yet (if it is, it skips with a notice), builds, type-checks
   and tests, packs with `pnpm pack` (which rewrites `workspace:` ranges; the job fails if any remain), and runs
   `npm publish <tarball> --provenance --access public`. Pre-release versions (`1.2.0-rc.1`) go to the `next`
   dist-tag, others to `latest`.

Publish `@nanoflags/sdk` before an OpenFeature provider release that needs a new SDK version: the provider's
peer range on the SDK is written from the workspace version (currently `^0.3.0`).

**Repository secret required:** the workflow authenticates with `NPM_TOKEN`
(`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`). It must be added to **this** repository
(Settings → Secrets and variables → Actions); a token configured elsewhere is not visible here.

## Contributing, security, conduct

- [CONTRIBUTING.md](CONTRIBUTING.md)
- Security issues: see [SECURITY.md](SECURITY.md) — e-mail support@nanoflags.io, do not open a public issue.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Each package directory carries its own copy.
The NanoFlags name and logo are not covered by the license.
