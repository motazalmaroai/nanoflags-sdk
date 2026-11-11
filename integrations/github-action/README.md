# NanoFlags scenarios — GitHub Action

Runs your NanoFlags scenario checks for a commit and fails the job when a scenario fails. Optionally
uploads flag code references. A composite action around [`@nanoflags/cli`](../../packages/cli) (published to npm from
[motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk)).

What it does:

1. `nanoflags scenarios run --source <source> --commit <sha> --run-url <this run>` — NanoFlags evaluates
   the scenarios, records the result against the commit, and the table is written to the job summary.
2. If `scan-refs: true`: `nanoflags refs scan <refs-dir> --repo <owner/name> --commit <sha>`.
3. Exit code: 0 all scenarios passed · 1 a scenario failed · 2 key/usage problem · 3 NanoFlags unreachable.
   A failed reference upload is a warning; it does not decide the check.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `key` | — (required) | NanoFlags **CI key**. Pass a secret. |
| `base-url` | CLI default | Edge URL. |
| `source` | `draft` | `draft` or `revision` (the published revision). |
| `scan-refs` | `false` | `true` also uploads code references. |
| `refs-dir` | `.` | Directory scanned for references. |
| `cli` | `npx --yes @nanoflags/cli@0` | Command that runs the CLI (see "Choosing the CLI"). |

Output: `result` — `passed`, `failed` or `error`.

## Security — read this first

- **Use a NanoFlags CI key (`nf_ci_…`), never an admin key.** A CI key can run scenarios and upload
  code references. It **cannot publish** or change configuration. The action refuses to run with an
  admin key. Create the key in the dashboard (Project settings → Keys) for the environment whose
  scenarios you want to check, and store it as a repository or environment secret.
- **Use `pull_request`, not `pull_request_target`.** `pull_request_target` runs with your secrets while
  the workflow can be made to check out and execute code from the pull request; that hands the key to
  anyone who can open a PR.
- **Pull requests from forks do not receive secrets.** For those runs the key is empty and the action
  would fail with "No key". Skip the job for forks (see the `if:` below) and let a maintainer run the
  check from a branch in the repository when needed.
- Keep `permissions: contents: read`. The action needs nothing else: it does not comment, push or
  create releases.
- The key reaches the CLI through the `NANOFLAGS_KEY` environment variable only; no input is
  interpolated into shell source. GitHub masks secrets in logs.
- `scan-refs` uploads, per reference, the file path, the line number and that line of source (up to
  240 characters). Leave it off if source lines must not leave the repository.

## Example workflow

```yaml
name: Flags
on:
  pull_request:          # NOT pull_request_target
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  scenarios:
    runs-on: ubuntu-latest
    # Fork pull requests get no secrets: skip instead of failing.
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: motazalmaroai/nanoflags-sdk/integrations/github-action@main   # pin to a commit SHA in production
        with:
          key: ${{ secrets.NANOFLAGS_CI_KEY }}
          source: draft
          scan-refs: ${{ github.ref == 'refs/heads/main' }}   # references from the default branch only
```

### Choosing the CLI

By default the action runs `npx --yes @nanoflags/cli@0`, the CLI published to npm from
[motazalmaroai/nanoflags-sdk](https://github.com/motazalmaroai/nanoflags-sdk). To pin an exact
version, pass it with `cli`:

```yaml
      - uses: motazalmaroai/nanoflags-sdk/integrations/github-action@<commit SHA>
        with:
          key: ${{ secrets.NANOFLAGS_CI_KEY }}
          cli: npx --yes @nanoflags/cli@0.1.0
```

Inside a checkout of the nanoflags-sdk repository itself, use `uses: ./integrations/github-action`
with `cli: node packages/cli/dist/bin.js` after `pnpm install && pnpm --filter @nanoflags/cli build`.

## Requiring scenarios before a publish

If an environment has "require scenarios" enabled, a publish is only accepted when every scenario
passed on the exact draft being published. Running this action with `source: draft` on the commit is
what records those passes; the result is tied to the draft's checksum, so editing the draft afterwards
requires a new run.
