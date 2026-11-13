/** Signature verification without WebCrypto (Hermes): pure-JS SHA-256 + Ed25519, through the React Native client. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, nobleCrypto, type NanoFlagsError, type ReactNativeClient, type ReactNativeClientOptions } from "../src/index";
import { canonicalString } from "../../sdk/src/verify";
import { BASE, CLIENT_KEY, ENV_ID, FakeEdge, makeBundle, makeSigner, waitFor } from "./helpers";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const clients: ReactNativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  vi.unstubAllGlobals();
});

function make(edge: FakeEdge, opts: Partial<ReactNativeClientOptions> = {}) {
  const errors: NanoFlagsError[] = [];
  const client = createClient({ sdkKey: CLIENT_KEY, baseUrl: BASE, appState: null, fetch: edge.fetch, streaming: false, pollIntervalMs: 0, events: false, verify: { publicKeys: [edge.signer.publicJwk], require: true }, ...opts });
  client.on("error", (e) => errors.push(e as NanoFlagsError));
  clients.push(client);
  return { client, errors };
}

describe("nobleCrypto", () => {
  it("SHA-256 test vector", async () => {
    expect(toHex(await nobleCrypto.sha256(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("RFC 8032 Ed25519 test vector 1 (empty message)", async () => {
    const pub = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const sig = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    expect(await nobleCrypto.ed25519Verify(pub, sig, new Uint8Array())).toBe(true);
    const bad = sig.slice();
    bad[0]! ^= 1;
    expect(await nobleCrypto.ed25519Verify(pub, bad, new Uint8Array())).toBe(false);
    expect(await nobleCrypto.ed25519Verify(pub, sig, new Uint8Array([0]))).toBe(false);
    expect(await nobleCrypto.ed25519Verify(new Uint8Array(32).fill(255), sig, new Uint8Array())).toBe(false); // not a point: false, no throw
  });

  it("verifies what WebCrypto signs (the publisher's algorithm) over the canonical string", async () => {
    const signer = await makeSigner();
    const text = canonicalString(ENV_ID, 7, "c7", "ab".repeat(32));
    const sig = Buffer.from(await signer.sign(text), "base64url");
    const pub = Buffer.from(signer.publicJwk.x!, "base64url");
    expect(await nobleCrypto.ed25519Verify(pub, sig, new TextEncoder().encode(text))).toBe(true);
    expect(await nobleCrypto.ed25519Verify(pub, sig, new TextEncoder().encode(text + " "))).toBe(false);
  });
});

describe("client verification on a runtime without WebCrypto", () => {
  async function hermesLike(edge: FakeEdge) {
    // Sign everything up front with WebCrypto, then remove it: from here on the SDK only has the pure-JS crypto.
    const responses = new Map<string, Response>();
    responses.set("/v1/bundle", await edge.fetch(`${BASE}/v1/bundle`));
    responses.set("/v1/keys", await edge.fetch(`${BASE}/v1/keys`));
    edge.calls.length = 0;
    vi.stubGlobal("crypto", undefined);
    expect((globalThis as { crypto?: unknown }).crypto).toBeUndefined();
    return (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      edge.calls.push({ url: String(input), path, method: "GET", headers: new Headers(), body: undefined });
      return responses.get(path)?.clone() ?? new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("accepts a correctly signed bundle", async () => {
    const edge = new FakeEdge(await makeSigner(), makeBundle(5));
    const fetch = await hermesLike(edge);
    const { client, errors } = make(edge, { fetch });
    await client.ready();
    expect(errors).toEqual([]);
    expect(client.status).toBe("ready");
    expect(client.revision).toBe(5);
  });

  it("refuses a tampered bundle and keeps what it has", async () => {
    const edge = new FakeEdge(await makeSigner(), makeBundle(5));
    edge.tamper = (body) => body.replace('"blue-r5"', '"red-r5"');
    const fetch = await hermesLike(edge);
    const { client, errors } = make(edge, { fetch, bootstrap: makeBundle(2) });
    await waitFor(() => errors.length > 0, 2000, "rejection");
    expect(client.revision).toBe(2);
    expect(client.string("accent", "")).toBe("blue-r2");
    expect(errors.map((e) => e.code)).toContain("signature");
  });

  it("refuses unsigned bundles when signatures are required", async () => {
    const edge = new FakeEdge(await makeSigner(), makeBundle(5));
    edge.signed = false;
    const { client, errors } = make(edge);
    await client.ready();
    expect(client.status).toBe("not-ready");
    expect(errors[0]!.message).toMatch(/not signed/);
  });

  it("an unknown key id loads /v1/keys once (rate limited), then verifies with the fetched key", async () => {
    const pinned = await makeSigner("k1");
    const rotated = await makeSigner("k2");
    const edge = new FakeEdge(rotated, makeBundle(5));
    // Pinned keys do not include k2; `"fetch"`-style refresh is what the official edge configuration does.
    const { client, errors } = make(edge, { verify: { publicKeys: "fetch", require: true } });
    await client.ready();
    expect(errors).toEqual([]);
    expect(client.revision).toBe(5);
    expect(edge.count("/v1/keys")).toBe(1);
    expect(edge.last("/v1/keys")!.headers.get("Authorization")).toBeNull(); // public endpoint: key not sent

    // Another unknown kid within the minute: no second key request, the bundle is refused.
    const other = await makeSigner("k3");
    const edge2 = new FakeEdge(other, makeBundle(6));
    edge.kid = "k3";
    edge.bundle = makeBundle(6);
    (edge as { signer: unknown }).signer = edge2.signer;
    await client.refresh();
    expect(edge.count("/v1/keys")).toBe(1);
    expect(client.revision).toBe(5);
    expect(errors.map((e) => e.code)).toContain("signature");
    void pinned;
  });

  it("verification time with the pure-JS implementation stays small", async () => {
    const big = makeBundle(9, Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`flag-${i}`, { type: "string", enabled: true, clientExposed: true, default: "x".repeat(200), off: "o", rules: [] }])) as never);
    const edge = new FakeEdge(await makeSigner(), big);
    const fetch = await hermesLike(edge);
    const t0 = performance.now();
    const { client } = make(edge, { fetch });
    await client.ready();
    const ms = performance.now() - t0;
    expect(client.revision).toBe(9);
    await waitFor(() => client.status === "ready");
    // ~100 KB bundle: SHA-256 + one Ed25519 verification in pure JS (V8 here; Hermes is a few times slower).
    expect(ms).toBeLessThan(1500);
  });
});
