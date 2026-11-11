import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, LIVE_PROTOCOL, NanoFlagsError, type Bundle, type NanoFlagsClient, type UpdateEvent, type WebSocketConstructor } from "../src/index";
import { canonicalString, sha256Hex } from "../src/verify";
import { BASE, CLIENT_KEY, SERVER_KEY, bundleResponse, conditional, makeBundle, memoryStore, mockEdge, tick } from "./helpers";
import { ENV_ID, makeSigner, signedResponse, mockRoutes, type Signer } from "./v2helpers";

/** Scriptable WebSocket: records what the SDK does and lets the test play the edge. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  /** What `new` does: connect normally, throw, or fail before opening (HTTP 503 / no upgrade path). */
  static mode: "ok" | "open" | "throw" | "refuse" = "ok";
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  autoPong = true;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeSocket.instances.push(this);
    if (FakeSocket.mode === "throw") throw new Error("WebSocket is not supported here");
    // A handshake the server answers with 503 surfaces as error + close, never as open.
    if (FakeSocket.mode === "refuse") queueMicrotask(() => this.fail());
    if (FakeSocket.mode === "open") queueMicrotask(() => this.open());
  }
  send(data: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
    if (data === "ping" && this.autoPong) queueMicrotask(() => this.onmessage?.({ data: "pong" }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  // --- test side
  open() {
    this.onopen?.({});
  }
  message(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  /** The edge (or the network) drops the connection. */
  drop(code = 1006) {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code });
  }
  fail() {
    this.onerror?.({});
    this.drop();
  }
  static get last(): FakeSocket {
    return FakeSocket.instances.at(-1)!;
  }
}
const WS = FakeSocket as unknown as WebSocketConstructor;

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, pollIntervalMs: 0, events: false, webSocket: WS, ...opts });
  clients.push(c);
  return c;
}

/** A `rev` / `hello` message as the sequencer sends it (unsigned unless a signer is given). */
async function pushMessage(bundle: Bundle, opts: { t?: "rev" | "hello"; signer?: Signer; checksum?: string; committedAt?: number | null; environmentId?: string; bundleText?: string; signature?: string } = {}) {
  const checksum = opts.checksum ?? `c${bundle.revision}`;
  const environmentId = opts.environmentId ?? ENV_ID;
  const text = opts.bundleText ?? JSON.stringify(bundle);
  const signature = opts.signature ?? (opts.signer ? await opts.signer.sign(canonicalString(environmentId, bundle.revision, checksum, await sha256Hex(text))) : "unsigned");
  return { t: opts.t ?? "rev", revision: bundle.revision, checksum, signature, kid: opts.signer?.kid ?? "k1", environmentId, bundle: text, committedAt: opts.committedAt === undefined ? Date.now() - 120 : opts.committedAt, sentAt: Date.now() };
}

/**
 * Lets queued microtasks and mocked fetches run. Only for paths that involve no real asynchronous work: WebCrypto
 * (signature verification, hashing, key import) runs on the libuv threadpool and finishes in real time, which a fixed
 * number of ticks does not bound — under load it can take longer. Tests that verify signatures wait for events instead.
 */
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/**
 * Records a client's events from now on; `count(n)` resolves once `n` have been emitted (immediately if they already
 * were). Waiting for the outcome itself — not for an amount of time — is what makes verification tests deterministic.
 */
function record<E>(c: NanoFlagsClient, event: "update" | "error") {
  const items: E[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  c.on(event as "error", (e) => {
    items.push(e as E);
    for (const w of waiters.splice(0)) {
      if (items.length >= w.n) w.resolve();
      else waiters.push(w);
    }
  });
  return {
    items,
    count: (n: number) => (items.length >= n ? Promise.resolve(items) : new Promise<E[]>((resolve) => waiters.push({ n, resolve: () => resolve(items) }))),
  };
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  FakeSocket.instances = [];
  FakeSocket.mode = "ok";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live transport", () => {
  it("connects to wss://…/v1/live with the key in the subprotocol list — never in the URL — and SSE is not opened", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await tick();
    expect(FakeSocket.instances).toHaveLength(1);
    const ws = FakeSocket.last;
    expect(ws.url).toBe("wss://edge.test/v1/live");
    expect(ws.url).not.toContain(SERVER_KEY);
    expect(ws.protocols).toEqual([LIVE_PROTOCOL, `key.${SERVER_KEY}`]);
    expect(c.transport).toBe("poll"); // not open yet
    ws.open();
    expect(c.transport).toBe("live");
    await settle();
    expect(edge.count("/v1/stream")).toBe(0);
  });

  it("applies a pushed bundle without any fetch and reports latency and transport", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await tick();
    FakeSocket.last.open();
    const before = edge.calls.length;
    const updates: UpdateEvent[] = [];
    c.on("update", (e) => updates.push(e));

    FakeSocket.last.message(await pushMessage(makeBundle(4), { committedAt: Date.now() - 250 }));
    await settle();
    expect(c.revision).toBe(4);
    expect(c.status).toBe("ready");
    expect(c.string("search-ranking", "fb")).toBe("relevance-v4");
    expect(edge.calls.length).toBe(before); // the push carried the bundle: no request followed
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ revision: 4, previousRevision: 3, checksum: "c4", source: "network", transport: "live" });
    expect(updates[0]!.latencyMs).toBeGreaterThanOrEqual(250);
    expect(updates[0]!.latencyMs).toBeLessThan(5_000);
  });

  it("`hello` on connect catches a client up in one message; the same revision only confirms it", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await tick();
    FakeSocket.last.open();
    const updates: UpdateEvent[] = [];
    c.on("update", (e) => updates.push(e));
    FakeSocket.last.message(await pushMessage(makeBundle(3), { t: "hello" }));
    await settle();
    expect(updates).toHaveLength(0);
    FakeSocket.last.message(await pushMessage(makeBundle(6), { t: "hello", committedAt: null }));
    await settle();
    expect(c.revision).toBe(6);
    expect(updates).toEqual([{ revision: 6, previousRevision: 3, checksum: "c6", source: "network", latencyMs: null, transport: "live" }]);
    // An environment with nothing published greets with revision 0 and no bundle.
    FakeSocket.last.message({ t: "hello", revision: 0, checksum: null, signature: null, kid: null, environmentId: ENV_ID, bundle: null, committedAt: null, sentAt: Date.now() });
    await settle();
    expect(c.revision).toBe(6);
  });

  it("a client that could not load anything becomes ready from the first push", async () => {
    const edge = mockEdge(); // offline for HTTP
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.status).toBe("not-ready");
    await tick();
    FakeSocket.last.open();
    FakeSocket.last.message(await pushMessage(makeBundle(2), { t: "hello" }));
    await settle();
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(2);
  });

  it("ignores older revisions and malformed messages", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(5)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await tick();
    const ws = FakeSocket.last;
    ws.open();
    const updates: UpdateEvent[] = [];
    const errors: Error[] = [];
    c.on("update", (e) => updates.push(e));
    c.on("error", (e) => errors.push(e));
    ws.message(await pushMessage(makeBundle(4)));
    ws.message("not json");
    ws.message([1, 2]);
    ws.message({ t: "other", revision: 9, bundle: "{}" });
    ws.message({ t: "rev", revision: "9", bundle: "{}" });
    ws.onmessage?.({ data: new ArrayBuffer(4) });
    await settle();
    expect(c.revision).toBe(5);
    expect(updates).toHaveLength(0);
    expect(errors).toHaveLength(0);

    // Out of order: r8 then r7 — the client ends on r8.
    ws.message(await pushMessage(makeBundle(8)));
    ws.message(await pushMessage(makeBundle(7)));
    await settle();
    expect(c.revision).toBe(8);
    expect(updates.map((u) => u.revision)).toEqual([8]);

    // A bundle that does not parse, or whose revision disagrees with the message, is refused.
    ws.message({ ...(await pushMessage(makeBundle(9))), bundle: "{broken" });
    ws.message({ ...(await pushMessage(makeBundle(9))), revision: 10 });
    await settle();
    expect(c.revision).toBe(8);
    expect(errors.map((e) => (e as NanoFlagsError).code)).toEqual(["invalid_bundle", "invalid_bundle"]);
  });

  it("a slower HTTP answer never replaces a pushed revision with an older one", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await tick();
    FakeSocket.last.open();
    FakeSocket.last.message(await pushMessage(makeBundle(4)));
    await settle();
    // KV still points at r3 (the pointer is written after the broadcast): the poll answers 200 with r3.
    await c.refresh();
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c4-server"');
    expect(c.revision).toBe(4);
    expect(c.status).toBe("ready");
  });

  it("the pushed bundle is persisted like a fetched one", async () => {
    const store = memoryStore();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, store });
    await c.ready();
    await tick();
    FakeSocket.last.open();
    FakeSocket.last.message(await pushMessage(makeBundle(4)));
    await settle();
    expect((JSON.parse(store.peek()!) as { bundle: Bundle; etag: string }).bundle.revision).toBe(4);
    expect((JSON.parse(store.peek()!) as { etag: string }).etag).toBe('"c4-server"');
  });

  it("browser keys use the live socket too, and expect the client view's ETag", async () => {
    const es = vi.fn();
    vi.stubGlobal("EventSource", es);
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3), { kind: "client" }) });
    const c = client({ fetch: edge.fetch, sdkKey: CLIENT_KEY });
    await c.ready();
    await tick();
    expect(FakeSocket.last.protocols).toEqual([LIVE_PROTOCOL, `key.${CLIENT_KEY}`]);
    FakeSocket.last.open();
    FakeSocket.last.message(await pushMessage(makeBundle(4)));
    await settle();
    expect(c.revision).toBe(4);
    expect(es).not.toHaveBeenCalled();
    await c.refresh();
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c4-client"');
  });

  it("uses the global WebSocket by default; `live: false` and `streaming: false` opt out", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const a = client({ fetch: edge.fetch, webSocket: undefined });
    await a.ready();
    await tick();
    expect(FakeSocket.instances).toHaveLength(1);

    const b = client({ fetch: edge.fetch, webSocket: undefined, live: false });
    await b.ready();
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(edge.count("/v1/stream")).toBe(1); // SSE as in 0.2
    expect(b.transport).toBe("stream");

    const n = edge.count("/v1/stream");
    const d = client({ fetch: edge.fetch, webSocket: undefined, streaming: false });
    await d.ready();
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(edge.count("/v1/stream")).toBe(n);
    expect(d.transport).toBe("poll");
  });
});

describe("live transport — signature verification", () => {
  it("verifies the pushed bundle against the pushed signature and adopts it", async () => {
    const signer = await makeSigner();
    const routes = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: routes.fetch, verify: { publicKeys: [signer.publicJwk], require: true } });
    await c.ready();
    expect(c.revision).toBe(3);
    await tick();
    FakeSocket.last.open();
    const before = routes.calls.length;
    const updates = record<UpdateEvent>(c, "update");
    // Text that is not what JSON.stringify would produce: the signature covers the exact bytes.
    const text = JSON.stringify(makeBundle(4), null, 1);
    FakeSocket.last.message(await pushMessage(makeBundle(4), { signer, bundleText: text }));
    // Verification is real asynchronous work (WebCrypto): wait for its outcome, not for a number of ticks.
    expect((await updates.count(1))[0]).toMatchObject({ revision: 4, transport: "live" });
    expect(c.revision).toBe(4);
    expect(routes.calls.length).toBe(before);
  });

  it("rejects a bad signature, keeps the old bundle, reports `signature`, and asks the edge over HTTP what is current", async () => {
    const signer = await makeSigner();
    const other = await makeSigner();
    const served = await signedResponse(signer, makeBundle(3));
    // Resolves when the edge is asked over HTTP again after the initial load (the rejection's verified re-check).
    let bundleRequests = 0;
    let consulted!: () => void;
    const reconsulted = new Promise<void>((r) => (consulted = r));
    const routes = mockRoutes({
      "/v1/bundle": () => {
        if (++bundleRequests === 2) consulted();
        return served;
      },
    });
    const c = client({ fetch: routes.fetch, verify: { publicKeys: [signer.publicJwk] } });
    await c.ready();
    await tick();
    const ws = FakeSocket.last;
    ws.open();
    const errors = record<NanoFlagsError>(c, "error");
    const updates = record<UpdateEvent>(c, "update");
    const evil = makeBundle(4, { "max-items": { type: "number", enabled: true, default: 9999, off: 0, rules: [] } } as never);

    // Each push is verified with WebCrypto (real asynchronous work); each step waits for its rejection.
    // Signed by someone else.
    ws.message(await pushMessage(evil, { signer: other }));
    await errors.count(1);
    // Signed correctly, but the bundle text was changed afterwards.
    const genuine = await pushMessage(makeBundle(4), { signer });
    ws.message({ ...genuine, bundle: JSON.stringify(evil) });
    await errors.count(2);
    // Signed for another environment (the client is pinned to the one it first verified).
    ws.message(await pushMessage(makeBundle(4), { signer, environmentId: "6f0c7c1e-0000-4000-8000-00000000ffff" }));
    await errors.count(3);
    // No signature at all.
    ws.message({ ...genuine, signature: undefined });
    await errors.count(4);
    await reconsulted; // the verified path was consulted

    expect(c.revision).toBe(3);
    expect(c.status).toBe("ready");
    expect(c.number("max-items", 0)).toBe(20);
    expect(updates.items).toHaveLength(0);
    expect(errors.items).toHaveLength(4);
    expect(errors.items.every((e) => e.code === "signature")).toBe(true);
    expect(errors.items[0]!.message).toContain("unchanged");
    expect(routes.count("/v1/bundle")).toBeGreaterThanOrEqual(2);

    // The genuine message is still accepted afterwards.
    ws.message(genuine);
    expect((await updates.count(1))[0]).toMatchObject({ revision: 4, previousRevision: 3, transport: "live" });
    expect(c.revision).toBe(4);
    expect(errors.items).toHaveLength(4);
  });
});

describe("live transport — reconnect and fallback", () => {
  it("reconnects with jittered exponential backoff and catches up from `hello`", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // backoff factor 1.0
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.last.open();
    await vi.advanceTimersByTimeAsync(40_000); // healthy for a while
    FakeSocket.last.drop();
    expect(c.transport).toBe("poll");

    // 1st retry after ~1 s.
    await vi.advanceTimersByTimeAsync(900);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.last.fail(); // still down
    // 2nd after ~2 s, 3rd after ~4 s.
    await vi.advanceTimersByTimeAsync(1_900);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.last.fail();
    await vi.advanceTimersByTimeAsync(3_900);
    expect(FakeSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.instances).toHaveLength(4);

    // Back: one `hello` brings the client to the revision it missed.
    FakeSocket.last.open();
    FakeSocket.last.message(await pushMessage(makeBundle(7), { t: "hello" }));
    await vi.advanceTimersByTimeAsync(10);
    expect(c.revision).toBe(7);
    expect(c.transport).toBe("live");
  });

  it("jitter spreads reconnects over 0.5×–1.5× of the backoff step, capped at 5 minutes", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, streaming: true });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.mode = "refuse";
    FakeSocket.last.fail();
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeSocket.instances).toHaveLength(2); // 1 s × 0.5
    random.mockReturnValue(0.999);
    // Many failures later the wait never exceeds 5 min × 1.5.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const n = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(7.5 * 60_000 + 1_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(n);
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(n + 2);
    c.close();
    const after = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(FakeSocket.instances.length).toBe(after); // close() stops reconnecting
  });

  it("falls back to SSE + polling when the socket cannot be established (503 / no upgrade), and returns to live when it can", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    FakeSocket.mode = "refuse";
    let current = makeBundle(3);
    const edge = mockEdge();
    edge.replies.bundle = conditional(() => current, edge.calls);
    edge.replies.stream = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const c = client({ fetch: edge.fetch, pollIntervalMs: 30_000, livePollIntervalMs: 300_000 });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.last.closed).toBe(true);
    // The fallback is in place: SSE is open and polling runs at its normal interval.
    expect(edge.count("/v1/stream")).toBe(1);
    expect(c.transport).toBe("stream");
    current = makeBundle(4);
    const polls = edge.count("/v1/bundle");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(edge.count("/v1/bundle")).toBeGreaterThan(polls);
    expect(c.revision).toBe(4);

    // The edge has capacity again: the next attempt opens, SSE is closed, the poll slows down to the safety interval.
    FakeSocket.mode = "open";
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeSocket.last.closed).toBe(false);
    expect(c.transport).toBe("live");
    const streams = edge.count("/v1/stream");
    const before = edge.count("/v1/bundle");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Two safety polls in ten minutes instead of twenty polls at the 30 s interval, and SSE stays closed.
    expect(edge.count("/v1/bundle") - before).toBe(2);
    expect(edge.count("/v1/stream")).toBe(streams);
  });

  it("falls back when there is no WebSocket in the runtime or the constructor throws", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)), stream: () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }) });
    const none = client({ fetch: edge.fetch, webSocket: undefined }); // the test setup removed the global
    await none.ready();
    await settle();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(edge.count("/v1/stream")).toBe(1);
    expect(none.transport).toBe("stream");

    FakeSocket.mode = "throw";
    const throwing = client({ fetch: edge.fetch });
    await throwing.ready();
    await settle();
    expect(edge.count("/v1/stream")).toBe(2);
    expect(throwing.transport).toBe("stream");
    expect(throwing.revision).toBe(3);
  });

  it("a connection that never opens is abandoned after 10 s", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)), stream: () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }) });
    const c = client({ fetch: edge.fetch });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(FakeSocket.last.closed).toBe(false);
    expect(edge.count("/v1/stream")).toBe(0);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeSocket.last.closed).toBe(true);
    expect(edge.count("/v1/stream")).toBe(1);
  });

  it("pings every ~30 s; a socket that stops answering is replaced", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.last;
    ws.open();
    await vi.advanceTimersByTimeAsync(95_000);
    expect(ws.sent).toEqual(["ping", "ping", "ping"]);
    expect(ws.closed).toBe(false);
    ws.autoPong = false; // the connection is dead but nobody told us
    await vi.advanceTimersByTimeAsync(30_000 + 10_000 + 100);
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("replaces a healthy socket after ~50 minutes so the edge validates the key again", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)), stream: () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }) });
    const c = client({ fetch: edge.fetch });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.last;
    first.open();
    await vi.advanceTimersByTimeAsync(49 * 60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2); // immediately, without backoff
    expect(edge.count("/v1/stream")).toBe(0); // and without falling back in between
  });

  it("a revoked key (401 on the safety poll) drops the socket", async () => {
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    await tick();
    const ws = FakeSocket.last;
    ws.open();
    edge.replies.bundle = new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
    const errors: NanoFlagsError[] = [];
    c.on("error", (e) => errors.push(e as NanoFlagsError));
    await c.refresh();
    expect(errors[0]!.code).toBe("unauthorized");
    expect(ws.closed).toBe(true);
    expect(c.transport).toBe("poll");
  });

  it("close() closes the socket and nothing reconnects", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last.open();
    c.close();
    expect(FakeSocket.last.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(c.boolean("checkout-v2", false, { key: "u", signedIn: true, region: "US" })).toBe(true);
  });
});

describe("idle service report", () => {
  it("with nothing queued the report goes out every 60 s; queued events still flush on the flush interval", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, service: "checkout-api", streaming: false, events: { sampleRate: 1, flushIntervalMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    // The first report goes out on the first interval, so the dashboard learns about the service quickly.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edge.count("/v1/events")).toBe(1);
    // Idle for five minutes: one report per minute instead of thirty requests.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(edge.count("/v1/events")).toBe(6);
    expect(edge.last("/v1/events")!.body).toMatchObject({ service: "checkout-api", revision: 3, events: [] });

    // An evaluation is flushed at the next flush interval, not a minute later.
    c.boolean("checkout-v2", false, { key: "u1" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edge.count("/v1/events")).toBe(7);
    expect((edge.last("/v1/events")!.body as { events: unknown[] }).events).toHaveLength(1);
    // And the idle clock restarts from that request.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(edge.count("/v1/events")).toBe(7);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(edge.count("/v1/events")).toBe(8);
  });

  it("`events.reportIntervalMs` is configurable", async () => {
    vi.useFakeTimers();
    const edge = mockEdge({ bundle: bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, streaming: false, events: { flushIntervalMs: 10_000, reportIntervalMs: 20_000 } });
    await vi.advanceTimersByTimeAsync(0);
    await c.ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edge.count("/v1/events")).toBe(3); // 10 s, 30 s, 50 s
  });
});
