/**
 * Provenance of agent actions (Management API migration 0189): which MCP client, over which transport, in which
 * client-asserted session and for which task. Sent as X-NanoFlags-Agent-* headers with the tool's API calls, recorded on
 * the audit log and on changes the agent opens, marked as asserted by the client. It never affects what the token may
 * do and is shown nowhere public. Values are reduced to bounded printable ASCII here (header values are bytes).
 */
export interface Provenance {
  client?: { name?: unknown; version?: unknown } | null;
  transport?: "stdio" | "streamable-http";
  session?: unknown;
  task?: unknown;
}

const ascii = (v: unknown, max: number) => (typeof v === "string" ? v.normalize("NFKD").replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "").replace(/ +/g, " ").trim().slice(0, max) : "");

/** Optional tool arguments of the write tools (recorded, never trusted). */
export const PROVENANCE_ARGS = {
  sessionId: { type: "string", maxLength: 128, pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Optional: your session or conversation id, recorded in the audit log with this action (letters, digits, . _ : -)." },
  taskRef: { type: "string", maxLength: 200, description: "Optional: the task, ticket or prompt summary this action serves, recorded in the audit log (at most 200 characters)." },
} as const;

export function provenanceHeaders(p: Provenance): Record<string, string> {
  const h: Record<string, string> = {};
  const name = ascii(p.client?.name, 60);
  const version = ascii(p.client?.version, 30);
  if (name) h["X-NanoFlags-Agent-Client"] = version ? `${name}/${version}` : name;
  if (p.transport) h["X-NanoFlags-Agent-Transport"] = p.transport;
  const session = typeof p.session === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(p.session) ? p.session : "";
  if (session) h["X-NanoFlags-Agent-Session"] = session;
  const task = ascii(p.task, 200);
  if (task) h["X-NanoFlags-Agent-Task"] = task;
  return h;
}
