/**
 * The NanoFlags MCP protocol core, shared by the stdio server (`nanoflags-mcp`, src/bin.ts) and the hosted remote
 * server (workers/mcp, Streamable HTTP at https://mcp.nanoflags.io/mcp). No Node.js or Workers APIs: a transport hands
 * it one parsed JSON-RPC message and writes back what `handle` returns.
 *
 * Dual-era (MCP 2026-07-28 "Versioning: Backward Compatibility"):
 *   * Modern requests carry `_meta["io.modelcontextprotocol/protocolVersion"]` (2026-07-28 and later): stateless, no
 *     handshake; `server/discover` is answered; every result has `resultType: "complete"` and the server's identity in
 *     `_meta`; list results carry `ttlMs` / `cacheScope`. An unsupported version answers -32022 with the supported list.
 *   * Legacy requests (2025-11-25 and earlier) start with `initialize`; `ping` is answered; nothing else changes.
 * Tools are identical in both eras and on both transports.
 */
import { ApiClient, ApiError } from "./api.js";
import { TOOLS, ToolInputError, validate, type Tool, type ToolContext } from "./tools.js";

export const VERSION = "0.3.0";
/** Handshake-based revisions answered by `initialize`, preferred first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** Per-request-metadata revisions (no handshake). */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
export const SUPPORTED_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...PROTOCOL_VERSIONS];

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** JSON-RPC error codes this server uses (MCP 2026-07-28 "Error Codes"). */
export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

export const INSTRUCTIONS = [
  "NanoFlags feature flags. This server acts through an AI-agent token: it reads flags and environments, creates flags, edits drafts (targeting rules, default and off values) and opens change requests.",
  "Publishing, approving, scheduling, the kill switch and settings are not available through this server: a person does them in the NanoFlags dashboard after reviewing the change.",
  "The tools fit together as: explain_flag or get_flag, then create_flag / update_draft, then open_change_request, then get_change_status.",
].join(" ");

/** How to fix a credential or configuration problem, in the words of the transport (env vars for stdio, sign-in for remote). */
export interface Hints {
  /** After INSUFFICIENT_SCOPE. */
  scope: string;
  /** After UNAUTHORIZED. */
  unauthorized: string;
  /** When no project is known. */
  project: string;
}

export const STDIO_HINTS: Hints = {
  scope: "The token in NANOFLAGS_API_TOKEN lacks that scope. Ask an owner or admin for an AI-agent token (Settings → API tokens → AI agents).",
  unauthorized: "Check NANOFLAGS_API_TOKEN: the token may be revoked or expired. Ask an owner or admin for a new AI-agent token.",
  project: "Name the project: pass `project` (a project key) or set NANOFLAGS_PROJECT in the MCP server configuration.",
};

type Id = string | number | null;
interface Request { jsonrpc: "2.0"; id?: Id; method: string; params?: Record<string, unknown> }
export type Message = Record<string, unknown>;

export interface ServerOptions {
  api: ApiClient;
  defaultProject?: string;
  tools?: Tool[];
  log?: (line: string) => void;
  hints?: Hints;
  /** Shown as serverInfo.name/title; defaults to nanoflags / NanoFlags. */
  serverInfo?: { name: string; title: string; version: string };
}

export const rpcError = (id: Id, code: number, message: string, data?: unknown): Message =>
  ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The protocol version a modern request declares in `_meta`, or null for a legacy (handshake-era) message. */
export function modernVersionOf(raw: unknown): string | null {
  if (!isObject(raw) || !isObject(raw.params) || !isObject(raw.params._meta)) return null;
  const v = raw.params._meta[META_PROTOCOL_VERSION];
  return typeof v === "string" ? v : null;
}

/** Text an agent can act on for an API refusal. */
export function explainError(e: unknown, hints: Hints = STDIO_HINTS): string {
  if (e instanceof ToolInputError) return e.message;
  if (!(e instanceof ApiError)) return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  const base = `NanoFlags refused (${e.code}): ${e.message}`;
  switch (e.code) {
    case "AGENT_FORBIDDEN":
      return `${base}\nThis is a governance rule, not a bug: AI agents propose, people approve and publish. Open a change request instead and ask a person to review it in the dashboard.`;
    case "INSUFFICIENT_SCOPE":
      return `${base}\n${hints.scope}`;
    case "UNAUTHORIZED":
      return `${base}\n${hints.unauthorized}`;
    case "FORBIDDEN":
      return `${base}\nThe person who owns this token does not have that permission in this project or environment.`;
    case "PLAN_REQUIRED":
      return `${base}\nThe organization's plan does not include this.`;
    default:
      return base;
  }
}

export function createServer(o: ServerOptions) {
  const tools = o.tools ?? TOOLS;
  const hints = o.hints ?? STDIO_HINTS;
  const serverInfo = o.serverInfo ?? { name: "nanoflags", title: "NanoFlags", version: VERSION };
  let tokenProject: Promise<string | null> | null = null;
  const ctx: ToolContext = {
    api: o.api,
    defaultProject: o.defaultProject,
    projectHint: hints.project,
    tokenProject: () =>
      (tokenProject ??= o.api.get<{ projectKey: string | null }>("/token").then(
        (t) => t.projectKey ?? null,
        () => null,
      )),
  };
  const toolList = () => tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } }));

  async function callTool(params: Record<string, unknown>): Promise<Message> {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), { rpc: RPC.INVALID_PARAMS });
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) return { content: [{ type: "text", text: "Arguments must be an object." }], isError: true };
    const invalid = validate(tool.inputSchema, args);
    if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };
    try {
      const r = await tool.run(args, ctx);
      return { content: [{ type: "text", text: r.text }], ...(r.data !== undefined && isObject(r.data) ? { structuredContent: r.data } : {}), isError: false };
    } catch (e) {
      if (!(e instanceof ApiError) && !(e instanceof ToolInputError)) o.log?.(`tool ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { content: [{ type: "text", text: explainError(e, hints) }], isError: true, ...(e instanceof ApiError ? { structuredContent: { error: { code: e.code, message: e.message, status: e.status } } } : {}) };
    }
  }

  /** Handles one message; returns the response, or null for notifications (and for responses a client sent). */
  async function handle(raw: unknown): Promise<Message | null> {
    if (!isObject(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
      return isObject(raw) && ("result" in raw || "error" in raw) ? null : rpcError(isObject(raw) && (typeof raw.id === "string" || typeof raw.id === "number") ? raw.id : null, RPC.INVALID_REQUEST, "Invalid request.");
    }
    const req = raw as unknown as Request;
    const notification = req.id === undefined;
    const id: Id = req.id ?? null;
    const params = isObject(req.params) ? req.params : {};
    const modern = modernVersionOf(raw);
    if (modern !== null && req.method !== "initialize") {
      if (!MODERN_PROTOCOL_VERSIONS.includes(modern)) {
        return notification ? null : rpcError(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: modern });
      }
      return handleModern(req, id, params, notification);
    }
    try {
      let result: unknown;
      switch (req.method) {
        case "initialize": {
          const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          result = {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: INSTRUCTIONS,
          };
          break;
        }
        case "ping":
          result = {};
          break;
        case "server/discover":
          result = discover();
          break;
        case "tools/list":
          result = { tools: toolList() };
          break;
        case "tools/call":
          result = await callTool(params);
          break;
        default:
          if (notification) return null; // notifications/initialized, notifications/cancelled, …
          return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
      }
      return notification ? null : { jsonrpc: "2.0", id, result };
    } catch (e) {
      const code = isObject(e) && typeof e.rpc === "number" ? e.rpc : RPC.INTERNAL;
      return notification ? null : rpcError(id, code, e instanceof Error ? e.message : "Internal error.");
    }
  }

  function discover() {
    return {
      resultType: "complete",
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      ttlMs: 3_600_000,
      cacheScope: "public",
      _meta: { [META_SERVER_INFO]: serverInfo },
    };
  }

  /** 2026-07-28: stateless, every result complete and self-identified. Removed methods (ping, logging) are unknown. */
  async function handleModern(req: Request, id: Id, params: Record<string, unknown>, notification: boolean): Promise<Message | null> {
    if (notification) return null;
    const meta = { [META_SERVER_INFO]: serverInfo };
    try {
      switch (req.method) {
        case "server/discover":
          return { jsonrpc: "2.0", id, result: discover() };
        case "tools/list":
          // The tool list is the same for every caller and changes only with a release.
          return { jsonrpc: "2.0", id, result: { resultType: "complete", tools: toolList(), ttlMs: 3_600_000, cacheScope: "public", _meta: meta } };
        case "tools/call":
          return { jsonrpc: "2.0", id, result: { resultType: "complete", ...(await callTool(params)), _meta: meta } };
        default:
          return rpcError(id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
      }
    } catch (e) {
      const code = isObject(e) && typeof e.rpc === "number" ? e.rpc : RPC.INTERNAL;
      return rpcError(id, code, e instanceof Error ? e.message : "Internal error.");
    }
  }

  return { handle, tools };
}

export type McpServer = ReturnType<typeof createServer>;
