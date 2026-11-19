import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api";
import { configFromEnv, createServer, serveStdio, PROTOCOL_VERSIONS } from "../src/server";
import { TOOLS, validate } from "../src/tools";

const TOKEN = "nf_api_" + "ab".repeat(24);
const T = "2026-11-19T10:00:00Z";
const CH = "542e9698-9947-42d8-8a1e-ee55f94c92f0";

interface Call { method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }
type Route = (c: Call) => { status?: number; body: unknown } | undefined;

/** A mocked Management API: records calls, answers from `route` (404 NOT_FOUND otherwise). */
function mockApi(route: Route) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname.slice(0, 7)).toBe("https://edge.test/api/v1");
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname.replace("/api/v1", ""), query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    calls.push(call);
    const r = route(call) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "Unknown endpoint." } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  const api = new ApiClient({ baseUrl: "https://edge.test/", token: TOKEN, fetch: fetchFn as unknown as typeof fetch, userAgent: "nanoflags-mcp/test" });
  return { api, calls };
}

const envs = { data: [
  { id: "e1", key: "staging", name: "Staging", requireApproval: false, requiredApprovers: 1, isProtected: false, publishedRevision: 4 },
  { id: "e2", key: "production", name: "Production", requireApproval: true, requiredApprovers: 2, isProtected: true, publishedRevision: 9 },
], nextCursor: null };
const flag = { id: "f1", key: "checkout-v2", name: "Checkout v2", description: "New checkout", type: "boolean", purpose: "release", permanent: false, archivedAt: null };
const config = (env: string, draftEnabled: boolean) => ({
  flag: "checkout-v2", environment: env, environmentId: "e", publishedRevision: 4,
  draft: { enabled: draftEnabled, rules: [], default: false, off: false, updatedAt: T, updatedBy: null },
  published: { type: "boolean", enabled: false, rules: [], default: false, off: false },
});
const change = (status: string, approvals: unknown[] = []) => ({
  id: CH, environment: "staging", title: "Enable checkout-v2 for pro", status, flags: ["checkout-v2"], approvals, publishedRevision: null,
  openedByAgent: { label: "Claude Code on laptop-x", tokenId: "t1" }, lifecycle: { stage: "open" },
});

async function call(server: ReturnType<typeof createServer>, name: string, args: Record<string, unknown>) {
  const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return (res as { result: { content: { text: string }[]; isError: boolean; structuredContent?: Record<string, unknown> } }).result;
}

describe("protocol", () => {
  it("initializes with a supported protocol version, tool capability and governance instructions", async () => {
    const { api, calls } = mockApi(() => undefined);
    const server = createServer({ api });
    const res = (await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } })) as { result: Record<string, unknown> };
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result.serverInfo).toMatchObject({ name: "nanoflags" });
    expect(String(res.result.instructions)).toMatch(/cannot publish, approve/);
    const unknown = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await server.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await server.handle({ nope: true })).toMatchObject({ error: { code: -32600 } });
    expect(calls).toHaveLength(0);
  });

  it("lists at most 8 tools, all on the propose side, with valid schemas and annotations", async () => {
    const { api } = mockApi(() => undefined);
    const res = (await createServer({ api }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[] } };
    const names = res.result.tools.map((t) => t.name);
    expect(names.length).toBeLessThanOrEqual(8);
    expect(names).toEqual(["list_environments", "list_flags", "get_flag", "create_flag", "update_draft", "open_change_request", "get_change_status", "explain_flag"]);
    for (const n of names) expect(n).not.toMatch(/publish|approve|kill|schedule|delete|archive|token|member/);
    for (const t of res.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(res.result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["list_environments", "list_flags", "get_flag", "get_change_status", "explain_flag"]);
  });

  it("refuses unknown tools and invalid arguments before calling the API", async () => {
    const { api, calls } = mockApi(() => undefined);
    const server = createServer({ api, defaultProject: "commerce" });
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish", arguments: {} } })).toMatchObject({ error: { code: -32602 } });
    expect(await call(server, "create_flag", { key: "Bad Key" })).toMatchObject({ isError: true, content: [{ text: "arguments.key has an invalid format." }] });
    expect(await call(server, "create_flag", { key: "ok", extra: 1 })).toMatchObject({ isError: true, content: [{ text: "Unknown argument(s): extra." }] });
    expect(await call(server, "create_flag", { key: "ok", type: "string" })).toMatchObject({ isError: true, content: [{ text: "`initialValue` is required for non-boolean flags." }] });
    expect(await call(server, "update_draft", { flag: "ok", environment: "staging" })).toMatchObject({ isError: true });
    expect(await call(server, "open_change_request", { environment: "staging", title: "x", flags: [] })).toMatchObject({ isError: true });
    expect(await call(server, "get_change_status", { change: "nope" })).toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });
});

describe("tools", () => {
  it("create_flag posts to the project with the token, an Idempotency-Key and only the given fields", async () => {
    const { api, calls } = mockApi((c) => (c.method === "POST" && c.path === "/projects/commerce/flags" ? { status: 201, body: { ...flag, key: "new-banner" } } : undefined));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "create_flag", { key: "new-banner", name: "New banner", description: "Banner test" });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain("Created flag new-banner");
    expect(r.content[0]!.text).toContain("open_change_request");
    expect(calls[0]!.body).toEqual({ key: "new-banner", name: "New banner", description: "Banner test" });
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.headers["User-Agent"]).toBe("nanoflags-mcp/test");
  });

  it("update_draft patches one environment's draft (targeting rules, default, off)", async () => {
    const rules = [{ id: "pro", conditions: [{ attribute: "plan", op: "eq", value: "pro" }], serve: { type: "fixed", value: true } }];
    const { api, calls } = mockApi((c) => (c.method === "PATCH" ? { body: { ...config("staging", true), draft: { ...config("staging", true).draft, rules } } } : undefined));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "update_draft", { flag: "checkout-v2", environment: "staging", enabled: true, rules, default: false });
    expect(r.isError).toBe(false);
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/projects/commerce/flags/checkout-v2/environments/staging", body: { enabled: true, rules, default: false } });
    expect(calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/Not live yet/);
  });

  it("open_change_request creates and submits the change, then reports that a person must approve", async () => {
    const { api, calls } = mockApi((c) => {
      if (c.method === "POST" && c.path === "/projects/commerce/changes") return { status: 201, body: change("draft") };
      if (c.method === "POST" && c.path === `/projects/commerce/changes/${CH}/submit`) return { body: change("awaiting_approval") };
      if (c.method === "GET" && c.path === `/projects/commerce/changes/${CH}`) return { body: change("awaiting_approval") };
      return undefined;
    });
    const r = await call(createServer({ api, defaultProject: "commerce" }), "open_change_request", { environment: "staging", title: " Enable checkout-v2 for pro ", reason: "Ticket 42", flags: ["checkout-v2"] });
    expect(r.isError).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /projects/commerce/changes", `POST /projects/commerce/changes/${CH}/submit`, `GET /projects/commerce/changes/${CH}`]);
    expect(calls[0]!.body).toEqual({ environment: "staging", title: "Enable checkout-v2 for pro", reason: "Ticket 42", flags: ["checkout-v2"] });
    expect(r.content[0]!.text).toContain("status awaiting_approval");
    expect(r.content[0]!.text).toContain('Opened by AI agent "Claude Code on laptop-x"');
    expect(r.content[0]!.text).toContain(`/app/changes/${CH}`);
  });

  it("open_change_request with submit: false only creates it", async () => {
    const { api, calls } = mockApi((c) => (c.method === "POST" ? { status: 201, body: change("draft") } : undefined));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "open_change_request", { environment: "staging", title: "x", flags: ["checkout-v2"], submit: false });
    expect(calls).toHaveLength(1);
    expect(r.content[0]!.text).toContain("Still a draft");
  });

  it("get_change_status summarises approvals", async () => {
    const { api } = mockApi(() => ({ body: change("approved", [{ approverId: "u2", decision: "approved", createdAt: T }]) }));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "get_change_status", { change: CH });
    expect(r.content[0]!.text).toContain("1 approved, 0 rejected");
    expect(r.content[0]!.text).toContain("A person can now publish it");
    expect(r.structuredContent).toMatchObject({ id: CH, status: "approved" });
  });

  it("list_environments and list_flags pass paging through", async () => {
    const { api, calls } = mockApi((c) => {
      if (c.path === "/projects/commerce/environments") return { body: envs };
      if (c.path === "/projects/commerce/flags") return { body: { data: [flag], nextCursor: "abc" } };
      return undefined;
    });
    const server = createServer({ api, defaultProject: "commerce" });
    expect((await call(server, "list_environments", {})).content[0]!.text).toContain("production (Production): r9, approval required (2), protected");
    const r = await call(server, "list_flags", { limit: 10, cursor: "xyz" });
    expect(calls[1]!.query).toEqual({ limit: "10", cursor: "xyz" });
    expect(r.content[0]!.text).toContain("More: cursor=abc");
  });

  it("get_flag reads every environment when none is given", async () => {
    const { api, calls } = mockApi((c) => {
      if (c.path === "/projects/commerce/flags/checkout-v2") return { body: flag };
      if (c.path === "/projects/commerce/environments") return { body: envs };
      const m = /\/environments\/(\w+)$/.exec(c.path);
      return m ? { body: config(m[1]!, m[1] === "staging") } : undefined;
    });
    const r = await call(createServer({ api, defaultProject: "commerce" }), "get_flag", { flag: "checkout-v2" });
    expect(calls.map((c) => c.path)).toEqual(["/projects/commerce/flags/checkout-v2", "/projects/commerce/environments", "/projects/commerce/flags/checkout-v2/environments/staging", "/projects/commerce/flags/checkout-v2/environments/production"]);
    expect(r.content[0]!.text).toContain("staging: on, 0 rule(s), default false, off false (draft differs from published)");
    expect(r.content[0]!.text).toContain("production: off");
  });

  it("explain_flag combines state per environment with where the flag is evaluated", async () => {
    const { api, calls } = mockApi((c) => {
      if (c.path === "/projects/commerce/flags/checkout-v2") return { body: flag };
      if (c.path === "/projects/commerce/environments") return { body: envs };
      if (c.path.endsWith("/insights")) return { body: { environment: "production", window: "7d", totals: { events: 120 }, services: [{ service: "checkout-api", sdk: "js/0.5.0", events: 120 }], variations: [{ value: true, events: 90 }, { value: false, events: 30 }] } };
      const m = /\/environments\/(\w+)$/.exec(c.path);
      return m ? { body: config(m[1]!, m[1] === "staging") } : undefined;
    });
    const r = await call(createServer({ api, defaultProject: "commerce" }), "explain_flag", { flag: "checkout-v2", window: "7d" });
    const text = r.content[0]!.text;
    expect(text).toContain("checkout-v2 (boolean, release): Checkout v2 — New checkout");
    expect(text).toContain("- staging (r4): live off, 0 rule(s), default false; draft: on");
    expect(text).toContain("Evaluated by: checkout-api (js/0.5.0, 120).");
    expect(text).toContain("Served: true ×90, false ×30.");
    expect(calls.find((c) => c.path.endsWith("/insights"))!.query).toEqual({ window: "7d" });
  });

  it("explain_flag still answers when usage insights are not available", async () => {
    const { api } = mockApi((c) => {
      if (c.path === "/projects/commerce/flags/checkout-v2") return { body: flag };
      if (c.path === "/projects/commerce/environments") return { body: { data: [envs.data[0]], nextCursor: null } };
      if (c.path.endsWith("/insights")) return { status: 403, body: { error: { code: "INSUFFICIENT_SCOPE", message: "This API token does not have the insights:read scope." } } };
      return { body: config("staging", false) };
    });
    const r = await call(createServer({ api, defaultProject: "commerce" }), "explain_flag", { flag: "checkout-v2" });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain("Usage insights unavailable (INSUFFICIENT_SCOPE");
  });
});

describe("governance and errors", () => {
  it("turns AGENT_FORBIDDEN into an explanation the agent can act on", async () => {
    const { api } = mockApi(() => ({ status: 403, body: { error: { code: "AGENT_FORBIDDEN", message: "AI-agent tokens cannot call changes.create." } } }));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "open_change_request", { environment: "production", title: "x", flags: ["a"] });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("NanoFlags refused (AGENT_FORBIDDEN)");
    expect(r.content[0]!.text).toContain("AI agents propose, people approve and publish");
    expect(r.structuredContent).toEqual({ error: { code: "AGENT_FORBIDDEN", message: "AI-agent tokens cannot call changes.create.", status: 403 } });
  });

  it("explains revoked tokens and unreachable servers", async () => {
    const { api } = mockApi(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Unknown or revoked API token." } } }));
    expect((await call(createServer({ api, defaultProject: "p" }), "list_flags", {})).content[0]!.text).toContain("Check NANOFLAGS_API_TOKEN");
    const down = new ApiClient({ baseUrl: "https://edge.test", token: TOKEN, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, userAgent: "t" });
    const r = await call(createServer({ api: down, defaultProject: "p" }), "list_flags", {});
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0]!.text).toContain("UNREACHABLE");
  });

  it("resolves the project from a project-scoped token once, or asks for one", async () => {
    const { api, calls } = mockApi((c) => (c.path === "/token" ? { body: { projectKey: "commerce", kind: "agent" } } : c.path === "/projects/commerce/environments" ? { body: envs } : undefined));
    const server = createServer({ api });
    await call(server, "list_environments", {});
    await call(server, "list_environments", {});
    expect(calls.filter((c) => c.path === "/token")).toHaveLength(1);
    const org = mockApi((c) => (c.path === "/token" ? { body: { projectKey: null } } : undefined));
    const r = await call(createServer({ api: org.api }), "list_flags", {});
    expect(r).toMatchObject({ isError: true });
    expect(r.content[0]!.text).toContain("NANOFLAGS_PROJECT");
  });

  it("no tool reaches a publish, approval, schedule, kill or settings endpoint", () => {
    const source = TOOLS.map((t) => t.run.toString()).join("\n");
    for (const p of ["/publish", "/approvals", "/schedules", "/kill", "/restore", "/archive", "/members", "/keys", "/imports", "/integrations"]) expect(source).not.toContain(p);
  });
});

describe("configuration", () => {
  it("requires an API token and https", () => {
    expect(() => configFromEnv({})).toThrow(/NANOFLAGS_API_TOKEN/);
    expect(() => configFromEnv({ NANOFLAGS_API_TOKEN: "nf_srv_123" })).toThrow(/AI-agent token/);
    expect(configFromEnv({ NANOFLAGS_API_TOKEN: TOKEN })).toEqual({ token: TOKEN, baseUrl: "https://edge.nanoflags.io", project: undefined });
    expect(configFromEnv({ NANOFLAGS_API_TOKEN: ` ${TOKEN} `, NANOFLAGS_BASE_URL: "http://localhost:8787/", NANOFLAGS_PROJECT: "commerce" })).toEqual({ token: TOKEN, baseUrl: "http://localhost:8787", project: "commerce" });
    expect(() => configFromEnv({ NANOFLAGS_API_TOKEN: TOKEN, NANOFLAGS_BASE_URL: "http://edge.example.com" })).toThrow(/https/);
  });
});

describe("stdio transport", () => {
  it("answers newline-delimited JSON-RPC in order and reports parse errors", async () => {
    const { api } = mockApi((c) => (c.path === "/projects/commerce/environments" ? { body: envs } : undefined));
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveStdio(createServer({ api, defaultProject: "commerce" }), { input, output: { write: (s: string) => out.push(s) } });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n{not json}\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_environments", arguments: {} } }).slice(0, 20));
    input.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_environments", arguments: {} } }).slice(20) + "\n");
    await done;
    const msgs = out.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id ?? null)).toEqual([1, null, 2]);
    expect(msgs[1].error.code).toBe(-32700);
    expect(msgs[2].result.content[0].text).toContain("Environments of commerce");
  });
});

describe("argument validation", () => {
  it("covers types, enums, bounds and nested items", () => {
    const s = { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 3 }, e: { type: "string", enum: ["a"] }, l: { type: "array", items: { type: "string", pattern: "^x" } } }, required: ["n"], additionalProperties: false };
    expect(validate(s, { n: 2 })).toBeNull();
    expect(validate(s, {})).toBe("arguments.n is required.");
    expect(validate(s, { n: 1.5 })).toBe("arguments.n must be integer.");
    expect(validate(s, { n: 4 })).toBe("arguments.n must be at most 3.");
    expect(validate(s, { n: 1, e: "b" })).toBe('arguments.e must be one of "a".');
    expect(validate(s, { n: 1, l: ["x1", "y"] })).toBe("arguments.l[1] has an invalid format.");
  });
});
