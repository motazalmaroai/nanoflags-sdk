/**
 * Rollback / replay protection (K1) and the status after a rejected update (K2).
 *
 * Revisions only grow per environment: every publish (including a kill switch, a guarded-rollout step and restoring an
 * old revision, which copies it into the draft and publishes it as a new one) is `published_revision + 1`. So with
 * `verify`, a bundle older than one this client already verified is a replayed or stale response and is never adopted.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type Bundle, type NanoFlagsClient, type NanoFlagsError, type StateEvent, type UpdateEvent } from "../src/index";
import { BASE, SERVER_KEY, bundleResponse, makeBundle, memoryStore, tick } from "./helpers";
import { makeSigner, mockRoutes, signedResponse, type Signer } from "./v2helpers";

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, store: false, verify: { publicKeys: [signer.publicJwk], require: true }, ...opts });
  clients.push(c);
  const errors: NanoFlagsError[] = [];
  const updates: UpdateEvent[] = [];
  const states: StateEvent[] = [];
  c.on("error", (e) => errors.push(e as NanoFlagsError));
  c.on("update", (e) => updates.push(e));
  c.on("state", (e) => states.push(e));
  return Object.assign(c, { errors, updates, states, codes: () => errors.map((e) => e.code) });
}
async function until(pred: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let signer: Signer;
beforeAll(async () => {
  signer = await makeSigner("k1");
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
});

describe("K1: an older revision than one already verified is never adopted", () => {
  it("fetch: a validly signed older revision (no stale marker) is refused, reported as `rollback`, the client turns stale", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.revision).toBe(5);

    // A replayed (or wrongly cached) answer for r4 — genuinely signed, so signature verification alone accepts it.
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4));
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v5");
    expect(c.updates.map((u) => u.revision)).toEqual([5]);
    expect(c.codes()).toEqual(["rollback"]);
    expect(c.errors[0]!.errorCode).toBe("BUNDLE_REJECTED");
    expect(c.errors[0]!.message).toMatch(/older than r5/);
    expect(c.status).toBe("stale");
    expect(c.lastError).toMatchObject({ code: "BUNDLE_REJECTED", reason: "rollback" });

    // The edge answers the current revision again: ready, lastError cleared; newer revisions are adopted as usual.
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(5));
    await c.refresh();
    expect(c.status).toBe("ready");
    expect(c.lastError).toBeNull();
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(6));
    await c.refresh();
    expect(c.revision).toBe(6);
    expect(c.states.map((s) => s.state)).toEqual(["ready", "stale", "ready"]);
  });

  it("poll: the scheduled poll refuses it too", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const c = client({ fetch: edge.fetch, pollIntervalMs: 250 });
    await c.ready();
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(3));
    await until(() => c.errors.length > 0);
    expect(c.revision).toBe(5);
    expect(c.codes()).toContain("rollback");
    expect(c.status).toBe("stale");
  });

  it("stripping the signature does not get around it (`require: false` accepts unsigned answers, but not older ones)", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk], require: false } });
    await c.ready();
    edge.routes["/v1/bundle"] = bundleResponse(makeBundle(4)); // unsigned
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(c.codes()).toEqual(["rollback"]);
    // An unsigned NEWER answer is still accepted with `require: false`, as before.
    edge.routes["/v1/bundle"] = bundleResponse(makeBundle(6));
    await c.refresh();
    expect(c.revision).toBe(6);
    expect(c.status).toBe("ready");
  });

  it("an older copy the edge marks as stale (its origin is down) is refused silently, as before: stale, no error", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    const stale = await signedResponse(signer, makeBundle(4));
    const headers = new Headers(stale.headers);
    headers.set("X-NanoFlags-Stale", "true");
    edge.routes["/v1/bundle"] = new Response(await stale.text(), { status: 200, headers });
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(c.status).toBe("stale");
    expect(c.errors).toEqual([]);
  });

  it("a restore in NanoFlags publishes a new, higher revision with the old content: adopted normally", async () => {
    const killed = makeBundle(7, { "checkout-v2": { type: "boolean", enabled: false, default: false, off: false, rules: [] } } as Partial<Bundle["flags"]>);
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, killed) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.boolean("checkout-v2", true, { email: "a@nanoflags.dev" })).toBe(false);
    // "Restore r5" = r5's configuration published as r8.
    const restored = { ...makeBundle(5), revision: 8 } as Bundle;
    edge.routes["/v1/bundle"] = await signedResponse(signer, restored);
    await c.refresh();
    expect(c.revision).toBe(8);
    expect(c.boolean("checkout-v2", false, { email: "a@nanoflags.dev" })).toBe(true);
    expect(c.status).toBe("ready");
    expect(c.errors).toEqual([]);
  });

  it("a bundle signed for another environment never moves the watermark (refused as `signature`, as before)", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(900), { environmentId: "6f0c7c1e-0000-4000-8000-00000000ffff" });
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(c.codes()).toEqual(["signature"]);
    // r6 of the client's own environment is still adopted: the foreign r900 was not counted.
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(6));
    await c.refresh();
    expect(c.revision).toBe(6);
  });

  it("unverified sources never block updates: a higher bootstrap, and clients without `verify`, keep today's behaviour", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const boot = client({ fetch: edge.fetch, bootstrap: makeBundle(9) });
    await boot.ready();
    await boot.refresh();
    expect(boot.revision).toBe(5); // the bootstrap is trusted as given but is not a verified revision
    expect(boot.errors).toEqual([]);

    const plain = mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(5)) });
    const off = client({ fetch: plain.fetch, verify: false });
    await off.ready();
    plain.routes["/v1/bundle"] = bundleResponse(makeBundle(4));
    await off.refresh();
    expect(off.revision).toBe(4); // without verification there is nothing to anchor a revision on
    expect(off.errors).toEqual([]);
  });
});

describe("K1: the store", () => {
  async function storedR5() {
    const store = memoryStore();
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(5)) });
    const first = client({ fetch: edge.fetch, store });
    await first.ready();
    await until(() => store.peek() !== null);
    first.close();
    return store;
  }

  it("after a restart, an older answer than the stored verified revision is refused", async () => {
    const store = await storedR5();
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(4)) });
    const c = client({ fetch: edge.fetch, store });
    await c.ready();
    await until(() => edge.count("/v1/bundle") > 0 && c.errors.length > 0);
    expect(c.revision).toBe(5);
    expect(c.updates.map((u) => [u.revision, u.source])).toEqual([[5, "store"]]);
    expect(c.codes()).toContain("rollback");
    expect(c.status).toBe("stale");
  });

  it("a network answer that arrives before the slow store was read is not adopted either", async () => {
    const saved = (await storedR5()).peek();
    const slowStore = { get: () => new Promise<string | null>((r) => setTimeout(() => r(saved), 150)), set: vi.fn(async () => undefined) };
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(4)) });
    const c = client({ fetch: edge.fetch, store: slowStore });
    await c.ready();
    await until(() => c.revision === 5 && c.errors.length > 0);
    expect(c.updates.map((u) => u.revision)).toEqual([5]); // r4 was never in use, not even briefly
    expect(c.codes()).toContain("rollback");
  });

  it("a stored copy older than the edge's revision is the normal case: replaced, no error", async () => {
    const store = await storedR5();
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(6)) });
    const c = client({ fetch: edge.fetch, store });
    await c.ready();
    await until(() => c.revision === 6);
    expect(c.status).toBe("ready");
    expect(c.errors).toEqual([]);
  });

  it("another SDK key (key rotation) does not read the old key's stored copy, so it is not bound by it", async () => {
    const store = await storedR5();
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(4)) });
    const c = client({ fetch: edge.fetch, store, sdkKey: "nf_srv_rotated_000000000000000000000000000000000000000000" });
    await c.ready();
    expect(c.revision).toBe(4);
    expect(c.errors).toEqual([]);
  });
});

describe("K2: status after a rejected update", () => {
  it("tampered update: stale with lastError BUNDLE_REJECTED / signature, a `state` event, until a bundle verifies", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4), { tamper: (b) => b.replace("relevance-v4", "attacker") });
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(c.status).toBe("stale");
    expect(c.state).toBe("stale");
    expect(c.lastError).toMatchObject({ code: "BUNDLE_REJECTED", reason: "signature" });
    expect(c.states.at(-1)).toMatchObject({ state: "stale", previous: "ready", error: { code: "BUNDLE_REJECTED" } });
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4));
    await c.refresh();
    expect(c.revision).toBe(4);
    expect(c.status).toBe("ready");
    expect(c.lastError).toBeNull();
  });

  it("the edge's unsigned answer while the publisher signs a new revision is not a reason for stale (error only)", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4), { signed: false });
    await c.refresh();
    expect(c.status).toBe("ready");
    expect(c.codes()).toEqual(["signature"]);
    expect(c.lastError).toMatchObject({ code: "BUNDLE_REJECTED", reason: "signature" });
  });

  it("first load rejected: no bundle, so `failed` (not stale)", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3), { tamper: (b) => b.replace("relevance-v3", "x") }) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.status).toBe("not-ready");
    expect(c.state).toBe("failed");
    expect(c.lastError?.code).toBe("BUNDLE_REJECTED");
  });
});
