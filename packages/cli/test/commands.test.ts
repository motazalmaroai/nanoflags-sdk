import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_KEY, BASE, CI_KEY, EXPORT, FIXTURES, SERVER_KEY, apiError, cli, json, tempDir, tempRepo } from "./helpers";

const RUN_OK = {
  source: "draft",
  checksum: "abc123",
  publishedRevision: 4,
  passed: 2,
  failed: 0,
  results: [
    { id: "s1", name: "Signed-in US user gets v2", flag: "checkout-v2", expected: true, actual: true, passed: true, reason: "rule_match" },
    { id: "s2", name: "Ranking | default", flag: "search-ranking", expected: "relevance-v2", actual: "relevance-v2", passed: true, reason: "default" },
  ],
};
const RUN_FAIL = { ...RUN_OK, passed: 1, failed: 1, results: [RUN_OK.results[0]!, { ...RUN_OK.results[1]!, actual: "relevance-v1", passed: false }] };

describe("general", () => {
  it("--help, --version, no command, unknown command, unknown option", async () => {
    expect((await cli(["--help"])).out).toContain("Usage: nanoflags <command>");
    expect((await cli(["--version"])).out).toBe("0.2.0\n");
    expect((await cli([])).code).toBe(2);
    expect(await cli(["frobnicate"])).toMatchObject({ code: 2, out: "" });
    expect((await cli(["export", "--nope"])).code).toBe(2);
  });

  it("the key comes from NANOFLAGS_KEY or --key and is sent as a bearer token, never in the URL", async () => {
    const env = await cli(["export"]);
    expect(env.calls[0]!.headers.get("Authorization")).toBe(`Bearer ${ADMIN_KEY}`);
    const flag = await cli(["export", "--key", CI_KEY], { env: { NANOFLAGS_KEY: undefined } });
    expect(flag.calls[0]!.headers.get("Authorization")).toBe(`Bearer ${CI_KEY}`);
    expect(await cli(["export"], { env: { NANOFLAGS_KEY: undefined } })).toMatchObject({ code: 2, calls: [] });
    expect((await cli(["export"], { env: { NANOFLAGS_KEY: "  " } })).err).toContain("NANOFLAGS_KEY");
  });

  it("base URL: flag beats environment, https is required except for localhost", async () => {
    const r = await cli(["export", "--base-url", `${BASE}/`]);
    expect(r.code).toBe(0);
    expect(await cli(["export", "--base-url", "http://flags.example.com"])).toMatchObject({ code: 2, calls: [] });
    expect(await cli(["export", "--base-url", "not a url"])).toMatchObject({ code: 2, calls: [] });
    expect((await cli(["export", "--base-url", "http://localhost:8787"])).code).toBe(3); // accepted, then unreachable in this test
  });

  it("errors: rejected key → 2, wrong key kind → 2, unreachable → 3, server error → 3; the key is never printed", async () => {
    const rejected = await cli(["export"], { routes: { "GET /v1/admin/export": apiError(401, "unauthorized", "Unknown or revoked key.") } });
    expect(rejected.code).toBe(2);
    const forbidden = await cli(["export"], { env: { NANOFLAGS_KEY: SERVER_KEY }, routes: { "GET /v1/admin/export": apiError(403, "forbidden", "CI or admin key required.") } });
    expect(forbidden.code).toBe(2);
    expect(forbidden.err).toContain("server key");
    const offline = await cli(["export"], { routes: { "GET /v1/admin/export": new Error("getaddrinfo ENOTFOUND") } });
    expect(offline.code).toBe(3);
    const down = await cli(["export"], { routes: { "GET /v1/admin/export": apiError(503, "unavailable", "Try later.") } });
    expect(down.code).toBe(3);
    const old = await cli(["export"], { routes: { "GET /v1/admin/export": apiError(404, "not_found", "Unknown endpoint.") } });
    expect(old.code).toBe(3);
    for (const r of [rejected, forbidden, offline, down, old]) expect(r.out + r.err).not.toMatch(/nf_(adm|srv|ci)_/);
  });
});

describe("export / flags list", () => {
  it("export prints the export as JSON", async () => {
    const r = await cli(["export"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(EXPORT);
    expect(r.calls).toMatchObject([{ method: "GET", path: "/v1/admin/export" }]);
  });

  it("export --out writes a file and keeps stdout clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nanoflags-cli-"));
    const r = await cli(["export", "--out", "flags.json"], { cwd: dir });
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(JSON.parse(readFileSync(join(dir, "flags.json"), "utf8"))).toEqual(EXPORT);
  });

  it("flags list shows a table; --json prints the flags", async () => {
    const r = await cli(["flags", "list"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("commerce · 6 flags · state shown for staging (draft)");
    expect(lines[2]).toMatch(/^KEY\s+TYPE\s+PURPOSE\s+LIFETIME\s+CLIENT\s+STATE$/);
    expect(r.out).toMatch(/checkout-v2\s+boolean\s+release\s+temporary\s+no\s+on/);
    expect(r.out).toMatch(/kill-switch\s+boolean\s+ops\s+permanent\s+no\s+off/);
    expect(r.out).toMatch(/old-banner\s+boolean\s+release\s+temporary\s+no\s+archived/);
    expect(JSON.parse((await cli(["flags", "list", "--json"])).out)).toHaveLength(6);
  });

  it("--export reads a saved export and makes no request", async () => {
    const r = await cli(["flags", "list", "--export", "export.json"], { env: { NANOFLAGS_KEY: undefined } });
    expect(r).toMatchObject({ code: 0, calls: [] });
    expect(await cli(["flags", "list", "--export", "missing.json"])).toMatchObject({ code: 2 });
  });
});

describe("eval", () => {
  it("evaluates the draft locally: value, reason, trace", async () => {
    const r = await cli(["eval", "checkout-v2", "--context", '{"key":"u1","signedIn":true}']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("checkout-v2 = true\n");
    expect(r.out).toMatch(/reason: rule_match · rule r1 \(#2\) · inside rollout \(bucket \d+\.\d\d\)/);
    expect(r.out).toContain("source: draft of staging");
    expect(r.out).toContain("Rule 01 did not match");
    expect(r.out).toContain("Rule 02 matched");
    expect(r.calls.map((c) => c.path)).toEqual(["/v1/admin/export"]); // evaluation itself is local
  });

  it("segments, defaults and disabled flags resolve like in the SDK", async () => {
    expect((await cli(["eval", "checkout-v2", "--context", '{"email":"a@nanoflags.dev"}'])).out).toContain("rule staff (#1)");
    expect((await cli(["eval", "checkout-v2"])).out).toContain("checkout-v2 = false\nreason: default");
    expect((await cli(["eval", "kill-switch"])).out).toContain("kill-switch = false\nreason: off");
    expect((await cli(["eval", "checkout-v2", "--environment", "production"])).out).toContain("reason: off");
  });

  it("--json prints the full evaluation", async () => {
    const r = await cli(["eval", "search-ranking", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ flagKey: "search-ranking", value: "relevance-v2", reason: "default", revision: 0, source: "draft of staging" });
  });

  it("an unknown flag returns the fallback with reason flag_not_found", async () => {
    const r = await cli(["eval", "nope", "--fallback", '"fb"']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nope = "fb"\nreason: flag_not_found');
  });

  it("--source published evaluates the bundle SDKs receive, with an SDK key", async () => {
    const bundle = { schema: 1, project: "commerce", environment: "staging", revision: 4, segments: {}, flags: { "search-ranking": { type: "string", enabled: true, default: "published-value", off: "off", rules: [] } } };
    const routes = { "GET /v1/bundle": json({ revision: 4, checksum: "c4", bundle }) };
    const r = await cli(["eval", "search-ranking", "--source", "published"], { env: { NANOFLAGS_SDK_KEY: SERVER_KEY }, routes });
    expect(r.code).toBe(0);
    expect(r.out).toContain('search-ranking = "published-value"');
    expect(r.out).toContain("source: published r4");
    expect(r.calls.map((c) => c.path)).toEqual(["/v1/bundle"]);
    expect(r.calls[0]!.headers.get("Authorization")).toBe(`Bearer ${SERVER_KEY}`); // not the admin key
    expect((await cli(["eval", "search-ranking", "--source", "published"], { env: { NANOFLAGS_KEY: SERVER_KEY }, routes })).code).toBe(0);
    // The SDK key wins over a CI / admin key when both are set.
    const both = await cli(["eval", "search-ranking", "--source", "published"], { env: { NANOFLAGS_SDK_KEY: SERVER_KEY, NANOFLAGS_KEY: CI_KEY }, routes });
    expect(both.calls.map((c) => [c.path, c.headers.get("Authorization")])).toEqual([["/v1/bundle", `Bearer ${SERVER_KEY}`]]);
  });

  it("--source published with a CI or admin key reads GET /v1/ci/published", async () => {
    const bundle = { schema: 1, project: "commerce", environment: "staging", revision: 6, segments: {}, flags: { "search-ranking": { type: "string", enabled: true, default: "from-ci-endpoint", off: "off", rules: [] } } };
    const routes = { "GET /v1/ci/published": json({ revision: 6, checksum: "c6", bundle }) };
    for (const key of [CI_KEY, ADMIN_KEY]) {
      const r = await cli(["eval", "search-ranking", "--source", "published", "--json"], { env: { NANOFLAGS_KEY: key }, routes });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ source: "published r6", value: "from-ci-endpoint" });
      expect(r.calls.map((c) => [c.method, c.path, c.headers.get("Authorization")])).toEqual([["GET", "/v1/ci/published", `Bearer ${key}`]]);
    }
    // Nothing published yet → usage-class exit with a clear message.
    const none = await cli(["eval", "search-ranking", "--source", "published"], { routes: { "GET /v1/ci/published": apiError(422, "INVALID_STATE", "Nothing has been published in this environment yet.") } });
    expect(none.code).toBe(2);
    expect(none.err).toContain("Nothing is published");
    // An older edge without the endpoint: explained, exit 3.
    const old = await cli(["eval", "search-ranking", "--source", "published"], { routes: {} });
    expect(old.code).toBe(3);
    expect(old.err).toContain("does not offer this endpoint");
    // No key at all.
    expect(await cli(["eval", "search-ranking", "--source", "published"], { env: { NANOFLAGS_KEY: undefined } })).toMatchObject({ code: 2, calls: [] });
    // Unknown / revoked key.
    expect((await cli(["eval", "search-ranking", "--source", "published"], { routes: { "GET /v1/ci/published": apiError(401, "unauthorized", "Unknown key.") } })).code).toBe(2);
  });

  it("usage errors", async () => {
    expect((await cli(["eval"])).code).toBe(2);
    expect((await cli(["eval", "checkout-v2", "--context", "{not json"])).code).toBe(2);
    expect((await cli(["eval", "checkout-v2", "--context", "[1]"])).code).toBe(2);
    expect((await cli(["eval", "checkout-v2", "--source", "revision"])).code).toBe(2);
    expect((await cli(["eval", "checkout-v2", "--environment", "nope"])).code).toBe(2);
  });
});

describe("scenarios run", () => {
  it("all passing: table, exit 0, request carries source, commit and run URL", async () => {
    const r = await cli(["scenarios", "run", "--commit", "0123abc", "--run-url", "https://ci.example/run/1"], { env: { NANOFLAGS_KEY: CI_KEY }, routes: { "POST /v1/ci/scenarios/run": json(RUN_OK) } });
    expect(r.code).toBe(0);
    expect(r.calls).toMatchObject([{ method: "POST", path: "/v1/ci/scenarios/run", body: { source: "draft", commit: "0123abc", runUrl: "https://ci.example/run/1" } }]);
    expect(r.calls[0]!.headers.get("Authorization")).toBe(`Bearer ${CI_KEY}`);
    expect(r.out).toMatch(/^RESULT\s+SCENARIO\s+FLAG\s+EXPECTED\s+ACTUAL\s+REASON$/m);
    expect(r.out).toMatch(/^pass\s+Signed-in US user gets v2\s+checkout-v2\s+true\s+true\s+rule_match$/m);
    expect(r.out).toContain("2 passed, 0 failed · source draft · checksum abc123 · published r4");
  });

  it("a failing scenario exits 1", async () => {
    const r = await cli(["scenarios", "run", "--source", "revision"], { routes: { "POST /v1/ci/scenarios/run": json({ ...RUN_FAIL, source: "revision" }) } });
    expect(r.code).toBe(1);
    expect(r.calls[0]!.body).toEqual({ source: "revision" });
    expect(r.out).toMatch(/^FAIL\s+Ranking \| default\s+search-ranking\s+relevance-v2\s+relevance-v1/m);
    expect(r.err).toContain("1 scenario failed.");
  });

  it("the exit code follows the individual results even if the counters disagree", async () => {
    const r = await cli(["scenarios", "run"], { routes: { "POST /v1/ci/scenarios/run": json({ ...RUN_FAIL, failed: 0, passed: 2 }) } });
    expect(r.code).toBe(1);
  });

  it("--json prints the run and still exits 1 on failure", async () => {
    const r = await cli(["scenarios", "run", "--json"], { routes: { "POST /v1/ci/scenarios/run": json(RUN_FAIL) } });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ passed: 1, failed: 1, results: [{ id: "s1" }, { id: "s2", passed: false }] });
  });

  it("no scenarios: exit 0 with a clear message", async () => {
    const r = await cli(["scenarios", "run"], { routes: { "POST /v1/ci/scenarios/run": json({ ...RUN_OK, passed: 0, results: [] }) } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No scenarios are included in CI");
  });

  it("GitHub Actions: commit and run URL default from the environment and a Markdown summary is appended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nanoflags-cli-"));
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "earlier step\n");
    const env = { GITHUB_STEP_SUMMARY: summary, GITHUB_SHA: "deadbeefdeadbeefdeadbeef", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/shop", GITHUB_RUN_ID: "42" };
    const r = await cli(["scenarios", "run"], { env, routes: { "POST /v1/ci/scenarios/run": json(RUN_FAIL) } });
    expect(r.code).toBe(1);
    expect(r.calls[0]!.body).toEqual({ source: "draft", commit: "deadbeefdeadbeefdeadbeef", runUrl: "https://github.com/acme/shop/actions/runs/42" });
    const md = readFileSync(summary, "utf8");
    expect(md.startsWith("earlier step\n### NanoFlags scenarios: FAILED\n")).toBe(true);
    expect(md).toContain("**1 passed, 1 failed** · source `draft` · checksum `abc123` · published r4 · commit `deadbeefdead`");
    expect(md).toContain("| **FAIL** | Ranking \\| default | `search-ranking` | `relevance-v2` | `relevance-v1` | default |");
    expect(md).toContain("| pass | Signed-in US user gets v2 | `checkout-v2` | `true` | `true` | rule_match |");
  });

  it("an SDK key is refused (exit 2); bad --source is a usage error", async () => {
    const r = await cli(["scenarios", "run"], { env: { NANOFLAGS_KEY: SERVER_KEY }, routes: { "POST /v1/ci/scenarios/run": apiError(403, "forbidden", "CI or admin key required.") } });
    expect(r.code).toBe(2);
    expect(await cli(["scenarios", "run", "--source", "published"])).toMatchObject({ code: 2, calls: [] });
  });
});

describe("flags create", () => {
  const created = (over: Record<string, unknown> = {}) => json({ id: "f1", key: "new-checkout", name: "new-checkout", type: "boolean", default: false, environments: ["development", "staging", "production"], ...over }, 201);

  it("creates a boolean flag (default false) with an admin key", async () => {
    const r = await cli(["flags", "create", "new-checkout", "--description", "New checkout flow"], { routes: { "POST /v1/admin/flags": created() } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Created new-checkout (boolean, default false).");
    expect(r.out).toContain("(development, staging, production). Nothing was published.");
    expect(r.calls).toMatchObject([{ method: "POST", path: "/v1/admin/flags", body: { key: "new-checkout", type: "boolean", default: false, description: "New checkout flow" } }]);
    expect(r.calls[0]!.headers.get("Authorization")).toBe(`Bearer ${ADMIN_KEY}`);
  });

  it("parses --default as JSON per type; a bare word is a string for string flags", async () => {
    const route = { "POST /v1/admin/flags": (c: { body: unknown }) => json({ id: "f", ...(c.body as object) }, 201) };
    const s = await cli(["flags", "create", "theme", "--type", "string", "--default", "blue", "--name", "Theme", "--json"], { routes: route });
    expect(s.code).toBe(0);
    expect(s.calls[0]!.body).toEqual({ key: "theme", type: "string", default: "blue", description: "", name: "Theme" });
    expect(JSON.parse(s.out)).toMatchObject({ key: "theme", default: "blue" });
    const n = await cli(["flags", "create", "limit", "--type", "number", "--default", "25"], { routes: route });
    expect(n.calls[0]!.body).toMatchObject({ type: "number", default: 25 });
    const j = await cli(["flags", "create", "cfg", "--type", "json", "--default", '{"a":[1,2]}'], { routes: route });
    expect(j.calls[0]!.body).toMatchObject({ type: "json", default: { a: [1, 2] } });
  });

  it("refuses bad input before any request", async () => {
    for (const argv of [
      ["flags", "create"],
      ["flags", "create", "Bad Key"],
      ["flags", "create", "ok", "--type", "date"],
      ["flags", "create", "ok", "--type", "number"],
      ["flags", "create", "ok", "--type", "number", "--default", "ten"],
      ["flags", "create", "ok", "--type", "boolean", "--default", '"yes"'],
      ["flags", "create", "ok", "--type", "string", "--default", "3"],
      ["flags", "create", "ok", "--name", ""],
    ]) {
      expect(await cli(argv), argv.join(" ")).toMatchObject({ code: 2, calls: [] });
    }
  });

  it("needs an admin key: a CI key never reaches the network", async () => {
    const r = await cli(["flags", "create", "x"], { env: { NANOFLAGS_KEY: CI_KEY } });
    expect(r).toMatchObject({ code: 2, calls: [] });
    expect(r.err).toContain("needs an admin key");
  });

  it("CONFLICT → exit 1 with the server's message; 401 → exit 2; 5xx → exit 3", async () => {
    const dup = await cli(["flags", "create", "new-checkout"], { routes: { "POST /v1/admin/flags": apiError(409, "CONFLICT", 'A flag with the key "new-checkout" already exists in this project.') } });
    expect(dup.code).toBe(1);
    expect(dup.err).toContain('Flag not created: A flag with the key "new-checkout" already exists in this project. [CONFLICT]');
    expect((await cli(["flags", "create", "x"], { routes: { "POST /v1/admin/flags": apiError(401, "unauthorized", "Unknown key.") } })).code).toBe(2);
    expect((await cli(["flags", "create", "x"], { routes: { "POST /v1/admin/flags": apiError(503, "unavailable", "Try again.") } })).code).toBe(3);
  });

  it("an older edge without the endpoint is explained", async () => {
    const r = await cli(["flags", "create", "x"], { routes: {} });
    expect(r.code).toBe(3);
    expect(r.err).toContain("does not offer this endpoint");
  });
});

describe("publish", () => {
  it("publishes with the expected revision and note", async () => {
    const r = await cli(["publish", "--expected-revision", "4", "--note", "ship it"], { routes: { "POST /v1/admin/publish": json({ revision: 5, checksum: "def456" }) } });
    expect(r.code).toBe(0);
    expect(r.out).toBe("Published r5 (checksum def456).\n");
    expect(r.calls).toMatchObject([{ method: "POST", path: "/v1/admin/publish", body: { expectedRevision: 4, note: "ship it" } }]);
  });

  it.each([
    ["DESTINATION_CHANGED", 409, "Staging is now r5. This request expected r4. Nothing was published.", "Someone published in the meantime"],
    ["NO_CHANGES", 409, "The draft is identical to the published configuration.", "There is nothing to publish"],
    ["CHANGE_REQUIRED", 422, "Production requires a reviewed change. Publish it from the dashboard.", "an admin key cannot bypass review"],
    ["SCENARIOS_REQUIRED", 422, "All saved scenarios must pass on the current draft.", "nanoflags scenarios run --source draft"],
  ])("%s → exit 1 with the server's message and what to do next", async (code, status, message, hint) => {
    const r = await cli(["publish", "--expected-revision", "4"], { routes: { "POST /v1/admin/publish": apiError(status, code, message) } });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain(`Publish refused: ${message} [${code}]`);
    expect(r.err).toContain(hint);
  });

  it("requires --expected-revision and an admin key; a CI key never reaches the network", async () => {
    expect(await cli(["publish"])).toMatchObject({ code: 2, calls: [] });
    expect(await cli(["publish", "--expected-revision", "latest"])).toMatchObject({ code: 2, calls: [] });
    const ci = await cli(["publish", "--expected-revision", "4"], { env: { NANOFLAGS_KEY: CI_KEY } });
    expect(ci).toMatchObject({ code: 2, calls: [] });
    expect(ci.err).toContain("CI keys can run scenarios and upload references, never publish");
  });
});

describe("refs scan", () => {
  const expected = [
    { flag: "layout", path: "scripts/legacy.cjs", line: 2, snippet: 'module.exports = () => flags.json("layout", null);' },
    { flag: "checkout-v2", path: "src/checkout.ts", line: 4, snippet: 'if (flags.boolean("checkout-v2", false, ctx)) {' },
    { flag: "max-items", path: "src/checkout.ts", line: 7, snippet: 'const limit = flags.number("max-items", 10, ctx);' },
    { flag: "search-ranking", path: "src/checkout.ts", line: 8, snippet: 'const details = flags.evaluate("search-ranking", "relevance-v1", ctx);' },
    { flag: "search-ranking", path: "src/checkout.ts", line: 9, snippet: 'const template = flags.string(`search-ranking`, "relevance-v1");' },
    { flag: "old-banner", path: "src/components/Banner.tsx", line: 4, snippet: 'const show = useFlag("old-banner", false);' },
    { flag: "layout", path: "src/components/Banner.tsx", line: 5, snippet: 'const layout = useFlag<{ columns: number }>("layout", { columns: 1 });' },
    { flag: "checkout-v2", path: "src/openfeature.mjs", line: 2, snippet: 'const on = await client.getBooleanValue("checkout-v2", false);' },
    { flag: "search-ranking", path: "src/openfeature.mjs", line: 3, snippet: 'const d = await client.getStringDetails("search-ranking", "x");' },
    { flag: "kill-switch", path: "src/view.jsx", line: 1, snippet: 'export const View = ({ flags }) => <p>{flags?.boolean("kill-switch", true) ? "on" : "off"}</p>;' },
  ];

  it("finds literal references to known flags in ts/tsx/js/jsx/mjs/cjs and uploads them", async () => {
    const dir = tempRepo();
    const r = await cli(["refs", "scan", dir, "--repo", "acme/shop", "--commit", "abc1234"], { env: { NANOFLAGS_KEY: CI_KEY }, routes: { "PUT /v1/ci/code-refs": json({ stored: 10 }) } });
    expect(r.code).toBe(0);
    const put = r.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/v1/ci/code-refs");
    expect(put.body).toEqual({ repo: "acme/shop", commit: "abc1234", refs: expected });
    expect(r.out).toContain("10 references to 6 of 6 flags in 5 files.");
    expect(r.err).toContain("10 references stored for acme/shop at abc1234");
  });

  it("skips node_modules, dist, build, .next, .git, declaration files and other extensions", async () => {
    const dir = tempRepo();
    expect(readdirSync(dir).sort()).toEqual([".git", ".next", "build", "dist", "node_modules", "scripts", "src"]);
    const r = await cli(["refs", "scan", dir, "--dry-run", "--json"]);
    const paths = (JSON.parse(r.out) as { refs: Array<{ path: string }> }).refs.map((x) => x.path);
    expect([...new Set(paths)]).toEqual(["scripts/legacy.cjs", "src/checkout.ts", "src/components/Banner.tsx", "src/openfeature.mjs", "src/view.jsx"]);
  });

  it("--dry-run prints what it found and uploads nothing; --repo is not needed", async () => {
    const r = await cli(["refs", "scan", "repo", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/admin/export"]);
    expect(r.out).toMatch(/^checkout-v2\s+src\/checkout\.ts:4\s+if \(flags\.boolean/m);
    expect(r.err).toContain("Dry run: nothing was uploaded.");
  });

  it("respects the file size cap", async () => {
    const dir = tempDir({ "small.ts": 'flags.boolean("checkout-v2", false);\n', "big.ts": `flags.boolean("checkout-v2", false);\n// ${"x".repeat(5000)}\n` });
    const r = await cli(["refs", "scan", dir, "--dry-run", "--json", "--max-file-size", "1000"]);
    expect((JSON.parse(r.out) as { refs: unknown[] }).refs).toHaveLength(1);
    expect(r.err).toContain("Skipped big.ts: larger than the file size cap.");
  });

  it("repo and commit default from GitHub Actions; a missing or malformed repo is a usage error", async () => {
    const r = await cli(["refs", "scan", "repo"], { env: { GITHUB_REPOSITORY: "acme/shop", GITHUB_SHA: "feedface" }, routes: { "PUT /v1/ci/code-refs": json({ stored: 10 }) } });
    expect(r.calls.at(-1)!.body).toMatchObject({ repo: "acme/shop", commit: "feedface" });
    expect(await cli(["refs", "scan", "repo"])).toMatchObject({ code: 2, calls: [] });
    expect(await cli(["refs", "scan", "repo", "--repo", "not a repo"])).toMatchObject({ code: 2, calls: [] });
    expect(await cli(["refs", "scan", "does-not-exist", "--repo", "a/b"])).toMatchObject({ code: 2, calls: [] });
  });
});

describe("cleanup", () => {
  const files = {
    "src/a.ts": 'export function f(ctx: C) {\n  if (flags.boolean("checkout-v2", false, ctx)) {\n    return v2();\n  } else {\n    return v1();\n  }\n}\n',
    "src/b.ts": 'export const d = flags.evaluate("checkout-v2", false);\nexport const t = flags.boolean("checkout-v2", false) ? "new" : "old";\n',
    "src/c.ts": 'export const unrelated = flags.boolean("kill-switch", true);\n',
    "node_modules/x/index.js": 'flags.boolean("checkout-v2", false) ? 1 : 2;\n',
  };

  it("default is a dry run: prints a unified diff, lists what it did not transform, changes no file", async () => {
    const dir = tempDir(files);
    const r = await cli(["cleanup", "checkout-v2", "--value", "true", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,7 +1,3 @@",
        " export function f(ctx: C) {",
        '-  if (flags.boolean("checkout-v2", false, ctx)) {',
        "-    return v2();",
        "-  } else {",
        "-    return v1();",
        "-  }",
        "+  return v2();",
        " }",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1,2 +1,2 @@",
        ' export const d = flags.evaluate("checkout-v2", false);',
        '-export const t = flags.boolean("checkout-v2", false) ? "new" : "old";',
        '+export const t = "new";',
        "",
      ].join("\n"),
    );
    expect(r.err).toContain("Would rewrite 2 references in 2 files.");
    expect(r.err).toContain("NOT transformed (1)");
    expect(r.err).toContain('src/b.ts:1  export const d = flags.evaluate("checkout-v2", false);');
    expect(r.err).toContain("evaluate() returns an evaluation object, not the value");
    expect(r.err).toContain("Dry run: no file was changed.");
    for (const [name, text] of Object.entries(files)) expect(readFileSync(join(dir, name), "utf8")).toBe(text);
  });

  it("--write edits the files in place and nothing else", async () => {
    const dir = tempDir(files);
    const r = await cli(["cleanup", "checkout-v2", "--value", "false", dir, "--write"]);
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("export function f(ctx: C) {\n  return v1();\n}\n");
    expect(readFileSync(join(dir, "src/b.ts"), "utf8")).toBe('export const d = flags.evaluate("checkout-v2", false);\nexport const t = "old";\n');
    expect(readFileSync(join(dir, "src/c.ts"), "utf8")).toBe(files["src/c.ts"]);
    expect(readFileSync(join(dir, "node_modules/x/index.js"), "utf8")).toBe(files["node_modules/x/index.js"]);
    expect(readdirSync(dir).sort()).toEqual(["node_modules", "src"]); // no .git, no backup files, nothing new
    expect(r.err).toContain("Nothing was committed or pushed");
  });

  it("refuses a flag marked permanent, before touching any file", async () => {
    const dir = tempDir(files);
    const r = await cli(["cleanup", "kill-switch", "--value", "true", dir, "--write"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain('"kill-switch" is marked permanent');
    expect(r.err).toContain("Nothing was changed");
    expect(readFileSync(join(dir, "src/c.ts"), "utf8")).toBe(files["src/c.ts"]);
  });

  it("refuses unknown flags, a value of the wrong type and a missing value", async () => {
    expect((await cli(["cleanup", "nope", "--value", "true", "repo"])).code).toBe(2);
    const wrong = await cli(["cleanup", "checkout-v2", "--value", '"yes"', "repo"]);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain("is a boolean flag");
    expect((await cli(["cleanup", "checkout-v2", "repo"])).code).toBe(2);
    expect((await cli(["cleanup", "checkout-v2", "--value", "tru", "repo"])).code).toBe(2);
    expect((await cli(["cleanup"])).code).toBe(2);
  });

  it("works from a saved export without a key", async () => {
    const dir = tempDir(files);
    const r = await cli(["cleanup", "checkout-v2", "--value", "true", dir, "--export", join(FIXTURES, "export.json")], { env: { NANOFLAGS_KEY: undefined } });
    expect(r).toMatchObject({ code: 0, calls: [] });
    expect(r.out).toContain("+  return v2();");
  });

  it("never runs git or any other program, and never talks to anything but the NanoFlags API", () => {
    const src = join(FIXTURES, "..", "..", "src");
    for (const f of readdirSync(src)) {
      const text = readFileSync(join(src, f), "utf8");
      expect(text).not.toMatch(/child_process|execSync|spawn\(|github\.com\/repos|api\.github\.com/);
    }
  });
});
