# Publishing the .NET SDK to NuGet

Released by `.github/workflows/release-dotnet.yml`, started by `auto-release.yml`. Two packages go to [nuget.org](https://www.nuget.org):

| Package | Targets |
| --- | --- |
| `NanoFlags` 0.1.0 | `netstandard2.0`, `net8.0` (+ `.snupkg` symbols) |
| `NanoFlags.OpenFeature` 0.1.0 | `netstandard2.0`, `net8.0` (+ `.snupkg` symbols) |

`dotnet pack -c Release -o artifacts` (run by `.github/workflows/dotnet.yml`, which uploads the packages as a build
artifact) produces both, with the metadata nuget.org shows: description, Apache-2.0 license expression, project and
repository URLs, README, tags, release notes link, deterministic builds and Source Link (commit and repository are
embedded in CI builds).

## 1. One-time setup (founder)

1. **nuget.org account.** Sign in at <https://www.nuget.org> with a Microsoft account (use a company account, enable
   2FA). Optionally create an organization `nanoflags` and publish under it.
2. **Reserve the prefix** (recommended): request ID prefix reservation for `NanoFlags.*` / `NanoFlags`
   (<https://learn.microsoft.com/nuget/nuget-org/id-prefix-reservation>, e-mail `account@nuget.org` from the account
   owner). Reserved packages get the verified check mark and nobody else can publish `NanoFlags.*` IDs.
3. **Publishing credential — prefer Trusted Publishing** (nuget.org's OIDC, no long-lived secret): on nuget.org,
   *Account → Trusted Publishing → Add policy* for repository `motazalmaroai/nanoflags-sdk`, workflow
   `release-dotnet.yml`, environment `nuget`. The release job then exchanges its GitHub OIDC token for a short-lived
   key with `NuGet/login@v1`.
   *Alternative:* an API key (*Account → API Keys → Create*, scope **Push new packages and package versions**, glob
   pattern `NanoFlags*`, 365 days) stored as the repository secret `NUGET_API_KEY`.
4. Protect the publishing job with a GitHub environment `nuget` (required reviewer: the founder).

## 2. Release workflow

**Current:** on a push to main, `auto-release.yml` pushes the tag `dotnet-v<version>` (with `RELEASE_TAG_TOKEN`) when
`VersionPrefix` is not on nuget.org and the repository variable `NUGET_USER` exists; that tag starts
`release-dotnet.yml`, which is the file below.

Tag `dotnet-v<version>`. It checks the tag against `VersionPrefix` in `dotnet/Directory.Build.props`, refuses a
version that is already on nuget.org, runs the tests, packs and pushes both packages.

```yaml
name: Release .NET SDK
on:
  push:
    tags: ["dotnet-v*"]
permissions:
  contents: read
  id-token: write # Trusted Publishing
jobs:
  release:
    runs-on: ubuntu-latest
    environment: nuget
    defaults:
      run:
        working-directory: dotnet
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: "8.0.x"
      - name: Check the tag matches Directory.Build.props
        run: |
          version=$(sed -n 's:.*<VersionPrefix>\(.*\)</VersionPrefix>.*:\1:p' Directory.Build.props)
          [ "${GITHUB_REF_NAME#dotnet-v}" = "$version" ] || { echo "::error::tag does not match $version"; exit 1; }
          if curl -sf "https://api.nuget.org/v3-flatcontainer/nanoflags/$version/nanoflags.$version.nupkg" -o /dev/null; then
            echo "::error::NanoFlags $version is already on nuget.org"; exit 1; fi
      - run: dotnet test -c Release
      - run: dotnet pack -c Release -o artifacts
      - uses: NuGet/login@v1
        id: login
        with:
          user: ${{ vars.NUGET_USER }} # the nuget.org profile name (a repository variable, not a secret)
      - run: dotnet nuget push "artifacts/*.nupkg" --api-key "${{ steps.login.outputs.NUGET_API_KEY }}" --source https://api.nuget.org/v3/index.json --skip-duplicate
```

`dotnet nuget push` uploads the matching `.snupkg` symbol packages automatically.

## 3. Release checklist

1. Bump `VersionPrefix` in `Directory.Build.props` **and** `NanoFlagsClient.Version` (`ClientTests.VersionMatchesTheBuild`
   fails when they differ); move the CHANGELOG entry out of "unreleased".
2. Make sure `NanoFlagsOptions.OfficialSigningKeys` matches `GET https://edge.nanoflags.io/v1/keys`.
3. Let `dotnet.yml` pass, tag `dotnet-v<version>`, approve the `nuget` environment. Packages are listed on nuget.org
   after validation (usually minutes).
