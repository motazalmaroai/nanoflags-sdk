# NanoFlags MCP server

`nanoflags-mcp` lets coding agents (Claude Code, Cursor and any other [Model Context Protocol](https://modelcontextprotocol.io) client) work with NanoFlags feature flags: read flags, create flags, edit drafts and open change requests.

**Agents propose, people approve.** The server runs with an *AI-agent token*. NanoFlags enforces in its database that an agent token can never publish, approve, schedule a publish, use the kill switch, or change policies, permissions, tokens, members or billing. Every change an agent makes is recorded in the audit log as "via agent &lt;label&gt;", and on Team and above work proposed by an agent always needs an independent approval by a person before it can be published. Read more: <https://nanoflags.io/docs/ai-agents>.

## 1. Create an agent token

An owner or admin opens **Settings → API tokens → AI agents** in the NanoFlags dashboard, names the agent (for example `Claude Code on laptop-x`), optionally limits it to one project, and copies the token (`nf_api_…`). It is shown once and expires within 90 days. Revoke it there at any time.

## 2. Configure your client

The server reads its configuration from the environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `NANOFLAGS_API_TOKEN` | yes | The agent token (`nf_api_…`). |
| `NANOFLAGS_PROJECT` | no | Default project key. Not needed when the token is limited to one project. |
| `NANOFLAGS_BASE_URL` | no | API origin. Default `https://edge.nanoflags.io`. |

### Claude Code

```sh
claude mcp add nanoflags --env NANOFLAGS_API_TOKEN=nf_api_… --env NANOFLAGS_PROJECT=commerce -- npx -y @nanoflags/mcp
```

or in `.mcp.json` at the root of your repository (keep the token out of version control: reference an environment variable):

```json
{
  "mcpServers": {
    "nanoflags": {
      "command": "npx",
      "args": ["-y", "@nanoflags/mcp"],
      "env": { "NANOFLAGS_API_TOKEN": "${NANOFLAGS_API_TOKEN}", "NANOFLAGS_PROJECT": "commerce" }
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "nanoflags": {
      "command": "npx",
      "args": ["-y", "@nanoflags/mcp"],
      "env": { "NANOFLAGS_API_TOKEN": "nf_api_…", "NANOFLAGS_PROJECT": "commerce" }
    }
  }
}
```

Other MCP clients: run `npx -y @nanoflags/mcp` as a stdio server with the variables above.

## Tools

| Tool | What it does |
| --- | --- |
| `list_environments` | Environments of a project and their publishing policy. |
| `list_flags` | Flags of a project (paged). |
| `get_flag` | A flag's definition and its draft configuration per environment. |
| `explain_flag` | What a flag is, its live and draft state in every environment, and where it is evaluated (services, SDKs, served values) from usage insights. |
| `create_flag` | Create a flag. It starts off in every draft. |
| `update_draft` | Edit one environment's draft: on/off, targeting rules, default and off values. |
| `open_change_request` | Open a change for edited flags and submit it for review. |
| `get_change_status` | Status and approvals of a change. |

There is no tool to publish, approve or kill, by design. If an agent asks the API for one of those anyway, NanoFlags answers `403 AGENT_FORBIDDEN` and the server tells the agent to open a change request instead.

## Typical session

1. "Roll out `checkout-v2` to pro customers in staging." The agent calls `explain_flag`, then `update_draft` with a rule `plan eq pro → true`.
2. It calls `open_change_request` with a title and the reason, and gives you the review link.
3. A teammate (not the token owner: the agent acts as you, so you are its author) approves the change in the dashboard, and a person publishes it.

## Development

```sh
pnpm --filter @nanoflags/mcp test        # unit tests against a mocked Management API
pnpm --filter @nanoflags/mcp typecheck
pnpm --filter @nanoflags/mcp build       # dist/bin.js
```

No runtime dependencies. Node 20 or later.

## License

Apache-2.0
