import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type NanoFlagsClient, type NanoFlagsError } from "../src/index";
import { rawMember } from "../src/verify";
import { BASE, SERVER_KEY, bundleResponse, makeBundle, memoryStore, tick } from "./helpers";
import { makeSigner, mockRoutes, signedResponse, type Signer } from "./v2helpers";

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, ...opts });
  clients.push(c);
  return c;
}
function errorsOf(c: NanoFlagsClient) {
  const errors: NanoFlagsError[] = [];
  c.on("error", (e) => errors.push(e as NanoFlagsError));
  return errors;
}

let signer: Signer;
let other: Signer;
beforeAll(async () => {
  signer = await makeSigner("k1");
  other = await makeSigner("k2");
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
});

describe("signature verification", () => {
  it("a correctly signed bundle is adopted", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk] } });
    const errors = errorsOf(c);
    await c.ready();
    expect(c.status).toBe("ready");
    expect(c.revision).toBe(3);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
    expect(errors).toEqual([]);
    expect(edge.count("/v1/keys")).toBe(0);
  });

  it("without `verify` nothing changes: signature headers are ignored", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3), { tamper: (b) => b.replace("relevance-v3", "tampered") }) });
    const c = client({ fetch: edge.fetch });
    await c.ready();
    expect(c.string("search-ranking", "fb")).toBe("tampered");
  });

  it("a tampered update is rejected: previous bundle kept, error emitted, status unchanged", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk] } });
    const errors = errorsOf(c);
    const updates: number[] = [];
    c.on("update", (e) => updates.push(e.revision));
    await c.ready();
    const versionBefore = c.version;

    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4), { tamper: (b) => b.replace("relevance-v4", "attacker-value") });
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(c.status).toBe("ready");
    expect(c.version).toBe(versionBefore);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3");
    expect(updates).toEqual([3]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: "NanoFlagsError", code: "signature" });

    // The next honest revision is accepted again.
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(5));
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(c.status).toBe("ready");
  });

  it("a bad signature on the very first load leaves the client not-ready", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(other, makeBundle(3), { kid: "k1" }) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk] } });
    const errors = errorsOf(c);
    await c.ready();
    expect(c.status).toBe("not-ready");
    expect(c.revision).toBeNull();
    expect(c.boolean("checkout-v2", false, { key: "u", signedIn: true, region: "US" })).toBe(false);
    expect(errors[0]).toMatchObject({ code: "signature" });
  });

  it("rejects: changed revision, changed checksum, malformed signature, unknown key id, missing headers", async () => {
    const good = await signedResponse(signer, makeBundle(3));
    const withHeader = (name: string, value: string | null) => {
      const headers = new Headers(good.headers);
      if (value === null) headers.delete(name);
      else headers.set(name, value);
      return good.clone().text().then((t) => new Response(t, { status: 200, headers }));
    };
    const cases: Response[] = [
      await signedResponse(signer, makeBundle(3), { tamper: (b) => b.replace('"checksum":"c3"', '"checksum":"c9"') }),
      await signedResponse(signer, makeBundle(3), { tamper: (b) => b.replace('{"revision":3,', '{"revision":4,') }),
      await withHeader("X-NanoFlags-Signature", "not base64url!"),
      await withHeader("X-NanoFlags-Signature", "AAAA"),
      await withHeader("X-NanoFlags-Key-Id", "k-unknown"),
      await withHeader("X-NanoFlags-Signature", null),
      await withHeader("X-NanoFlags-Environment-Id", null),
      await withHeader("X-NanoFlags-Environment-Id", "another-environment"),
    ];
    for (const response of cases) {
      const edge = mockRoutes({ "/v1/bundle": response });
      const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk] } });
      const errors = errorsOf(c);
      await c.ready();
      expect(c.status).toBe("not-ready");
      expect(errors[0]).toMatchObject({ code: "signature" });
    }
  });

  it("unsigned bundles: accepted by default, rejected with require", async () => {
    const unsigned = await signedResponse(signer, makeBundle(3), { signed: false });
    const lenient = client({ fetch: mockRoutes({ "/v1/bundle": unsigned }).fetch, verify: { publicKeys: [signer.publicJwk] } });
    await lenient.ready();
    expect(lenient.status).toBe("ready");
    expect(lenient.revision).toBe(3);

    // A response without any signature header counts as unsigned too.
    const strictEdge = mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(3)) });
    const strict = client({ fetch: strictEdge.fetch, verify: { publicKeys: [signer.publicJwk], require: true } });
    const errors = errorsOf(strict);
    await strict.ready();
    expect(strict.status).toBe("not-ready");
    expect(errors[0]).toMatchObject({ code: "signature" });

    // Publisher lag: a signed r3 is in use, the edge then serves r4 unsigned → r3 stays, status unchanged.
    strictEdge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(3));
    await strict.refresh();
    expect(strict.revision).toBe(3);
    strictEdge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4), { signed: false });
    await strict.refresh();
    expect(strict.revision).toBe(3);
    expect(strict.status).toBe("ready");
    expect(errors.at(-1)).toMatchObject({ code: "signature" });
  });

  it("'fetch' loads the keys once from /v1/keys, without sending the SDK key", async () => {
    const edge = mockRoutes({
      "/v1/bundle": await signedResponse(signer, makeBundle(3)),
      "/v1/keys": new Response(JSON.stringify({ keys: [signer.publicJwk] }), { status: 200 }),
    });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: "fetch" } });
    await c.ready();
    expect(c.revision).toBe(3);
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(4));
    await c.refresh();
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(5));
    await c.refresh();
    expect(c.revision).toBe(5);
    expect(edge.count("/v1/keys")).toBe(1);
    expect(edge.last("/v1/keys")!.headers.get("Authorization")).toBeNull();
    expect(edge.last("/v1/keys")!.url).not.toContain(SERVER_KEY);
  });

  it("'fetch': when the keys cannot be loaded the bundle is rejected, and loading is retried later", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)), "/v1/keys": new Response("{}", { status: 503 }) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: "fetch" } });
    const errors = errorsOf(c);
    await c.ready();
    expect(c.status).toBe("not-ready");
    expect(errors[0]).toMatchObject({ code: "signature" });
    edge.routes["/v1/keys"] = new Response(JSON.stringify({ keys: [signer.publicJwk] }), { status: 200 });
    await c.refresh();
    expect(c.status).toBe("ready");
    expect(edge.count("/v1/keys")).toBe(2);
  });

  it("a bundle signed for another environment is rejected once an environment is known", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk] } });
    const errors = errorsOf(c);
    await c.ready();
    // Validly signed — but for a different environment (a replay from elsewhere).
    edge.routes["/v1/bundle"] = await signedResponse(signer, makeBundle(9), { environmentId: "11111111-0000-4000-8000-000000000002" });
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(errors[0]).toMatchObject({ code: "signature" });
  });

  it("verifies the bundle text byte-for-byte, even when it is not canonical JSON.stringify output", async () => {
    const bundle = makeBundle(3);
    const pretty = JSON.stringify(bundle, null, 2);
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, bundle, { bundleText: pretty }) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk], require: true } });
    await c.ready();
    expect(c.status).toBe("ready");
    expect(c.number("max-items", 0)).toBe(20);
  });

  it("several keys: the key id selects the right one (rotation)", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(other, makeBundle(3)) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [signer.publicJwk, other.publicJwk], require: true } });
    await c.ready();
    expect(c.status).toBe("ready");
  });

  it("private keys are refused: a JWK with `d` is ignored and reported", async () => {
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(3)) });
    const c = client({ fetch: edge.fetch, verify: { publicKeys: [{ ...signer.privateJwk, kid: "k1" } as JsonWebKey] } });
    const errors = errorsOf(c);
    await c.ready();
    await tick();
    expect(c.status).toBe("not-ready");
    expect(errors.map((e) => e.code).sort()).toEqual(["config", "signature"]);
  });

  it("the persisted copy is verified again on restore; a modified copy is ignored", async () => {
    const store = memoryStore();
    const online = mockRoutes({ "/v1/bundle": await signedResponse(signer, makeBundle(4)) });
    await client({ fetch: online.fetch, store, verify: { publicKeys: [signer.publicJwk], require: true } }).ready();
    await tick();
    expect(store.peek()).toContain('"sig"');
    expect(store.peek()).not.toContain(SERVER_KEY);

    const offline = client({ fetch: mockRoutes({ "/v1/bundle": new Error("offline") }).fetch, store, verify: { publicKeys: [signer.publicJwk], require: true } });
    await offline.ready();
    expect(offline.status).toBe("stale");
    expect(offline.revision).toBe(4);

    const tampered = memoryStore(store.peek()!.replace("relevance-v4", "attacker-value"));
    const c = client({ fetch: mockRoutes({ "/v1/bundle": new Error("offline") }).fetch, store: tampered, verify: { publicKeys: [signer.publicJwk] } });
    const errors = errorsOf(c);
    await c.ready();
    expect(c.status).toBe("not-ready");
    expect(errors.map((e) => e.code)).toContain("signature");
  });

  it("with require, an unsigned persisted copy is not restored", async () => {
    const store = memoryStore();
    await client({ fetch: mockRoutes({ "/v1/bundle": bundleResponse(makeBundle(4)) }).fetch, store }).ready();
    await tick();
    const strict = client({ fetch: mockRoutes({ "/v1/bundle": new Error("offline") }).fetch, store, verify: { publicKeys: [signer.publicJwk], require: true } });
    await strict.ready();
    expect(strict.status).toBe("not-ready");
    const lenient = client({ fetch: mockRoutes({ "/v1/bundle": new Error("offline") }).fetch, store, verify: { publicKeys: [signer.publicJwk] } });
    await lenient.ready();
    expect(lenient.status).toBe("stale");
  });
});

describe("rawMember", () => {
  it("returns the exact source text of a top-level member", () => {
    expect(rawMember('{"revision":3,"bundle":{"a":[1,2,{"b":"}"}],"c":"x\\"y"},"z":1}', "bundle")).toBe('{"a":[1,2,{"b":"}"}],"c":"x\\"y"}');
    expect(rawMember(' { "bundle" : { "a" : 1 } , "x": null }', "bundle")).toBe('{ "a" : 1 }');
    expect(rawMember('{"a":{"bundle":1},"bundle":2}', "bundle")).toBe("2");
    expect(rawMember('{"bundle":1,"bundle":{"last":true}}', "bundle")).toBe('{"last":true}');
    expect(rawMember('{"a":"bundle\\":","b":1}', "bundle")).toBeNull();
    expect(rawMember("[1,2]", "bundle")).toBeNull();
    expect(rawMember('{"bundle":{"a":1}', "bundle")).toBeNull();
    expect(rawMember("", "bundle")).toBeNull();
  });
});
