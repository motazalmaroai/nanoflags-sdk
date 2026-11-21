import { afterEach, describe, expect, it } from "vitest";
import { createClient, type NanoFlagsError, type ReactNativeClient, type ReactNativeClientOptions } from "../src/index";
import { AppState } from "./react-native-shim";
import { BASE, CLIENT_KEY, FakeEdge, FakeSocket, makeBundle, makeSigner, waitFor } from "./helpers";

// Options of the core client that the React Native client passes through (0.3.0): shadow evaluation (with
// serviceVersion), verifyLog, coSignerKeys / allowEmergencyWithoutCosign and experiments.

const SESSION = "6f1c2a4e-8b1d-4c3e-9f00-1234567890ab";
const DRAFT = "0123456789abcdef0123456789abcdef";

const clients: ReactNativeClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  FakeSocket.reset();
  AppState.reset();
});

async function setup(opts: Partial<ReactNativeClientOptions> = {}, prepare?: (edge: FakeEdge) => void | Promise<void>) {
  const signer = await makeSigner();
  const edge = new FakeEdge(signer, makeBundle(3));
  await prepare?.(edge);
  const client = createClient({
    sdkKey: CLIENT_KEY,
    baseUrl: BASE,
    verify: { publicKeys: [signer.publicJwk], require: true },
    fetch: edge.fetch,
    streaming: false,
    pollIntervalMs: 0,
    events: { sampleRate: 0, flushIntervalMs: 60_000 },
    ...opts,
  });
  clients.push(client);
  const errors: NanoFlagsError[] = [];
  client.on("error", (e) => errors.push(e as NanoFlagsError));
  return { client, edge, errors };
}

/** The draft waiting for approval: `accent` gets another default value. */
const withDraft = (edge: FakeEdge) => {
  const live = edge.bundle;
  return edge.serveShadow({ ...live, flags: { ...live.flags, accent: { ...live.flags.accent!, default: "green" } } }, SESSION, DRAFT);
};

type ShadowReport = { sessionId: string; checksum: string; version?: string; flags: { flag: string; samples: number; flips: number; pairs: { live: string; shadow: string; count: number }[] }[] };
const shadowOf = (body: unknown) => (body as { shadow?: ShadowReport }).shadow;

describe("shadow evaluation", () => {
  it("is on by default when events are on: the draft is loaded, but the app keeps the live value", async () => {
    const { client, edge, errors } = await setup({}, withDraft);
    await client.ready();
    await waitFor(() => edge.count("/v1/shadow") === 1, 3000, "the shadow bundle");
    for (let i = 0; i < 20; i++) expect(client.string("accent", "fallback")).toBe("blue-r3");
    expect(client.revision).toBe(3);
    expect(errors).toEqual([]);
  });

  it("reports counters only, labelled with serviceVersion, with the react-native sdk label", async () => {
    const { client, edge, errors } = await setup({ shadow: { sampleRate: 1 }, serviceVersion: "4.2.0", context: { key: "user-42", email: "x@example.com" } }, withDraft);
    await client.ready();
    await waitFor(() => edge.count("/v1/shadow") === 1, 3000, "the shadow bundle");
    await new Promise((r) => setTimeout(r, 20)); // the shadow bundle is checked in the background
    for (let i = 0; i < 10; i++) expect(client.string("accent", "fallback")).toBe("blue-r3");
    client.boolean("new-checkout", false); // unchanged by the draft: not shadowed
    await client.flush();
    const body = edge.last("/v1/events")!.body as { sdk: string };
    expect(body.sdk).toBe("react-native/0.4.0");
    expect(shadowOf(body)).toEqual({
      sessionId: SESSION,
      checksum: DRAFT,
      version: "4.2.0",
      flags: [{ flag: "accent", samples: 10, flips: 10, pairs: [{ live: '"blue-r3"', shadow: '"green"', count: 10 }], rules: { default: 10 } }],
    });
    expect(JSON.stringify(shadowOf(body))).not.toContain("user-42");
    expect(JSON.stringify(shadowOf(body))).not.toContain("example.com");
    expect(errors).toEqual([]);
  });

  it("shadow: false turns it off: the draft is never fetched and nothing is reported", async () => {
    const { client, edge } = await setup({ shadow: false }, withDraft);
    await client.ready();
    for (let i = 0; i < 10; i++) client.string("accent", "fallback");
    await client.flush();
    expect(edge.count("/v1/shadow")).toBe(0);
    expect(shadowOf(edge.last("/v1/events")!.body)).toBeUndefined();
  });

  it("events: false turns it off too", async () => {
    const { client, edge } = await setup({ events: false, shadow: { sampleRate: 1 } }, withDraft);
    await client.ready();
    client.string("accent", "fallback");
    await client.flush();
    expect(edge.count("/v1/shadow")).toBe(0);
    expect(edge.count("/v1/events")).toBe(0);
  });
});

describe("verifiable history and co-signing", () => {
  it("verifyLog: an update that is not in the transparency log is refused (error code log)", async () => {
    const { client, edge, errors } = await setup({ verifyLog: true }, (e) => {
      e.routes["/v1/log/proof"] = () => new Response('{"error":{"code":"unavailable"}}', { status: 503 });
    });
    await client.ready();
    await waitFor(() => errors.length > 0, 3000, "the log error");
    expect(edge.count("/v1/log/proof")).toBeGreaterThan(0);
    expect(errors[0]!.code).toBe("log");
    expect(client.revision).toBeNull();
  });

  it("coSignerKeys: an update without a co-signature is refused (error code cosign)", async () => {
    const ci = await makeSigner("ci-key");
    const { client, errors } = await setup({ coSignerKeys: [ci.publicJwk] });
    await client.ready();
    await waitFor(() => errors.length > 0, 3000, "the cosign error");
    expect(errors[0]!.code).toBe("cosign");
    expect(client.revision).toBeNull();
  });

  it("without the new options nothing changes", async () => {
    const { client, edge, errors } = await setup();
    await client.ready();
    expect(client.revision).toBe(3);
    expect(edge.count("/v1/log/proof")).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("experiments", () => {
  it("experiments: { enabled: true } keeps track() on with events: false", async () => {
    const { client, edge } = await setup({ events: false, experiments: { enabled: true }, context: { key: "user-42" } }, (e) => {
      e.routes["/v1/track"] = () => new Response('{"accepted":1}', { status: 202 });
    });
    await client.ready();
    client.track("checkout_completed");
    await client.flush();
    expect(edge.count("/v1/track")).toBe(1);
    expect(JSON.stringify(edge.last("/v1/track")!.body)).not.toContain("user-42");
  });

  it("events: false alone turns track() off", async () => {
    const { client, edge } = await setup({ events: false, context: { key: "user-42" } });
    await client.ready();
    client.track("checkout_completed");
    await client.flush();
    expect(edge.count("/v1/track")).toBe(0);
  });
});
