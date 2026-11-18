/** A fetch() that answers like the Management API for one project ("web"), for tests. */
export const TOKEN = "nf_api_" + "ab".repeat(24);

export interface FakeApi {
  fetch: typeof fetch;
  requests: { url: string; auth: string | null }[];
  flags: any[];
  failWith?: { status: number; code: string; message: string };
}

const flag = (key: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${key}`, key, name: key, description: "", type: "boolean", purpose: "release", permanent: false, clientExposed: false,
  initialValue: false, jsonSchema: null, ownerId: null, reviewDate: null, archivedAt: null, createdAt: "2026-01-01T00:00:00Z", ...extra,
});

export function fakeApi(): FakeApi {
  const api: FakeApi = {
    requests: [],
    flags: [
      flag("new-checkout", { name: "New checkout", description: "Rebuilt *checkout*", clientExposed: true }),
      flag("accent-color", { name: "Accent color", type: "string", purpose: "experiment" }),
      flag("old-banner", { name: "Old banner", archivedAt: "2026-05-01T10:00:00Z" }),
    ],
    fetch: undefined as unknown as typeof fetch,
  };
  const envs = [
    { id: "e1", key: "development", name: "Development", sort: 0, isProtected: false, requireApproval: false, publishedRevision: 3 },
    { id: "e2", key: "production", name: "Production", sort: 1, isProtected: true, requireApproval: true, publishedRevision: 0 },
  ];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    api.requests.push({ url: url.pathname + url.search, auth });
    if (api.failWith) return json(api.failWith.status, { error: { code: api.failWith.code, message: api.failWith.message } });
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: { code: "UNAUTHORIZED", message: "Missing, unknown, revoked or expired token." } });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    if (p === "/token") return json(200, { id: "t", name: "Laptop", prefix: TOKEN.slice(0, 14), orgId: "o", projectId: null, projectKey: null, scopes: ["flags:read"], expiresAt: "2099-01-01T00:00:00Z", status: "active" });
    if (p === "/projects") return json(200, { data: [{ id: "p1", key: "web", name: "Web app", defaultEnvironment: "development" }], nextCursor: null });
    if (p === "/projects/web/environments") return json(200, { data: envs, nextCursor: null });
    if (p === "/projects/web/flags") {
      // Two pages, to exercise pagination.
      const cursor = url.searchParams.get("cursor");
      return cursor ? json(200, { data: api.flags.slice(2), nextCursor: null }) : json(200, { data: api.flags.slice(0, 2), nextCursor: "c2" });
    }
    if (p === "/projects/web/environments/development/draft")
      return json(200, { environment: "development", checksum: "x", publishedRevision: 3, publishedChecksum: "y", dirty: true, bundle: { flags: { "new-checkout": { type: "boolean", enabled: true, rules: [{ id: "r" }], default: false, off: false }, "accent-color": { type: "string", enabled: false, rules: [], default: "blue", off: "grey" } } } });
    if (p === "/projects/web/environments/development/revisions/3")
      return json(200, { number: 3, bundle: { flags: { "new-checkout": { type: "boolean", enabled: false, rules: [], default: false, off: false } } } });
    if (p === "/projects/web/environments/production/draft")
      return json(200, { environment: "production", checksum: "z", publishedRevision: 0, publishedChecksum: null, dirty: true, bundle: { flags: { "new-checkout": { type: "boolean", enabled: false, rules: [], default: false, off: false } } } });
    return json(404, { error: { code: "not_found", message: `no route ${p}` } });
  }) as typeof fetch;
  return api;
}
