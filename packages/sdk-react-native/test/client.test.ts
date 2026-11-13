import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, NanoFlagsError, OFFICIAL_EDGE_URL, createClient, memoryStorage, type ReactNativeClient, type ReactNativeClientOptions } from "../src/index";
import { AppState } from "./react-native-shim";
import { BASE, CLIENT_KEY, FakeEdge, FakeSocket, SERVER_KEY, makeBundle, makeSigner, waitFor } from "./helpers";

const clients: ReactNativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  FakeSocket.reset();
  AppState.reset();
});

async function setup(opts: Partial<ReactNativeClientOptions> = {}, prepare?: (edge: FakeEdge) => void) {
  const signer = await makeSigner();
  const edge = new FakeEdge(signer, makeBundle(3));
  prepare?.(edge);
  const client = createClient({
    sdkKey: CLIENT_KEY,
    baseUrl: BASE,
    verify: { publicKeys: [signer.publicJwk], require: true },
    fetch: edge.fetch,
    streaming: false,
    pollIntervalMs: 0,
    events: false,
    ...opts,
  });
  clients.push(client);
  return { client, edge, signer };
}

describe("keys", () => {
  it("refuses server keys before any request", () => {
    let requests = 0;
    const fetch = (async () => {
      requests++;
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    expect(() => createClient({ sdkKey: SERVER_KEY, fetch })).toThrow(NanoFlagsError);
    expect(() => createClient({ sdkKey: SERVER_KEY, fetch })).toThrow(/must never ship in a mobile app/);
    expect(() => createClient({ sdkKey: "nf_ci_abc", fetch })).toThrow(/nf_pub_/);
    expect(() => createClient({ sdkKey: "" as string, fetch })).toThrow(/nf_pub_/);
    expect(requests).toBe(0);
  });
});

describe("evaluation", () => {
  it("evaluates locally with the identified context; identify() needs no request and notifies subscribers", async () => {
    const { client, edge } = await setup({ context: { key: "u1", plan: "free" } });
    await client.ready();
    expect(client.status).toBe("ready");
    expect(client.revision).toBe(3);
    const requests = edge.calls.length;
    let notified = 0;
    client.subscribe(() => notified++);

    expect(client.boolean("new-checkout", false)).toBe(false);
    client.identify({ key: "u1", plan: "vip" });
    expect(client.context).toEqual({ key: "u1", plan: "vip" });
    expect(client.boolean("new-checkout", false)).toBe(true);
    // A per-call context is merged over the identified one.
    expect(client.boolean("new-checkout", false, { plan: "free" })).toBe(false);
    expect(client.boolean("new-checkout", false, { email: "a@nanoflags.dev", plan: "free" })).toBe(true);
    expect(notified).toBe(1);
    expect(edge.calls.length).toBe(requests);
  });

  it("typed accessors, detail with reason, allFlags", async () => {
    const { client } = await setup({ context: { key: "u1", plan: "vip" } });
    await client.ready();
    expect(client.string("accent", "none")).toBe("blue-r3");
    expect(client.number("max-items", 1)).toBe(20);
    expect(client.json("layout", {})).toEqual({ columns: 2 });
    expect(client.number("accent", 7)).toBe(7); // type mismatch → fallback

    expect(client.detail("new-checkout", false)).toMatchObject({ value: true, reason: "rule_match", ruleId: "vip", ruleIndex: 1, revision: 3 });
    expect(client.detail("accent", "x")).toMatchObject({ value: "blue-r3", reason: "default" });
    expect(client.detail("accent", 7)).toMatchObject({ value: 7, reason: "error", error: expect.stringMatching(/does not match/) });
    expect(client.detail("missing", "fb")).toMatchObject({ value: "fb", reason: "flag_not_found" });

    expect(client.allFlags()).toEqual({ "new-checkout": true, accent: "blue-r3", "max-items": 20, layout: { columns: 2 } });
    expect(client.allFlags({ plan: "free" })["new-checkout"]).toBe(false);
  });

  it("returns fallbacks (never throws) before anything is loaded", async () => {
    const { client } = await setup({}, (edge) => (edge.offline = true));
    expect(client.boolean("new-checkout", true)).toBe(true);
    expect(client.allFlags()).toEqual({});
    await client.ready();
    expect(client.status).toBe("not-ready");
    expect(client.settled).toBe(true);
  });

  it("bootstrap is used until the network answers", async () => {
    const { client } = await setup({ bootstrap: makeBundle(1) });
    expect(client.status).toBe("ready");
    expect(client.string("accent", "")).toBe("blue-r1");
    await client.ready();
    await waitFor(() => client.revision === 3, 2000, "network bundle");
    expect(client.string("accent", "")).toBe("blue-r3");
  });
});

describe("defaults", () => {
  it("talks to the official edge, verifies against its embedded keys and refuses its unsigned fallback", async () => {
    const seen: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ revision: 1, checksum: "c1", bundle: makeBundle(1) }), { headers: { "X-NanoFlags-Signed": "false" } });
    }) as unknown as typeof globalThis.fetch;
    const errors: Error[] = [];
    const client = createClient({ sdkKey: CLIENT_KEY, fetch, appState: null, streaming: false, pollIntervalMs: 0, events: false });
    clients.push(client);
    client.on("error", (e) => errors.push(e));
    await client.ready();
    expect(seen[0]).toBe(`${OFFICIAL_EDGE_URL}/v1/bundle`);
    expect(client.status).toBe("not-ready");
    expect(errors.some((e) => (e as NanoFlagsError).code === "signature")).toBe(true);
  });

  it("sends the NanoFlags User-Agent on requests and on the live socket (key in the subprotocol list, not the URL)", async () => {
    const { client, edge } = await setup({ streaming: true, webSocket: FakeSocket as never });
    await client.ready();
    expect(edge.last("/v1/bundle")!.headers.get("User-Agent")).toBe(DEFAULT_USER_AGENT);
    expect(edge.last("/v1/bundle")!.headers.get("Authorization")).toBe(`Bearer ${CLIENT_KEY}`);
    await waitFor(() => FakeSocket.last, 1000, "socket");
    const ws = FakeSocket.last!;
    expect(ws.url).toBe("wss://edge.test/v1/live");
    expect(ws.protocols).toEqual(["nanoflags.v1", `key.${CLIENT_KEY}`]);
    expect(ws.options).toEqual({ headers: { "User-Agent": DEFAULT_USER_AGENT } });
    expect(DEFAULT_USER_AGENT).toBe("nanoflags-react-native/0.1.0");
  });

  it("persists only in memory unless a storage adapter is given", async () => {
    const storage = memoryStorage();
    const { client } = await setup({ storage });
    await client.ready();
    await waitFor(() => storage.entries.size === 1, 1000, "persist");
    const [key, value] = [...storage.entries][0]!;
    expect(key).toMatch(/^nanoflags:bundle:[0-9a-f]{8}$/);
    expect(JSON.parse(value)).toMatchObject({ v: 1, bundle: { revision: 3 }, sig: { kid: "k-test", revision: 3 } });
  });
});

describe("telemetry", () => {
  it("reports as react-native/<version> with attribute names and types only, never values", async () => {
    const { client, edge } = await setup({ events: { sampleRate: 1, flushIntervalMs: 60_000 }, context: { key: "user-42", plan: "vip", email: "x@example.com" } });
    await client.ready();
    client.boolean("new-checkout", false);
    await client.flush();
    const body = edge.last("/v1/events")!.body as { sdk: string; service: string; events: Array<{ context: Record<string, unknown>; flagKey: string }> };
    expect(body.sdk).toBe("react-native/0.1.0");
    expect(body.service).toBe("react-native");
    expect(body.events[0]!.flagKey).toBe("new-checkout");
    expect(body.events[0]!.context).toEqual({ email: "string", plan: "string" });
    expect(JSON.stringify(body)).not.toContain("user-42");
    expect(JSON.stringify(body)).not.toContain("x@example.com");
  });

  it("events: false opts out", async () => {
    const { client, edge } = await setup({ events: false });
    await client.ready();
    client.boolean("new-checkout", false);
    await client.flush();
    expect(edge.count("/v1/events")).toBe(0);
  });
});
