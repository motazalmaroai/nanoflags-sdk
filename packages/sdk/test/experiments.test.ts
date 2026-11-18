import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, sha256Hex, unitHash, type Bundle, type NanoFlagsClient } from "../src/index";
import { BASE, CLIENT_KEY, SERVER_KEY, makeBundle, tick } from "./helpers";

const EXP = "3f1c2b8e-7d52-4c1a-9a43-1f0e6d5b2c11";
const EXP2 = "9b0d7a52-1e33-4c55-8f0a-2d6c4e1b7a90";

/** A bundle whose `checkout-v2` flag runs an experiment on its 50 % rollout rule. */
function experimentBundle(traffic = 100, over: Partial<Bundle["flags"]> = {}): Bundle {
  const b = makeBundle(4);
  b.flags["checkout-v2"] = {
    type: "boolean",
    enabled: true,
    default: false,
    off: false,
    rules: [
      { id: "staff", match: "all", conditions: [{ attribute: "staff", op: "eq", value: true }], serve: { type: "fixed", value: true } },
      { id: "r1", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: true, otherwise: false } },
    ],
    experiment: { id: EXP, key: "new-checkout", ruleId: "r1", unit: "key", traffic, seed: `exp:${EXP}`, variants: [{ key: "control", value: false }, { key: "treatment", value: true }] },
  };
  Object.assign(b.flags, over);
  return b;
}

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function edge(status: Record<string, number | Error> = {}) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/bundle") throw new Error("offline");
    sent.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const s = status[path] ?? 202;
    if (s instanceof Error) throw s;
    return new Response("{}", { status: s });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, of: (p: string) => sent.filter((s) => s.path === p) };
}

const clients: NanoFlagsClient[] = [];
function client(fetch: typeof globalThis.fetch, opts: Partial<Parameters<typeof createClient>[0]> = {}) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, store: false, bootstrap: experimentBundle(), experiments: { enabled: true, flushIntervalMs: 0 }, fetch, ...opts });
  clients.push(c);
  return c;
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sha256Hex / unitHash", () => {
  it("matches FIPS 180-4 test vectors and node:crypto", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    for (const s of ["مرحبا بالعالم", "emoji 🚀✨", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("scopes the unit to project, environment and attribute (documented format)", () => {
    // Documented test vector (/docs/experiments/track).
    expect(unitHash("commerce", "production", "key", "user-1")).toBe("1080ed9b5d7279af40f8645e827ac76c42472fdb4a6b33071f2196d9b11817b9");
    expect(unitHash("commerce", "production", "key", "user-1")).toBe(createHash("sha256").update("nanoflags-unit-v1\ncommerce\nproduction\nkey\nuser-1").digest("hex"));
    expect(unitHash("commerce", "staging", "key", "user-1")).not.toBe(unitHash("commerce", "production", "key", "user-1"));
    expect(unitHash("commerce", "production", "accountId", "user-1")).not.toBe(unitHash("commerce", "production", "key", "user-1"));
  });
});

describe("experiments and telemetry opt-out", () => {
  it("events: false turns exposures and track() off unless experiments are enabled explicitly", async () => {
    const e = edge();
    const off = client(e.fetch, { events: false, experiments: { flushIntervalMs: 0 } });
    off.boolean("checkout-v2", false, { key: "user-1" });
    off.track("purchase", 10, { key: "user-1" });
    await off.flush();
    expect(e.of("/v1/exposures")).toHaveLength(0);
    expect(e.of("/v1/track")).toHaveLength(0);
    const on = client(e.fetch, { events: false, experiments: { enabled: true, flushIntervalMs: 0 } });
    on.boolean("checkout-v2", false, { key: "user-2" });
    await on.flush();
    expect(e.of("/v1/exposures")).toHaveLength(1);
  });
});

describe("exposures", () => {
  it("are logged once per unit, unsampled, with a hashed unit and nothing else", async () => {
    const e = edge();
    const c = client(e.fetch, { events: { sampleRate: 0 } });
    const variants = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      const ctx = { key: `user-${i}`, email: `u${i}@example.com` };
      const v = c.boolean("checkout-v2", false, ctx);
      c.boolean("checkout-v2", false, ctx); // repeat: not logged again
      variants.set(unitHash("commerce", "production", "key", `user-${i}`), v ? "treatment" : "control");
    }
    await c.flush();
    const sent = e.of("/v1/exposures");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.sdk).toMatch(/^js\//);
    const exposures = sent[0]!.body.exposures as { experiment: string; variant: string; unit: string }[];
    expect(exposures).toHaveLength(40);
    for (const x of exposures) {
      expect(Object.keys(x).sort()).toEqual(["experiment", "unit", "variant"]);
      expect(x.experiment).toBe(EXP);
      expect(x.variant).toBe(variants.get(x.unit));
    }
    expect(new Set(exposures.map((x) => x.variant))).toEqual(new Set(["control", "treatment"]));
    const raw = JSON.stringify(sent[0]!.body);
    expect(raw).not.toContain("user-");
    expect(raw).not.toContain("example.com");
    // Telemetry sampling (0) does not apply to exposures: telemetry carries the service report only.
    for (const t of e.of("/v1/events")) expect(t.body.events).toEqual([]);
  });

  it("only the experiment's rule, inside its traffic, is an exposure", async () => {
    const e = edge();
    const c = client(e.fetch, { bootstrap: experimentBundle(30) });
    c.boolean("checkout-v2", false, { key: "staff-1", staff: true }); // decided by another rule
    c.boolean("checkout-v2", false, {}); // no unit
    c.string("search-ranking", "x", { key: "user-1" }); // flag without an experiment
    for (let i = 0; i < 200; i++) c.boolean("checkout-v2", false, { key: `u${i}` });
    await c.flush();
    const exposures = e.of("/v1/exposures").flatMap((s) => s.body.exposures as unknown[]);
    expect(exposures.length).toBeGreaterThan(30);
    expect(exposures.length).toBeLessThan(90); // ≈ 30 % of 200
  });

  it("allFlags(), test sessions and experiments: false do not log exposures", async () => {
    const e = edge();
    const c = client(e.fetch);
    c.allFlags({ key: "user-1" });
    await c.flush();
    expect(e.of("/v1/exposures")).toHaveLength(0);

    const off = client(e.fetch, { experiments: false });
    off.boolean("checkout-v2", false, { key: "user-1" });
    off.track("purchase", 10, { key: "user-1" });
    await off.flush();
    expect(e.sent).toHaveLength(0);
  });

  it("are retried after a network error or 5xx, never after a 4xx", async () => {
    const e = edge({ "/v1/exposures": 503 });
    const c = client(e.fetch);
    c.boolean("checkout-v2", false, { key: "user-1" });
    await c.flush();
    await c.flush();
    expect(e.of("/v1/exposures")).toHaveLength(2);
    expect(e.of("/v1/exposures")[1]!.body).toEqual(e.of("/v1/exposures")[0]!.body);

    const bad = edge({ "/v1/exposures": 400 });
    const c2 = client(bad.fetch);
    c2.boolean("checkout-v2", false, { key: "user-1" });
    await c2.flush();
    await c2.flush();
    expect(bad.of("/v1/exposures")).toHaveLength(1);
  });

  it("are sent in the background at the flush interval", async () => {
    vi.useFakeTimers();
    const e = edge();
    const c = client(e.fetch, { experiments: { enabled: true, flushIntervalMs: 1000 } });
    await c.ready();
    c.boolean("checkout-v2", false, { key: "user-1" });
    expect(e.of("/v1/exposures")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(e.of("/v1/exposures")).toHaveLength(1);
  });

  it("a full batch is sent without waiting for the interval", async () => {
    vi.useFakeTimers();
    const e = edge();
    const c = client(e.fetch, { experiments: { enabled: true, flushIntervalMs: 60_000 } });
    await c.ready();
    for (let i = 0; i < 100; i++) c.boolean("checkout-v2", false, { key: `user-${i}` });
    await vi.advanceTimersByTimeAsync(10);
    expect(e.of("/v1/exposures")).toHaveLength(1);
    expect((e.of("/v1/exposures")[0]!.body.exposures as unknown[]).length).toBe(100);
  });

  it("malformed experiment metadata never breaks evaluation", async () => {
    const e = edge();
    const b = experimentBundle();
    (b.flags["checkout-v2"] as unknown as { experiment: unknown }).experiment = { id: 5, variants: "nope" };
    const c = client(e.fetch, { bootstrap: b });
    expect(typeof c.boolean("checkout-v2", false, { key: "u" })).toBe("boolean");
    await c.flush();
    expect(e.of("/v1/exposures")).toHaveLength(0);
  });
});

describe("track()", () => {
  it("sends the event name, the optional value and the hashed unit only", async () => {
    const e = edge();
    const c = client(e.fetch, { sdkKey: CLIENT_KEY });
    c.track("checkout_completed", 42.5, { key: "user-1", email: "a@example.com" });
    c.track("signup", { key: "user-2" });
    c.track("visited", undefined, { key: "user-3" });
    await c.flush();
    const sent = e.of("/v1/track");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.events).toEqual([
      { event: "checkout_completed", unit: unitHash("commerce", "production", "key", "user-1"), value: 42.5 },
      { event: "signup", unit: unitHash("commerce", "production", "key", "user-2") },
      { event: "visited", unit: unitHash("commerce", "production", "key", "user-3") },
    ]);
    expect(JSON.stringify(sent[0]!.body)).not.toContain("example.com");
  });

  it("exposures are sent before track events", async () => {
    const e = edge();
    const c = client(e.fetch);
    c.track("purchase", 1, { key: "user-1" });
    c.boolean("checkout-v2", false, { key: "user-1" });
    await c.flush();
    expect(e.sent.map((s) => s.path)).toEqual(["/v1/exposures", "/v1/track"]);
  });

  it("reports the unit under every experiment's unit attribute", async () => {
    const e = edge();
    const b = experimentBundle();
    b.flags["plan-page"] = {
      type: "string", enabled: true, default: "a", off: "a",
      rules: [{ id: "r9", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "b", otherwise: "a", bucketBy: "accountId" } }],
      experiment: { id: EXP2, key: "plans", ruleId: "r9", unit: "accountId", seed: `exp:${EXP2}`, variants: [{ key: "control", value: "a" }, { key: "treatment", value: "b" }] },
    };
    const c = client(e.fetch, { bootstrap: b });
    c.track("upgrade", { key: "user-1", accountId: 77 });
    c.track("upgrade", { key: "user-2" });
    await c.flush();
    expect((e.of("/v1/track")[0]!.body.events as { unit: string }[]).map((x) => x.unit)).toEqual([
      unitHash("commerce", "production", "key", "user-1"),
      unitHash("commerce", "production", "accountId", "77"),
      unitHash("commerce", "production", "key", "user-2"),
    ]);
  });

  it("drops invalid calls with an error, never throws, and ignores events without a unit", async () => {
    const e = edge();
    const c = client(e.fetch);
    const errors: Error[] = [];
    c.on("error", (err) => errors.push(err));
    expect(() => c.track("has space", { key: "u" })).not.toThrow();
    expect(() => c.track("ok", Number.NaN, { key: "u" })).not.toThrow();
    expect(() => c.track(undefined as unknown as string)).not.toThrow();
    c.track("no-unit", 1, { email: "a@example.com" });
    c.track("no-context");
    await c.flush();
    expect(e.of("/v1/track")).toHaveLength(0);
    expect(errors.map((x) => (x as { code?: string }).code).filter((code) => code === "config")).toHaveLength(3);
  });

  it("waits for a bundle (the hash needs the project and environment), then sends", async () => {
    const e = edge();
    const c = client(e.fetch, { bootstrap: undefined });
    await c.ready();
    c.track("purchase", 3, { key: "user-1" });
    await c.flush();
    expect(e.of("/v1/track")).toHaveLength(0);
  });

  it("is at most once: a failed batch is not sent again", async () => {
    const e = edge({ "/v1/track": new Error("offline") });
    const c = client(e.fetch);
    c.track("purchase", 3, { key: "user-1" });
    await c.flush();
    await c.flush();
    expect(e.of("/v1/track")).toHaveLength(1);
  });

  it("close() sends what is queued", async () => {
    const e = edge();
    const c = client(e.fetch);
    c.boolean("checkout-v2", false, { key: "user-1" });
    c.track("purchase", 3, { key: "user-1" });
    c.close();
    await tick();
    await tick();
    expect(e.of("/v1/exposures")).toHaveLength(1);
    expect(e.of("/v1/track")).toHaveLength(1);
    c.track("after-close", { key: "user-1" });
    await tick();
    expect(e.of("/v1/track")).toHaveLength(1);
  });
});
