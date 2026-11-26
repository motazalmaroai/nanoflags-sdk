# Changelog

## 0.6.1 (2026-11-26)

Patch.

- `import --format`: the help lists `auto|flagd|nanoflags|csv`; other JSON export shapes are recognised by `auto`, and
  any other identifier is passed to the API, which validates it and lists the accepted ones.
- The README and the docs use the short command `npx nanoflags init`.

## 0.6.0 (2026-11-26)

Additive.

- New command `nanoflags init`: sets up a JS/TS app in one command. It detects the framework (Next.js App and Pages
  Router, React with Vite, Vite, Create React App, Node/Express; other frameworks get a clear fallback message) and the
  package manager, signs you in through the browser (a one-time code with a paste-back connection string), creates or
  reuses a Development SDK key (a client key for browser frameworks, a server key otherwise), installs
  `@nanoflags/sdk`, writes the key to `.env.local` (`.env` for Node, mode 600, never replacing an existing value
  without asking, and adds the file to `.gitignore` when git would not ignore it), writes a client file in the
  framework's idiom (never overwriting an existing one), creates the draft flag `welcome-banner`, prints a usage
  snippet and waits for the app's first report (a report at revision 0 is not success). Publishing the example flag
  needs your confirmation or `--publish`, and is never done in an environment that requires a reviewed change.
  Flags for CI and scripts: `--yes --framework --key --token --project --env --app-url --base-url --wait --publish
  --skip-install`. The sign-in token it creates is project-scoped and expires after one hour.
- `import`: the help text and messages describe sources by file shape (`auto`, `flagd`, `nanoflags`, `csv`); the
  `--format` identifiers of earlier versions are still accepted. `auto` detects JSON exports.
- The bundled evaluation engine is updated (stricter validation of configuration values).

## 0.5.0 (2026-11-21)

Additive.

- New condition operators: `semver_eq`, `semver_neq`, `semver_gt`, `semver_gte`, `semver_lt`, `semver_lte` compare
  semantic versions (SemVer 2.0 precedence: `4.10.0` > `4.9.0`, `1.0.0-alpha` < `1.0.0-alpha.1` < `1.0.0-beta` <
  `1.0.0-rc.1` < `1.0.0`, build metadata ignored; leniently, a leading `v` is allowed, missing minor / patch are 0 so
  `4.10` = `4.10.0`, and leading zeros are ignored); `before` / `after` compare points in time (`YYYY-MM-DD` as
  00:00 UTC, RFC 3339 timestamps with `Z` or an offset, or Unix time: seconds below 1e12, milliseconds from 1e12).
  A value that cannot be read on either side makes the condition false; evaluation never throws.
- `gt` / `gte` / `lt` / `lte` are unchanged (numeric), so existing rules evaluate exactly as before.
- Verified against the shared conformance vectors (`packages/engine/fixtures/operators.json`, embedded in
  `parity.json`) that every NanoFlags SDK passes. No bundle-format change (`engine` stays 1).
- Earlier releases evaluate conditions with these operators as not matching (they never fail on them): upgrade before
  publishing rules that use them.
- Local evaluation (`nanoflags eval` and scenario checks run by the CLI) uses the new operators.
- `nanoflags import` maps version and date conditions of the source onto the new operators instead of leaving the
  rule out (see the import docs), and refuses version / date conditions whose value cannot be read.

## 0.4.1 (2026-11-20)

- `nanoflags publish` retries a publish refused `BUSY` (HTTP 503: the project's draft is being edited right now, e.g.
  by an import; nothing was published) after 1, 2 and 4 s, then explains it. Needs the edge and database of
  migration 0181.

## 0.4.0 (2026-11-19)

Additive, no breaking changes.

- Co-signing: `nanoflags keygen` creates an Ed25519 co-signing key; `nanoflags sign` co-signs the revision the next
  publish would create (computed and checked locally; `--expect` / `--expect-checksum` refuse to sign a draft that
  differs from the one your pipeline reviewed); `nanoflags publish --cosign <file>` publishes with that co-signature,
  and `--change <id>` publishes an approved change on a co-signed environment. New `COSIGN_REQUIRED`,
  `COSIGN_INVALID` and `APPROVAL_REQUIRED` error explanations.
- Transparency log: `nanoflags log verify` downloads an environment's publish history and verifies it locally (signed
  tree head, every entry, consistency with the head saved in `--state`); `nanoflags log monitor` is the light one-shot
  check for scheduled CI jobs. `--public-keys` pins NanoFlags' signing keys.
- Import: `--format statsig`, and `nanoflags import verify` compares the source's evaluation with the NanoFlags engine
  on your sample contexts before you switch (dry run, nothing is written).
