# Changelog

## 0.2.0 (2026-11-21)

- `update_draft` lists every condition operator, including the version (`semver_*`) and date (`before` / `after`)
  operators, and says that `gt` / `gte` / `lt` / `lte` compare numbers only (`"4.10"` is 4.1), so agents pick the
  version operators for app versions.

## 0.1.0 (2026-11-19)

First release.

- `nanoflags-mcp`: a Model Context Protocol server (stdio) for coding agents, configured with an AI-agent token
  (`NANOFLAGS_API_TOKEN`, optional `NANOFLAGS_PROJECT` and `NANOFLAGS_BASE_URL`).
- Tools: `list_environments`, `list_flags`, `get_flag`, `explain_flag`, `create_flag`, `update_draft`,
  `open_change_request`, `get_change_status`. Agents propose; people approve and publish (no publish, approve or
  kill tool).
