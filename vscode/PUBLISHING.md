# Publishing the VS Code extension

`.github/workflows/vscode.yml` builds, tests and packages `vscode-nanoflags.vsix` on every pull request and push
(downloadable as a workflow artifact). It publishes only on a tag `vscode-v<version>` that matches `version` in
`vscode/package.json`, to the Visual Studio Marketplace (secret `VSCE_PAT`) and to Open VSX (secret `OVSX_PAT`). Each
registry is skipped with a notice while its secret is missing.

> **Status (checked 2026-11-25).** 0.1.0 is live on both registries from the `vscode-v0.1.0` tag run: Visual Studio
> Marketplace `nanoflags.vscode-nanoflags` (publisher `nanoflags`; domain not verified) and Open VSX
> `nanoflags/vscode-nanoflags` (namespace `nanoflags` exists but is **not verified**; no namespace-claim issue found
> yet). Both secrets and the `vscode-marketplace` environment are therefore set up; the one-time steps still open are
> Marketplace domain verification (step 4) and the Open VSX namespace claim (step 3).

## Release

1. Bump `version` in `vscode/package.json` and date the entry in `vscode/CHANGELOG.md`; merge.
2. Push the tag `vscode-v<version>` (e.g. `vscode-v0.1.0`) on that commit.

The VS Code extension is not part of the npm auto-release: it is not in the pnpm workspace and `package.json` is
`"private": true`, so it is never published to npm.

## One-time setup (founder)

### Visual Studio Marketplace publisher `nanoflags`

1. Sign in at <https://marketplace.visualstudio.com/manage> with the account that should own the extension and create
   the publisher **`nanoflags`** (ID `nanoflags`, display name "NanoFlags"). If the ID is taken, choose another and
   change `publisher` in `vscode/package.json`.
2. Create a personal access token in the Azure DevOps organization of that account (User settings → Personal access
   tokens): organization **All accessible organizations**, scope **Marketplace → Manage**. Set an expiry and a reminder
   to rotate it.
3. Add it as the secret `VSCE_PAT` in the repository environment `vscode-marketplace` (Settings → Environments).
4. Optional: verify the publisher's domain (nanoflags.io) in the publisher settings to get the verified badge.

### Open VSX (editors built on the open-source VS Code)

1. Sign in at <https://open-vsx.org> with GitHub and sign the publisher agreement (profile page).
2. Create an access token (Settings → Access Tokens) and add it as `OVSX_PAT` in the same environment.
3. Create the namespace once: `npx ovsx create-namespace nanoflags -p <token>`. Then claim ownership of the namespace
   (an issue on the Open VSX namespace-claim tracker, linking the publisher and the domain) so it shows as verified.

### Icon

Add a 128×128 PNG as `vscode/media/icon.png` and `"icon": "media/icon.png"` to `package.json` before the first public
release (the Marketplace listing shows a placeholder otherwise).
