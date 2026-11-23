# Changelog

## 0.3.0 (2026-11-23)

- MCP 2026-07-28: the server is dual-era. Requests that carry their protocol version in `_meta` are served statelessly
  (`server/discover`, `resultType`, server identity in `_meta`, `ttlMs` / `cacheScope` on `tools/list`, -32022 for an
  unsupported version); clients that start with `initialize` (2025-11-25 and earlier) work as before.
- The protocol and tools moved to a transport-independent core (`src/core.ts`), shared with NanoFlags' hosted remote
  server at `https://mcp.nanoflags.io/mcp` (connect ChatGPT, Claude and other apps with OAuth, no token to copy).
- Tool input schemas declare the JSON types of value parameters (`initialValue`, `default`, `off`); the rule format
  moved from the `update_draft` description to its `rules` parameter; descriptions state facts only.
- `mcpName` (`io.github.motazalmaroai/nanoflags`) and `server.json` for the official MCP Registry.

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
