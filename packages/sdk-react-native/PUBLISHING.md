# Publishing `@nanoflags/react-native` to npm

Nothing has been published. Like `@nanoflags/sdk`, `@nanoflags/openfeature-provider` and `@nanoflags/cli`, the package is
released from the public mirror [motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk) by GitHub
Actions, with **npm provenance** (a signed SLSA statement linking the tarball to the commit and workflow run that built
it). The name was free on 2026-11-13 (`npm view @nanoflags/react-native` → 404); the `@nanoflags` scope is already the
founder's (it publishes `@nanoflags/sdk` 0.4.0).

The package has no runtime dependencies: the engine, the `@nanoflags/sdk` core, the OpenFeature mapping and the pinned
`@noble/*` crypto are compiled into `dist/` (see `tsdown.config.ts`). The `workspace:*` entries are devDependencies
only and are rewritten by `pnpm pack`.

## 1. One-time setup (founder)

1. **npm account**: the account that owns the `@nanoflags` scope, with 2FA enabled (already required for the existing
   packages).
2. **First publish** — npm's trusted publishing can only be configured for a package that exists, so the first release
   uses the mirror's existing `NPM_TOKEN` secret (a granular token with *read and write* on `@nanoflags/*`). Provenance
   works with a token too: the workflow below passes `--provenance` and grants `id-token: write`.
3. **Then switch to trusted publishing (no token)**: on npmjs.com → `@nanoflags/react-native` → *Settings* → *Trusted
   publishing* → GitHub Actions: organization/user `motazalmaroai`, repository `nanoflags-sdk`, workflow filename
   `release-react-native.yml`, environment `npm`. Then set *Publishing access* to "Require two-factor authentication
   and disallow tokens". With trusted publishing npm generates provenance automatically. Remove `NODE_AUTH_TOKEN` from
   the workflow afterwards (or leave it: OIDC is preferred when configured).
4. **GitHub environment** `npm` in `motazalmaroai/nanoflags-sdk` (*Settings → Environments*), optionally with required
   reviewers, so a tag alone cannot publish.

## 2. Mirror the package (private monorepo → public repo)

`scripts/export-sdk-repo.sh` does not copy `packages/sdk-react-native` yet. Proposed change (not applied):

```diff
 #   packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go (as go/)
+#   packages/sdk-react-native
 ...
-dirs=(packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go:go)
+dirs=(packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go:go packages/sdk-react-native)
 ...
     --exclude .DS_Store \
+    --exclude .expo/ \
+    --exclude 'dist-*/' \
+    --exclude /ci/ \
     "$src/$d/" "$dest/$to/"
```

`packages/sdk-react-native/ci/mobile-react-native.yml` (device tests, see section 3b) contains the **public** live-demo
browser key, which the export script's credential pattern (`nf_pub_[0-9a-f]{16,}`) would flag. It is a root workflow
of the public repository, installed by hand into `.github/workflows/`, so the export excludes `ci/` (the anchored
`/ci/` only matches the package's top-level `ci` directory).

The package builds from its siblings' sources (`../engine/src`, `../sdk/src`, `../openfeature/src`), which the mirror
has at the same relative paths. The parity test reads `packages/engine/fixtures/parity.json` and, when present,
`go/internal/testdata/extra.json`. The credential scan of the export script passes on `packages/sdk-react-native`
(checked 2026-11-13; no SDK key is stored in the package — `scripts/live-check.mjs` reads `NANOFLAGS_SDK_KEY`).

The mirror's `pnpm-workspace.yaml` must include `packages/*` (it does for the other packages). `example/` is not a
workspace member (its own `package.json`, Expo dependencies), so `pnpm install` at the root does not pull in Expo.

## 3. Workflow in the public repo

Add `.github/workflows/release-react-native.yml` to `motazalmaroai/nanoflags-sdk` (root files there are maintained by
hand; the export script does not touch them). The tag `react-native-v<version>` cannot collide with `sdk-v*`,
`openfeature-v*`, `cli-v*` or `python-v*`.

```yaml
name: Release React Native SDK

# tag react-native-v<version> -> npm @nanoflags/react-native (packages/sdk-react-native), with provenance.
on:
  push:
    tags: ["react-native-v*"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest # provenance requires a GitHub-hosted runner
    timeout-minutes: 20
    environment:
      name: npm
      url: https://www.npmjs.com/package/@nanoflags/react-native
    permissions:
      contents: read
      id-token: write # npm provenance / trusted publishing (OIDC)
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          cache: pnpm
      - name: npm >= 11.5.1 (trusted publishing)
        run: npm install -g npm@11
      - run: pnpm install --frozen-lockfile
      - name: Check the tag matches package.json and the version is new
        working-directory: packages/sdk-react-native
        run: |
          version=$(node -p "require('./package.json').version")
          if [ "$GITHUB_EVENT_NAME" = "push" ] && [ "${GITHUB_REF_NAME#react-native-v}" != "$version" ]; then
            echo "::error::Tag $GITHUB_REF_NAME does not match version $version in packages/sdk-react-native/package.json"; exit 1
          fi
          if npm view "@nanoflags/react-native@$version" version >/dev/null 2>&1; then
            echo "::error::@nanoflags/react-native $version is already on npm. Bump the version."; exit 1
          fi
      - name: Typecheck, build, test (parity through dist/)
        working-directory: packages/sdk-react-native
        run: pnpm typecheck && pnpm test
      - name: Pack (rewrites workspace:* devDependencies)
        working-directory: packages/sdk-react-native
        run: pnpm pack --pack-destination "$RUNNER_TEMP"
      - name: Publish with provenance
        run: npm publish "$RUNNER_TEMP"/nanoflags-react-native-*.tgz --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} # first release only; trusted publishing needs no token
```

Optionally type-check and bundle the Expo example on pull requests (no simulator needed; Metro + Hermes bytecode):

```yaml
  react-native-example:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile && pnpm --filter @nanoflags/react-native build
      - working-directory: packages/sdk-react-native
        run: pnpm pack --pack-destination /tmp/rn
      - working-directory: packages/sdk-react-native/example
        run: |
          npm pkg set "dependencies.@nanoflags/react-native=file:$(ls /tmp/rn/*.tgz)"
          npm install --no-audit --no-fund
          npx tsc --noEmit
          CI=1 npx expo export --platform android --output-dir /tmp/rn-export
```

## 3b. Device tests (Android emulator, iOS simulator)

`packages/sdk-react-native/ci/mobile-react-native.yml` is a ready-to-use workflow: copy it to
`.github/workflows/mobile-react-native.yml` in the public repo. No secrets; free on a public repository (macOS
runners included). Jobs:

| Job | Runner | What it does |
| --- | --- | --- |
| `sdk` | ubuntu-latest | typecheck, build, unit tests, parity fixtures through `dist/`; packs the tarball |
| `example` | ubuntu-latest | installs the Expo example against the tarball; `tsc`; Jest (`jest-expo`, `@testing-library/react-native`) |
| `android` | ubuntu-latest + KVM | `expo prebuild` + `gradlew assembleRelease` (x86_64), emulator API 34 x86_64 (`reactivecircus/android-emulator-runner`), Maestro flows |
| `ios` | macos-latest | `expo prebuild` + `xcodebuild` (simulator, unsigned), first available iPhone simulator, Maestro flows; `continue-on-error` |

The Maestro flows (`example/.maestro/`) run against production with the public demo key: wait for `status ready · … ·
live`, publish the next `demo-accent` through `POST /v1/demo/toggle` (from a Maestro `runScript`), assert the UI shows
it, background → toggle → foreground catch-up, `identify()` and a relaunch from the persisted bundle; each flow restores
the value it changed. The device jobs run one after the other and runs never overlap (they share the public demo flag).
Actions are pinned by commit SHA; Maestro by version (`MAESTRO_VERSION`).

## 4. Release steps

1. In the monorepo: bump `version` in `packages/sdk-react-native/package.json` **and** `SDK_VERSION` in
   `src/client.ts` (the User-Agent and the telemetry label use it; a test checks the User-Agent), add a `CHANGELOG.md`
   entry, run `pnpm --filter @nanoflags/react-native typecheck && pnpm --filter @nanoflags/react-native test`.
2. Optional live check against production (public demo key, rate limited — keep it gentle, it restores the value):
   `cd packages/sdk-react-native && pnpm build && NANOFLAGS_SDK_KEY=<demo key> node --use-env-proxy --import ./scripts/rn-env.mjs scripts/live-check.mjs --toggles 3`.
3. `scripts/export-sdk-repo.sh ../nanoflags-sdk`, then in the mirror `pnpm install && pnpm build && pnpm typecheck && pnpm test`,
   review `git diff`, commit, push.
4. Tag in the mirror: `git tag react-native-v0.1.0 && git push origin react-native-v0.1.0`.
5. Check https://www.npmjs.com/package/@nanoflags/react-native shows the *Provenance* badge, and
   `npm audit signatures` in a project that installed it reports a verified attestation.

## 5. Notes

- Changes to `packages/sdk/src` (the core) reach React Native users only through a new `@nanoflags/react-native`
  release, since the core is compiled in. The core changes made for this package (`crypto`, `openStream`, `lifecycle`,
  `sdkLabel`, `allFlags`, synchronous socket teardown) are additive and should also go out in the next
  `@nanoflags/sdk` minor release (0.5.0).
- Embedded signing keys come from `packages/sdk/src/keys.ts` (`OFFICIAL_SIGNING_KEYS`); after a key rotation, release
  both packages (RUNTIME.md, "Signing-key rotation").
