/**
 * SDK 0.4: signatures are verified by default against the official edge, keys are selected by key id (one reload of
 * /v1/keys on an unknown id), bundles for a newer engine are refused, and a deleted environment (close code 4004)
 * stops the reconnect loop.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS, SUPPORTED_ENGINE_VERSION, type NanoFlagsClient, type NanoFlagsError, type WebSocketConstructor, type Bundle } from "../src/index";
import { canonicalString, sha256Hex } from "../src/verify";
import { BASE, SERVER_KEY, bundleResponse, makeBundle, tick } from "./helpers";
import { ENV_ID, makeSigner, mockRoutes, signedResponse, type Signer } from "./v2helpers";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.onopen?.({});
  }
  message(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code });
  }
}
const WS = FakeSocket as unknown as WebSocketConstructor;

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: OFFICIAL_EDGE_URL, streaming: false, pollIntervalMs: 0, events: false, store: false, ...opts });
  clients.push(c);
  return c;
}
function record<E>(c: NanoFlagsClient, event: "update" | "error") {
  const items: E[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  c.on(event as "error", (e) => {
    items.push(e as E);
    for (const w of waiters.splice(0)) (items.length >= w.n ? w.resolve() : waiters.push(w));
  });
  return { items, count: (n: number) => (items.length >= n ? Promise.resolve(items) : new Promise<E[]>((resolve) => waiters.push({ n, resolve: () => resolve(items) }))) };
}
const keysResponse = (...signers: Signer[]) => new Response(JSON.stringify({ keys: signers.map((s) => ({ ...s.publicJwk, alg: "EdDSA", use: "sig", status: "active" })) }), { status: 200 });

async function pushMessage(bundle: Bundle, signer: Signer | null, text = JSON.stringify(bundle)) {
  const checksum = `c${bundle.revision}`;
  const signature = signer ? await signer.sign(canonicalString(ENV_ID, bundle.revision, checksum, await sha256Hex(text))) : null;
  return { t: "rev", revision: bundle.revision, checksum, signature, kid: signer?.kid ?? null, environmentId: ENV_ID, bundle: text, committedAt: null, sentAt: Date.now() };
}

let rotated: Signer;
let impostor: Signer;
beforeAll(async () => {
  rotated = await makeSigner("k9"); // a key the edge started using after this SDK was built
  impostor = await makeSigner("k1"); // claims the production key id, but is not the production key
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  FakeSocket.instances = [];
  vi.restoreAllMocks();
});

describe("default verification against the official edge", () => {
  it("embeds the production key", () => {
    expect(OFFICIAL_SIGNING_KEYS).toEqual([{ kty: "OKP", crv: "Ed25519", x: "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", kid: "k1" }]);
  });

  it("a bundle signed by another key under the production key id is rejected (verification is on without any option)", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(impostor, makeBundle(3)), "/v1/keys": keysResponse(impostor) });
    const c = client({ fetch: edge.fetch });
    const errors = record<NanoFlagsError>(c, "error");
    await c.ready();
    expect(c.status).toBe("not-ready");
    expect(c.revision).toBeNull();
    expect(errors.items.map((e) => e.code)).toEqual(["signature"]);
    // The embedded key has that id: the edge's key list is not consulted for it.
    expect(edge.count("/v1/keys")).toBe(0);
  });

  it("an unknown key id loads /v1/keys once, and the bundle verifies against the fetched key", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(rotated, makeBundle(3)), "/v1/keys": keysResponse(rotated) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(3);
    expect(edge.count("/v1/keys")).toBe(1);
    // Cached: the next bundle signed with the same key needs no further request.
    edge.routes["/v1/bundle"] = await signedResponse(rotated, makeBundle(4));
    await c.refresh();
    expect(c.revision).toBe(4);
    expect(edge.count("/v1/keys")).toBe(1);
  });

  it("an unknown key id that /v1/keys does not list either is rejected; the reload is not repeated within a minute", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(rotated, makeBundle(3)), "/v1/keys": keysResponse() });
    const c = client({ fetch: edge.fetch });
    const errors = record<NanoFlagsError>(c, "error");
    await c.ready();
    await c.refresh();
    expect(c.revision).toBeNull();
    expect(errors.items.map((e) => e.code)).toEqual(["signature", "signature"]);
    expect(edge.count("/v1/keys")).toBe(1);
  });

  it("an unsigned fallback bundle is not applied: previous bundle kept, error emitted, fetched again later", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(rotated, makeBundle(3)), "/v1/keys": keysResponse(rotated) });
    const c = client({ fetch: edge.fetch });
    const errors = record<NanoFlagsError>(c, "error");
    await c.ready();
    expect(c.revision).toBe(3);
    edge.routes["/v1/bundle"] = bundleResponse(makeBundle(4)); // no signature headers at all
    await c.refresh();
    edge.routes["/v1/bundle"] = await signedResponse(rotated, makeBundle(4), { signed: false });
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(c.status).toBe("ready");
    expect(errors.items.map((e) => e.code)).toEqual(["signature", "signature"]);
    expect(errors.items[0]!.message).toContain("not signed");
    // Once signed, it is applied.
    edge.routes["/v1/bundle"] = await signedResponse(rotated, makeBundle(4));
    await c.refresh();
    expect(c.revision).toBe(4);
  });

  it("`verify.require: false` accepts the unsigned fallback; `verify: false` turns verification off", async () => {
    const tampered = await signedResponse(impostor, makeBundle(5));
    let edge = mockRoutes({ "/v1/bundle": await signedResponse(rotated, makeBundle(3), { signed: false }), "/v1/keys": keysResponse(rotated) });
    let c = client({ fetch: edge.fetch, verify: { require: false } });
    await c.ready();
    expect(c.revision).toBe(3);
    edge = mockRoutes({ "/v1/bundle": tampered });
    c = client({ fetch: edge.fetch, verify: false });
    await c.ready();
    expect(c.revision).toBe(5);
  });

  it("a custom baseUrl keeps the 0.3 behaviour: nothing is verified unless configured", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(impostor, makeBundle(3)) });
    const c = client({ fetch: edge.fetch, baseUrl: BASE });
    await c.ready();
    expect(c.revision).toBe(3);
    const unsigned = mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(4)) });
    const d = client({ fetch: unsigned.fetch, baseUrl: BASE, verify: { publicKeys: [rotated.publicJwk] } });
    await d.ready();
    expect(d.revision).toBe(4); // require defaults to false off the official edge
  });

  it("pushed bundles: unsigned or wrongly signed pushes are rejected, a correctly signed one is applied", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(rotated, makeBundle(3)), "/v1/keys": keysResponse(rotated) });
    const c = client({ fetch: edge.fetch, streaming: true, webSocket: WS });
    const errors = record<NanoFlagsError>(c, "error");
    const updates = record<{ revision: number; transport: string }>(c, "update");
    await c.ready();
    await tick();
    const ws = FakeSocket.instances.at(-1)!;
    expect(ws.url).toBe("wss://edge.nanoflags.io/v1/live");
    ws.open();
    ws.message(await pushMessage(makeBundle(4), null));
    await errors.count(1);
    ws.message(await pushMessage(makeBundle(4), impostor));
    await errors.count(2);
    expect(c.revision).toBe(3);
    ws.message(await pushMessage(makeBundle(5), rotated));
    await updates.count(2);
    expect(c.revision).toBe(5);
    expect(updates.items.at(-1)).toMatchObject({ revision: 5, transport: "live" });
  });
});

describe("engine version", () => {
  const withEngine = (b: Bundle, engine: unknown) => ({ ...b, engine }) as Bundle;

  it("bundles without `engine` or with a supported one are applied; a newer one is refused without changing anything", async () => {
    const edge = mockRoutes({ "/v1/bundle": bundleResponse(withEngine(makeBundle(3), SUPPORTED_ENGINE_VERSION)) });
    const c = client({ fetch: edge.fetch, baseUrl: BASE });
    const errors = record<NanoFlagsError>(c, "error");
    await c.ready();
    expect(c.revision).toBe(3);
    const version = c.version;
    edge.routes["/v1/bundle"] = bundleResponse(withEngine(makeBundle(4), SUPPORTED_ENGINE_VERSION + 1));
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(c.status).toBe("ready");
    expect(c.version).toBe(version);
    expect(errors.items.map((e) => e.code)).toEqual(["engine"]);
    expect(errors.items[0]!.message).toContain("Upgrade @nanoflags/sdk");
    edge.routes["/v1/bundle"] = bundleResponse(makeBundle(5)); // no field: as before
    await c.refresh();
    expect(c.revision).toBe(5);
  });

  it("a pushed bundle for a newer engine is refused; a signed one with a supported engine is applied", async () => {
    const edge = mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(3)) });
    const c = client({ fetch: edge.fetch, baseUrl: BASE, streaming: true, webSocket: WS });
    const errors = record<NanoFlagsError>(c, "error");
    const updates = record<{ revision: number }>(c, "update");
    await c.ready();
    await tick();
    const ws = FakeSocket.instances.at(-1)!;
    ws.open();
    ws.message(await pushMessage(withEngine(makeBundle(4), 99), null));
    await errors.count(1);
    expect(errors.items[0]!.code).toBe("engine");
    expect(c.revision).toBe(3);
    ws.message(await pushMessage(withEngine(makeBundle(5), 1), null));
    await updates.count(2);
    expect(c.revision).toBe(5);
  });

  it("a bootstrap bundle for a newer engine is ignored with an error", async () => {
    const edge = mockRoutes({ "/v1/bundle": new Error("offline") });
    const c = client({ fetch: edge.fetch, baseUrl: BASE, bootstrap: withEngine(makeBundle(2), 7) });
    const errors = record<NanoFlagsError>(c, "error");
    await errors.count(1);
    expect(errors.items[0]!.code).toBe("engine");
    expect(c.revision).toBeNull();
  });
});

describe("environment deleted (close code 4004)", () => {
  it("stops reconnecting, keeps the last bundle as stale and reports environment_deleted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const edge = mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(3)) });
      const c = client({ fetch: edge.fetch, baseUrl: BASE, streaming: true, webSocket: WS });
      const errors = record<NanoFlagsError>(c, "error");
      await c.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeSocket.instances).toHaveLength(1);
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.drop(4004);
      expect(c.status).toBe("stale");
      expect(c.revision).toBe(3);
      expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
      expect(errors.items.map((e) => e.code)).toEqual(["environment_deleted"]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(FakeSocket.instances).toHaveLength(1); // no reconnect
      expect(edge.count("/v1/stream")).toBe(0); // no SSE fallback either
    } finally {
      vi.useRealTimers();
    }
  });

  it("other close codes still reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const edge = mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(3)) });
      const c = client({ fetch: edge.fetch, baseUrl: BASE, streaming: true, webSocket: WS });
      await c.ready();
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.drop(1006);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeSocket.instances.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
