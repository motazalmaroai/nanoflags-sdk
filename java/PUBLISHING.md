# Publishing the Java SDK to Maven Central

Nothing has been published. Two artifacts go to Maven Central under the namespace **`io.nanoflags`** (the same
namespace as the Kotlin SDK, see [`kotlin/PUBLISHING.md`](../kotlin/PUBLISHING.md)):

| Coordinates | Packaging |
| --- | --- |
| `io.nanoflags:nanoflags-java:0.1.0` | jar (+ sources, javadoc), no dependencies |
| `io.nanoflags:nanoflags-java-openfeature:0.1.0` | jar (+ sources, javadoc), depends on `nanoflags-java` and `dev.openfeature:sdk` |

The build produces everything Central requires: POMs with name, description, URL, Apache-2.0 license, developer, SCM
and issue tracker; sources and javadoc jars; checksums; GPG signatures when a key is supplied.
`./gradlew publishAllPublicationsToStagingRepository` writes the complete Maven layout to `java/build/staging-deploy/`
(unsigned without a key). Nothing in the build uploads anything.

The Java version lives in `java/gradle.properties` (`nanoflags.version`), separate from `kotlin/gradle.properties`, so
`auto-release.yml` (which releases the Kotlin artifacts when *their* version is not on Central) never picks the Java
artifacts up.

## 1. One-time setup (founder)

The Central Portal account, the verified `io.nanoflags` namespace, the user token and the GPG key are shared with the
Kotlin SDK: follow section 1 of [`kotlin/PUBLISHING.md`](../kotlin/PUBLISHING.md) once. The same repository secrets
(`CENTRAL_TOKEN_USERNAME`, `CENTRAL_TOKEN_PASSWORD`, `GPG_SIGNING_KEY`, `GPG_SIGNING_PASSWORD`) and the protected
environment `maven-central` serve both.

## 2. Release workflow (proposed, not added)

Tag `java-v<version>`. Same flow as the Kotlin release: check the tag against `java/gradle.properties`, refuse a
version that is already on Central, test, build and sign into the staging directory, upload a **user-managed**
deployment to the Central Portal, then click *Publish* in the portal after review.

```yaml
name: Release Java SDK
on:
  push:
    tags: ["java-v*"]
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    environment: maven-central
    defaults:
      run:
        working-directory: java
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
          [ "${GITHUB_REF_NAME#java-v}" = "$version" ] || { echo "::error::tag does not match $version"; exit 1; }
          if curl -sf "https://repo1.maven.org/maven2/io/nanoflags/nanoflags-java/$version/nanoflags-java-$version.pom" > /dev/null; then
            echo "::error::io.nanoflags:nanoflags-java $version is already on Maven Central"; exit 1; fi
          echo "VERSION=$version" >> "$GITHUB_ENV"
      - run: ./gradlew --no-daemon test
      - name: Build and sign
        env:
          ORG_GRADLE_PROJECT_signingKey: ${{ secrets.GPG_SIGNING_KEY }}
          ORG_GRADLE_PROJECT_signingPassword: ${{ secrets.GPG_SIGNING_PASSWORD }}
        run: |
          ./gradlew --no-daemon publishAllPublicationsToStagingRepository
          missing=$(find build/staging-deploy -type f \( -name '*.jar' -o -name '*.pom' -o -name '*.module' \) ! -exec test -e '{}.asc' \; -print)
          [ -z "$missing" ] || { echo "::error::unsigned files: $missing"; exit 1; }
          (cd build/staging-deploy && zip -qr ../central-bundle.zip io)
      - name: Upload to the Central Portal (user-managed)
        env:
          CENTRAL_USER: ${{ secrets.CENTRAL_TOKEN_USERNAME }}
          CENTRAL_PASS: ${{ secrets.CENTRAL_TOKEN_PASSWORD }}
        run: |
          token=$(printf '%s:%s' "$CENTRAL_USER" "$CENTRAL_PASS" | base64 -w0)
          curl -sSf -X POST -H "Authorization: Bearer $token" -F "bundle=@build/central-bundle.zip" \
            "https://central.sonatype.com/api/v1/publisher/upload?name=nanoflags-java-$VERSION&publishingType=USER_MANAGED"
```

## 3. Release checklist

1. Bump `nanoflags.version` in `java/gradle.properties` (the runtime version is generated from it;
   `ClientTest.versionMatchesTheBuild` checks the wiring); move the CHANGELOG entry out of "unreleased".
2. Make sure `NanoFlagsOptions.OFFICIAL_SIGNING_KEYS` matches `GET https://edge.nanoflags.io/v1/keys`.
3. Let `java.yml` pass, tag `java-v<version>`, approve the `maven-central` environment, then *Publish* the validated
   deployment in the portal.
