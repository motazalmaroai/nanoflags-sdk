import { afterEach, describe, expect, it, vi } from "vitest";
import type { NanoFlagsClient } from "../src/index";
import { BASE, CLIENT_KEY, SERVER_KEY, mockEdge, tick } from "./helpers";

/**
 * Developer warnings: an `error` with no listener is logged once per error code (per client), and a server key used
 * in a browser is logged once per process. Each test imports a fresh module so the process-wide flag starts unset.
 */
const clients: NanoFlagsClient[] = [];
async function load() {
  vi.resetModules();
  return import("../src/index");
}
function browser() {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined });
}
const nanoflagsWarnings = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[nanoflags]"));

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unhandled error events", () => {
  it("are logged with console.warn once per error code when no error listener is attached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createClient } = await load();
    const edge = mockEdge({ bundle: new Error("offline") });
    const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, fetch: edge.fetch, streaming: false, pollIntervalMs: 0, events: false, store: false });
    clients.push(c);
    await c.ready();
    await c.refresh();
    await c.refresh();
    const logged = nanoflagsWarnings(warn);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("network:");
    expect(logged[0]).toContain('client.on("error"');
  });

  it("logs each distinct code once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createClient } = await load();
    const edge = mockEdge({ bundle: new Error("offline") });
    // An invalid bootstrap emits invalid_bundle; the failing fetch emits network.
    const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, fetch: edge.fetch, streaming: false, pollIntervalMs: 0, events: false, store: false, bootstrap: { nope: true } as never });
    clients.push(c);
    await c.ready();
    await c.refresh();
    await tick();
    const logged = nanoflagsWarnings(warn);
    expect(logged.filter((m) => m.includes("invalid_bundle:"))).toHaveLength(1);
    expect(logged.filter((m) => m.includes("network:"))).toHaveLength(1);
  });

  it("are not logged when an error listener is attached (it receives them instead)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createClient } = await load();
    const edge = mockEdge({ bundle: new Error("offline") });
    const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, fetch: edge.fetch, streaming: false, pollIntervalMs: 0, events: false, store: false });
    clients.push(c);
    const seen: string[] = [];
    c.on("error", (e) => seen.push((e as { code?: string }).code ?? ""));
    await c.ready();
    await c.refresh();
    // Every failed load is emitted to the listener; only the console logging is deduplicated.
    expect(seen.filter((code) => code === "network").length).toBeGreaterThanOrEqual(2);
    expect(nanoflagsWarnings(warn)).toHaveLength(0);
  });
});

describe("server key in a browser", () => {
  it("warns once per process, however many clients are created", async () => {
    browser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createClient } = await load();
    for (let i = 0; i < 3; i++) {
      const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, fetch: mockEdge().fetch, streaming: false, pollIntervalMs: 0, events: false, store: false });
      c.on("error", () => undefined);
      clients.push(c);
    }
    const logged = nanoflagsWarnings(warn).filter((m) => m.includes("server key"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("nf_pub_");
  });

  it("does not warn for a client key in a browser", async () => {
    browser();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createClient } = await load();
    const c = createClient({ sdkKey: CLIENT_KEY, baseUrl: BASE, fetch: mockEdge().fetch, streaming: false, pollIntervalMs: 0, events: false, store: false });
    c.on("error", () => undefined);
    clients.push(c);
    expect(nanoflagsWarnings(warn).filter((m) => m.includes("server key"))).toHaveLength(0);
  });

  it("does not warn for a server key outside a browser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createClient } = await load();
    const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, fetch: mockEdge().fetch, streaming: false, pollIntervalMs: 0, events: false, store: false });
    c.on("error", () => undefined);
    clients.push(c);
    expect(nanoflagsWarnings(warn).filter((m) => m.includes("server key"))).toHaveLength(0);
  });
});
