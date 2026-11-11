# Contributing

Thanks for helping improve the NanoFlags client packages. Bug reports, documentation fixes and pull
requests are welcome.

## Before you start

- **Security issues:** do not open an issue — follow [SECURITY.md](SECURITY.md).
- For larger changes (new options, new transports, behaviour changes), open an issue first so we can agree
  on the approach before you invest time.
- By contributing you agree that your contribution is licensed under the Apache License 2.0
  ([LICENSE](LICENSE)).

## Setup

Node 22.18 or newer (needed by the build tools) and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Guidelines

- **Keep evaluation local and synchronous.** Flag accessors never perform I/O and never throw; the network is
  used only in the background.
- **Deterministic engine.** Changes to `packages/engine` must keep bucketing stable: the same flag, rule and
  context must land in the same bucket across versions. Add tests for every behaviour change.
- **Tests mock the network.** Unit tests must never call a real NanoFlags endpoint or need a real key. Use
  obviously fake keys such as `nf_srv_test_0000…` and the helpers in each package's `test/` directory.
- **No secrets.** Never commit keys, tokens, `.env` files or private signing keys. Scripts that talk to a real
  environment read keys from environment variables only.
- **Public API.** Exported types and options of `@nanoflags/sdk`, `@nanoflags/openfeature-provider` and the CLI
  flags are public API; breaking changes need a major version (or a minor version while below 1.0) and a
  README update.
- TypeScript strict mode; match the existing code style.

## Pull requests

1. Fork and branch from `main`.
2. Make the change with tests and docs.
3. Make sure `pnpm build && pnpm typecheck && pnpm test` passes — CI runs the same on Node 20 and 22.
4. Describe what changed and why. Do not bump versions; maintainers do that when releasing
   (see "Release process" in [README.md](README.md)).
