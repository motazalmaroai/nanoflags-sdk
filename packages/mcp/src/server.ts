/**
 * A Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0), without dependencies: initialize,
 * ping, tools/list and tools/call. Logs go to stderr only; stdout carries protocol messages.
 */
import { ApiClient, ApiError, DEFAULT_BASE_URL, TOKEN_PATTERN } from "./api.js";
import { TOOLS, ToolInputError, validate, type Tool, type ToolContext } from "./tools.js";

export const VERSION = "0.2.0";
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = [
  "NanoFlags feature flags. You act through an AI-agent token: you can read flags and environments, create flags, edit drafts (targeting rules, default and off values) and open change requests.",
  "You cannot publish, approve, schedule, use the kill switch or change settings: a person does that in the NanoFlags dashboard after reviewing your change. Do not try to work around it.",
  "Typical flow: explain_flag or get_flag, then create_flag / update_draft, then open_change_request with a clear title and reason, then get_change_status.",
].join(" ");

type Id = string | number | null;
interface Request { jsonrpc: "2.0"; id?: Id; method: string; params?: Record<string, unknown> }
type Message = Record<string, unknown>;

export interface ServerOptions {
  api: ApiClient;
  defaultProject?: string;
  tools?: Tool[];
  log?: (line: string) => void;
}

const rpcError = (id: Id, code: number, message: string): Message => ({ jsonrpc: "2.0", id, error: { code, message } });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Text an agent can act on for an API refusal. */
export function explainError(e: unknown): string {
  if (e instanceof ToolInputError) return e.message;
  if (!(e instanceof ApiError)) return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  const base = `NanoFlags refused (${e.code}): ${e.message}`;
  switch (e.code) {
    case "AGENT_FORBIDDEN":
      return `${base}\nThis is a governance rule, not a bug: AI agents propose, people approve and publish. Open a change request instead and ask a person to review it in the dashboard.`;
    case "INSUFFICIENT_SCOPE":
      return `${base}\nThe token in NANOFLAGS_API_TOKEN lacks that scope. Ask an owner or admin for an AI-agent token (Settings → API tokens → AI agents).`;
    case "UNAUTHORIZED":
      return `${base}\nCheck NANOFLAGS_API_TOKEN: the token may be revoked or expired. Ask an owner or admin for a new AI-agent token.`;
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
  let tokenProject: Promise<string | null> | null = null;
  const ctx: ToolContext = {
    api: o.api,
    defaultProject: o.defaultProject,
    tokenProject: () =>
      (tokenProject ??= o.api.get<{ projectKey: string | null }>("/token").then(
        (t) => t.projectKey ?? null,
        () => null,
      )),
  };

  async function callTool(params: Record<string, unknown>): Promise<Message> {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), { rpc: -32602 });
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) return { content: [{ type: "text", text: "Arguments must be an object." }], isError: true };
    const invalid = validate(tool.inputSchema, args);
    if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };
    try {
      const r = await tool.run(args, ctx);
      return { content: [{ type: "text", text: r.text }], ...(r.data !== undefined && isObject(r.data) ? { structuredContent: r.data } : {}), isError: false };
    } catch (e) {
      if (!(e instanceof ApiError) && !(e instanceof ToolInputError)) o.log?.(`tool ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { content: [{ type: "text", text: explainError(e) }], isError: true, ...(e instanceof ApiError ? { structuredContent: { error: { code: e.code, message: e.message, status: e.status } } } : {}) };
    }
  }

  /** Handles one message; returns the response, or null for notifications. */
  async function handle(raw: unknown): Promise<Message | null> {
    if (!isObject(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
      return isObject(raw) && ("result" in raw || "error" in raw) ? null : rpcError(isObject(raw) && (typeof raw.id === "string" || typeof raw.id === "number") ? raw.id : null, -32600, "Invalid request.");
    }
    const req = raw as unknown as Request;
    const notification = req.id === undefined;
    const id: Id = req.id ?? null;
    const params = isObject(req.params) ? req.params : {};
    try {
      let result: unknown;
      switch (req.method) {
        case "initialize": {
          const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          result = {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "nanoflags", title: "NanoFlags", version: VERSION },
            instructions: INSTRUCTIONS,
          };
          break;
        }
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } })) };
          break;
        case "tools/call":
          result = await callTool(params);
          break;
        default:
          if (notification) return null; // notifications/initialized, notifications/cancelled, …
          return rpcError(id, -32601, `Method not found: ${req.method}`);
      }
      return notification ? null : { jsonrpc: "2.0", id, result };
    } catch (e) {
      const code = isObject(e) && typeof e.rpc === "number" ? e.rpc : -32603;
      return notification ? null : rpcError(id, code, e instanceof Error ? e.message : "Internal error.");
    }
  }

  return { handle, tools };
}

export interface Streams {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
}

/** Reads newline-delimited JSON-RPC from `input`, writes answers to `output`. Resolves when input ends. */
export function serveStdio(server: ReturnType<typeof createServer>, s: Streams): Promise<void> {
  return new Promise((resolve) => {
    let buffer = "";
    let pending = Promise.resolve();
    const send = (m: Message | null) => {
      if (m) s.output.write(`${JSON.stringify(m)}\n`);
    };
    const line = (text: string) => {
      if (!text.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        pending = pending.then(() => send(rpcError(null, -32700, "Parse error.")));
        return;
      }
      // Answers are written in arrival order; tool calls run one after another.
      pending = pending.then(async () => send(await server.handle(msg)));
    };
    s.input.setEncoding?.("utf8");
    s.input.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    s.input.on("end", () => {
      line(buffer);
      void pending.then(() => resolve());
    });
  });
}

export interface Config {
  token: string;
  baseUrl: string;
  project?: string;
}

/** Reads the configuration from the environment (NANOFLAGS_API_TOKEN, NANOFLAGS_BASE_URL, NANOFLAGS_PROJECT). */
export function configFromEnv(env: Record<string, string | undefined>): Config {
  const token = (env.NANOFLAGS_API_TOKEN ?? "").trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Set NANOFLAGS_API_TOKEN to an AI-agent token (nf_api_…). Owners and admins create one in the NanoFlags dashboard: Settings → API tokens → AI agents.");
  }
  const baseUrl = (env.NANOFLAGS_BASE_URL ?? "").trim() || DEFAULT_BASE_URL;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("NANOFLAGS_BASE_URL must be a URL, e.g. https://edge.nanoflags.io.");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) {
    throw new Error("NANOFLAGS_BASE_URL must use https (http only for localhost).");
  }
  const project = (env.NANOFLAGS_PROJECT ?? "").trim() || undefined;
  return { token, baseUrl: baseUrl.replace(/\/+$/, ""), project };
}
