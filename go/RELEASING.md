# Releasing the Go SDK

The Go SDK is developed here (`packages/sdk-go`, private monorepo) and published from the public
repository `github.com/motazalmaroai/nanoflags-sdk`, where it lives in the directory `go/`.

| Module | Directory in the public repo | Tag |
| --- | --- | --- |
| `github.com/motazalmaroai/nanoflags-sdk/go` | `go/` | `go/vX.Y.Z` |
| `github.com/motazalmaroai/nanoflags-sdk/go/ofprovider` | `go/ofprovider/` | `go/ofprovider/vX.Y.Z` |

Go resolves a module in a subdirectory by a tag prefixed with that directory, so `go/v0.1.0` is
version `v0.1.0` of `github.com/motazalmaroai/nanoflags-sdk/go`. The provider is a nested module so
that the SDK does not depend on OpenFeature (and keeps `go 1.22`; the provider needs Go 1.24).

## 1. Mirror (proposed change to `scripts/export-sdk-repo.sh`, not applied)

The script copies each directory to the same path in the public repository. The Go SDK needs a
different destination (`go/`, so the module path is short), so the list becomes `source:destination`
pairs. The secret scan then covers `go/` as well. The SDK's files pass the scan as they are (no keys:
examples read `NANOFLAGS_SDK_KEY`, the test key is not hex).

```diff
--- a/scripts/export-sdk-repo.sh
+++ b/scripts/export-sdk-repo.sh
@@
 # Copies (with --delete, so files removed here are removed there):
-#   packages/engine packages/sdk packages/openfeature packages/cli integrations/github-action
+#   packages/engine packages/sdk packages/openfeature packages/cli integrations/github-action,
+#   and packages/sdk-go to go/ (Go module github.com/motazalmaroai/nanoflags-sdk/go, tags go/vX.Y.Z)
@@
-dirs=(packages/engine packages/sdk packages/openfeature packages/cli integrations/github-action)
+# source[:destination] — the destination defaults to the source path.
+dirs=(packages/engine packages/sdk packages/openfeature packages/cli integrations/github-action packages/sdk-go:go)
 
-for d in "${dirs[@]}"; do
-  mkdir -p "$dest/$d"
+for entry in "${dirs[@]}"; do
+  d="${entry%%:*}"
+  to="${entry#*:}"
+  mkdir -p "$dest/$to"
   rsync -a --delete \
     --exclude node_modules/ \
     --exclude dist/ \
     --exclude coverage/ \
     --exclude .turbo/ \
     --exclude '*.tsbuildinfo' \
     --exclude '*.tgz' \
     --exclude '.env*' \
     --exclude .dev.vars \
     --exclude .secrets/ \
     --exclude .DS_Store \
-    "$src/$d/" "$dest/$d/"
-  echo "copied $d"
+    "$src/$d/" "$dest/$to/"
+  echo "copied $d -> $to"
 done
@@
 scan_paths=()
-for d in "${dirs[@]}"; do scan_paths+=("$dest/$d"); done
+for entry in "${dirs[@]}"; do scan_paths+=("$dest/${entry#*:}"); done
 if grep -rnIE "$pattern" "${scan_paths[@]}" --exclude-dir=node_modules --exclude-dir=dist; then
@@
-echo "scan clean. Next: cd $dest && pnpm install && pnpm build && pnpm typecheck && pnpm test, review git diff, commit."
+echo "scan clean. Next: cd $dest && pnpm install && pnpm build && pnpm typecheck && pnpm test,"
+echo "  (cd go && go vet ./... && go test -race ./... && cd ofprovider && go vet ./... && go test -race ./...),"
+echo "  review git diff, commit."
```

`packages/engine` is mirrored to the same relative place, so the Go parity tests find the shared
fixtures in both layouts (`../../engine/fixtures/parity.json` here, `../../packages/engine/fixtures/parity.json`
from `go/engine` there), and `internal/testdata/generate-extra.mjs` finds the TypeScript engine in both.

Suggested CI job for the public repository (`.github/workflows/ci.yml`):

```yaml
  go:
    runs-on: ubuntu-latest
    strategy: { matrix: { go: ["1.22", "stable"] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "${{ matrix.go }}" }
      - run: cd go && go vet ./... && go test -race ./...
      - run: cd go/ofprovider && go vet ./... && go test -race ./...
        if: matrix.go == 'stable'
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node go/internal/testdata/generate-extra.mjs --check && node packages/engine/fixtures/generate-parity.mjs --check
```

## 2. Release checklist

In the monorepo:

1. Set `SDKVersion` in `client.go` (e.g. `0.1.0`); if the provider changes, set its `require
   github.com/motazalmaroai/nanoflags-sdk/go vX.Y.Z` in `ofprovider/go.mod` to the SDK version it needs.
2. `go vet ./... && go test -race ./...` and the same in `ofprovider/`; `node internal/testdata/generate-extra.mjs --check`.
3. Live check: `NANOFLAGS_SDK_KEY=<demo browser key> go run ./examples/live -toggle 2`.

Then mirror and tag:

```sh
scripts/export-sdk-repo.sh ../nanoflags-sdk          # with the change above
cd ../nanoflags-sdk
(cd go && go vet ./... && go test -race ./...)
(cd go/ofprovider && go vet ./... && go test -race ./...)
git add go && git diff --cached --stat               # review: the repository is PUBLIC
git commit -m "go: v0.1.0"
git push origin main

git tag -a go/v0.1.0 -m "Go SDK v0.1.0"
git push origin go/v0.1.0
# The provider requires the SDK tag, so it is tagged after it:
git tag -a go/ofprovider/v0.1.0 -m "Go OpenFeature provider v0.1.0"
git push origin go/ofprovider/v0.1.0

# Make the versions known to the module proxy and pkg.go.dev:
GOPROXY=https://proxy.golang.org go list -m github.com/motazalmaroai/nanoflags-sdk/go@v0.1.0
GOPROXY=https://proxy.golang.org go list -m github.com/motazalmaroai/nanoflags-sdk/go/ofprovider@v0.1.0
```

Check that `go get github.com/motazalmaroai/nanoflags-sdk/go@v0.1.0` works from an empty module and that
<https://pkg.go.dev/github.com/motazalmaroai/nanoflags-sdk/go> shows the docs and the Apache-2.0 license
(each module directory carries its own `LICENSE`).

Notes:

- Tags are immutable for Go users (the proxy and the checksum database keep the first content they
  saw): never move or re-push a tag; release a new patch version instead.
- The `replace github.com/motazalmaroai/nanoflags-sdk/go => ../` line in `ofprovider/go.mod` only
  applies inside this repository; applications that require the provider resolve the SDK by its tag.
- A `v2+` major version would need the module path suffix `/v2` (`…/nanoflags-sdk/go/v2`, tag `go/v2.0.0`).
