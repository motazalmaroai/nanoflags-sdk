# Publishing the Dart / Flutter SDK to pub.dev

Nothing has been published. Three packages, all `0.1.0`, released in this order (each depends on the
one before):

| Package | Directory | Needs |
| --- | --- | --- |
| `nanoflags` | `packages/sdk-dart/nanoflags` | Dart |
| `nanoflags_openfeature` | `packages/sdk-dart/nanoflags_openfeature` | Dart ≥ 3.10, `nanoflags` on pub.dev |
| `nanoflags_flutter` | `packages/sdk-dart/nanoflags_flutter` | Flutter, `nanoflags` on pub.dev |

All three names answered `404` on `https://pub.dev/api/packages/<name>` on 2026-11-13 (free).
`dart pub publish --dry-run` of `nanoflags` reports 0 warnings.

Releases go out from the public mirror
[motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk) with **pub.dev automated
publishing** (GitHub Actions OIDC: no token or credential is stored anywhere). pub.dev only allows
enabling it for a package that already exists, so the very first version of each package is uploaded
by hand once.

## 1. Accounts the founder must create (one time)

1. **Google account** for pub.dev (pub.dev signs in with Google only). Use a company account
   (e.g. `dev@nanoflags.io`, Google Workspace or a Google account on that address) rather than a personal
   one, and turn on 2-step verification.
2. **Verified publisher `nanoflags.io`** — packages then show "Published by nanoflags.io ✓" instead of an
   e-mail address:
   1. Verify the domain in [Google Search Console](https://search.google.com/search-console) with the same
      Google account: add a *Domain* property `nanoflags.io` and the DNS `TXT` record it shows
      (`google-site-verification=…`) at the DNS provider (Cloudflare). Wait for "Ownership verified".
   2. On pub.dev: avatar → **Create publisher** → `nanoflags.io` → follow the prompts (pub.dev checks the
      Search Console verification).
   3. Publisher → **Members**: add a second admin (another Google account) so the publisher is never
      locked to one person.

## 2. First upload (manual, once per package)

On a trusted machine with the Dart SDK (and Flutter for `nanoflags_flutter`), from a clean checkout of the
public mirror at the release commit:

```bash
cd packages/sdk-dart/nanoflags
dart pub get && dart test && dart pub publish --dry-run
dart pub publish            # browser login with the pub.dev Google account

cd ../nanoflags_openfeature
rm -f pubspec_overrides.yaml   # dev-only path override; the published package depends on nanoflags ^0.1.0
dart pub get && dart test && dart pub publish

cd ../nanoflags_flutter
rm -f pubspec_overrides.yaml example/pubspec_overrides.yaml
flutter pub get && flutter test && flutter pub publish
```

Then for each package on pub.dev: **Admin → Transfer to publisher** `nanoflags.io` (the uploader's e-mail
then disappears from the listing).

## 3. Enable automated publishing (per package, on pub.dev)

Package → **Admin → Automated publishing → Enable publishing from GitHub Actions**:

| Package | Repository | Tag pattern | Environment |
| --- | --- | --- | --- |
| `nanoflags` | `motazalmaroai/nanoflags-sdk` | `dart-nanoflags-v{{version}}` | `pub.dev` |
| `nanoflags_openfeature` | `motazalmaroai/nanoflags-sdk` | `dart-nanoflags_openfeature-v{{version}}` | `pub.dev` |
| `nanoflags_flutter` | `motazalmaroai/nanoflags-sdk` | `dart-nanoflags_flutter-v{{version}}` | `pub.dev` |

Tick **Require GitHub Actions environment** and create the environment `pub.dev` in the GitHub repository
(Settings → Environments) with **required reviewers** (the founder) and "Deployment branches and tags:
selected" → tag rule `dart-*-v*`. A pushed tag then waits for an approval before anything is published.
The tag prefixes cannot collide with the existing `sdk-v*`, `openfeature-v*`, `cli-v*`, `python-v*` or
Go `go/v*` tags.

## 4. Workflow in the public repo

`.github/workflows/release-dart.yml` (root files of the public repository are maintained by hand; the
export script does not touch them). pub.dev only accepts OIDC tokens from a workflow run triggered by a
**tag push** matching the pattern.

```yaml
name: Release Dart / Flutter SDK

# Tags: dart-nanoflags-v<version>, dart-nanoflags_openfeature-v<version>, dart-nanoflags_flutter-v<version>
on:
  push:
    tags: ["dart-nanoflags-v*", "dart-nanoflags_openfeature-v*", "dart-nanoflags_flutter-v*"]

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: pub.dev
    permissions:
      contents: read
      id-token: write # OIDC token for pub.dev
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      # Exchanges the GitHub OIDC token for a pub.dev token (needs id-token: write).
      - uses: dart-lang/setup-dart@2286a0c042b44434fe26d292bbce8d34f7ec662b # v1.8.2
      - uses: subosito/flutter-action@1a449444c387b1966244ae4d4f8c696479add0b2 # v2.23.0
        with:
          channel: stable
          flutter-version: "3.50.0"
      - name: Select the package from the tag
        id: pkg
        run: |
          tag="$GITHUB_REF_NAME"
          case "$tag" in
            dart-nanoflags_openfeature-v*) pkg=nanoflags_openfeature; tool=dart ;;
            dart-nanoflags_flutter-v*)     pkg=nanoflags_flutter;     tool=flutter ;;
            dart-nanoflags-v*)             pkg=nanoflags;             tool=dart ;;
            *) echo "::error::unexpected tag $tag"; exit 1 ;;
          esac
          version="${tag##*-v}"
          dir="packages/sdk-dart/$pkg"
          actual=$(grep -E '^version:' "$dir/pubspec.yaml" | awk '{print $2}')
          if [ "$actual" != "$version" ]; then
            echo "::error::Tag $tag does not match version $actual in $dir/pubspec.yaml"; exit 1
          fi
          if curl -sf "https://pub.dev/api/packages/$pkg/versions/$version" > /dev/null; then
            echo "::error::$pkg $version is already on pub.dev. Bump the version."; exit 1
          fi
          echo "dir=$dir" >> "$GITHUB_OUTPUT"
          echo "tool=$tool" >> "$GITHUB_OUTPUT"
      - name: Test
        working-directory: ${{ steps.pkg.outputs.dir }}
        run: |
          # The published packages depend on the released `nanoflags`, not the sibling directory.
          rm -f pubspec_overrides.yaml example/pubspec_overrides.yaml
          ${{ steps.pkg.outputs.tool }} pub get
          ${{ steps.pkg.outputs.tool }} test
      - name: Publish
        working-directory: ${{ steps.pkg.outputs.dir }}
        run: |
          ${{ steps.pkg.outputs.tool }} pub publish --dry-run
          ${{ steps.pkg.outputs.tool }} pub publish --force
```

Release: bump `version` + `CHANGELOG.md` in the package, export to the public repo, commit, then
`git tag dart-nanoflags-v0.1.1 && git push origin dart-nanoflags-v0.1.1` (approve the `pub.dev`
environment run). Release `nanoflags` first when the others need its new version.

(`dart-lang/setup-dart/.github/workflows/publish.yml@v1`, the reusable workflow from the pub.dev docs,
works for the two pure-Dart packages too; the explicit job above is used because `nanoflags_flutter`
must be published with the Flutter SDK.)

## 5. Device tests (CI)

`packages/sdk-dart/ci/mobile-flutter.yml` goes to `.github/workflows/mobile-flutter.yml` in the public
repo: `dart test` (parity on the VM and dart2js, unit tests, one live production toggle), then the
example's `integration_test` on an Android emulator (API 34, KVM) and on an iOS simulator
(`macos-latest`). It uses only the public demo browser key; no secrets. That file contains the demo key
literally, which the export scan would flag — keep it out of the export (below) and install it by hand.

## 6. Mirror the packages (private monorepo → public repo)

`scripts/export-sdk-repo.sh` does not copy `packages/sdk-dart` yet. Proposed change (not applied):

```diff
-#   packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go (as go/)
+#   packages/engine packages/sdk packages/sdk-python packages/sdk-dart packages/openfeature packages/cli integrations/github-action packages/sdk-go (as go/)
 ...
-dirs=(packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go:go)
+dirs=(packages/engine packages/sdk packages/sdk-python packages/sdk-dart packages/openfeature packages/cli integrations/github-action packages/sdk-go:go)
 ...
     --exclude .venv/ \
+    --exclude .dart_tool/ \
+    --exclude pubspec.lock \
+    --exclude .flutter-plugins \
+    --exclude .flutter-plugins-dependencies \
+    --exclude /ci/ \
     --exclude coverage/ \
```

(`--exclude /ci/` is anchored to the transfer root, so it only drops `packages/sdk-dart/ci/`; no other
mirrored package has a `ci/` directory at its root.) Test paths already handle both layouts: the parity
tests look for `../../engine/fixtures/parity.json` and the Go corner cases at
`../../sdk-go/internal/testdata/extra.json` (monorepo) or `../../../go/internal/testdata/extra.json`
(public repo). No SDK key is stored in the packages: `tool/live_verify.dart`, the live test and the
example read `NANOFLAGS_SDK_KEY` from the environment / `--dart-define`.
