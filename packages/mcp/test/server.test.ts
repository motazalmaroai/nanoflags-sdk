import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api";
import { configFromEnv, createServer, serveStdio, PROTOCOL_VERSIONS, SUPPORTED_PROTOCOL_VERSIONS } from "../src/server";
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
    expect(String(res.result.instructions)).toMatch(/not available through this server/);
    const unknown = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await server.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await server.handle({ nope: true })).toMatchObject({ error: { code: -32600 } });
    expect(calls).toHaveLength(0);
  });

  it("lists at most 14 tools, all on the propose side (or read-only), with valid schemas", async () => {
    const { api } = mockApi(() => undefined);
    const res = (await createServer({ api }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[] } };
    const names = res.result.tools.map((t) => t.name);
    // 9 reviewed tools (get_profile was added for the ChatGPT directory), then 5 read-only review tools (wave 1), appended.
    expect(names.length).toBeLessThanOrEqual(14);
    expect(names).toEqual(["list_environments", "list_flags", "get_flag", "create_flag", "update_draft", "open_change_request", "get_change_status", "explain_flag", "get_profile",
      "preview_change", "find_stale_flags", "get_removal_readiness", "get_effective_policy", "get_flag_usage"]);
    const draft = res.result.tools.find((t) => t.name === "update_draft") as unknown as { description: string; inputSchema: { properties: { rules: { description: string } } } };
    for (const op of ["semver_gte", "semver_neq", "before", "after", "gte", "not_segment"]) expect(draft.inputSchema.properties.rules.description).toContain(op);
    for (const n of names) expect(n).not.toMatch(/publish|approve|kill|schedule|delete|archive|token|member/);
    for (const t of res.result.tools) expect(t.inputSchema.type).toBe("object");
    expect(res.result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["list_environments", "list_flags", "get_flag", "get_change_status", "explain_flag", "get_profile",
      "preview_change", "find_stale_flags", "get_removal_readiness", "get_effective_policy", "get_flag_usage"]);
  });

  it("declares every annotation hint explicitly, as booleans, with the reviewed values", async () => {
    const { api } = mockApi(() => undefined);
    const res = (await createServer({ api }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; title: string; annotations: Record<string, unknown> }[] } };
    const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const expected: Record<string, Record<string, boolean>> = {
      list_environments: ro, list_flags: ro, get_flag: ro, get_change_status: ro, explain_flag: ro, get_profile: ro,
      preview_change: ro, find_stale_flags: ro, get_removal_readiness: ro, get_effective_policy: ro, get_flag_usage: ro,
      create_flag: write, open_change_request: write,
      // Overwrites the draft's rules and values (the previous draft is not kept).
      update_draft: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    };
    expect(res.result.tools.map((t) => t.name).sort()).toEqual(Object.keys(expected).sort());
    for (const t of res.result.tools) {
      for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"]) expect(typeof t.annotations[k], `${t.name}.${k}`).toBe("boolean");
      expect(t.annotations, t.name).toMatchObject(expected[t.name]!);
      expect(t.annotations.title).toBe(t.title);
    }
  });

  it("advertises securitySchemes only when asked (remote server), at the top level and mirrored in _meta", async () => {
    const { api } = mockApi(() => undefined);
    type Listed = { name: string; securitySchemes?: unknown; _meta?: Record<string, unknown> };
    const local = (await createServer({ api }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: Listed[] } };
    // The stdio server authenticates with an env token: no OAuth declaration, and _meta only where a tool needs it.
    for (const t of local.result.tools) {
      expect(t.securitySchemes).toBeUndefined();
      expect(t._meta?.securitySchemes).toBeUndefined();
      if (t.name !== "get_profile") expect(t._meta).toBeUndefined();
    }
    const schemes = [{ type: "oauth2" as const, scopes: ["nanoflags:agent"] }];
    const remote = (await createServer({ api, securitySchemes: schemes }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: Listed[] } };
    expect(remote.result.tools).toHaveLength(14);
    for (const t of remote.result.tools) {
      expect(t.securitySchemes).toEqual(schemes);
      expect(t._meta?.securitySchemes).toEqual(schemes);
    }
  });

  it("returns _meta[mcp/www_authenticate] on an UNAUTHORIZED tool call only when a challenge builder is set", async () => {
    const { api } = mockApi(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Unknown or revoked API token." } } }));
    const plain = await call(createServer({ api, defaultProject: "p" }), "list_flags", {});
    expect((plain as Record<string, unknown>)._meta).toBeUndefined();
    const server = createServer({ api, defaultProject: "p", authChallenge: (e) => [`Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", error="${e.code}", error_description="${e.description}"`] });
    const r = (await call(server, "list_flags", {})) as unknown as { isError: boolean; _meta: Record<string, string[]> };
    expect(r.isError).toBe(true);
    expect(r._meta["mcp/www_authenticate"]![0]).toMatch(/^Bearer resource_metadata="[^"]+", error="invalid_token", error_description="[^"]+"$/);
    // Other refusals (a governance rule, a missing scope) are not fixed by signing in again: no challenge.
    const forbidden = mockApi(() => ({ status: 403, body: { error: { code: "AGENT_FORBIDDEN", message: "no" } } }));
    const f = await call(createServer({ api: forbidden.api, defaultProject: "p", authChallenge: () => ["x"] }), "list_flags", {});
    expect((f as Record<string, unknown>)._meta).toBeUndefined();
    // Modern era: the challenge survives next to the server identity.
    const modern = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_flags", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } })) as { result: { _meta: Record<string, unknown> } };
    expect(modern.result._meta["mcp/www_authenticate"]).toHaveLength(1);
    expect(modern.result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "nanoflags" });
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

  it("update_draft with expectedVersion sends If-Match; get_flag shows draftVersion", async () => {
    const { api, calls } = mockApi((c) => (c.method === "PATCH" ? { body: { ...config("staging", true), draftVersion: 8 } } : c.path.endsWith("/environments/staging") ? { body: { ...config("staging", false), draftVersion: 7 } } : c.path === "/projects/commerce/flags/checkout-v2" ? { body: flag } : undefined));
    const server = createServer({ api, defaultProject: "commerce" });
    const g = await call(server, "get_flag", { flag: "checkout-v2", environment: "staging" });
    expect(g.content[0]!.text).toContain("draftVersion 7");
    expect((g.structuredContent as { configs: { draftVersion: number }[] }).configs[0]!.draftVersion).toBe(7);
    const r = await call(server, "update_draft", { flag: "checkout-v2", environment: "staging", enabled: true, expectedVersion: 7 });
    expect(r.isError).toBe(false);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["If-Match"]).toBe('"7"');
    expect(patch.body).toEqual({ enabled: true });
    expect(r.content[0]!.text).toContain("draftVersion 8");
    const plain = await call(server, "update_draft", { flag: "checkout-v2", environment: "staging", enabled: true });
    expect(plain.isError).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH")[1]!.headers["If-Match"]).toBeUndefined();
    const bad = await call(server, "update_draft", { flag: "checkout-v2", environment: "staging", enabled: true, expectedVersion: 0 });
    expect(bad.isError).toBe(true);
  });

  it("update_draft on a stale version explains DRAFT_CONFLICT with the current version", async () => {
    const msg = "The draft of checkout-v2 in staging changed since you read it: its version is now 9, you sent 7. Nothing was written.";
    const { api } = mockApi((c) => (c.method === "PATCH" ? { status: 412, body: { error: { code: "DRAFT_CONFLICT", message: msg, currentVersion: 9 } } } : undefined));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "update_draft", { flag: "checkout-v2", environment: "staging", enabled: true, expectedVersion: 7 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/DRAFT_CONFLICT/);
    expect(r.content[0]!.text).toMatch(/get_flag again.*draftVersion 9.*expectedVersion 9/s);
    expect(r.structuredContent).toEqual({ error: { code: "DRAFT_CONFLICT", message: msg, status: 412, currentVersion: 9 } });
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

  it("get_profile returns a stable opaque id from token.get, marked openai/profile with an outputSchema", async () => {
    const tok = { id: "t1", name: "Claude Code", orgId: "11111111-1111-4111-8111-111111111111", projectKey: "commerce", createdBy: "22222222-2222-4222-8222-222222222222", createdByName: "Sara", kind: "agent", agentLabel: "ChatGPT" };
    const { api, calls } = mockApi((c) => (c.path === "/token" ? { body: tok } : undefined));
    const server = createServer({ api });
    const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; outputSchema?: { required: string[]; properties: Record<string, unknown> }; _meta?: Record<string, unknown> }[] } };
    const descriptor = list.result.tools.find((t) => t.name === "get_profile")!;
    expect(descriptor._meta).toEqual({ "openai/profile": true });
    expect(descriptor.outputSchema?.required).toEqual(["id"]);
    expect(list.result.tools.filter((t) => t._meta?.["openai/profile"] === true)).toHaveLength(1);
    const r = await call(server, "get_profile", {});
    expect(r.isError).toBe(false);
    const p = r.structuredContent as Record<string, unknown>;
    expect(p).toEqual({ id: expect.stringMatching(/^nfp_[0-9a-f]{32}$/), name: "Sara", nickname: "ChatGPT · commerce", agentLabel: "ChatGPT", projectKey: "commerce" });
    expect(JSON.parse(r.content[0]!.text)).toEqual(p);
    expect(validate(descriptor.outputSchema as Record<string, unknown>, p)).toBeNull();
    // Stable across tokens (refresh / reconnection mint a new token): same person + organization, same id.
    const again = mockApi((c) => (c.path === "/token" ? { body: { ...tok, id: "t2", agentLabel: "Renamed", projectKey: null } } : undefined));
    const p2 = (await call(createServer({ api: again.api }), "get_profile", {})).structuredContent as Record<string, unknown>;
    expect(p2.id).toBe(p.id);
    expect(p2.nickname).toBe("Renamed · all projects");
    // Another person in the same organization, or the same person in another one: a different id.
    const other = mockApi((c) => (c.path === "/token" ? { body: { ...tok, createdBy: "33333333-3333-4333-8333-333333333333" } } : undefined));
    expect(((await call(createServer({ api: other.api }), "get_profile", {})).structuredContent as Record<string, unknown>).id).not.toBe(p.id);
    // The id reveals neither UUID.
    expect(String(p.id)).not.toContain("1111");
    expect(calls.map((c) => c.path)).toEqual(["/token"]);
  });

  it("get_profile explains a revoked token like every other tool", async () => {
    const { api } = mockApi(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Unknown or revoked API token." } } }));
    const r = await call(createServer({ api }), "get_profile", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("NANOFLAGS_API_TOKEN");
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

describe("MCP Registry metadata", () => {
  it("server.json names the npm package and the remote endpoint, and matches package.json (mcpName, version)", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://mcp.nanoflags.io/mcp" }]);
    const { VERSION } = await import("../src/core");
    expect(VERSION).toBe(pkg.version);
  });
});

describe("modern protocol (2026-07-28, per-request _meta)", () => {
  const meta = (v = "2026-07-28") => ({ _meta: { "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } });

  it("answers server/discover with every supported version, capabilities and identity", async () => {
    const { api, calls } = mockApi(() => undefined);
    const res = (await createServer({ api }).handle({ jsonrpc: "2.0", id: "d", method: "server/discover", params: meta() })) as { result: Record<string, unknown> };
    expect(res.result).toMatchObject({ resultType: "complete", capabilities: { tools: { listChanged: false } }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "nanoflags" } } });
    expect(res.result.supportedVersions).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe("2026-07-28");
    expect(String(res.result.instructions)).toMatch(/not available through this server/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unsupported version with -32022 and the supported list", async () => {
    const { api } = mockApi(() => undefined);
    const res = await createServer({ api }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: meta("1900-01-01") });
    expect(res).toMatchObject({ error: { code: -32022, data: { requested: "1900-01-01", supported: SUPPORTED_PROTOCOL_VERSIONS } } });
  });

  it("marks results complete, adds cache hints to tools/list and drops removed methods", async () => {
    const { api } = mockApi((c) => (c.path === "/projects/commerce/environments" ? { body: envs } : undefined));
    const server = createServer({ api, defaultProject: "commerce" });
    const list = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: meta() })) as { result: Record<string, unknown> };
    expect(list.result).toMatchObject({ resultType: "complete", ttlMs: 3_600_000, cacheScope: "public" });
    expect((list.result.tools as unknown[]).length).toBe(14);
    const callRes = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_environments", arguments: {}, ...meta() } })) as { result: Record<string, unknown> };
    expect(callRes.result).toMatchObject({ resultType: "complete", isError: false });
    expect(await server.handle({ jsonrpc: "2.0", id: 3, method: "ping", params: meta() })).toMatchObject({ error: { code: -32601 } });
  });

  it("uses the transport's hints for credential and project problems", async () => {
    const { api } = mockApi(() => ({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Unknown or revoked API token." } } }));
    const hints = { scope: "S", unauthorized: "Reconnect NanoFlags in your AI app.", project: "Pass `project`." };
    const server = createServer({ api, hints });
    expect((await call(server, "list_flags", {})).content[0]!.text).toBe("Pass `project`.");
    expect((await call(server, "list_flags", { project: "commerce" })).content[0]!.text).toContain("Reconnect NanoFlags in your AI app.");
  });
});

describe("schemas for directories", () => {
  it("every value parameter declares its JSON types, and no description tells the model how to behave", async () => {
    const { TOOLS } = await import("../src/tools");
    for (const t of TOOLS) {
      expect(t.description).not.toMatch(/\b(you must|you should|do not|don't|never try|work around)\b/i);
      for (const [k, v] of Object.entries((t.inputSchema as { properties: Record<string, { type?: unknown }> }).properties)) {
        expect(v.type, `${t.name}.${k}`).toBeDefined();
      }
    }
  });
});

describe("bounded outputs (pagination, list limits, output byte cap)", () => {
  const manyEnvs = { data: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, key: `env${i}`, name: `Env ${i}`, requireApproval: false, requiredApprovers: 1, isProtected: false, publishedRevision: i })), nextCursor: null };

  it("list_environments pages with limit and an opaque cursor bound to the project", async () => {
    const { api } = mockApi((c) => (c.path === "/projects/commerce/environments" ? { body: manyEnvs } : undefined));
    const server = createServer({ api, defaultProject: "commerce" });
    const first = await call(server, "list_environments", { limit: 3 });
    const d1 = first.structuredContent as { data: { key: string }[]; nextCursor: string; total: number };
    expect(d1.data.map((e) => e.key)).toEqual(["env0", "env1", "env2"]);
    expect(d1.total).toBe(7);
    expect(first.content[0]!.text).toContain(`cursor=${d1.nextCursor}`);
    const second = await call(server, "list_environments", { limit: 5, cursor: d1.nextCursor });
    const d2 = second.structuredContent as { data: { key: string }[]; nextCursor: string | null };
    expect(d2.data.map((e) => e.key)).toEqual(["env3", "env4", "env5", "env6"]);
    expect(d2.nextCursor).toBeNull();
    const other = await call(server, "list_environments", { project: "other", cursor: d1.nextCursor });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/not a cursor of this list/);
    expect((await call(server, "list_environments", { limit: 101 })).isError).toBe(true);
    const all = await call(server, "list_environments", {});
    expect((all.structuredContent as { data: unknown[] }).data).toHaveLength(7);
  });

  it("list_flags passes limit and cursor to the API (max 100) and reports the next cursor", async () => {
    const { api, calls } = mockApi(() => ({ body: { data: [flag], nextCursor: "abc" } }));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "list_flags", { limit: 100, cursor: "xyz" });
    expect(calls[0]!.query).toMatchObject({ limit: "100", cursor: "xyz" });
    expect(r.content[0]!.text).toContain("cursor=abc");
    expect((await call(createServer({ api, defaultProject: "commerce" }), "list_flags", { limit: 500 })).isError).toBe(true);
  });

  it("get_change_status bounds the approvals list (newest first) but counts every approval", async () => {
    const approvals = Array.from({ length: 30 }, (_, i) => ({ approverId: `u${i}`, decision: "approved", createdAt: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    const { api } = mockApi(() => ({ body: change("awaiting_approval", approvals) }));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "get_change_status", { change: CH, limit: 5 });
    const d = r.structuredContent as { approvals: { approverId: string }[]; approvalsTotal: number; approvalsTruncated: boolean };
    expect(d.approvals.map((a) => a.approverId)).toEqual(["u29", "u28", "u27", "u26", "u25"]);
    expect(d).toMatchObject({ approvalsTotal: 30, approvalsTruncated: true });
    expect(r.content[0]!.text).toContain("30 approved");
    expect(r.content[0]!.text).toContain("Showing 5 of 30 approvals");
  });

  it("explain_flag holds services, served values, rules and publishes to `limit` and says which were cut", async () => {
    const services = Array.from({ length: 40 }, (_, i) => ({ service: `svc-${i}`, sdk: "js/0.8.1", events: 40 - i, lastAt: T }));
    const insights = { environment: "production", window: "24h", totals: { events: 99 }, services, variations: [{ value: true, events: 3 }], rules: [], publishes: [] };
    const { api } = mockApi((c) => {
      if (c.path === "/projects/commerce/flags/checkout-v2") return { body: flag };
      if (c.path === "/projects/commerce/environments") return { body: envs };
      if (c.path.includes("/environments/")) return { body: config(c.path.endsWith("staging") ? "staging" : "production", false) };
      if (c.path.endsWith("/insights")) return { body: insights };
      return undefined;
    });
    const r = await call(createServer({ api, defaultProject: "commerce" }), "explain_flag", { flag: "checkout-v2", limit: 3 });
    const d = r.structuredContent as { insights: { services: unknown[]; listsTruncated: Record<string, number>; variations: unknown[] } };
    expect(d.insights.services).toHaveLength(3);
    expect(d.insights.variations).toHaveLength(1);
    expect(d.insights.listsTruncated).toEqual({ services: 40 });
    expect(r.content[0]!.text).toContain("services (40 in total)");
    expect(r.content[0]!.text).not.toContain("svc-3 ");
  });

  it("every tool result is held to the output byte cap with a truncated marker", async () => {
    const { capResult, MAX_OUTPUT_BYTES, TRUNCATED_MARKER } = await import("../src/limits");
    const big = { data: Array.from({ length: 5000 }, (_, i) => ({ key: `flag-${i}`, name: "x".repeat(40) })), nextCursor: null };
    const r = capResult("y".repeat(200_000), big);
    const size = new TextEncoder().encode(r.text).byteLength + new TextEncoder().encode(JSON.stringify(r.data)).byteLength;
    expect(size).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(r.truncated).toBe(true);
    expect((r.data as { truncated: boolean; data: unknown[] }).truncated).toBe(true);
    expect((r.data as { data: unknown[] }).data.length).toBeGreaterThan(0);
    expect(r.text.endsWith(TRUNCATED_MARKER)).toBe(true);
    const small = capResult("ok", { a: [1, 2] });
    expect(small).toEqual({ text: "ok", data: { a: [1, 2] }, truncated: false });
    // Multi-byte text is never split inside a character.
    expect(capResult("é".repeat(100_000), undefined).text).not.toMatch(/�/);
    // Through the server: a huge flags page comes back bounded.
    const { api } = mockApi(() => ({ body: { data: Array.from({ length: 100 }, (_, i) => ({ ...flag, key: `k${i}`, name: "n".repeat(2000) })), nextCursor: "more" } }));
    const res = await call(createServer({ api, defaultProject: "commerce" }), "list_flags", { limit: 100 });
    expect(new TextEncoder().encode(res.content[0]!.text + JSON.stringify(res.structuredContent)).byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(res.structuredContent).toMatchObject({ truncated: true, nextCursor: "more" });
    expect(res.content[0]!.text).toContain(TRUNCATED_MARKER);
    expect(res.content[0]!.text).toContain("More: cursor=more");
  });
});

describe("strict validation before the API (engine strictDraftConfig)", () => {
  it("update_draft refuses unknown keys and bad operators with every path, without calling the API", async () => {
    const { api, calls } = mockApi(() => ({ body: config("staging", true) }));
    const rules = [{ id: "r1", conditions: [{ attribute: "plan", op: "equals", value: "pro" }], serve: { type: "fixed", value: true, variants: [] } }];
    const r = await call(createServer({ api, defaultProject: "commerce" }), "update_draft", { flag: "checkout-v2", environment: "staging", rules });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("rules[0].serve.variants: unknown key");
    expect(r.content[0]!.text).toContain("rules[0].conditions[0].op");
    expect(calls).toHaveLength(0);
    const okRules = [{ id: "r1", conditions: [{ attribute: "plan", op: "eq", value: "pro" }], serve: { type: "fixed", value: true } }];
    expect((await call(createServer({ api, defaultProject: "commerce" }), "update_draft", { flag: "checkout-v2", environment: "staging", rules: okRules })).isError).toBe(false);
  });
  it("create_flag checks initialValue against the type", async () => {
    const { api, calls } = mockApi(() => ({ status: 201, body: flag }));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "create_flag", { key: "limit", type: "number", initialValue: "ten" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("initialValue");
    expect(calls).toHaveLength(0);
  });
});

describe("provenance of agent actions (headers, migration 0189)", () => {
  it("write tools send client, transport, session and task headers; reads send client and transport only", async () => {
    const { api, calls } = mockApi((c) => (c.method === "PATCH" ? { body: config("staging", true) } : c.method === "POST" ? { status: 201, body: flag } : { body: { data: [], nextCursor: null } }));
    const server = createServer({ api, defaultProject: "commerce", transport: "stdio" });
    await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "Claude Code ✓", version: "2.1.0" } } });
    const r = await call(server, "update_draft", { flag: "checkout-v2", environment: "staging", enabled: true, sessionId: "conv-9:abc", taskRef: "PROJ-7\nenable checkout" });
    expect(r.isError).toBe(false);
    expect(calls[0]!.headers).toMatchObject({ "X-NanoFlags-Agent-Client": "Claude Code/2.1.0", "X-NanoFlags-Agent-Transport": "stdio", "X-NanoFlags-Agent-Session": "conv-9:abc", "X-NanoFlags-Agent-Task": "PROJ-7 enable checkout" });
    expect(calls[0]!.body).toEqual({ enabled: true });
    await call(server, "list_flags", {});
    expect(calls[1]!.headers["X-NanoFlags-Agent-Session"]).toBeUndefined();
    expect(calls[1]!.headers["X-NanoFlags-Agent-Client"]).toBe("Claude Code/2.1.0");
    const bad = await call(server, "create_flag", { key: "x1", sessionId: "has space" });
    expect(bad.isError).toBe(true);
  });
  it("modern requests name the client in _meta; the remote server falls back to the grant's client name", async () => {
    const { api, calls } = mockApi(() => ({ status: 201, body: flag }));
    const server = createServer({ api, defaultProject: "commerce", transport: "streamable-http", clientName: "ChatGPT" });
    await call(server, "create_flag", { key: "x1" });
    expect(calls[0]!.headers).toMatchObject({ "X-NanoFlags-Agent-Client": "ChatGPT", "X-NanoFlags-Agent-Transport": "streamable-http" });
    await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_flag", arguments: { key: "x2" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Inspector", version: "1" } } } });
    expect(calls[1]!.headers["X-NanoFlags-Agent-Client"]).toBe("Inspector/1");
  });
});

describe("read-only review tools (B6)", () => {
  const NEW = ["preview_change", "find_stale_flags", "get_removal_readiness", "get_effective_policy", "get_flag_usage"];
  it("publish an outputSchema and the read-only annotations", async () => {
    const { api } = mockApi(() => undefined);
    const res = (await createServer({ api }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string; outputSchema?: { type: string }; annotations: Record<string, boolean> }[] } };
    for (const n of NEW) {
      const t = res.result.tools.find((x) => x.name === n)!;
      expect(t.outputSchema?.type, n).toBe("object");
      expect(t.annotations, n).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });
  it("never write: only GET requests", () => {
    const source = TOOLS.filter((t) => NEW.includes(t.name)).map((t) => t.run.toString()).join("\n");
    expect(source).not.toMatch(/\.(post|patch)\(/);
    for (const p of ["/publish", "/approvals", "/schedules", "/kill", "/archive"]) expect(source).not.toContain(p);
  });

  it("preview_change: diff vs published, rules touched, scenario checks on this draft, validation, no impact claims", async () => {
    const draftBundle = { flags: { "checkout-v2": { type: "boolean", enabled: true, rules: [{ id: "r1", conditions: [], serve: { type: "fixed", value: true, variants: [] } }], default: false, off: false } }, segments: {} };
    const { api, calls } = mockApi((c) => {
      if (c.path === "/projects/commerce/environments/staging") return { body: { key: "staging", publishedRevision: 4 } };
      if (c.path === "/projects/commerce/environments/staging/draft") return { body: { checksum: "abc", dirty: true, bundle: draftBundle } };
      if (c.path === "/projects/commerce/environments/staging/revisions/4/diff") return { body: { changes: [
        { flagKey: "checkout-v2", field: "enabled", before: "false", after: "true" }, { flagKey: "checkout-v2", field: "rule 01", before: "—", after: "all contexts ⇒ true" }, { flagKey: "other", field: "default", before: "1", after: "2" },
      ] } };
      if (c.path === "/projects/commerce/scenarios") return { body: { data: [{ id: "s1", name: "pro sees it", flag: "checkout-v2" }, { id: "s2", name: "free does not", flag: "checkout-v2" }, { id: "s3", name: "other", flag: "other" }], nextCursor: null } };
      if (c.path === "/projects/commerce/scenario-runs") return { body: { data: [{ scenarioId: "s1", configChecksum: "abc", passed: true, createdAt: T }, { scenarioId: "s2", configChecksum: "old", passed: false, createdAt: T }], nextCursor: null } };
      return undefined;
    });
    const r = await call(createServer({ api, defaultProject: "commerce" }), "preview_change", { environment: "staging", flags: ["checkout-v2"] });
    expect(r.isError).toBe(false);
    const d = r.structuredContent as Record<string, any>;
    expect(d.changesTotal).toBe(2);
    expect(d.flagsTouched).toEqual(["checkout-v2"]);
    expect(d.rulesTouched).toEqual([{ flag: "checkout-v2", rule: "rule 01" }]);
    expect(d.scenarios).toEqual({ total: 2, passed: 1, failed: 0, notRun: 1, failing: [] });
    expect(d.validation.ok).toBe(false);
    expect(d.validation.issues[0].path).toBe("flags.checkout-v2.rules[0].serve.variants");
    expect(r.content[0]!.text).toMatch(/does not estimate how many users/);
    expect(JSON.stringify(d)).not.toMatch(/affected users|% of users|impact/i);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.find((c) => c.path.endsWith("/diff"))!.query).toEqual({ to: "draft" });
  });

  it("find_stale_flags pages the cleanup list", async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({ key: `f${i}`, name: `F${i}`, reasons: ["review_overdue"], reviewDate: null, ownerName: null }));
    const { api } = mockApi((c) => (c.path === "/projects/commerce/stale-flags" ? { body: { data, nextCursor: null } } : undefined));
    const server = createServer({ api, defaultProject: "commerce" });
    const r = await call(server, "find_stale_flags", { limit: 2 });
    const d = r.structuredContent as { data: { key: string }[]; nextCursor: string; total: number };
    expect(d.data.map((f) => f.key)).toEqual(["f0", "f1"]);
    expect(d.total).toBe(5);
    const r2 = await call(server, "find_stale_flags", { limit: 10, cursor: d.nextCursor });
    expect((r2.structuredContent as { data: unknown[]; nextCursor: null }).data).toHaveLength(3);
  });

  function readinessApi(o: { purpose?: string; permanent?: boolean; lastSeen?: string | null; events?: number; refs?: number; scanned?: boolean; prodDefault?: boolean }) {
    return mockApi((c) => {
      if (c.path === "/projects/commerce/flags/checkout-v2") return { body: { ...flag, purpose: o.purpose ?? "release", permanent: o.permanent ?? false } };
      if (c.path === "/projects/commerce/environments") return { body: envs };
      if (c.path.startsWith("/projects/commerce/flags/checkout-v2/environments/")) {
        const env = c.path.split("/").pop()!;
        return { body: { ...config(env, false), published: { type: "boolean", enabled: env === "production" && o.prodDefault === true, rules: [], default: true, off: false } } };
      }
      if (c.path.endsWith("/insights")) return { body: { totals: { events: o.events ?? 0 }, seen: { lastSeenAt: o.lastSeen ?? null } } };
      if (c.path.endsWith("/code-refs")) return { body: { total: o.refs ?? 0, repositories: o.refs ? ["acme/shop"] : [], lastScannedAt: o.scanned === false ? null : T, data: [] } };
      if (c.path.endsWith("/stale-flags")) return { body: { data: [{ key: "checkout-v2", reasons: ["single_value"] }], nextCursor: null } };
      return undefined;
    });
  }
  it("get_removal_readiness: safe with clean evidence", async () => {
    const { api } = readinessApi({});
    const r = await call(createServer({ api, defaultProject: "commerce" }), "get_removal_readiness", { flag: "checkout-v2" });
    const d = r.structuredContent as { verdict: string; reasons: { code: string }[]; evidence: { staleReasons: string[] } };
    expect(d.verdict).toBe("safe");
    expect(d.reasons.map((x) => x.code)).toEqual(["stale"]);
    expect(d.evidence.staleReasons).toEqual(["single_value"]);
  });
  it("get_removal_readiness: blocked when permanent, recently evaluated or referenced in code", async () => {
    for (const [o, code] of [[{ permanent: true }, "permanent"], [{ lastSeen: new Date().toISOString(), events: 5 }, "evaluated_recently"], [{ refs: 3 }, "code_references"]] as const) {
      const { api } = readinessApi(o);
      const d = (await call(createServer({ api, defaultProject: "commerce" }), "get_removal_readiness", { flag: "checkout-v2" })).structuredContent as { verdict: string; reasons: { code: string }[] };
      expect(d.verdict, code).toBe("blocked");
      expect(d.reasons.map((x) => x.code)).toContain(code);
    }
  });
  it("get_removal_readiness: caution for operational/permission purposes, missing scans and differing values", async () => {
    for (const [o, code] of [[{ purpose: "operational" }, "purpose_operational"], [{ purpose: "permission" }, "purpose_permission"], [{ scanned: false }, "no_code_scan"], [{ prodDefault: true }, "values_differ"], [{ events: 2, lastSeen: "2026-10-30T00:00:00Z" }, "evaluated_30d"]] as const) {
      const { api } = readinessApi(o);
      const d = (await call(createServer({ api, defaultProject: "commerce" }), "get_removal_readiness", { flag: "checkout-v2" })).structuredContent as { verdict: string; reasons: { code: string }[] };
      expect(d.verdict, code).toBe("caution");
      expect(d.reasons.map((x) => x.code)).toContain(code);
    }
  });

  it("get_effective_policy summarises the policy and grants", async () => {
    const policy = { token: { kind: "agent", agentLabel: "Claude Code", scopes: [], projectKey: null, expiresAt: T }, role: "owner", environment: { key: "production", requireApproval: true, requiredApprovers: 2, requireScenarios: false, isProtected: true, publishedRevision: 9 },
      approvalsOnPlan: true, agentWorkNeedsApproval: true, grants: [{ environment: "staging", actions: ["configs.update"], note: "" }], hasGrants: true, allowedOperations: ["token.get"], personOnly: ["publish"] };
    const { api, calls } = mockApi((c) => (c.path === "/projects/commerce/agent-policy" ? { body: policy } : undefined));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "get_effective_policy", { environment: "production" });
    expect(calls[0]!.query).toEqual({ environment: "production" });
    expect(r.structuredContent).toMatchObject({ agentWorkNeedsApproval: true, hasGrants: true });
    expect(r.content[0]!.text).toContain("approval required (2)");
    expect(r.content[0]!.text).toContain("independent approval");
    expect(r.content[0]!.text).toContain("staging: configs.update");
  });

  it("get_flag_usage bounds its lists", async () => {
    const services = Array.from({ length: 30 }, (_, i) => ({ service: `s${i}`, sdk: "js", events: 1 }));
    const { api, calls } = mockApi(() => ({ body: { environment: "production", flag: "checkout-v2", window: "7d", totals: { events: 30, weighted: 3000 }, services, variations: [], rules: [], publishes: [], seen: { lastSeenAt: T } } }));
    const r = await call(createServer({ api, defaultProject: "commerce" }), "get_flag_usage", { flag: "checkout-v2", window: "7d", limit: 5 });
    expect(calls[0]!.query).toEqual({ window: "7d" });
    const d = r.structuredContent as { services: unknown[]; listsTruncated: Record<string, number> };
    expect(d.services).toHaveLength(5);
    expect(d.listsTruncated).toEqual({ services: 30 });
    expect(r.content[0]!.text).toContain("about 3000 evaluations");
  });
});
