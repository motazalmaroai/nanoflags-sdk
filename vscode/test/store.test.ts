import { describe, expect, it } from "vitest";
import { ManagementClient } from "../src/api";
import { FlagStore } from "../src/store";
import { TOKEN, fakeApi } from "./fake-api";

function setup(now = { t: 1000 }) {
  const api = fakeApi();
  const client = new ManagementClient({ token: TOKEN, baseUrl: "https://edge.test", fetch: api.fetch });
  const store = new FlagStore(() => client, { ttlMs: 60_000, now: () => now.t });
  return { api, store, now };
}

describe("FlagStore", () => {
  it("loads flags, environments, drafts and published revisions", async () => {
    const { store, api } = setup();
    let changes = 0;
    store.onDidChange(() => changes++);
    await store.refresh("web");
    expect(store.loaded).toBe(true);
    expect(changes).toBe(1);
    expect(store.project?.name).toBe("Web app");
    expect(store.flags.map((f) => f.key)).toEqual(["accent-color", "new-checkout", "old-banner"]);
    const s = store.statusOf("new-checkout");
    expect(s.map((x) => x.environment.key)).toEqual(["development", "production"]);
    expect(s[0]!.published?.enabled).toBe(false);
    expect(s[0]!.draft?.enabled).toBe(true);
    expect(s[1]!.published).toBeNull();
    // production has nothing published: no revision request
    expect(api.requests.some((r) => r.url.includes("production/revisions"))).toBe(false);
  });

  it("caches until the TTL and shares concurrent loads", async () => {
    const { store, api, now } = setup();
    await Promise.all([store.refresh("web"), store.refresh("web")]);
    const n = api.requests.length;
    await store.ensureFresh("web");
    expect(api.requests.length).toBe(n);
    now.t += 61_000;
    expect(store.isStale()).toBe(true);
    await store.ensureFresh("web");
    expect(api.requests.length).toBe(2 * n);
  });

  it("keeps the last data and records the error when a refresh fails", async () => {
    const { store, api } = setup();
    await store.refresh("web");
    api.failWith = { status: 503, code: "UNAVAILABLE", message: "down" };
    await store.refresh("web");
    expect(store.lastError).toBeDefined();
    expect(store.get("new-checkout")).toBeDefined();
    store.clear();
    expect(store.loaded).toBe(false);
  });
});
