/** App lifecycle (AppState), connectivity (NetInfo) and the persisted bundle (offline-first start, re-verified). */
import { afterEach, describe, expect, it } from "vitest";
import { createClient, memoryStorage, type NanoFlagsError, type ReactNativeClient, type ReactNativeClientOptions, type StorageAdapter } from "../src/index";
import { AppState } from "./react-native-shim";
import { BASE, CLIENT_KEY, FakeEdge, FakeSocket, fakeNetInfo, makeBundle, makeSigner, sleep, waitFor, type Signer } from "./helpers";

const clients: ReactNativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  FakeSocket.reset();
  AppState.reset();
});

function make(edge: FakeEdge, opts: Partial<ReactNativeClientOptions> = {}) {
  const errors: NanoFlagsError[] = [];
  const client = createClient({
    sdkKey: CLIENT_KEY,
    baseUrl: BASE,
    verify: { publicKeys: [edge.signer.publicJwk], require: true },
    fetch: edge.fetch,
    webSocket: FakeSocket as never,
    pollIntervalMs: 200,
    livePollIntervalMs: 200,
    events: false,
    ...opts,
  });
  client.on("error", (e) => errors.push(e as NanoFlagsError));
  clients.push(client);
  return { client, errors };
}

async function edgeWith(revision = 3, signer?: Signer) {
  return new FakeEdge(signer ?? (await makeSigner()), makeBundle(revision));
}

describe("AppState", () => {
  it("background: closes the live socket, stops polling and flushes telemetry; no reconnect while in the background", async () => {
    const edge = await edgeWith();
    const { client } = make(edge, { events: { sampleRate: 1, flushIntervalMs: 60_000 } });
    await client.ready();
    await waitFor(() => client.transport === "live", 1000, "live");
    client.boolean("new-checkout", false); // one queued telemetry event

    AppState.set("background");
    expect(FakeSocket.open).toHaveLength(0);
    expect(client.lifecycle).toMatchObject({ background: true, paused: true });
    await waitFor(() => edge.count("/v1/events") === 1, 1000, "flush on background");
    const bundles = edge.count("/v1/bundle");
    const sockets = FakeSocket.instances.length;
    await sleep(1700); // > poll interval and > first reconnect backoff
    expect(edge.count("/v1/bundle")).toBe(bundles);
    expect(FakeSocket.instances.length).toBe(sockets);
    // Evaluation keeps working from memory.
    expect(client.string("accent", "")).toBe("blue-r3");
  });

  it("foreground: revalidates right away (conditional request), adopts what changed and reopens the socket", async () => {
    const edge = await edgeWith();
    const { client } = make(edge);
    await client.ready();
    await waitFor(() => client.transport === "live");
    AppState.set("background");
    edge.bundle = makeBundle(8); // published while the app was in the background
    const bundles = edge.count("/v1/bundle");
    const sockets = FakeSocket.instances.length;

    AppState.set("active");
    expect(edge.count("/v1/bundle")).toBe(bundles + 1);
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c3-client"');
    await waitFor(() => client.revision === 8, 2000, "r8");
    expect(FakeSocket.instances.length).toBe(sockets + 1);
    await waitFor(() => client.transport === "live");
    expect(client.lifecycle.paused).toBe(false);
  });

  it("iOS 'inactive' (app switcher, call) does not pause", async () => {
    const edge = await edgeWith();
    const { client } = make(edge);
    await client.ready();
    await waitFor(() => client.transport === "live");
    AppState.set("inactive");
    expect(FakeSocket.open).toHaveLength(1);
    expect(client.lifecycle.paused).toBe(false);
  });

  it("started in the background (headless task): no network until the app comes to the foreground", async () => {
    AppState.currentState = "background";
    const edge = await edgeWith();
    const { client } = make(edge);
    await client.ready(); // resolves after the (empty) store was read
    expect(client.settled).toBe(true);
    expect(edge.calls).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(0);
    AppState.set("active");
    await waitFor(() => client.revision === 3, 2000, "first load");
    await waitFor(() => client.transport === "live");
  });

  it("pauseInBackground: false keeps the connection", async () => {
    const edge = await edgeWith();
    const { client } = make(edge, { pauseInBackground: false });
    await client.ready();
    await waitFor(() => client.transport === "live");
    AppState.set("background");
    expect(FakeSocket.open).toHaveLength(1);
  });

  it("close() removes the AppState listener", async () => {
    const edge = await edgeWith();
    const { client } = make(edge);
    expect(AppState.listenerCount).toBe(1);
    client.close();
    expect(AppState.listenerCount).toBe(0);
  });
});

describe("NetInfo", () => {
  it("offline pauses, back online revalidates", async () => {
    const edge = await edgeWith();
    const netInfo = fakeNetInfo();
    const { client } = make(edge, { netInfo });
    await client.ready();
    await waitFor(() => client.transport === "live");
    netInfo.emit({ isConnected: false, isInternetReachable: false, details: null });
    expect(FakeSocket.open).toHaveLength(0);
    expect(client.lifecycle).toMatchObject({ offline: true, paused: true });
    const bundles = edge.count("/v1/bundle");
    await sleep(500);
    expect(edge.count("/v1/bundle")).toBe(bundles);
    netInfo.emit({ isConnected: true, isInternetReachable: true, details: { isConnectionExpensive: false } });
    expect(edge.count("/v1/bundle")).toBe(bundles + 1);
    await waitFor(() => client.transport === "live");
  });

  it("data saver: on a metered connection no live socket, ETag polling only; unmetered brings the socket back", async () => {
    const edge = await edgeWith();
    const netInfo = fakeNetInfo();
    const { client } = make(edge, { netInfo });
    await client.ready();
    await waitFor(() => client.transport === "live");
    netInfo.emit({ isConnected: true, isInternetReachable: true, details: { isConnectionExpensive: true } });
    expect(FakeSocket.open).toHaveLength(0);
    expect(client.lifecycle).toMatchObject({ metered: true, realtime: false, paused: false });
    const polls = edge.count("/v1/bundle");
    await waitFor(() => edge.count("/v1/bundle") >= polls + 2, 2000, "polls");
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c3-client"');
    expect(FakeSocket.open).toHaveLength(0);
    netInfo.emit({ isConnected: true, isInternetReachable: true, details: { isConnectionExpensive: false } });
    await waitFor(() => client.transport === "live");
  });

  it("dataSaver: false keeps the socket on metered connections", async () => {
    const edge = await edgeWith();
    const netInfo = fakeNetInfo();
    const { client } = make(edge, { netInfo, dataSaver: false });
    await client.ready();
    await waitFor(() => client.transport === "live");
    netInfo.emit({ isConnected: true, details: { isConnectionExpensive: true } });
    expect(FakeSocket.open).toHaveLength(1);
  });
});

describe("persisted bundle", () => {
  async function persisted(signer: Signer, storage: ReturnType<typeof memoryStorage>, revision = 4) {
    const edge = await edgeWith(revision, signer);
    const { client } = make(edge, { storage, streaming: false, pollIntervalMs: 0 });
    await client.ready();
    await waitFor(() => storage.entries.size === 1, 1000, "persist");
    client.close();
  }

  it("offline start: the stored bundle is verified again and used (status stale until the edge confirms it)", async () => {
    const signer = await makeSigner();
    const storage = memoryStorage();
    await persisted(signer, storage, 4);
    const edge = await edgeWith(4, signer);
    edge.offline = true;
    const { client, errors } = make(edge, { storage });
    await client.ready();
    expect(client.revision).toBe(4);
    expect(client.status).toBe("stale");
    expect(client.string("accent", "")).toBe("blue-r4");
    expect(errors.filter((e) => e.code === "signature")).toEqual([]);
    edge.offline = false;
    await client.refresh();
    expect(client.status).toBe("ready");
  });

  it("a tampered stored bundle is refused", async () => {
    const signer = await makeSigner();
    const storage = memoryStorage();
    await persisted(signer, storage, 4);
    for (const [k, v] of storage.entries) storage.entries.set(k, v.replace('"blue-r4"', '"evil"'));
    const edge = await edgeWith(4, signer);
    edge.offline = true;
    const { client, errors } = make(edge, { storage });
    await client.ready();
    expect(client.revision).toBeNull();
    expect(client.string("accent", "fallback")).toBe("fallback");
    expect(errors.map((e) => e.code)).toContain("signature");
  });

  it("a stored bundle signed by a key that is not trusted is refused", async () => {
    const storage = memoryStorage();
    await persisted(await makeSigner(), storage, 4);
    const edge = await edgeWith(4, await makeSigner()); // different key pair, same kid
    edge.offline = true;
    const { client, errors } = make(edge, { storage });
    await client.ready();
    expect(client.revision).toBeNull();
    expect(errors.map((e) => e.code)).toContain("signature");
  });

  it("an unsigned stored bundle is ignored when signatures are required", async () => {
    const storage = memoryStorage();
    const signer = await makeSigner();
    await persisted(signer, storage, 4);
    for (const [k, v] of storage.entries) {
      const p = JSON.parse(v) as Record<string, unknown>;
      delete p.sig;
      storage.entries.set(k, JSON.stringify(p));
    }
    const edge = await edgeWith(4, signer);
    edge.offline = true;
    const { client } = make(edge, { storage });
    await client.ready();
    expect(client.revision).toBeNull();
  });

  it("a storage adapter that throws does not break the client", async () => {
    const storage: StorageAdapter = {
      getItem: () => {
        throw new Error("disk");
      },
      setItem: async () => {
        throw new Error("quota");
      },
    };
    const edge = await edgeWith();
    const { client, errors } = make(edge, { storage, streaming: false, pollIntervalMs: 0 });
    await client.ready();
    expect(client.revision).toBe(3);
    await waitFor(() => errors.filter((e) => e.code === "store").length >= 2, 1000, "store errors");
  });
});
