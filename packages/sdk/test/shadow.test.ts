import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type Bundle, type NanoFlagsClient, type NanoFlagsError } from "../src/index";
import { canonicalString, sha256Hex, shadowCanonicalString } from "../src/verify";
import { changedFlags, MAX_SHADOW_FLAGS, MAX_SHADOW_PAIRS, parseShadowHeader, reprValue, ShadowCounters, type ShadowMarker } from "../src/shadow";
import { BASE, CLIENT_KEY, SERVER_KEY, makeBundle, tick } from "./helpers";
import { ENV_ID, makeSigner, mockRoutes, signedResponse, type Signer } from "./v2helpers";

// Shadow evaluation of drafts (migration 0179): the draft of a change waiting for approval is evaluated next to the
// live bundle for a sample of evaluations; only counters leave the SDK; the shadow bundle is never applied.

const SESSION = "6f1c2a4e-8b1d-4c3e-9f00-1234567890ab";
const DRAFT = "0123456789abcdef0123456789abcdef";
const marker = (over: Partial<ShadowMarker> = {}): ShadowMarker => ({ sessionId: SESSION, checksum: DRAFT, environmentId: ENV_ID, baseRevision: 3, ...over });

/** The draft: checkout-v2 is on by default (live: off by default). Everything else as live. */
function draftOf(live: Bundle): Bundle {
  return { ...live, flags: { ...live.flags, "checkout-v2": { ...live.flags["checkout-v2"]!, default: true } } };
}

async function shadowResponse(signer: Signer, bundle: Bundle, opts: { marker?: ShadowMarker; tamper?: (t: string) => string; domain?: "shadow" | "bundle"; sessionId?: string; checksum?: string; environmentId?: string } = {}): Promise<Response> {
  const m = opts.marker ?? marker();
  const sessionId = opts.sessionId ?? m.sessionId;
  const checksum = opts.checksum ?? m.checksum;
  const environmentId = opts.environmentId ?? ENV_ID;
  const text = JSON.stringify({ ...bundle, shadow: m });
  const digest = await sha256Hex(text);
  const signature = await signer.sign(opts.domain === "bundle" ? canonicalString(environmentId, bundle.revision, checksum, digest) : shadowCanonicalString(environmentId, sessionId, checksum, digest));
  const body = `{"sessionId":${JSON.stringify(sessionId)},"checksum":${JSON.stringify(checksum)},"baseRevision":3,"bundle":${opts.tamper ? opts.tamper(text) : text}}`;
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json", "X-NanoFlags-Signed": "true", "X-NanoFlags-Signature": signature, "X-NanoFlags-Key-Id": signer.kid, "X-NanoFlags-Environment-Id": environmentId } });
}

/** The live `/v1/bundle` answer, announcing the shadow session (or not). */
async function liveResponse(signer: Signer, bundle: Bundle, announce: string | null = `${SESSION}.${DRAFT}`): Promise<Response> {
  const res = await signedResponse(signer, bundle);
  const headers = new Headers(res.headers);
  if (announce) headers.set("X-NanoFlags-Shadow", announce);
  return new Response(await res.text(), { status: 200, headers });
}

const clients: NanoFlagsClient[] = [];
function client(opts: Partial<Parameters<typeof createClient>[0]> & { fetch: typeof fetch }) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, service: "checkout-service", serviceVersion: "3.1.0", events: { sampleRate: 0, flushIntervalMs: 60_000 }, verify: { publicKeys: [signer.publicJwk] }, ...opts });
  clients.push(c);
  return c;
}
const errorsOf = (c: NanoFlagsClient) => {
  const errors: NanoFlagsError[] = [];
  c.on("error", (e) => errors.push(e as NanoFlagsError));
  return errors;
};
/** Waits until the shadow bundle was fetched and checked (it loads in the background). */
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}
type EventsBody = { shadow?: { sessionId: string; checksum: string; version?: string; flags: { flag: string; samples: number; flips: number; pairs: { live: string; shadow: string; count: number }[]; rules: Record<string, number> }[] } };
const shadowOf = (body: unknown) => (body as EventsBody).shadow;

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

describe("shadow evaluation", () => {
  it("evaluates the draft next to the live bundle, never applies it, and reports only counters", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({
      "/v1/bundle": await liveResponse(signer, live),
      "/v1/shadow": await shadowResponse(signer, draftOf(live)),
      "/v1/events": new Response('{"accepted":0}', { status: 202 }),
    });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 } });
    const errors = errorsOf(c);
    await c.ready();
    await settle();
    expect(edge.count("/v1/shadow")).toBe(1);

    // Zero behaviour change: the app always gets the live value.
    for (let i = 0; i < 30; i++) expect(c.boolean("checkout-v2", true, { region: "DE", email: `person${i}@example.test`, userId: `u${i}` })).toBe(false);
    for (let i = 0; i < 10; i++) expect(c.boolean("checkout-v2", false, { signedIn: true, region: "US", key: "k" })).toBe(true);
    expect(c.string("search-ranking", "fb")).toBe("relevance-v3"); // unchanged flag: not shadowed
    expect(c.revision).toBe(3);
    expect(errors).toEqual([]);

    await c.flush();
    const body = edge.last("/v1/events")!.body;
    expect(shadowOf(body)).toEqual({
      sessionId: SESSION, checksum: DRAFT, version: "3.1.0",
      flags: [{ flag: "checkout-v2", samples: 40, flips: 30, pairs: [{ live: "false", shadow: "true", count: 30 }], rules: { default: 30, "1": 10 } }],
    });
    // No context, attribute or identifier leaves the SDK with the shadow report.
    const text = JSON.stringify(shadowOf(body));
    for (const s of ["example.test", "person", "u1", "region", "DE", "signedIn", "US"]) expect(text).not.toContain(s);

    // Counters restart after a report: the next flush carries no shadow member.
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)).toBeUndefined();
  });

  it("samples at the configured rate and only the flags the draft changes", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draftOf(live)), "/v1/events": new Response("{}", { status: 202 }) });
    let n = 0;
    const random = vi.fn(() => (n++ % 4) / 4); // 0, .25, .5, .75 …
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 0.25, random } });
    await c.ready();
    await settle();
    for (let i = 0; i < 100; i++) c.boolean("checkout-v2", false, { region: "DE" });
    for (let i = 0; i < 50; i++) c.number("max-items", 0);
    expect(random).toHaveBeenCalledTimes(100); // unchanged flags never draw
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)!.flags).toEqual([{ flag: "checkout-v2", samples: 25, flips: 25, pairs: [{ live: "false", shadow: "true", count: 25 }], rules: { default: 25 } }]);
  });

  it("a tampered shadow bundle is ignored: no evaluation, no report, an error with code shadow", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({
      "/v1/bundle": await liveResponse(signer, live),
      "/v1/shadow": await shadowResponse(signer, draftOf(live), { tamper: (t) => t.replace('"default":true', '"default":"evil"') }),
      "/v1/events": new Response("{}", { status: 202 }),
    });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 } });
    const errors = errorsOf(c);
    await c.ready();
    await settle();
    for (let i = 0; i < 5; i++) expect(c.boolean("checkout-v2", true, { region: "DE" })).toBe(false);
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)).toBeUndefined();
    expect(errors.map((e) => e.code)).toEqual(["shadow"]);
    expect(c.revision).toBe(3);
  });

  it.each([
    ["signed by an unknown key", { signerOverride: true }],
    ["signed as a normal bundle (no domain separation abuse)", { domain: "bundle" as const }],
    ["marker of another session inside the signed bytes", { marker: marker({ sessionId: "11111111-2222-4333-8444-555555555555" }), sessionId: SESSION }],
    ["marker of another environment", { marker: marker({ environmentId: "6f0c7c1e-0000-4000-8000-000000000999" }) }],
    ["signed for another environment", { environmentId: "6f0c7c1e-0000-4000-8000-000000000999" }],
  ])("rejects a shadow bundle %s", async (_name, o) => {
    const live = makeBundle(3);
    const { signerOverride, ...opts } = o as { signerOverride?: boolean } & Parameters<typeof shadowResponse>[2];
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signerOverride ? other : signer, draftOf(live), opts), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 } });
    const errors = errorsOf(c);
    await c.ready();
    await settle();
    c.boolean("checkout-v2", true, { region: "DE" });
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)).toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("shadow");
  });

  it("a shadow bundle is never applied as configuration, even when served (validly signed) as a bundle", async () => {
    const live = makeBundle(3);
    const draft = { ...draftOf(makeBundle(4)), shadow: marker() } as unknown as Bundle;
    const edge = mockRoutes({ "/v1/bundle": await signedResponse(signer, live), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch });
    const errors = errorsOf(c);
    await c.ready();
    expect(c.revision).toBe(3);
    // An attacker (or a bug) serves the shadow bundle on /v1/bundle with a bundle signature over its bytes.
    edge.routes["/v1/bundle"] = await signedResponse(signer, draft);
    await c.refresh();
    expect(c.revision).toBe(3);
    expect(c.boolean("checkout-v2", true, { region: "DE" })).toBe(false);
    expect(errors.map((e) => e.code)).toEqual(["invalid_bundle"]);
    // Without verification as well.
    const edge2 = mockRoutes({ "/v1/bundle": new Response(JSON.stringify({ revision: 4, checksum: "c4", bundle: draft }), { status: 200 }) });
    const c2 = client({ fetch: edge2.fetch, verify: false });
    await c2.ready();
    expect(c2.status).toBe("not-ready");
    expect(c2.boolean("checkout-v2", false)).toBe(false);
    // Nor as a bootstrap.
    const c3 = client({ fetch: edge2.fetch, verify: false, bootstrap: draft });
    expect(c3.revision).not.toBe(4);
  });

  it("is withdrawn when the edge stops announcing it; pending counters are sent first", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draftOf(live)), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 } });
    await c.ready();
    await settle();
    c.boolean("checkout-v2", false, { region: "DE" });
    edge.routes["/v1/bundle"] = new Response(null, { status: 304 });
    await c.refresh();
    await settle();
    expect(shadowOf(edge.last("/v1/events")!.body)!.flags[0]).toMatchObject({ flag: "checkout-v2", samples: 1 });
    const before = edge.count("/v1/events");
    c.boolean("checkout-v2", false, { region: "DE" });
    await c.flush();
    expect(edge.count("/v1/events")).toBe(before + 1);
    expect(shadowOf(edge.last("/v1/events")!.body)).toBeUndefined();
  });

  it("a new draft (new announcement) replaces the session; the old counters go out first", async () => {
    const live = makeBundle(3);
    const next = "f".repeat(32);
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draftOf(live)), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 } });
    await c.ready();
    await settle();
    c.boolean("checkout-v2", false, { region: "DE" });
    const etag = new Headers({ "X-NanoFlags-Shadow": `${SESSION}.${next}` });
    edge.routes["/v1/bundle"] = new Response(null, { status: 304, headers: etag });
    edge.routes["/v1/shadow"] = await shadowResponse(signer, draftOf(live), { marker: marker({ checksum: next }) });
    await c.refresh();
    await settle();
    expect(shadowOf(edge.last("/v1/events")!.body)).toMatchObject({ checksum: DRAFT, flags: [{ samples: 1 }] });
    c.boolean("checkout-v2", false, { region: "DE" });
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)).toMatchObject({ checksum: next, flags: [{ samples: 1 }] });
  });

  it("counters ride with timer flushes at most once a minute", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draftOf(live)), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 }, events: { sampleRate: 1, flushIntervalMs: 10 } });
    await c.ready();
    await settle();
    c.boolean("checkout-v2", false, { region: "DE" });
    await new Promise((r) => setTimeout(r, 40));
    expect(edge.count("/v1/events")).toBeGreaterThan(0);
    expect(edge.calls.filter((x) => x.path === "/v1/events").every((x) => shadowOf(x.body) === undefined)).toBe(true);
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)!.flags[0]!.samples).toBe(1);
  });

  it("`shadow: false` and `events: false` never fetch the shadow bundle", async () => {
    const live = makeBundle(3);
    for (const opts of [{ shadow: false as const }, { events: false as const }, { shadow: { enabled: false } }]) {
      const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draftOf(live)) });
      const c = client({ fetch: edge.fetch, ...opts });
      await c.ready();
      await settle();
      expect(edge.count("/v1/shadow")).toBe(0);
    }
  });

  it("without verification configured the shadow bundle is still checked, with /v1/keys", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({
      "/v1/bundle": await liveResponse(signer, live),
      "/v1/shadow": await shadowResponse(signer, draftOf(live)),
      "/v1/keys": new Response(JSON.stringify({ keys: [signer.publicJwk] }), { status: 200 }),
      "/v1/events": new Response("{}", { status: 202 }),
    });
    const c = client({ fetch: edge.fetch, verify: undefined, shadow: { sampleRate: 1 } });
    await c.ready();
    await settle();
    c.boolean("checkout-v2", false, { region: "DE" });
    await c.flush();
    expect(edge.count("/v1/keys")).toBe(1);
    expect(shadowOf(edge.last("/v1/events")!.body)!.flags[0]!.samples).toBe(1);
    // The SDK key is never sent to the public keys endpoint.
    expect(edge.last("/v1/keys")!.headers.get("Authorization")).toBeNull();
  });

  it("the app's own fallback never leaves the SDK: a flag only in the draft, a wrong type, a flag removed by the draft", async () => {
    const live = makeBundle(3);
    const draft = draftOf(live);
    draft.flags = { ...draft.flags, "brand-new": { type: "string", enabled: true, default: "x", off: "off", rules: [] } };
    draft.flags["search-ranking"] = { ...draft.flags["search-ranking"]!, default: 42 } as never; // wrong type for c.string()
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draft), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch, shadow: { sampleRate: 1 } });
    await c.ready();
    await settle();
    expect(c.string("brand-new", "alice@example.test")).toBe("alice@example.test");
    expect(c.string("search-ranking", "bob@example.test")).toBe("relevance-v3");
    await c.flush();
    const report = shadowOf(edge.last("/v1/events")!.body)!;
    const text = JSON.stringify(report);
    expect(text).not.toContain("example.test");
    expect(report.flags.find((f) => f.flag === "brand-new")!.pairs).toEqual([{ live: "<fallback>", shadow: '"x"', count: 1 }]);
    expect(report.flags.find((f) => f.flag === "search-ranking")!.pairs).toEqual([{ live: '"relevance-v3"', shadow: "<fallback>", count: 1 }]);
  });

  it("browser keys work the same way", async () => {
    const live = makeBundle(3);
    const edge = mockRoutes({ "/v1/bundle": await liveResponse(signer, live), "/v1/shadow": await shadowResponse(signer, draftOf(live)), "/v1/events": new Response("{}", { status: 202 }) });
    const c = client({ fetch: edge.fetch, sdkKey: CLIENT_KEY, store: false, shadow: { sampleRate: 1 } });
    await c.ready();
    await settle();
    expect(c.boolean("checkout-v2", true, { region: "DE" })).toBe(false);
    await c.flush();
    expect(shadowOf(edge.last("/v1/events")!.body)!.flags[0]).toMatchObject({ flag: "checkout-v2", flips: 1 });
  });
});

describe("shadow helpers", () => {
  it("parses the announcement header", () => {
    expect(parseShadowHeader(`${SESSION}.${DRAFT}`)).toEqual({ sessionId: SESSION, checksum: DRAFT });
    for (const bad of [null, "", "x.y", `${SESSION}`, `${SESSION}.${DRAFT}x`, `not-a-uuid-not-a-uuid-not-a-uuid-xxx.${DRAFT}`]) expect(parseShadowHeader(bad)).toBeNull();
  });

  it("changed flags: configuration differences and changed segments, whatever the key order", () => {
    const live = makeBundle(3);
    expect([...changedFlags(live, live)]).toEqual([]);
    const reordered = JSON.parse(JSON.stringify(live, Object.keys(live).reverse())) as Bundle;
    expect([...changedFlags(live, reordered)]).toEqual([]);
    expect([...changedFlags(live, draftOf(live))]).toEqual(["checkout-v2"]);
    const seg = { ...live, segments: { staff: { match: "all", conditions: [{ attribute: "email", op: "ends_with", value: "@example.test" }] } } } as Bundle;
    expect([...changedFlags(live, seg)]).toEqual(["checkout-v2"]); // it references `staff`
    const added = { ...live, flags: { ...live.flags, brand_new: { type: "boolean", enabled: true, default: true, off: false, rules: [] } } } as Bundle;
    expect([...changedFlags(live, added)]).toEqual(["brand_new"]);
  });

  it("changed flags: segments inside segments and removed segments count (same cases as supabase/tests/shadow_eval.sql)", () => {
    const flag = (op: "segment" | "not_segment", value: string) => ({ type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "r", match: "all", conditions: [{ attribute: "", op, value }], serve: { type: "fixed", value: true } }] });
    const g = { type: "boolean", enabled: true, default: false, off: false, rules: [] };
    const nested = (v: number) => ({ schema: 1, project: "p", environment: "e", revision: 1, flags: { f: flag("segment", "a"), g },
      segments: { a: { match: "all", conditions: [{ attribute: "", op: "segment", value: "b" }] }, b: { match: "all", conditions: [{ attribute: "x", op: "eq", value: v }] } } }) as unknown as Bundle;
    expect([...changedFlags(nested(1), nested(2))]).toEqual(["f"]);
    expect([...changedFlags(nested(1), nested(1))]).toEqual([]);
    const withC = { ...nested(1), flags: { f: flag("not_segment", "a"), g }, segments: { a: { match: "any", conditions: [{ attribute: "", op: "segment", value: "c" }] }, c: { match: "all", conditions: [] } } } as unknown as Bundle;
    const withoutC = { ...withC, segments: { a: withC.segments.a! } } as Bundle;
    expect([...changedFlags(withC, withoutC)]).toEqual(["f"]);
    // A cycle terminates.
    const cyc = (extra: boolean) => ({ ...nested(1), segments: { a: { match: "all", conditions: [{ attribute: "", op: "segment", value: "b" }] }, b: { match: "all", conditions: [{ attribute: "", op: "segment", value: "a" }, ...(extra ? [{ attribute: "x", op: "eq", value: 1 }] : [])] } } }) as unknown as Bundle;
    expect([...changedFlags(cyc(false), cyc(true))]).toEqual(["f"]);
  });

  it("flips are decided independently of object key order", () => {
    const c = new ShadowCounters(SESSION, DRAFT);
    c.add("cfg", { a: 1, b: 2 }, { b: 2, a: 1 }, undefined);
    c.add("cfg", { a: 1, b: { d: 1, c: 2 } }, { b: { c: 2, d: 1 }, a: 1 }, undefined);
    expect(c.report(undefined).flags[0]).toMatchObject({ samples: 2, flips: 0, pairs: [] });
    expect(reprValue({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("values: JSON text up to 100 characters, longer ones hashed", () => {
    expect(reprValue(true)).toBe("true");
    expect(reprValue("blue")).toBe('"blue"');
    expect(reprValue({ a: 1 })).toBe('{"a":1}');
    expect(reprValue("x".repeat(200))).toMatch(/^#[0-9a-f]{8}$/);
    expect(reprValue(undefined)).toBe("null");
  });

  it("counters are bounded (flags, value pairs, rules)", () => {
    const c = new ShadowCounters(SESSION, DRAFT);
    for (let i = 0; i < MAX_SHADOW_FLAGS + 20; i++) c.add(`f${i}`, false, true, 0);
    expect(c.size).toBe(MAX_SHADOW_FLAGS);
    const p = new ShadowCounters(SESSION, DRAFT);
    for (let i = 0; i < 50; i++) p.add("color", "a", `b${i}`, i);
    const r = p.report(undefined).flags[0]!;
    expect(r.samples).toBe(50);
    expect(r.flips).toBe(50);
    expect(r.pairs).toHaveLength(MAX_SHADOW_PAIRS);
    expect(r.pairs.at(-1)).toEqual({ live: "*", shadow: "*", count: 50 - (MAX_SHADOW_PAIRS - 1) });
    expect(r.pairs.reduce((a, x) => a + x.count, 0)).toBe(50);
    expect(Object.keys(r.rules)).toHaveLength(50);
    expect(p.report(undefined)).not.toHaveProperty("version");
  });
});
