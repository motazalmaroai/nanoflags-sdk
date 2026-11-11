import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type NanoFlagsClient, type NanoFlagsError } from "../src/index";
import { currentSession, flagsFor, sessionFlags, sessionHeaders, sessionMiddleware, withSession, withSessionHandler } from "../src/node";
import { BASE, SERVER_KEY, bundleResponse, makeBundle } from "./helpers";
import { mockRoutes, sessionBody, sessionRoute } from "./v2helpers";

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, service: "checkout-api", streaming: false, pollIntervalMs: 0, events: false, ...opts });
  clients.push(c);
  return c;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Published r3 says relevance-v3; session A pins a draft that says "session-a", session B "session-b". */
const pinned = (label: string) => makeBundle(0, { "search-ranking": { type: "string", enabled: true, default: label, off: "off", rules: [{ id: "vip", match: "all", conditions: [{ attribute: "plan", op: "eq", value: "vip" }], serve: { type: "fixed", value: `${label}-vip` } }] } });
function edgeWith(sessions: Record<string, () => unknown> = {}) {
  return mockRoutes({
    "/v1/bundle": bundleResponse(makeBundle(3)),
    "/v1/events": () => new Response('{"accepted":0}', { status: 202 }),
    "/v1/session": sessionRoute({ nf_ts_aaaaaaaa: () => sessionBody("sess-a", pinned("session-a"), { plan: "vip", key: "synthetic-user" }), nf_ts_bbbbbbbb: () => sessionBody("sess-b", pinned("session-b")), ...sessions }),
  });
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client.session()", () => {
  it("evaluates against the session's pinned bundle with the merged context", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const s = await c.session("nf_ts_aaaaaaaa");
    expect(s.active).toBe(true);
    expect(s.id).toBe("sess-a");
    expect(Date.parse(s.expiresAt!)).toBeGreaterThan(Date.now());
    expect(s.revision).toBe(0);
    // session.context supplies plan=vip …
    expect(s.string("search-ranking", "fb")).toBe("session-a-vip");
    expect(s.evaluate("search-ranking", "fb")).toMatchObject({ value: "session-a-vip", reason: "rule_match", ruleId: "vip", revision: 0 });
    // … and the call context wins over it.
    expect(s.string("search-ranking", "fb", { plan: "free" })).toBe("session-a");
    // Typed accessors keep their type check; other flags come from the pinned bundle too.
    expect(s.boolean("search-ranking", true)).toBe(true);
    expect(s.number("max-items", 1)).toBe(20);
    expect(s.json("layout", null)).toEqual({ columns: 3 });
    // The client itself is untouched.
    expect(c.string("search-ranking", "fb", { plan: "vip" })).toBe("relevance-v3");
    expect(c.revision).toBe(3);

    const call = edge.last("/v1/session")!;
    expect(call.headers.get("X-NanoFlags-Session")).toBe("nf_ts_aaaaaaaa");
    expect(call.headers.get("X-NanoFlags-Service")).toBe("checkout-api");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${SERVER_KEY}`);
    expect(call.url).not.toContain("nf_ts_");
  });

  it("fetches a session once per token, also for concurrent callers", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const [a, b] = await Promise.all([c.session("nf_ts_aaaaaaaa"), c.session("nf_ts_aaaaaaaa")]);
    await c.session("nf_ts_aaaaaaaa");
    expect(edge.count("/v1/session")).toBe(1);
    expect(a.id).toBe(b.id);
    await c.session("nf_ts_aaaaaaaa", { service: "other-service" }); // permission is per service: its own lookup
    expect(edge.count("/v1/session")).toBe(2);
    expect(edge.last("/v1/session")!.headers.get("X-NanoFlags-Service")).toBe("other-service");
  });

  it("an unknown session falls back to normal evaluation: active false, no error, never throws", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    const errors: Error[] = [];
    c.on("error", (e) => errors.push(e));
    await c.ready();
    const s = await c.session("nf_ts_unknown0");
    expect(s.active).toBe(false);
    expect(s.id).toBeNull();
    expect(s.expiresAt).toBeNull();
    expect(s.revision).toBe(3);
    expect(s.string("search-ranking", "fb", { plan: "vip" })).toBe("relevance-v3");
    expect(s.evaluate("search-ranking", "fb").revision).toBe(3);
    expect(errors).toEqual([]);
    // A miss is remembered briefly instead of asking the edge on every request.
    await c.session("nf_ts_unknown0");
    expect(edge.count("/v1/session")).toBe(1);
  });

  it("missing, empty and malformed tokens never reach the network", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    for (const token of [undefined, null, "", "has space", "line\nbreak", "x".repeat(600)]) {
      const s = await c.session(token);
      expect(s.active).toBe(false);
      expect(s.boolean("checkout-v2", false, { key: "u", signedIn: true, region: "US" })).toBe(true);
    }
    expect(edge.count("/v1/session")).toBe(0);
  });

  it("network failures, 5xx and invalid payloads fall back and are reported, not thrown", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    const errors: NanoFlagsError[] = [];
    c.on("error", (e) => errors.push(e as NanoFlagsError));
    await c.ready();
    edge.routes["/v1/session"] = new Error("socket hang up");
    expect((await c.session("nf_ts_11111111")).active).toBe(false);
    edge.routes["/v1/session"] = new Response("boom", { status: 500 });
    expect((await c.session("nf_ts_22222222")).active).toBe(false);
    edge.routes["/v1/session"] = new Response(JSON.stringify({ id: "x", bundle: { nope: true }, expires_at: "2999-01-01T00:00:00Z" }), { status: 200 });
    expect((await c.session("nf_ts_33333333")).active).toBe(false);
    edge.routes["/v1/session"] = new Response(JSON.stringify(sessionBody("old", pinned("old"), {}, -1000)), { status: 200 });
    const expired = await c.session("nf_ts_44444444");
    expect(expired.active).toBe(false);
    expect(errors.map((e) => e.code)).toEqual(["session", "session", "session"]);
    expect(expired.string("search-ranking", "fb")).toBe("relevance-v3");
  });

  it("an expired session falls back to normal evaluation, and the token is looked up again afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const edge = edgeWith({ nf_ts_shortlived: () => sessionBody("short", pinned("short"), {}, 5_000) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const s = await c.session("nf_ts_shortlived");
    expect(s.active).toBe(true);
    expect(s.string("search-ranking", "fb")).toBe("short");

    vi.setSystemTime(Date.now() + 5_001);
    expect(s.active).toBe(false);
    expect(s.revision).toBe(3);
    expect(s.string("search-ranking", "fb")).toBe("relevance-v3");
    expect(s.evaluate("search-ranking", "fb")).toMatchObject({ value: "relevance-v3", revision: 3 });
    expect(s.id).toBe("short"); // still says which session it was

    // The cache entry ended with the session: the edge is asked again (and now says 404).
    edge.routes["/v1/session"] = new Response("{}", { status: 404 });
    const again = await c.session("nf_ts_shortlived");
    expect(edge.count("/v1/session")).toBe(2);
    expect(again.active).toBe(false);
  });

  it("parallel sessions do not affect each other or the client", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, i) => {
        const token = i % 3 === 0 ? "nf_ts_aaaaaaaa" : i % 3 === 1 ? "nf_ts_bbbbbbbb" : null;
        const s = await c.session(token);
        await sleep(i % 7);
        const first = s.string("search-ranking", "fb");
        await sleep((i * 3) % 5);
        return { i, first, second: s.string("search-ranking", "fb"), plain: c.string("search-ranking", "fb"), id: s.id };
      }),
    );
    for (const r of results) {
      const expected = r.i % 3 === 0 ? "session-a-vip" : r.i % 3 === 1 ? "session-b" : "relevance-v3";
      expect(r.first).toBe(expected);
      expect(r.second).toBe(expected);
      expect(r.plain).toBe("relevance-v3");
      expect(r.id).toBe(r.i % 3 === 0 ? "sess-a" : r.i % 3 === 1 ? "sess-b" : null);
    }
    expect(edge.count("/v1/session")).toBe(2);
  });

  it("a new published revision does not change what an active session evaluates", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const s = await c.session("nf_ts_bbbbbbbb");
    edge.routes["/v1/bundle"] = bundleResponse(makeBundle(4));
    await c.refresh();
    expect(c.string("search-ranking", "fb")).toBe("relevance-v4");
    expect(s.string("search-ranking", "fb")).toBe("session-b");
  });

  it("events are tagged with the session id; normal evaluations are not", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0 } });
    await c.ready();
    const s = await c.session("nf_ts_aaaaaaaa");
    s.string("search-ranking", "fb");
    c.string("search-ranking", "fb", { plan: "vip" });
    (await c.session("nf_ts_unknown0")).string("search-ranking", "fb");
    await c.flush();
    const body = edge.last("/v1/events")!.body as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(3);
    expect(body.events[0]).toMatchObject({ flagKey: "search-ranking", value: "session-a-vip", sessionId: "sess-a", revision: 0 });
    // Default redaction applies to the merged context and uses the pinned bundle's rules: names and types only.
    expect(body.events[0]!.context).toEqual({ plan: "string" });
    expect(body.events[1]).toMatchObject({ value: "relevance-v3", revision: 3 });
    expect(body.events[1]).not.toHaveProperty("sessionId");
    expect(body.events[2]).not.toHaveProperty("sessionId");
  });

  it("useSession() is refused outside a browser: a server client never becomes session-wide", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    const errors: NanoFlagsError[] = [];
    c.on("error", (e) => errors.push(e as NanoFlagsError));
    await c.ready();
    const s = await c.useSession("nf_ts_aaaaaaaa");
    expect(s.active).toBe(false);
    expect(c.string("search-ranking", "fb", { plan: "vip" })).toBe("relevance-v3");
    expect(c.sessionHeaders()).toEqual({});
    expect(errors[0]).toMatchObject({ code: "config" });
    expect(edge.count("/v1/session")).toBe(0);
  });
});

describe("browser page session", () => {
  function browser(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("sessionStorage", storage);
    return data;
  }

  it("useSession stores the token for the page session and routes the client's accessors through it", async () => {
    const data = browser();
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch, store: false });
    await c.ready();
    expect(c.sessionHeaders()).toEqual({});
    const before = c.version;
    const s = await c.useSession("nf_ts_aaaaaaaa");
    expect(s.active).toBe(true);
    expect(c.version).toBeGreaterThan(before); // React bindings re-render
    expect(data.get("nanoflags:session")).toBe("nf_ts_aaaaaaaa");
    expect(c.sessionHeaders()).toEqual({ "x-nanoflags-session": "nf_ts_aaaaaaaa" });
    expect(c.string("search-ranking", "fb")).toBe("session-a-vip");
    expect(c.string("search-ranking", "fb", { plan: "free" })).toBe("session-a");
    expect(c.revision).toBe(3); // the published revision the client holds is unchanged

    await c.useSession(null);
    expect(data.has("nanoflags:session")).toBe(false);
    expect(c.sessionHeaders()).toEqual({});
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
  });

  it("a reload resumes the stored session; an unknown stored token is harmless", async () => {
    browser({ "nanoflags:session": "nf_ts_bbbbbbbb" });
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch, store: false });
    await c.ready();
    await vi.waitFor(() => expect(c.string("search-ranking", "fb")).toBe("session-b"));
    expect(c.sessionHeaders()).toEqual({ "x-nanoflags-session": "nf_ts_bbbbbbbb" });

    browser({ "nanoflags:session": "nf_ts_unknown0" });
    const d = client({ fetch: edge.fetch, store: false });
    await d.ready();
    await vi.waitFor(() => expect(d.sessionHeaders()).toEqual({}));
    expect(d.string("search-ranking", "fb")).toBe("relevance-v3");
  });

  it("when the page session expires the client returns to the normal configuration", async () => {
    browser();
    vi.useFakeTimers({ toFake: ["Date"] });
    const edge = edgeWith({ nf_ts_shortlived: () => sessionBody("short", pinned("short"), {}, 5_000) });
    const c = client({ fetch: edge.fetch, store: false });
    await c.ready();
    await c.useSession("nf_ts_shortlived");
    expect(c.string("search-ranking", "fb")).toBe("short");
    vi.setSystemTime(Date.now() + 6_000);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
    expect(c.sessionHeaders()).toEqual({});
  });
});

describe("@nanoflags/sdk/node", () => {
  it("withSession / currentSession / sessionHeaders are scoped to the async chain", async () => {
    expect(currentSession()).toBeUndefined();
    expect(sessionHeaders()).toEqual({});
    const inside = await withSession("nf_ts_aaaaaaaa", async () => {
      await sleep(1);
      return new Promise<{ token: string | undefined; headers: Record<string, string> }>((resolve) => setTimeout(() => resolve({ token: currentSession(), headers: sessionHeaders() }), 1));
    });
    expect(inside).toEqual({ token: "nf_ts_aaaaaaaa", headers: { "x-nanoflags-session": "nf_ts_aaaaaaaa" } });
    expect(currentSession()).toBeUndefined();
    // Malformed tokens are not propagated; nesting restores the outer session.
    expect(withSession("bad token", () => currentSession())).toBeUndefined();
    withSession("nf_ts_aaaaaaaa", () => {
      expect(withSession("nf_ts_bbbbbbbb", () => currentSession())).toBe("nf_ts_bbbbbbbb");
      expect(withSession(undefined, () => currentSession())).toBeUndefined();
      expect(currentSession()).toBe("nf_ts_aaaaaaaa");
    });
  });

  it("concurrent requests are isolated from each other", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const handle = async (i: number) => {
      const token = i % 3 === 0 ? "nf_ts_aaaaaaaa" : i % 3 === 1 ? "nf_ts_bbbbbbbb" : undefined;
      return withSession(token, async () => {
        await sleep(i % 5);
        const flags = await sessionFlags(c);
        await sleep((i * 7) % 4);
        return { i, token: currentSession(), headers: sessionHeaders(), value: flags.string("search-ranking", "fb"), sync: flagsFor(c).string("search-ranking", "fb") };
      });
    };
    const results = await Promise.all(Array.from({ length: 90 }, (_, i) => handle(i)));
    for (const r of results) {
      const expected = r.i % 3 === 0 ? ["nf_ts_aaaaaaaa", "session-a-vip"] : r.i % 3 === 1 ? ["nf_ts_bbbbbbbb", "session-b"] : [undefined, "relevance-v3"];
      expect([r.token, r.value]).toEqual(expected);
      expect(r.sync).toBe(r.value);
      expect(r.headers).toEqual(expected[0] ? { "x-nanoflags-session": expected[0] } : {});
    }
    expect(currentSession()).toBeUndefined();
    expect(flagsFor(c).active).toBe(false);
    expect(edge.count("/v1/session")).toBe(2);
  });

  it("sessionMiddleware reads the header, sets req.flags and keeps the session for the rest of the request", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const mw = sessionMiddleware(c);
    const run = (headers: Record<string, string | string[] | undefined>) =>
      new Promise<{ value: string; active: boolean; token: string | undefined; downstream: Record<string, string>; later: string }>((resolve, reject) => {
        const req: Parameters<typeof mw>[0] = { headers };
        mw(req, {}, (err) => {
          if (err) return reject(err);
          const now = { value: req.flags!.string("search-ranking", "fb"), active: req.flags!.active, token: currentSession(), downstream: sessionHeaders() };
          setTimeout(() => resolve({ ...now, later: flagsFor(c).string("search-ranking", "fb") }), 2);
        });
      });
    const [a, b, none, unknown, arr] = await Promise.all([
      run({ "x-nanoflags-session": "nf_ts_aaaaaaaa" }),
      run({ "x-nanoflags-session": "nf_ts_bbbbbbbb" }),
      run({}),
      run({ "x-nanoflags-session": "nf_ts_unknown0" }),
      run({ "x-nanoflags-session": ["nf_ts_bbbbbbbb", "nf_ts_aaaaaaaa"] }),
    ]);
    expect(a).toEqual({ value: "session-a-vip", active: true, token: "nf_ts_aaaaaaaa", downstream: { "x-nanoflags-session": "nf_ts_aaaaaaaa" }, later: "session-a-vip" });
    expect(b).toMatchObject({ value: "session-b", active: true, later: "session-b" });
    expect(none).toEqual({ value: "relevance-v3", active: false, token: undefined, downstream: {}, later: "relevance-v3" });
    // An unknown session evaluates normally but is still propagated: the next service decides for itself.
    expect(unknown).toMatchObject({ value: "relevance-v3", active: false, token: "nf_ts_unknown0" });
    expect(arr).toMatchObject({ value: "session-b", token: "nf_ts_bbbbbbbb" });
    expect(currentSession()).toBeUndefined();
  });

  it("the middleware calls next even when the session lookup fails", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    c.on("error", () => undefined);
    await c.ready();
    edge.routes["/v1/session"] = new Error("offline");
    const req: Parameters<ReturnType<typeof sessionMiddleware>>[0] = { headers: { "x-nanoflags-session": "nf_ts_aaaaaaaa" } };
    await new Promise<void>((resolve) => sessionMiddleware(c)(req, {}, () => resolve()));
    expect(req.flags!.active).toBe(false);
    expect(req.flags!.string("search-ranking", "fb")).toBe("relevance-v3");
  });

  it("withSessionHandler wraps a fetch handler", async () => {
    const edge = edgeWith();
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const handler = withSessionHandler(c, async (request: Request, tag: string) => {
      await sleep(1);
      return Response.json({ tag, path: new URL(request.url).pathname, value: flagsFor(c).string("search-ranking", "fb"), downstream: sessionHeaders() });
    });
    const [a, plain] = await Promise.all([
      handler(new Request("https://app.test/a", { headers: { "X-NanoFlags-Session": "nf_ts_aaaaaaaa" } }), "one").then((r) => r.json()),
      handler(new Request("https://app.test/b"), "two").then((r) => r.json()),
    ]);
    expect(a).toEqual({ tag: "one", path: "/a", value: "session-a-vip", downstream: { "x-nanoflags-session": "nf_ts_aaaaaaaa" } });
    expect(plain).toEqual({ tag: "two", path: "/b", value: "relevance-v3", downstream: {} });
  });
});
