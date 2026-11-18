import { describe, expect, it } from "vitest";
import { ApiError, ManagementClient, apiRoot, explainError } from "../src/api";
import { TOKEN, fakeApi } from "./fake-api";

describe("ManagementClient", () => {
  it("normalises the base URL to the /api/v1 root", () => {
    expect(apiRoot(undefined)).toBe("https://edge.nanoflags.io/api/v1");
    expect(apiRoot("https://edge.nanoflags.io/")).toBe("https://edge.nanoflags.io/api/v1");
    expect(apiRoot("http://localhost:8787/api/v1")).toBe("http://localhost:8787/api/v1");
  });

  it("sends the bearer token and follows pagination", async () => {
    const api = fakeApi();
    const c = new ManagementClient({ token: TOKEN, baseUrl: "https://edge.test", fetch: api.fetch });
    const flags = await c.flags("web");
    expect(flags.map((f) => f.key)).toEqual(["new-checkout", "accent-color", "old-banner"]);
    expect(api.requests.map((r) => r.url)).toEqual(["/api/v1/projects/web/flags?archived=all&limit=100", "/api/v1/projects/web/flags?archived=all&limit=100&cursor=c2"]);
    expect(api.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("turns error envelopes into ApiError with readable explanations", async () => {
    const api = fakeApi();
    const c = new ManagementClient({ token: "nf_api_wrong", baseUrl: "https://edge.test", fetch: api.fetch });
    const err = await c.token().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(explainError(err)).toMatch(/Sign In/);
    api.failWith = { status: 403, code: "FORBIDDEN", message: "scope" };
    expect(explainError(await c.projects().catch((e) => e))).toMatch(/flags:read/);
  });

  it("reports network failures", async () => {
    const c = new ManagementClient({ token: TOKEN, baseUrl: "https://edge.test", fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    const err = await c.token().catch((e) => e);
    expect(err.code).toBe("NETWORK");
    expect(explainError(err)).toMatch(/offline/);
  });
});
