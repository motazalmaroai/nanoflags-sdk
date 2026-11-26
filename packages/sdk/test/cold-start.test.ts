import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, NanoFlagsError, type ClientOptions, type NanoFlagsClient, type StateEvent } from "../src/index";
import { BASE, SERVER_KEY, bundleResponse, makeBundle, memoryStore, mockEdge } from "./helpers";

const clients: NanoFlagsClient[] = [];
function make(opts: Partial<ClientOptions>) {
  const c = createClient({ sdkKey: SERVER_KEY, baseUrl: BASE, streaming: false, pollIntervalMs: 0, events: false, store: false, ...opts });
  clients.push(c);
  return c;
}
function watch(c: NanoFlagsClient) {
  const errors: NanoFlagsError[] = [];
  const states: StateEvent[] = [];
  c.on("error", (e) => errors.push(e as NanoFlagsError));
  c.on("state", (e) => states.push(e));
  return { errors, states };
}
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  vi.useRealTimers();
});

describe("cold start without any configuration", () => {
  it("is `starting` until the first attempt has finished", async () => {
    const c = make({ fetch: mockEdge({ bundle: new Error("offline") }).fetch });
    expect(c.state).toBe("starting");
    expect(c.lastError).toBeNull();
    await c.ready();
    expect(c.state).toBe("failed");
  });

  for (const httpStatus of [401, 403]) {
    it(`invalid key (HTTP ${httpStatus}): state failed, lastError INVALID_KEY, error event, evaluations say CONFIG_NOT_LOADED`, async () => {
      const c = make({ fetch: mockEdge({ bundle: new Response('{"error":"unauthorized"}', { status: httpStatus }) }).fetch });
      const { errors, states } = watch(c);
      await c.ready();
      expect(c.state).toBe("failed");
      expect(c.status).toBe("not-ready"); // unchanged meaning
      expect(c.lastError).toMatchObject({ code: "INVALID_KEY", httpStatus, message: "The SDK key was rejected (unknown or revoked)." });
      expect(typeof c.lastError!.at).toBe("string");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(NanoFlagsError);
      expect(errors[0]!.code).toBe("unauthorized");
      expect(errors[0]!.errorCode).toBe("INVALID_KEY");
      expect(states).toEqual([{ state: "failed", previous: "starting", error: c.lastError }]);
      expect(c.boolean("checkout-v2", true)).toBe(true);
      expect(c.evaluate("checkout-v2", false)).toMatchObject({ value: false, reason: "flag_not_found", errorCode: "CONFIG_NOT_LOADED", revision: 0 });
    });
  }

  it("edge unreachable: EDGE_UNREACHABLE", async () => {
    const c = make({ fetch: mockEdge({ bundle: new TypeError("fetch failed") }).fetch });
    const { errors } = watch(c);
    await c.ready();
    expect(c.state).toBe("failed");
    expect(c.lastError).toMatchObject({ code: "EDGE_UNREACHABLE", message: "Could not reach the NanoFlags edge: fetch failed" });
    expect(c.lastError!.httpStatus).toBeUndefined();
    expect(errors.map((e) => [e.code, e.errorCode])).toEqual([["network", "EDGE_UNREACHABLE"]]);
    expect(c.evaluate("anything", "fb").errorCode).toBe("CONFIG_NOT_LOADED");
  });

  it("edge answering 5xx: HTTP_ERROR with the status", async () => {
    const c = make({ fetch: mockEdge({ bundle: new Response("bad gateway", { status: 502 }) }).fetch });
    const { errors } = watch(c);
    await c.ready();
    expect(c.state).toBe("failed");
    expect(c.lastError).toMatchObject({ code: "HTTP_ERROR", httpStatus: 502 });
    expect(errors[0]!.errorCode).toBe("HTTP_ERROR");
  });

  it("edge not answering: TIMEOUT after 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    const c = make({ fetch: fetch as unknown as typeof globalThis.fetch });
    const { errors, states } = watch(c);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(c.state).toBe("starting");
    await vi.advanceTimersByTimeAsync(1);
    await c.ready();
    expect(c.state).toBe("failed");
    expect(c.lastError).toMatchObject({ code: "TIMEOUT", message: "Could not reach the NanoFlags edge: no answer within 10 seconds." });
    expect(errors.map((e) => [e.code, e.errorCode])).toEqual([["network", "TIMEOUT"]]);
    expect(states.map((s) => s.state)).toEqual(["failed"]);
  });

  it("recovers later: failed → ready, lastError cleared, real values and FLAG_NOT_FOUND for missing flags", async () => {
    const edge = mockEdge({ bundle: new Response("", { status: 401 }) });
    const c = make({ fetch: edge.fetch });
    const { states } = watch(c);
    await c.ready();
    expect(c.state).toBe("failed");
    edge.replies.bundle = new Error("offline");
    await c.refresh();
    expect(c.state).toBe("failed");
    expect(c.lastError!.code).toBe("EDGE_UNREACHABLE"); // the most recent failure
    edge.replies.bundle = bundleResponse(makeBundle(5));
    await c.refresh();
    expect(c.state).toBe("ready");
    expect(c.status).toBe("ready");
    expect(c.lastError).toBeNull();
    expect(states.map((s) => [s.previous, s.state])).toEqual([
      ["starting", "failed"],
      ["failed", "ready"],
    ]);
    expect(states[1]!.error).toBeNull();
    expect(c.evaluate("max-items", 1)).toMatchObject({ value: 20, reason: "default" });
    expect(c.evaluate("max-items", 1).errorCode).toBeUndefined();
    expect(c.evaluate("no-such-flag", 1)).toMatchObject({ value: 1, reason: "flag_not_found", errorCode: "FLAG_NOT_FOUND" });
  });

  it("a stored configuration is used: stale (not failed) while the edge is down, with lastError set", async () => {
    const seed = mockEdge({ bundle: bundleResponse(makeBundle(4)) });
    const store = memoryStore();
    const first = make({ fetch: seed.fetch, store });
    await first.ready();
    await new Promise((r) => setTimeout(r, 0));
    first.close();
    const c = make({ fetch: mockEdge({ bundle: new Error("offline") }).fetch, store });
    await c.ready(); // resolves with the stored bundle, possibly before the edge request has failed
    expect(c.state).toBe("stale");
    await c.refresh();
    expect(c.state).toBe("stale");
    expect(c.lastError!.code).toBe("EDGE_UNREACHABLE");
    expect(c.evaluate("max-items", 1)).toMatchObject({ value: 20, reason: "default" });
  });

  it("a bootstrap bundle is ready even when the edge is down; the failure is still visible", async () => {
    const c = make({ fetch: mockEdge({ bundle: new Response("", { status: 403 }) }).fetch, bootstrap: makeBundle(2) });
    expect(c.state).toBe("ready");
    await c.ready();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.state).toBe("stale");
    expect(c.lastError!.code).toBe("INVALID_KEY");
  });

  it("missing sdkKey / baseUrl: failed at once with CONFIG", () => {
    const c = make({ sdkKey: "", fetch: mockEdge().fetch });
    expect(c.state).toBe("failed");
    expect(c.lastError!.code).toBe("CONFIG");
  });

  it("started in the background (paused): stays starting until the first request after resume()", async () => {
    let control: { resume(): void } | null = null;
    const c = make({
      fetch: mockEdge({ bundle: new Response("", { status: 401 }) }).fetch,
      lifecycle: (ctl) => {
        ctl.pause();
        control = ctl;
      },
    });
    await c.ready();
    expect(c.state).toBe("starting");
    control!.resume();
    await c.refresh();
    expect(c.state).toBe("failed");
    expect(c.lastError!.code).toBe("INVALID_KEY");
  });

  it("errors that are not about loading the configuration leave lastError alone", async () => {
    const c = make({ fetch: mockEdge({ bundle: bundleResponse(makeBundle(1)) }).fetch, experiments: { enabled: true } });
    const { errors } = watch(c);
    await c.ready();
    c.track("not a valid name!");
    expect(errors.map((e) => e.code)).toEqual(["config"]);
    expect(c.lastError).toBeNull();
    expect(c.state).toBe("ready");
  });

  it("an engine newer than the SDK is UNSUPPORTED_ENGINE", async () => {
    const c = make({ fetch: mockEdge({ bundle: bundleResponse({ ...makeBundle(9), engine: 99 }) }).fetch });
    const { errors } = watch(c);
    await c.ready();
    expect(c.state).toBe("failed");
    expect(c.lastError!.code).toBe("UNSUPPORTED_ENGINE");
    expect(errors[0]!.errorCode).toBe("UNSUPPORTED_ENGINE");
  });

  it("an invalid answer is INVALID_BUNDLE", async () => {
    const c = make({ fetch: mockEdge({ bundle: new Response('{"nope":true}', { status: 200 }) }).fetch });
    watch(c);
    await c.ready();
    expect(c.state).toBe("failed");
    expect(c.lastError!.code).toBe("INVALID_BUNDLE");
  });
});
