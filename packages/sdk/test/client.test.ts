import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, SDK_VERSION, type NanoFlagsClient, type UpdateEvent } from "../src/index";
import { BASE, CLIENT_KEY, SERVER_KEY, bundleResponse, conditional, makeBundle, memoryStore, mockEdge, tick } from "./helpers";

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, ...opts });
  clients.push(c);
  return c;
}
const US = { key: "user-1", signedIn: true, region: "US" };

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loading", () => {
  it("ready from network", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    expect(c.status).toBe("not-ready");
    expect(c.revision).toBeNull();
    await c.ready();
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(3);
    expect(c.boolean("checkout-v2", false, US)).toBe(true);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
    expect(c.number("max-items", 1)).toBe(20);
    expect(c.json("layout", { columns: 1 })).toEqual({ columns: 3 });

    const call = edge.calls[0]!;
    expect(call.url).toBe(`${BASE}/v1/bundle`);
    expect(call.headers.get("Authorization")).toBe(`Bearer ${SERVER_KEY}`);
    expect(call.headers.get("If-None-Match")).toBeNull();
    expect(call.url).not.toContain(SERVER_KEY);
  });

  it("trailing slashes in baseUrl are tolerated", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    await client({ fetch: edge.fetch, baseUrl: `${BASE}//` }).ready();
    expect(edge.calls[0]!.url).toBe(`${BASE}/v1/bundle`);
  });

  it("ready from bootstrap: usable synchronously, before any network answer", async () => {
    let release!: (r: Response) => void;
    const edge = mockEdge({ bundle: () => new Promise<Response>((r) => (release = r)) });
    const c = client({ fetch: edge.fetch, bootstrap: makeBundle(2) });
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(2);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v2");
    await c.ready(); // resolves although the network request is still pending
    release(bundleResponse(makeBundle(5)));
    await tick();
    expect(c.revision).toBe(5);
    expect(c.status).toBe("ready");
  });

  it("bootstrap + offline: keeps the bootstrap bundle and reports stale", async () => {
    const edge = mockEdge();
    const errors: Error[] = [];
    const c = client({ fetch: edge.fetch, bootstrap: makeBundle(2) });
    c.on("error", (e) => errors.push(e));
    await c.refresh();
    expect(c.status).toBe("stale");
    expect(c.revision).toBe(2);
    expect(errors[0]).toMatchObject({ name: "NanoFlagsError", code: "network" });
  });

  it("an invalid bootstrap is ignored", async () => {
    const edge = mockEdge();
    const c = client({ fetch: edge.fetch, bootstrap: { flags: {} } as never });
    await c.ready();
    expect(c.status).toBe("not-ready");
  });

  it("ready from store when offline: status stale", async () => {
    // First client: online, persists the bundle.
    const store = memoryStore();
    const online = mockEdge({ bundle: bundleResponse(makeBundle(4)) });
    await client({ fetch: online.fetch, store }).ready();
    await tick();
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.peek()).not.toContain(SERVER_KEY);

    // Second client: same store, edge unreachable.
    const offline = mockEdge();
    const updates: UpdateEvent[] = [];
    const c = client({ fetch: offline.fetch, store });
    c.on("update", (e) => updates.push(e));
    await c.ready();
    expect(c.status).toBe("stale");
    expect(c.revision).toBe(4);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v4");
    expect(updates).toEqual([{ revision: 4, previousRevision: null, checksum: "c4", source: "store", latencyMs: null, transport: "poll" }]);
  });

  it("a restored bundle is revalidated with If-None-Match and becomes ready on 304", async () => {
    const store = memoryStore();
    const first = mockEdge({ bundle: bundleResponse(makeBundle(4)) });
    await client({ fetch: first.fetch, store }).ready();
    await tick();

    const edge = mockEdge();
    const c = client({ fetch: edge.fetch, store });
    await c.ready();
    expect(c.status).toBe("stale");
    edge.replies.bundle = conditional(() => makeBundle(4), edge.calls);
    await c.refresh();
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c4-server"');
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(4);
  });

  it("the store is bound to the SDK key: a bundle persisted for another key is not restored", async () => {
    const store = memoryStore();
    const first = mockEdge({ bundle: bundleResponse(makeBundle(4)) });
    await client({ fetch: first.fetch, store }).ready();
    await tick();
    const c = client({ fetch: mockEdge().fetch, store, sdkKey: CLIENT_KEY });
    await c.ready();
    expect(c.status).toBe("not-ready");
  });

  it("a broken or corrupt store never prevents start-up", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const throwing = { get: async () => Promise.reject(new Error("denied")), set: async () => Promise.reject(new Error("quota")) };
    const a = client({ fetch: edge.fetch, store: throwing });
    await a.ready();
    expect(a.status).toBe("ready");
    const b = client({ fetch: mockEdge().fetch, store: memoryStore("{not json") });
    await b.ready();
    expect(b.status).toBe("not-ready");
  });

  it("the stored copy never replaces a newer bundle from the network", async () => {
    const store = memoryStore();
    await client({ fetch: mockEdge({ bundle: bundleResponse(makeBundle(4)) }).fetch, store }).ready();
    await tick();
    const slow = { get: async () => (await tick(), await tick(), store.peek()), set: store.set };
    const c = client({ fetch: mockEdge({ bundle: bundleResponse(makeBundle(6)) }).fetch, store: slow });
    await c.ready();
    await tick();
    await tick();
    await tick();
    expect(c.revision).toBe(6);
    expect(c.status).toBe("ready");
  });

  it("nothing available: ready() still resolves, status not-ready, fallbacks with reason flag_not_found", async () => {
    const edge = mockEdge();
    const errors: Error[] = [];
    const c = client({ fetch: edge.fetch });
    c.on("error", (e) => errors.push(e));
    await expect(c.ready()).resolves.toBeUndefined();
    expect(c.status).toBe("not-ready");
    expect(c.revision).toBeNull();
    expect(c.boolean("checkout-v2", true, US)).toBe(true);
    expect(c.boolean("checkout-v2", false, US)).toBe(false);
    expect(c.string("search-ranking", "fb")).toBe("fb");
    expect(c.number("max-items", 7)).toBe(7);
    expect(c.json("layout", { columns: 1 })).toEqual({ columns: 1 });
    expect(c.evaluate("checkout-v2", false, US)).toMatchObject({ value: false, reason: "flag_not_found", revision: 0 });
    expect(errors).toHaveLength(1);
  });

  it("HTTP errors: 401 → unauthorized error, 503 → http error; never throws", async () => {
    for (const [status, code] of [[401, "unauthorized"], [503, "http"], [500, "http"]] as const) {
      const edge = mockEdge({ bundle: new Response('{"error":{}}', { status }) });
      const errors: Error[] = [];
      const c = client({ fetch: edge.fetch });
      c.on("error", (e) => errors.push(e));
      await c.ready();
      expect(c.status).toBe("not-ready");
      expect(errors[0]).toMatchObject({ code, httpStatus: status });
      expect(errors[0]!.message).not.toContain(SERVER_KEY);
    }
  });

  it("an invalid bundle payload is rejected and the current bundle is kept", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    edge.replies.bundle = new Response(JSON.stringify({ revision: 9, checksum: "x", bundle: { schema: 2 } }), { status: 200 });
    const errors: Error[] = [];
    c.on("error", (e) => errors.push(e));
    await c.refresh();
    expect(errors[0]).toMatchObject({ code: "invalid_bundle" });
    expect(c.revision).toBe(3);
    expect(c.status).toBe("stale");
  });

  it("missing configuration: ready resolves, error is reported, fallbacks apply", async () => {
    const errors: Error[] = [];
    const c = createClient({ sdkKey: "", baseUrl: "" });
    c.on("error", (e) => errors.push(e));
    await c.ready();
    expect(c.status).toBe("not-ready");
    expect(c.boolean("x", true)).toBe(true);
    expect(errors[0]).toMatchObject({ code: "config" });
    c.close();
  });
});

describe("updates", () => {
  it("304 handling: sends If-None-Match, keeps the bundle, no update event, nothing re-persisted", async () => {
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => makeBundle(3), edge.calls);
    const store = memoryStore();
    const updates: UpdateEvent[] = [];
    const c = client({ fetch: edge.fetch, store });
    c.on("update", (e) => updates.push(e));
    await c.ready();
    await tick();
    expect(updates).toHaveLength(1);
    const versionBefore = c.version;

    await c.refresh();
    await c.refresh();
    expect(edge.count("/v1/bundle")).toBe(3);
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c3-server"');
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(3);
    expect(updates).toHaveLength(1);
    expect(c.version).toBe(versionBefore);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("atomic update on a new revision", async () => {
    let current = makeBundle(3);
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => current, edge.calls);
    const store = memoryStore();
    const c = client({ fetch: edge.fetch, store });
    await c.ready();

    // Revision 4 changes two flags together; an evaluation must never see a mix of both revisions.
    current = makeBundle(4, { "max-items": { type: "number", enabled: true, default: 40, off: 0, rules: [] } });
    const seen: Array<[string, number, number]> = [];
    const snapshot = () => seen.push([c.string("search-ranking", "fb"), c.number("max-items", -1), c.revision!]);
    const updates: UpdateEvent[] = [];
    c.on("update", (e) => {
      updates.push(e);
      snapshot(); // inside the event the new bundle is already fully in place
    });
    snapshot();
    const pending = c.refresh();
    snapshot(); // request in flight: still the old revision
    await pending;
    snapshot();

    expect(seen).toEqual([
      ["relevance-v3", 20, 3],
      ["relevance-v3", 20, 3],
      ["relevance-v4", 40, 4],
      ["relevance-v4", 40, 4],
    ]);
    expect(updates).toEqual([{ revision: 4, previousRevision: 3, checksum: "c4", source: "network", latencyMs: null, transport: "poll" }]);
    expect(c.evaluate("max-items", 0).revision).toBe(4);
    await tick();
    expect(JSON.parse(store.peek()!).bundle.revision).toBe(4);
  });

  it("a failed refresh keeps the bundle (stale) and recovers on the next success", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    edge.replies.bundle = new Error("offline");
    await c.refresh();
    expect(c.status).toBe("stale");
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
    edge.replies.bundle = conditional(() => makeBundle(3), edge.calls);
    await c.refresh();
    expect(c.status).toBe("ready");
  });

  it("edge serving last-known-good (X-NanoFlags-Stale): bundle is used, status stale, never downgrades", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3), { stale: true }) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.status).toBe("stale");
    expect(c.revision).toBe(3);

    edge.replies.bundle = bundleResponse(makeBundle(5));
    await c.refresh();
    expect(c.status).toBe("ready");
    edge.replies.bundle = bundleResponse(makeBundle(4), { stale: true });
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(c.status).toBe("stale");
  });

  it("concurrent refreshes share one request", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await Promise.all([c.refresh(), c.refresh(), c.refresh()]);
    expect(edge.count("/v1/bundle")).toBe(2);
  });

  it("polls with jitter (±20%)", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => makeBundle(3), edge.calls);
    const c = client({ fetch: edge.fetch, pollIntervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    expect(edge.count("/v1/bundle")).toBe(1);
    await vi.advanceTimersByTimeAsync(23_999); // shortest delay is 24s
    expect(edge.count("/v1/bundle")).toBe(1);
    random.mockReturnValue(0.999999); // applies to the timer armed after this poll: ~36s
    await vi.advanceTimersByTimeAsync(1);
    expect(edge.count("/v1/bundle")).toBe(2);
    await vi.advanceTimersByTimeAsync(35_900);
    expect(edge.count("/v1/bundle")).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(edge.count("/v1/bundle")).toBe(3);
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c3-server"');
  });

  it("catches up quickly after failures (1s, 2s, … instead of a full interval)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor exactly 1.0
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => makeBundle(3), edge.calls);
    const c = client({ fetch: edge.fetch, pollIntervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    edge.replies.bundle = new Error("offline");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(edge.count("/v1/bundle")).toBe(2);
    expect(c.status).toBe("stale");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(edge.count("/v1/bundle")).toBe(3);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(edge.count("/v1/bundle")).toBe(3);
    edge.replies.bundle = conditional(() => makeBundle(4), edge.calls);
    await vi.advanceTimersByTimeAsync(100);
    expect(edge.count("/v1/bundle")).toBe(4);
    expect(c.revision).toBe(4);
    expect(c.status).toBe("ready");
    // Back to the normal cadence.
    await vi.advanceTimersByTimeAsync(29_900);
    expect(edge.count("/v1/bundle")).toBe(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(edge.count("/v1/bundle")).toBe(5);
  });

  it("tab visibility: hidden tabs skip polls and catch up when visible again", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, () => void>();
    const doc = { visibilityState: "visible", addEventListener: (t: string, h: () => void) => handlers.set(t, h), removeEventListener: (t: string) => handlers.delete(t) };
    vi.stubGlobal("document", doc);
    const edge = mockEdge();
    let current = makeBundle(3);
    edge.replies.bundle = conditional(() => current, edge.calls);
    const c = client({ fetch: edge.fetch, pollIntervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();

    doc.visibilityState = "hidden";
    handlers.get("visibilitychange")!();
    current = makeBundle(4);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(edge.count("/v1/bundle")).toBe(1);
    expect(c.revision).toBe(3);

    doc.visibilityState = "visible";
    handlers.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(edge.count("/v1/bundle")).toBe(2);
    expect(c.revision).toBe(4);
    c.close();
    expect(handlers.has("visibilitychange")).toBe(false);
  });

  it("close() stops polling; evaluations keep working", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, pollIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    c.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edge.count("/v1/bundle")).toBe(1);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("streaming", () => {
  const sse = (chunks: string[], keepOpen = false) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          if (!keepOpen) controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );

  it("server key: fetch-stream with Authorization header; a revision notification triggers a conditional bundle fetch", async () => {
    let current = makeBundle(3);
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => current, edge.calls);
    let push!: (s: string) => void;
    edge.replies.stream = () =>
      new Response(new ReadableStream<Uint8Array>({ start: (c) => void (push = (s) => c.enqueue(new TextEncoder().encode(s))) }), { status: 200 });
    const c = client({ fetch: edge.fetch, streaming: true });
    await c.ready();
    await tick();
    const streamCall = edge.last("/v1/stream")!;
    expect(streamCall.headers.get("Authorization")).toBe(`Bearer ${SERVER_KEY}`);
    expect(streamCall.url).toBe(`${BASE}/v1/stream`); // server keys never travel in the URL

    // Same revision: no bundle request. Split across chunks, with a heartbeat in between.
    push('retry: 3000\nevent: revision\ndata: {"revision":3,');
    push('"checksum":"c3"}\n\n: hb\n\n');
    await tick();
    expect(edge.count("/v1/bundle")).toBe(1);

    current = makeBundle(4);
    const updated = new Promise<UpdateEvent>((r) => c.on("update", r));
    push('event: revision\ndata: {"revision":4,"checksum":"c4"}\n\n');
    expect(await updated).toMatchObject({ revision: 4, previousRevision: 3 });
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c3-server"');
    expect(c.revision).toBe(4);
    // The notification itself carries no flag data: values come from the fetched bundle.
    expect(c.string("search-ranking", "fb")).toBe("relevance-v4");
  });

  it("reconnects after the edge closes the stream", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    edge.replies.stream = () => sse(['event: revision\ndata: {"revision":3,"checksum":"c3"}\n\n']);
    const c = client({ fetch: edge.fetch, streaming: true });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(10);
    expect(edge.count("/v1/stream")).toBe(1);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(edge.count("/v1/stream")).toBeGreaterThanOrEqual(2);
    c.close();
    const n = edge.count("/v1/stream");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(edge.count("/v1/stream")).toBe(n);
  });

  it("browser key + EventSource: connects with ?key= and refetches on revision events", async () => {
    const instances: FakeES[] = [];
    class FakeES {
      listeners = new Map<string, (e: { data: string }) => void>();
      closed = false;
      constructor(readonly url: string) {
        instances.push(this);
      }
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        this.listeners.set(type, cb);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeES);
    let current = makeBundle(3);
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => current, edge.calls);
    const c = client({ fetch: edge.fetch, streaming: true, sdkKey: CLIENT_KEY });
    await c.ready();
    await tick();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toBe(`${BASE}/v1/stream?key=${CLIENT_KEY}`);
    expect(edge.count("/v1/stream")).toBe(0);

    current = makeBundle(4);
    instances[0]!.listeners.get("revision")!({ data: '{"revision":4,"checksum":"c4"}' });
    await tick();
    await tick();
    expect(c.revision).toBe(4);
    c.close();
    expect(instances[0]!.closed).toBe(true);
  });

  it("server key never uses EventSource, even when it exists", async () => {
    const ctor = vi.fn();
    vi.stubGlobal("EventSource", ctor);
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)), stream: () => sse([], true) });
    const c = client({ fetch: edge.fetch, streaming: true });
    await c.ready();
    await tick();
    expect(ctor).not.toHaveBeenCalled();
    expect(edge.count("/v1/stream")).toBe(1);
    expect(edge.calls.every((x) => !x.url.includes("key="))).toBe(true);
  });
});

describe("evaluation", () => {
  it("type mismatch between flag value and accessor returns the fallback with reason error", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.boolean("search-ranking", true)).toBe(true);
    expect(c.boolean("search-ranking", false)).toBe(false);
    expect(c.string("checkout-v2", "fb", US)).toBe("fb");
    expect(c.number("search-ranking", 42)).toBe(42);
    expect(c.string("max-items", "fb")).toBe("fb");
    expect(c.number("layout", 1)).toBe(1);
    // json accepts any JSON value.
    expect(c.json("search-ranking", null)).toBe("relevance-v3");
    // evaluate() returns the raw engine result, without a type check.
    expect(c.evaluate("search-ranking", false)).toMatchObject({ value: "relevance-v3", reason: "default" });
  });

  it("type mismatch is visible as reason error in sampled events", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0 } });
    await c.ready();
    c.boolean("search-ranking", true);
    await c.flush();
    expect((edge.last("/v1/events")!.body as { events: unknown[] }).events).toMatchObject([{ flagKey: "search-ranking", value: true, reason: "error", revision: 3 }]);
  });

  it("evaluate returns the engine Evaluation (reason, rule, trace)", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const r = c.evaluate("checkout-v2", false, US);
    expect(r).toMatchObject({ flagKey: "checkout-v2", value: true, reason: "rule_match", ruleIndex: 1, ruleId: "r1", inRollout: true, revision: 3 });
    expect(r.trace.length).toBeGreaterThan(0);
    expect(c.evaluate("checkout-v2", true, { email: "a@nanoflags.dev" })).toMatchObject({ value: true, ruleId: "staff" });
    expect(c.evaluate("nope", "fb")).toMatchObject({ value: "fb", reason: "flag_not_found", revision: 3 });
    expect(c.boolean("checkout-v2", true)).toBe(false); // no context → default
  });

  it("no network on evaluate: thousands of evaluations cause zero requests", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 60_000 } });
    await c.ready();
    const before = edge.calls.length;
    expect(before).toBe(1);
    for (let i = 0; i < 5_000; i++) {
      const ctx = { key: `user-${i}`, signedIn: true, region: "US" };
      c.boolean("checkout-v2", false, ctx);
      c.string("search-ranking", "fb", ctx);
      c.number("max-items", 0, ctx);
      c.json("layout", null, ctx);
      c.evaluate("missing", false, ctx);
    }
    await tick();
    expect(edge.calls.length).toBe(before);
  });

  it("accessors are synchronous and never throw, even for odd input", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3, { broken: { type: "boolean", enabled: true, default: false, off: false, rules: null as never } })) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.boolean("broken", true)).toBe(true);
    expect(c.evaluate("broken", true).reason).toBe("error");
    expect(c.boolean("constructor", true)).toBe(true);
    expect(c.boolean("checkout-v2", true, undefined)).toBe(false);
  });
});

describe("events", () => {
  it("batches sampled evaluations and sends a periodic report", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, service: "checkout-api", events: { sampleRate: 1, flushIntervalMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    for (let i = 0; i < 7; i++) c.boolean("checkout-v2", false, { key: `u${i}`, signedIn: true, region: "US", email: "secret@example.com", plan: "pro" });
    expect(edge.count("/v1/events")).toBe(0); // nothing is sent on the hot path

    await vi.advanceTimersByTimeAsync(10_000);
    expect(edge.count("/v1/events")).toBe(1);
    const call = edge.last("/v1/events")!;
    expect(call.method).toBe("POST");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${SERVER_KEY}`);
    const body = call.body as { service: string; sdk: string; revision: number; events: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ service: "checkout-api", sdk: `js/${SDK_VERSION}`, revision: 3 });
    expect(body.events).toHaveLength(7);
    expect(body.events[0]).toMatchObject({ flagKey: "checkout-v2", value: true, reason: "rule_match", ruleIndex: 1, revision: 3 });
    expect(Number.isNaN(Date.parse(body.events[0]!.at as string))).toBe(false);

    // No evaluations in the next intervals: nothing is sent until the idle report is due (60 s after the last request).
    await vi.advanceTimersByTimeAsync(50_000);
    expect(edge.count("/v1/events")).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edge.count("/v1/events")).toBe(2);
    expect(edge.last("/v1/events")!.body).toMatchObject({ service: "checkout-api", revision: 3, events: [] });
  });

  it("default redaction: only names (with value types) of attributes used by the flag's rules — no values", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0 } });
    await c.ready();
    c.boolean("checkout-v2", false, { key: "user-secret-id", signedIn: true, region: "US", email: "secret@example.com", plan: "pro", cart: { total: 99 } });
    c.string("search-ranking", "fb", { key: "user-secret-id", email: "secret@example.com" });
    await c.flush();
    const sent = JSON.stringify(edge.last("/v1/events")!.body);
    const events = (edge.last("/v1/events")!.body as { events: Array<{ context: unknown }> }).events;
    // checkout-v2 rules reference: email (via segment "staff"), signedIn, region, and key (rollout bucketing).
    expect(events[0]!.context).toEqual({ email: "string", signedIn: "boolean", region: "string", key: "string" });
    // search-ranking has no rules: nothing is sent.
    expect(events[1]!.context).toEqual({});
    for (const secret of ["user-secret-id", "secret@example.com", "pro", "99", "cart", "plan"]) expect(sent).not.toContain(secret);
  });

  it("custom redact decides what leaves the process", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0, redact: (ctx) => ({ region: ctx.region }) } });
    await c.ready();
    c.boolean("checkout-v2", false, { key: "user-1", region: "US", email: "x@example.com" });
    await c.flush();
    expect((edge.last("/v1/events")!.body as { events: Array<{ context: unknown }> }).events[0]!.context).toEqual({ region: "US" });
  });

  it("sampling: only the sampled fraction is queued", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    let i = 0;
    const random = () => (i++ % 10) / 10; // 0, 0.1, … 0.9 → exactly 1 in 10 is below 0.1
    const c = client({ fetch: edge.fetch, events: { sampleRate: 0.1, flushIntervalMs: 0, random } });
    await c.ready();
    for (let n = 0; n < 200; n++) c.string("search-ranking", "fb");
    await c.flush();
    expect((edge.last("/v1/events")!.body as { events: unknown[] }).events).toHaveLength(20);
  });

  it("default sample rate is 0.1; sampleRate 0 or events disabled sends nothing", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const random = vi.fn(() => 0.09);
    const a = client({ fetch: edge.fetch, events: { flushIntervalMs: 0, random } });
    await a.ready();
    a.string("search-ranking", "fb");
    random.mockReturnValue(0.1);
    a.string("search-ranking", "fb");
    await a.flush();
    expect((edge.last("/v1/events")!.body as { events: unknown[] }).events).toHaveLength(1);

    const off = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const b = client({ fetch: off.fetch, events: { enabled: false } });
    await b.ready();
    b.string("search-ranking", "fb");
    await b.flush();
    const d = client({ fetch: off.fetch, events: false });
    await d.ready();
    await d.flush();
    expect(off.count("/v1/events")).toBe(0);
  });

  it("at most 50 events per request; the queue is bounded", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0 } });
    await c.ready();
    for (let n = 0; n < 5_000; n++) c.string("search-ranking", "fb");
    let total = 0;
    for (let n = 0; n < 12; n++) {
      await c.flush();
      const sent = (edge.last("/v1/events")!.body as { events: unknown[] }).events.length;
      expect(sent).toBeLessThanOrEqual(50);
      total += sent;
    }
    expect(total).toBe(500); // 4,500 evaluations were dropped instead of growing memory
  });

  it("events are dropped on failure — never retried, never thrown", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)), events: new Error("offline") });
    const errors: Error[] = [];
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0 } });
    c.on("error", (e) => errors.push(e));
    await c.ready();
    for (let n = 0; n < 3; n++) c.string("search-ranking", "fb");
    await expect(c.flush()).resolves.toBeUndefined();
    edge.replies.events = () => new Response('{"accepted":0}', { status: 202 });
    await c.flush();
    expect(edge.count("/v1/events")).toBe(2);
    expect((edge.last("/v1/events")!.body as { events: unknown[] }).events).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(c.status).toBe("ready");
  });

  it("oversized values are not shipped", async () => {
    const big = { blob: "x".repeat(5_000) };
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3, { layout: { type: "json", enabled: true, default: big, off: null, rules: [] } })) });
    const c = client({ fetch: edge.fetch, events: { sampleRate: 1, flushIntervalMs: 0 } });
    await c.ready();
    expect(c.json("layout", null)).toEqual(big);
    await c.flush();
    expect((edge.last("/v1/events")!.body as { events: Array<{ value: unknown }> }).events[0]!.value).toBeNull();
  });
});

describe("listeners", () => {
  it("on() returns an unsubscribe function; a throwing listener does not break the client", async () => {
    let current = makeBundle(3);
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => current, edge.calls);
    const c = client({ fetch: edge.fetch });
    const seen: number[] = [];
    c.on("update", () => {
      throw new Error("listener bug");
    });
    const off = c.on("update", (e) => seen.push(e.revision));
    await c.ready();
    current = makeBundle(4);
    await c.refresh();
    off();
    current = makeBundle(5);
    await c.refresh();
    expect(seen).toEqual([3, 4]);
    expect(c.revision).toBe(5);
  });

  it("subscribe/version change on bundle and status changes only", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    const versions: number[] = [];
    const unsubscribe = c.subscribe(() => versions.push(c.version));
    await c.ready();
    expect(versions).toHaveLength(1);
    edge.replies.bundle = new Error("offline");
    await c.refresh(); // ready → stale
    await c.refresh(); // still stale: no notification
    expect(versions).toHaveLength(2);
    unsubscribe();
    edge.replies.bundle = bundleResponse(makeBundle(4));
    await c.refresh();
    expect(versions).toHaveLength(2);
    expect(c.version).toBeGreaterThan(versions[1]!);
  });
});
