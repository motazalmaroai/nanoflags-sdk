/** Live socket (React Native WebSocket with headers), SSE over XMLHttpRequest, polling, close code 4004. */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT as DEFAULT_UA, createClient, xhrStreamOpener, type NanoFlagsError, type ReactNativeClient, type ReactNativeClientOptions, type UpdateEvent } from "../src/index";
import { BASE, CLIENT_KEY, FakeEdge, FakeSocket, makeBundle, makeSigner, waitFor } from "./helpers";

/** Scriptable XMLHttpRequest the way React Native implements it (partial `responseText` + `progress`). */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  responseText = "";
  status = 0;
  aborted = false;
  onprogress: ((e: unknown) => void) | null = null;
  onload: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  ontimeout: ((e: unknown) => void) | null = null;
  onabort: ((e: unknown) => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {}
  abort() {
    this.aborted = true;
    this.onabort?.({});
  }
  // --- test side
  chunk(text: string, status = 200) {
    this.status = status;
    this.responseText += text;
    this.onprogress?.({});
  }
  end(status = this.status || 200) {
    this.status = status;
    this.onload?.({});
  }
  static get last() {
    return FakeXhr.instances.at(-1);
  }
}

const clients: ReactNativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  FakeSocket.reset();
  FakeXhr.instances = [];
});

async function setup(opts: Partial<ReactNativeClientOptions> = {}) {
  const signer = await makeSigner();
  const edge = new FakeEdge(signer, makeBundle(3));
  const updates: UpdateEvent[] = [];
  const errors: NanoFlagsError[] = [];
  const client = createClient({
    sdkKey: CLIENT_KEY,
    baseUrl: BASE,
    appState: null,
    verify: { publicKeys: [signer.publicJwk], require: true },
    fetch: edge.fetch,
    webSocket: FakeSocket as never,
    xmlHttpRequest: FakeXhr as never,
    pollIntervalMs: 0,
    events: false,
    ...opts,
  });
  client.on("update", (u) => updates.push(u));
  client.on("error", (e) => errors.push(e as NanoFlagsError));
  clients.push(client);
  await client.ready();
  return { client, edge, updates, errors };
}

describe("live socket", () => {
  it("applies a verified push without any request, and reports latency", async () => {
    const { client, edge, updates } = await setup();
    await waitFor(() => client.transport === "live", 1000, "live");
    const requests = edge.calls.length;
    FakeSocket.last!.message(await edge.push(makeBundle(4)));
    await waitFor(() => client.revision === 4, 2000, "r4");
    expect(edge.calls.length).toBe(requests);
    const u = updates.at(-1)!;
    expect(u).toMatchObject({ revision: 4, previousRevision: 3, transport: "live", source: "network" });
    expect(u.latencyMs).toBeGreaterThanOrEqual(0);
    expect(client.string("accent", "")).toBe("blue-r4");
  });

  it("refuses a push whose signature does not verify", async () => {
    const { client, edge, errors } = await setup();
    await waitFor(() => client.transport === "live");
    const m = await edge.push(makeBundle(4));
    m.bundle = String(m.bundle).replace("blue-r4", "evil");
    FakeSocket.last!.message(m);
    await waitFor(() => errors.some((e) => e.code === "signature"), 2000, "rejection");
    expect(client.revision).toBe(3);
  });

  it("close code 4004 (environment deleted): no reconnect, last config kept, status stale", async () => {
    const { client, errors } = await setup();
    await waitFor(() => client.transport === "live");
    const sockets = FakeSocket.instances.length;
    FakeSocket.last!.drop(4004);
    await waitFor(() => errors.some((e) => e.code === "environment_deleted"), 1000, "4004");
    expect(client.status).toBe("stale");
    expect(client.string("accent", "")).toBe("blue-r3");
    await new Promise((r) => setTimeout(r, 1600)); // longer than the first reconnect backoff (≤ 1.5 s)
    expect(FakeSocket.instances.length).toBe(sockets);
    expect(FakeXhr.instances.length).toBe(0); // no SSE fallback either
  });

  it("a dropped socket reconnects with backoff and catches up from `hello`", async () => {
    const { client, edge } = await setup();
    await waitFor(() => client.transport === "live");
    FakeSocket.last!.drop(1006);
    await waitFor(() => FakeSocket.open.length === 1, 3000, "reconnect");
    FakeSocket.last!.message(await edge.push(makeBundle(7), "hello"));
    await waitFor(() => client.revision === 7, 2000, "r7");
  });
});

describe("SSE fallback over XMLHttpRequest", () => {
  it("is used when the socket cannot be opened; a revision event triggers a conditional fetch", async () => {
    FakeSocket.autoOpen = false;
    const { client, edge } = await setup();
    await waitFor(() => FakeSocket.last, 1000, "socket attempt");
    FakeSocket.last!.drop(1006); // handshake refused (e.g. 503: socket cap)
    await waitFor(() => FakeXhr.last, 1000, "SSE request");
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe(`${BASE}/v1/stream`);
    expect(xhr.headers).toMatchObject({ Authorization: `Bearer ${CLIENT_KEY}`, Accept: "text/event-stream", "User-Agent": DEFAULT_UA });
    expect(client.transport).toBe("stream");
    edge.bundle = makeBundle(5);
    const before = edge.count("/v1/bundle");
    xhr.chunk(": hi\r\n\r\nevent: revision\r\ndata: {\"revision\":5,");
    xhr.chunk('"checksum":"c5"}\r\n\r\n');
    await waitFor(() => client.revision === 5, 2000, "r5");
    expect(edge.count("/v1/bundle")).toBe(before + 1);
  });
});

describe("xhrStreamOpener", () => {
  it("parses events across chunks, resolves with the status, and ends on abort", async () => {
    const opener = xhrStreamOpener(FakeXhr as never, { "User-Agent": "ua" });
    const seen: Array<[string, string]> = [];
    const ac = new AbortController();
    const done = opener("https://x/v1/stream", { headers: { A: "1" }, signal: ac.signal }, (e, d) => seen.push([e, d]));
    const xhr = FakeXhr.last!;
    expect(xhr.headers).toEqual({ "User-Agent": "ua", A: "1" });
    xhr.chunk("event: revision\ndata: a\n");
    xhr.chunk("data: b\n\nevent: x\n");
    xhr.chunk("data: c\n\n");
    expect(seen).toEqual([
      ["revision", "a\nb"],
      ["x", "c"],
    ]);
    ac.abort();
    expect(await done).toBe(0);
    expect(xhr.aborted).toBe(true);

    const refused = opener("https://x/v1/stream", { headers: {}, signal: new AbortController().signal }, () => undefined);
    FakeXhr.last!.end(401);
    expect(await refused).toBe(401);

    const failing = opener("https://x/v1/stream", { headers: {}, signal: new AbortController().signal }, () => undefined);
    FakeXhr.last!.onerror?.({});
    await expect(failing).rejects.toThrow(/failed/);
  });
});

describe("polling", () => {
  it("revalidates with If-None-Match and keeps the bundle on 304", async () => {
    const { client, edge } = await setup({ streaming: false, pollIntervalMs: 300 });
    const first = edge.count("/v1/bundle");
    await waitFor(() => edge.count("/v1/bundle") >= first + 1, 2000, "poll");
    expect(edge.last("/v1/bundle")!.headers.get("If-None-Match")).toBe('"c3-client"');
    expect(client.revision).toBe(3);
    expect(client.status).toBe("ready");
  });
});
