# Changelog

## Unreleased

- Five new read-only tools (14 tools; the nine existing ones keep their names and semantics): `preview_change`,
  `find_stale_flags`, `get_removal_readiness`, `get_effective_policy`, `get_flag_usage`, each with an `outputSchema`.
- `update_draft` takes an optional `expectedVersion` (`If-Match`, 412 `DRAFT_CONFLICT` explained); `get_flag` shows
  `draftVersion`. Drafts and initial values are checked with the engine's strict validator before the API call
  (the engine is now compiled into the package).
- Bounded output: `limit`/`cursor` on `list_environments`, `limit` on `get_change_status` (approvals) and
  `explain_flag` (insight lists), and every result held to 64 KB with `truncated: true` and a marker line.
- Provenance: client name/version, transport and the optional `sessionId` / `taskRef` arguments of the write tools
  are sent as `X-NanoFlags-Agent-*` headers and recorded in the audit log; they never change what a token may do.

- New read-only tool `get_profile` (9 tools): a stable opaque profile id (per person and organization, from
  `token.get`), display name, agent label and project. Marked `_meta["openai/profile"]: true` with an `outputSchema`.
- Tool annotations are explicit and reviewed: `openWorldHint` is `false` for every tool (a private NanoFlags
  workspace), and `update_draft` is `destructiveHint: true` (it overwrites draft rules and values).
- `createServer` options `securitySchemes` and `authChallenge` (used by the hosted remote server for ChatGPT's
  per-tool OAuth declaration and `_meta["mcp/www_authenticate"]`); the stdio server does not set them.

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
