# Publishing the Android / Kotlin SDK to Maven Central

Nothing has been published. The three artifacts go to Maven Central under the namespace **`io.nanoflags`**:

| Coordinates | Packaging |
| --- | --- |
| `io.nanoflags:nanoflags-core:0.1.0` | jar (+ sources, javadoc) |
| `io.nanoflags:nanoflags-android:0.1.0` | aar (+ sources, javadoc) |
| `io.nanoflags:nanoflags-openfeature:0.1.0` | jar (+ sources, javadoc) |

Releases go out from the public mirror [motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk)
through the **Sonatype Central Portal** (central.sonatype.com; the legacy OSSRH / s01 hosts are retired). The build
already produces everything Central requires: POMs with name, description, URL, Apache-2.0 license, developer and
SCM; sources and javadoc jars; checksums; GPG signatures when a key is supplied. Locally,
`./gradlew publishAllPublicationsToStagingRepository` writes the complete Maven layout to `build/staging-deploy/`
(unsigned without a key — checked on 2026-11-13).

## 1. One-time setup (founder)

### 1.1 Central Portal account

1. Sign up at <https://central.sonatype.com> (use a company account / shared mailbox, enable 2FA).
2. **Namespace `io.nanoflags`** — Central only lets you publish under a namespace you prove you own. For a domain
   namespace the proof is a DNS TXT record:
   1. *Publishing → Namespaces → Add Namespace* → `io.nanoflags`. The portal shows a **verification key** (a random
      string).
   2. In the DNS of **nanoflags.io** (Cloudflare) add a **TXT** record on the apex `nanoflags.io` (name `@`) with
      the verification key as its value. TTL: auto.
   3. Check it resolves: `dig +short TXT nanoflags.io` must list the key.
   4. Click *Verify Namespace*. Once it shows *Verified* the TXT record may be removed (keeping it does no harm).
3. **User token** for CI: *Account → Generate User Token*. It shows a token **username** and **password** once —
   store both as repository secrets (below). Never use the account password in CI.

### 1.2 GPG signing key

Central requires every file to be signed and the public key to be on a public key server.

```bash
gpg --quick-generate-key "NanoFlags Releases <releases@nanoflags.io>" ed25519 sign 3y
gpg --list-secret-keys --keyid-format long          # note the key id (16 hex chars)
gpg --keyserver keyserver.ubuntu.com --send-keys <KEYID>
gpg --keyserver keys.openpgp.org --send-keys <KEYID>   # then confirm the e-mail keys.openpgp.org sends
gpg --armor --export-secret-keys <KEYID> > nanoflags-signing.asc   # for the CI secret; delete the file afterwards
```

Keep an offline backup of the secret key and a revocation certificate (`gpg --gen-revoke <KEYID>`).

### 1.3 Secrets in the public repository

*Settings → Secrets and variables → Actions*:

| Name | Kind | Value |
| --- | --- | --- |
| `CENTRAL_TOKEN_USERNAME` | secret | user token username |
| `CENTRAL_TOKEN_PASSWORD` | secret | user token password |
| `GPG_SIGNING_KEY` | secret | content of `nanoflags-signing.asc` |
| `GPG_SIGNING_PASSWORD` | secret | its passphrase |
| `NANOFLAGS_DEMO_SDK_KEY` | **variable** (not a secret) | the public demo browser key, for the optional production checks of `mobile-android.yml` |

Restrict the secrets to a protected environment `maven-central` (required reviewer: the founder) so only an approved
release run can use them.

## 2. Mirror the package (private monorepo → public repo)

`scripts/export-sdk-repo.sh` does not copy `packages/sdk-kotlin` yet. Proposed change (not applied):

```diff
-#   packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go (as go/)
+#   packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go (as go/) packages/sdk-kotlin (as kotlin/)
 ...
-dirs=(packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go:go)
+dirs=(packages/engine packages/sdk packages/sdk-python packages/openfeature packages/cli integrations/github-action packages/sdk-go:go packages/sdk-kotlin:kotlin)
 ...
     --exclude .venv/ \
+    --exclude .gradle/ \
+    --exclude .kotlin/ \
+    --exclude local.properties \
     --exclude coverage/ \
```

`build/` is already excluded. The tests find the shared fixtures at their public paths
(`packages/engine/fixtures/parity.json`, `go/internal/testdata/extra.json`, `go/internal/testdata/signed-demo-response.json`),
so the mirrored Go fixtures must stay. No SDK key is stored in the package: the production tests read
`NANOFLAGS_SDK_KEY` / the instrumentation argument `nanoflagsSdkKey`, so the credential scan's `nf_pub_<hex>` rule
passes. `gradle/wrapper/gradle-wrapper.jar` is binary (the scan's `grep -I` skips it); its distribution URL is pinned
with `distributionSha256Sum`.

Then copy the two workflows by hand (root files of the public repo are maintained there):

- `kotlin/ci/mobile-android.yml` → `.github/workflows/mobile-android.yml` (JVM tests + emulator tests, no secrets);
- the release workflow below → `.github/workflows/release-kotlin.yml`.

## 3. Release workflow (public repo)

Tag `kotlin-v<version>` (cannot collide with `sdk-v*`, `python-v*`, `go/v*`, …). It checks the tag against
`kotlin/gradle.properties`, runs the JVM tests, builds and signs into the staging directory, zips it and uploads it to
the Central Portal Publisher API as a **user-managed** deployment: the founder reviews the validated deployment in the
portal (*Publishing → Deployments*) and clicks **Publish**. (Switch to `publishingType=AUTOMATIC` once a few releases
went through.)

```yaml
name: Release Kotlin SDK

on:
  push:
    tags: ["kotlin-v*"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    environment: maven-central
    timeout-minutes: 30
    defaults:
      run:
        working-directory: kotlin
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-java@77dd5b2ce225ea11469928ac317850245a74ae78 # v6.2.0
        with:
          distribution: temurin
          java-version: "17"
      - uses: gradle/actions/setup-gradle@8da46b539cd8fe6ab27ca75128919a18d757604c # v6.4.1
      - name: Check the tag matches gradle.properties
        run: |
          version=$(sed -n 's/^nanoflags.version=//p' gradle.properties)
          if [ "$GITHUB_EVENT_NAME" = "push" ] && [ "${GITHUB_REF_NAME#kotlin-v}" != "$version" ]; then
            echo "::error::Tag $GITHUB_REF_NAME does not match nanoflags.version=$version"; exit 1
          fi
          if curl -sf "https://repo1.maven.org/maven2/io/nanoflags/nanoflags-core/$version/nanoflags-core-$version.pom" > /dev/null; then
            echo "::error::io.nanoflags $version is already on Maven Central. Bump the version."; exit 1
          fi
          echo "VERSION=$version" >> "$GITHUB_ENV"
      - name: Test
        run: ./gradlew --no-daemon :nanoflags-core:test :nanoflags-android:testDebugUnitTest :nanoflags-openfeature:test
      - name: Build and sign
        env:
          ORG_GRADLE_PROJECT_signingKey: ${{ secrets.GPG_SIGNING_KEY }}
          ORG_GRADLE_PROJECT_signingPassword: ${{ secrets.GPG_SIGNING_PASSWORD }}
        run: |
          ./gradlew --no-daemon publishAllPublicationsToStagingRepository
          # every artifact must be signed
          missing=$(find build/staging-deploy -type f \( -name '*.jar' -o -name '*.aar' -o -name '*.pom' -o -name '*.module' \) ! -exec test -e '{}.asc' \; -print)
          if [ -n "$missing" ]; then echo "::error::unsigned files: $missing"; exit 1; fi
          (cd build/staging-deploy && zip -qr ../central-bundle.zip io)
      - name: Upload to the Central Portal (user-managed: publish from the portal after review)
        env:
          CENTRAL_USER: ${{ secrets.CENTRAL_TOKEN_USERNAME }}
          CENTRAL_PASS: ${{ secrets.CENTRAL_TOKEN_PASSWORD }}
        run: |
          token=$(printf '%s:%s' "$CENTRAL_USER" "$CENTRAL_PASS" | base64 -w0)
          id=$(curl -sSf -X POST -H "Authorization: Bearer $token" \
            -F "bundle=@build/central-bundle.zip" \
            "https://central.sonatype.com/api/v1/publisher/upload?name=nanoflags-kotlin-$VERSION&publishingType=USER_MANAGED")
          echo "deployment id: $id"
          for i in $(seq 1 60); do
            state=$(curl -sSf -X POST -H "Authorization: Bearer $token" "https://central.sonatype.com/api/v1/publisher/status?id=$id" | jq -r .deploymentState)
            echo "state: $state"
            case "$state" in VALIDATED) echo "Validated: publish it at https://central.sonatype.com/publishing/deployments"; exit 0;; FAILED) exit 1;; esac
            sleep 10
          done
          exit 1
```

Gradle reads `ORG_GRADLE_PROJECT_signingKey` / `…signingPassword` as the properties `signingKey` / `signingPassword`;
the root `build.gradle.kts` then signs every publication with the in-memory key (`useInMemoryPgpKeys`).

## 4. Release checklist

1. Bump `nanoflags.version` in `gradle.properties` **and** `BuildInfo.VERSION` (`ValueTest.versionMatchesTheBuild`
   fails when they differ); move the CHANGELOG entry out of "unreleased".
2. Make sure `OFFICIAL_SIGNING_KEYS` matches `GET https://edge.nanoflags.io/v1/keys` (key rotations, RUNTIME.md).
3. Export to the public repo, let `mobile-android.yml` pass (JVM + emulator), tag `kotlin-v<version>`, approve the
   `maven-central` environment, then *Publish* the validated deployment in the portal. Artifacts appear on
   `repo1.maven.org` within ~30 minutes (search can take longer).
