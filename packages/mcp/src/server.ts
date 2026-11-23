/**
 * The stdio transport of the NanoFlags MCP server (newline-delimited JSON-RPC 2.0) and its environment configuration.
 * The protocol itself (initialize / server/discover, tools/list, tools/call) lives in core.ts, shared with the hosted
 * Streamable HTTP server (workers/mcp). Logs go to stderr only; stdout carries protocol messages.
 */
import { DEFAULT_BASE_URL, TOKEN_PATTERN } from "./api.js";
import { rpcError, type McpServer, type Message } from "./core.js";

export {
  INSTRUCTIONS, MODERN_PROTOCOL_VERSIONS, PROTOCOL_VERSIONS, STDIO_HINTS, SUPPORTED_PROTOCOL_VERSIONS, VERSION,
  createServer, explainError, type Hints, type McpServer, type ServerOptions,
} from "./core.js";

export interface Streams {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
}

/** Reads newline-delimited JSON-RPC from `input`, writes answers to `output`. Resolves when input ends. */
export function serveStdio(server: McpServer, s: Streams): Promise<void> {
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
