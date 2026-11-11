#!/usr/bin/env bash
# NanoFlags scenarios action. Reads its configuration from the environment (see action.yml).
set -uo pipefail

out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "result=$1" >> "$GITHUB_OUTPUT"; fi; }

if [ -z "${NANOFLAGS_KEY:-}" ]; then
  echo "::error title=NanoFlags::No key. Pass a NanoFlags CI key through the 'key' input from a secret. Pull requests from forks do not receive secrets: skip this job for them."
  out error
  exit 2
fi
case "$NANOFLAGS_KEY" in
  nf_adm_*)
    echo "::error title=NanoFlags::This is an admin key. CI must use a CI key (nf_ci_…), which cannot publish. Create one in Project settings → Keys and rotate the admin key."
    out error
    exit 2
    ;;
esac
case "${NANOFLAGS_SOURCE:-draft}" in
  draft | revision) ;;
  *)
    echo "::error title=NanoFlags::Input 'source' must be \"draft\" or \"revision\"."
    out error
    exit 2
    ;;
esac

# The CLI command is split on spaces on purpose ("npx --yes @nanoflags/cli", "node path/to/bin.js").
read -r -a CLI <<< "${NANOFLAGS_CLI:-npx --yes @nanoflags/cli@0}"

"${CLI[@]}" scenarios run --source "${NANOFLAGS_SOURCE:-draft}" --commit "${GITHUB_SHA:-}" --run-url "${NANOFLAGS_RUN_URL:-}"
status=$?

if [ "${NANOFLAGS_SCAN_REFS:-false}" = "true" ]; then
  if [ "$status" -eq 0 ] || [ "$status" -eq 1 ]; then
    echo
    if ! "${CLI[@]}" refs scan "${NANOFLAGS_REFS_DIR:-.}" --repo "${GITHUB_REPOSITORY:-}" --commit "${GITHUB_SHA:-}"; then
      # References are bookkeeping: failing to upload them does not decide the check.
      echo "::warning title=NanoFlags::Flag references could not be uploaded."
    fi
  fi
fi

case "$status" in
  0) out passed ;;
  1)
    out failed
    echo "::error title=NanoFlags::One or more scenarios failed. See the job summary."
    ;;
  *)
    out error
    echo "::error title=NanoFlags::The scenario checks could not run (exit code $status)."
    ;;
esac
exit "$status"
