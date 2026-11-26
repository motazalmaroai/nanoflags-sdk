/** Verification hardening: rollback protection, status after a rejected update, the official edge address. */
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_EDGE_URL, createClient, memoryStorage, type NanoFlagsError, type ReactNativeClient, type ReactNativeClientOptions } from "../src/index";
import { BASE, CLIENT_KEY, FakeEdge, FakeSocket, makeBundle, makeSigner, waitFor } from "./helpers";

const clients: ReactNativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  FakeSocket.reset();
});

async function setup(rev: number, opts: Partial<ReactNativeClientOptions> = {}, edgeIn?: FakeEdge) {
  const edge = edgeIn ?? new FakeEdge(await makeSigner(), makeBundle(rev));
  const errors: NanoFlagsError[] = [];
  const revisions: number[] = [];
  const client = createClient({ sdkKey: CLIENT_KEY, baseUrl: BASE, appState: null, verify: { publicKeys: [edge.signer.publicJwk], require: true }, fetch: edge.fetch, streaming: false, pollIntervalMs: 0, events: false, ...opts });
  client.on("error", (e) => errors.push(e as NanoFlagsError));
  client.on("update", (u) => revisions.push(u.revision));
  clients.push(client);
  await client.ready();
  return { client, edge, errors, revisions };
}

describe("rollback protection", () => {
  it("a validly signed older revision is refused as `rollback`, the config stays, the client turns stale", async () => {
    const { client, edge, errors, revisions } = await setup(5);
    expect(client.revision).toBe(5);
    edge.bundle = makeBundle(4);
    await client.refresh();
    expect(client.revision).toBe(5);
    expect(client.string("accent", "")).toBe("blue-r5");
    expect(errors.map((e) => e.code)).toEqual(["rollback"]);
    expect(client.status).toBe("stale");
    // The edge confirms the current revision: ready again; newer revisions are adopted as usual.
    edge.bundle = makeBundle(5);
    await client.refresh();
    expect(client.status).toBe("ready");
    edge.bundle = makeBundle(6);
    await client.refresh();
    expect(client.revision).toBe(6);
    expect(revisions).toEqual([5, 6]);
  });

  it("stripping the signature does not get around it (`require: false`)", async () => {
    const signedEdge = new FakeEdge(await makeSigner(), makeBundle(5));
    const { client, edge, errors } = await setup(5, { verify: { publicKeys: [signedEdge.signer.publicJwk], require: false } }, signedEdge);
    edge.signed = false;
    edge.bundle = makeBundle(4);
    await client.refresh();
    expect(client.revision).toBe(5);
    expect(errors.map((e) => e.code)).toContain("rollback");
  });

  it("an older copy the edge marks as stale is refused silently: stale, no error", async () => {
    const { client, edge, errors } = await setup(5);
    edge.bundle = makeBundle(4);
    edge.bundleHeaders["X-NanoFlags-Stale"] = "true";
    await client.refresh();
    expect(client.revision).toBe(5);
    expect(client.status).toBe("stale");
    expect(errors).toEqual([]);
  });

  it("a bootstrap is not a verified revision: it never blocks an update", async () => {
    const { client, errors } = await setup(5, { bootstrap: makeBundle(9) });
    await client.refresh();
    expect(client.revision).toBe(5);
    expect(errors).toEqual([]);
  });

  it("after a restart the persisted verified revision is the floor", async () => {
    const storage = memoryStorage();
    const first = await setup(5, { storage });
    await waitFor(() => storage.entries.size > 0, 2000, "persisted copy");
    first.client.close();
    const older = new FakeEdge(first.edge.signer, makeBundle(4));
    const { client, errors, revisions } = await setup(4, { storage }, older);
    await waitFor(() => errors.some((e) => e.code === "rollback"), 3000, "rollback error");
    expect(client.revision).toBe(5);
    expect(revisions).toEqual([5]);
    expect(client.status).toBe("stale");
  });

  it("a pushed older revision is refused as `rollback`; the request path then confirms the current one", async () => {
    const { client, edge, errors } = await setup(5, { streaming: true, webSocket: FakeSocket as never });
    await waitFor(() => client.transport === "live", 1000, "live");
    edge.bundle = makeBundle(6);
    FakeSocket.last!.message(await edge.push(makeBundle(6)));
    await waitFor(() => client.revision === 6, 2000, "r6");
    FakeSocket.last!.message(await edge.push(makeBundle(5), "hello"));
    await waitFor(() => errors.some((e) => e.code === "rollback"), 2000, "rollback error");
    expect(client.revision).toBe(6);
  });
});

describe("status after a rejected update", () => {
  it("a tampered update leaves the config in use but the client stale, until a bundle verifies", async () => {
    const { client, edge, errors } = await setup(3);
    edge.bundle = makeBundle(4);
    edge.tamper = (b) => b.replace("blue-r4", "attacker");
    await client.refresh();
    expect(client.revision).toBe(3);
    expect(client.status).toBe("stale");
    expect(errors.map((e) => e.code)).toEqual(["signature"]);
    edge.tamper = null;
    await client.refresh();
    expect(client.revision).toBe(4);
    expect(client.status).toBe("ready");
  });

  it("the edge's own unsigned marker (publisher still signing) is an error only: status unchanged", async () => {
    const { client, edge, errors } = await setup(3);
    edge.bundle = makeBundle(4);
    edge.signed = false;
    await client.refresh();
    expect(client.status).toBe("ready");
    expect(errors.map((e) => e.code)).toEqual(["signature"]);
  });
});

describe("the official edge address", () => {
  it.each(["https://edge.nanoflags.io", "https://edge.nanoflags.io/", "https://EDGE.nanoflags.io:443", "https://edge.nanoflags.io./", "https://edge.nanoflags.io///"])("%s verifies like the canonical spelling", async (baseUrl) => {
    const seen: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ revision: 1, checksum: "c1", bundle: makeBundle(1) }), { headers: { "X-NanoFlags-Signed": "false" } });
    }) as unknown as typeof globalThis.fetch;
    const errors: NanoFlagsError[] = [];
    const client = createClient({ sdkKey: CLIENT_KEY, baseUrl, fetch, appState: null, streaming: false, pollIntervalMs: 0, events: false });
    clients.push(client);
    client.on("error", (e) => errors.push(e as NanoFlagsError));
    await client.ready();
    expect(seen[0]).toBe(`${OFFICIAL_EDGE_URL}/v1/bundle`);
    expect(client.revision).toBeNull();
    expect(errors.some((e) => e.code === "signature")).toBe(true);
  });

  it.each(["http://edge.nanoflags.io", "https://edge.nanoflags.io.example.com", "https://edge.nanoflags.io:8443", "https://edge.nanoflags.io/v1", "https://user@edge.nanoflags.io", "https://edge.nanoflags.io?x=1", "https://other.test"])("%s is not the official edge: unverified default", async (baseUrl) => {
    const fetch = (async () => new Response(JSON.stringify({ revision: 1, checksum: "c1", bundle: makeBundle(1) }), { headers: { "X-NanoFlags-Signed": "false" } })) as unknown as typeof globalThis.fetch;
    const client = createClient({ sdkKey: CLIENT_KEY, baseUrl, fetch, appState: null, streaming: false, pollIntervalMs: 0, events: false });
    clients.push(client);
    await client.ready();
    expect(client.revision).toBe(1);
  });
});
