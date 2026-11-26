import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, type Io } from "../src/main";
import { connectUrl, decodeConnection, encodeConnection, oneTimeCode, CODE_RE, type Connection } from "../src/init/connect";
import { detect, installCommand, keyKindFor, serviceName } from "../src/init/detect";
import { clientFile, ensureIgnored, envPlan, isIgnored, mergeEnv, parseEnv, usageSnippet } from "../src/init/files";
import { BASE, apiError, json, tempDir, type Call } from "./helpers";

const pkg = (o: Record<string, unknown>) => JSON.stringify({ name: "acme-web", ...o });
const TOKEN = `nf_api_${"a".repeat(48)}`;
const SRV = "nf_srv_live_1234567890abcdef";
const PUB = "nf_pub_live_1234567890abcdef";

describe("detect", () => {
  it("Next.js app and pages router, src dir, TypeScript, package manager", () => {
    const app = detect(tempDir({ "package.json": pkg({ dependencies: { next: "16", react: "19" }, devDependencies: { typescript: "5" } }), "src/app/page.tsx": "", "pnpm-lock.yaml": "" }));
    expect(app).toMatchObject({ framework: "next-app", packageManager: "pnpm", typescript: true, srcDir: true, service: "acme-web", hasSdk: false });
    const pages = detect(tempDir({ "package.json": pkg({ dependencies: { next: "14" } }), "pages/index.js": "", "yarn.lock": "" }));
    expect(pages).toMatchObject({ framework: "next-pages", packageManager: "yarn", typescript: false, srcDir: false });
    // A bare Next.js project defaults to the App Router.
    expect(detect(tempDir({ "package.json": pkg({ dependencies: { next: "16" } }) })).framework).toBe("next-app");
  });

  it("Vite (+React), Create React App, Node servers, unsupported frameworks", () => {
    expect(detect(tempDir({ "package.json": pkg({ devDependencies: { vite: "7" }, dependencies: { react: "19" } }), "bun.lock": "" }))).toMatchObject({ framework: "vite-react", packageManager: "bun" });
    expect(detect(tempDir({ "package.json": pkg({ devDependencies: { vite: "7" } }) })).framework).toBe("vite");
    expect(detect(tempDir({ "package.json": pkg({ dependencies: { "react-scripts": "5", react: "18" } }) })).framework).toBe("react");
    expect(detect(tempDir({ "package.json": pkg({ type: "module", dependencies: { express: "5", "@nanoflags/sdk": "0.8.1" } }) }))).toMatchObject({ framework: "node", server: "express", esm: true, hasSdk: true });
    expect(detect(tempDir({ "package.json": pkg({ dependencies: { "@sveltejs/kit": "2" }, devDependencies: { vite: "7" } }) }))).toMatchObject({ framework: "vite", unsupported: "SvelteKit" });
    expect(detect(tempDir({ "package.json": pkg({ packageManager: "pnpm@10.0.0" }), "package-lock.json": "" })).packageManager).toBe("pnpm");
    expect(() => detect(tempDir({ "README.md": "" }))).toThrow(/No package.json/);
  });

  it("helpers", () => {
    expect(serviceName("@acme/Checkout Web!")).toBe("checkout-web");
    expect(serviceName("")).toBe("my-app");
    expect(installCommand("npm")).toEqual(["npm", ["install", "@nanoflags/sdk"]]);
    expect(installCommand("pnpm")).toEqual(["pnpm", ["add", "@nanoflags/sdk"]]);
    expect(keyKindFor("vite-react")).toBe("client");
    expect(keyKindFor("next-app")).toBe("server");
  });
});

describe("files", () => {
  it("parses dotenv files", () => {
    const m = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=val # note\nbad line\nA=3\n');
    expect(Object.fromEntries(m)).toEqual({ A: "3", B: "two words", C: "x", D: "val" });
  });

  it("adds missing variables, never replaces without consent, keeps other lines", async () => {
    const dir = tempDir({ ".env.local": "OTHER=1\nNANOFLAGS_SDK_KEY=nf_srv_old\n" });
    const path = join(dir, ".env.local");
    const ask = vi.fn(async () => false);
    const r = await mergeEnv(path, [["NANOFLAGS_SDK_KEY", SRV], ["NANOFLAGS_BASE_URL", "http://localhost:8787"]], ask);
    expect(r).toEqual([{ name: "NANOFLAGS_SDK_KEY", status: "kept" }, { name: "NANOFLAGS_BASE_URL", status: "added" }]);
    expect(ask).toHaveBeenCalledWith("NANOFLAGS_SDK_KEY", "nf_srv_old");
    expect(readFileSync(path, "utf8")).toBe("OTHER=1\nNANOFLAGS_SDK_KEY=nf_srv_old\n\n# NanoFlags (written by `nanoflags init`)\nNANOFLAGS_BASE_URL=http://localhost:8787\n");
    const again = await mergeEnv(path, [["NANOFLAGS_SDK_KEY", SRV]], async () => true);
    expect(again).toEqual([{ name: "NANOFLAGS_SDK_KEY", status: "replaced" }]);
    expect(parseEnv(readFileSync(path, "utf8")).get("NANOFLAGS_SDK_KEY")).toBe(SRV);
    expect(readFileSync(path, "utf8")).toContain("OTHER=1\n");
    const fresh = join(tempDir({}), ".env");
    expect(await mergeEnv(fresh, [["X", "1"]], ask)).toEqual([{ name: "X", status: "added" }]);
    expect(readFileSync(fresh, "utf8")).toBe("# NanoFlags (written by `nanoflags init`)\nX=1\n");
  });

  it("gitignore matching and appending", () => {
    expect(isIgnored(".env*\n", ".env.local")).toBe(true);
    expect(isIgnored("*.local\n", ".env.local")).toBe(true);
    expect(isIgnored("/.env\n", ".env")).toBe(true);
    expect(isIgnored(".env\n", ".env.local")).toBe(false);
    expect(isIgnored(".env*\n!.env.local\n", ".env.local")).toBe(false);
    expect(isIgnored("config/.env\n", ".env")).toBe(false);
    const dir = tempDir({ ".gitignore": "node_modules" });
    expect(ensureIgnored(dir, ".env")).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n\n# NanoFlags SDK key (written by `nanoflags init`)\n.env\n");
    expect(ensureIgnored(dir, ".env")).toBe(false);
    const none = tempDir({});
    expect(ensureIgnored(none, ".env.local")).toBe(true);
    expect(readFileSync(join(none, ".gitignore"), "utf8")).toBe("# NanoFlags SDK key (written by `nanoflags init`)\n.env.local\n");
  });

  it("client files per framework", () => {
    const base = { unsupported: null, packageManager: "npm", typescript: true, esm: false, srcDir: true, service: "acme-web", hasSdk: false, server: null } as const;
    const next = clientFile({ ...base, framework: "next-app" }, "next-app", "https://edge.nanoflags.io");
    expect(next.path).toBe("src/lib/nanoflags.ts");
    expect(next.content).toContain("process.env.NANOFLAGS_SDK_KEY");
    expect(next.content).toContain('service: "acme-web"');
    expect(next.content).toContain("export async function getFlags(): Promise<NanoFlagsClient>");
    const vite = clientFile({ ...base, framework: "vite-react" }, "vite-react", "http://localhost:8787");
    expect(vite).toMatchObject({ path: "src/nanoflags.ts" });
    expect(vite.content).toContain("import.meta.env.VITE_NANOFLAGS_KEY");
    expect(vite.content).toContain('"http://localhost:8787"');
    const cjs = clientFile({ ...base, typescript: false, srcDir: false, framework: "node" }, "node", "https://edge.nanoflags.io");
    expect(cjs.path).toBe("nanoflags.js");
    expect(cjs.content).toContain('require("@nanoflags/sdk")');
    expect(cjs.content).toContain("module.exports = { flags }");
    const esm = clientFile({ ...base, typescript: false, esm: true, srcDir: false, framework: "node" }, "node", "https://edge.nanoflags.io");
    expect(esm.content).toContain("export const flags = createClient");
    expect(envPlan("react").keyVar).toBe("REACT_APP_NANOFLAGS_KEY");
    expect(usageSnippet("vite-react", vite, "welcome-banner", { ...base, framework: "vite-react" })).toContain('useFlag("welcome-banner", false)');
    expect(usageSnippet("next-app", next, "welcome-banner", { ...base, framework: "next-app" })).toContain('import { getFlags } from "@/lib/nanoflags"');
  });
});

describe("connection string", () => {
  const conn: Connection = { v: 1, code: "ABCD-2345", token: TOKEN, tokenExpiresAt: "2026-11-25T22:00:00Z", sdkKey: SRV, sdkKeyKind: "server", project: { key: "acme", name: "Acme" }, environment: { key: "development", name: "Development" }, edgeUrl: null };
  it("round-trips and is bound to its code", () => {
    expect(CODE_RE.test(oneTimeCode())).toBe(true);
    expect(oneTimeCode(() => 0)).toBe("AAAA-AAAA");
    const s = encodeConnection(conn);
    expect(s.startsWith("nfcli1_")).toBe(true);
    expect(decodeConnection(` ${s.slice(0, 20)}\n${s.slice(20)} `, "ABCD-2345")).toEqual(conn);
    expect(() => decodeConnection(s, "WXYZ-2345")).toThrow(/made for code ABCD-2345/);
    expect(() => decodeConnection("hello", "ABCD-2345")).toThrow(/not a NanoFlags connection string/);
    expect(() => decodeConnection(encodeConnection({ ...conn, token: "nf_adm_x" }), "ABCD-2345")).toThrow(/not valid/);
    expect(connectUrl("https://app.nanoflags.io", { code: "ABCD-2345", framework: "next-app", kind: "server", reuseKey: false, publish: false, environment: "development" })).toBe(
      "https://app.nanoflags.io/app/cli/connect?code=ABCD-2345&framework=next-app&kind=server&env=development",
    );
  });
});

/* ---------------- end to end, mocked API ---------------- */

type Route = (call: Call) => Response;

function mockApi(state: { flagExists: boolean; reportAfter: number; requireApproval?: boolean; reportRevision?: number }) {
  const calls: Call[] = [];
  let polls = 0;
  let revision = 3;
  const env = () => ({ id: "e1", key: "development", name: "Development", isProtected: false, requireApproval: state.requireApproval ?? false, requireScenarios: false, publishedRevision: revision });
  const routes: Record<string, Route> = {
    "GET /api/v1/projects": () => json({ data: [{ id: "p1", key: "acme", name: "Acme" }], nextCursor: null }),
    "GET /api/v1/projects/acme/environments/development": () => json(env()),
    "GET /api/v1/projects/acme/flags/welcome-banner": () => (state.flagExists ? json({ id: "f1", key: "welcome-banner", type: "boolean", clientExposed: true, archivedAt: null }) : apiError(404, "NOT_FOUND", "Flag not found.")),
    "POST /api/v1/projects/acme/flags": (c) => {
      state.flagExists = true;
      return json({ id: "f1", key: "welcome-banner", type: "boolean", clientExposed: (c.body as { clientExposed: boolean }).clientExposed, archivedAt: null }, 201);
    },
    "PATCH /api/v1/projects/acme/flags/welcome-banner/environments/development": () => json({}),
    "POST /api/v1/projects/acme/environments/development/publish": () => json({ environment: "development", revision: ++revision, checksum: "c" }),
    "GET /api/v1/projects/acme/insights": () => {
      polls++;
      return json({ services: polls >= state.reportAfter ? [{ service: "acme-web", sdk: "js/0.8.1", revision: state.reportRevision ?? revision, lastSeenAt: new Date(clock).toISOString() }, { service: "old", sdk: "js/0.7.0", revision: 1, lastSeenAt: "2020-01-01T00:00:00Z" }] : [] });
    },
  };
  let clock = Date.parse("2026-11-25T21:00:00Z");
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.origin !== BASE) throw new Error(`unexpected origin ${url.origin}`);
    const r = routes[`${call.method} ${call.path}`];
    return r ? r(call) : apiError(404, "not_found", "Unknown endpoint.");
  });
  return { calls, fetch, now: () => clock, sleep: async (ms: number) => void (clock += ms), polls: () => polls };
}

async function runInit(argv: string[], o: { dir: string; answers?: (q: string, out: string) => string; api: ReturnType<typeof mockApi>; exec?: Io["exec"]; env?: Record<string, string> }) {
  let out = "";
  let err = "";
  const opened: string[] = [];
  const io: Io = {
    env: { NANOFLAGS_BASE_URL: BASE, ...o.env },
    cwd: o.dir,
    fetch: o.api.fetch as unknown as typeof fetch,
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    sleep: o.api.sleep,
    now: o.api.now,
    ...(o.answers ? { prompt: async (q: string) => o.answers!(q, out), open: (u: string) => void opened.push(u) } : {}),
    exec: o.exec ?? (async () => 0),
  };
  const code = await main(["init", ...argv], io);
  return { code, out, err, opened };
}

function connectionFor(out: string, over: Partial<Connection> = {}): string {
  const code = /one-time code is ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)![1]!;
  return encodeConnection({ v: 1, code, token: TOKEN, tokenExpiresAt: "2026-11-25T22:00:00Z", sdkKey: SRV, sdkKeyKind: "server", project: { key: "acme", name: "Acme" }, environment: { key: "development", name: "Development" }, edgeUrl: BASE, ...over });
}

describe("init (mocked API)", () => {
  it("interactive Next.js run: browser sign-in, install, files, flag, no publish by default, first report", async () => {
    const dir = tempDir({ "package.json": pkg({ dependencies: { next: "16", react: "19" }, devDependencies: { typescript: "5" }, scripts: { dev: "next dev" } }), "app/page.tsx": "", ".gitignore": "node_modules\n" });
    const api = mockApi({ flagExists: false, reportAfter: 3 });
    const exec = vi.fn(async () => 0);
    const r = await runInit([], { dir, api, exec, answers: (q, out) => (q.startsWith("Paste") ? connectionFor(out) : "") });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.opened[0]).toMatch(/^https:\/\/app\.nanoflags\.io\/app\/cli\/connect\?code=[A-Z0-9-]{9}&framework=next-app&kind=server&env=development$/);
    expect(exec).toHaveBeenCalledWith("npm", ["install", "@nanoflags/sdk"], dir);
    expect(parseEnv(readFileSync(join(dir, ".env.local"), "utf8")).get("NANOFLAGS_SDK_KEY")).toBe(SRV);
    // The test edge is not the default one, so its URL is written too.
    expect(parseEnv(readFileSync(join(dir, ".env.local"), "utf8")).get("NANOFLAGS_BASE_URL")).toBe(BASE);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env.local");
    expect(readFileSync(join(dir, "lib/nanoflags.ts"), "utf8")).toContain("getFlags");
    const create = api.calls.find((c) => c.method === "POST" && c.path === "/api/v1/projects/acme/flags")!;
    expect(create.body).toMatchObject({ key: "welcome-banner", type: "boolean", initialValue: false, clientExposed: false });
    expect(create.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(api.calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    expect(r.out).toContain("Nothing was published");
    expect(r.out).toContain("await getFlags()");
    expect(r.out).toContain("✓ revision 3 is live in Development (acme-web, js/0.8.1)");
    expect(r.out).not.toContain(SRV); // keys are never printed in full
    expect(r.out).not.toContain(TOKEN);
  });

  it("--yes with --token and --key: no questions, no overwrite, publishes only with --publish", async () => {
    const dir = tempDir({ "package.json": pkg({ type: "module", dependencies: { express: "5", "@nanoflags/sdk": "0.8.1" } }), ".env": "NANOFLAGS_SDK_KEY=nf_srv_existing_key_000\n" });
    const api = mockApi({ flagExists: true, reportAfter: 1 });
    const exec = vi.fn(async () => 0);
    const r = await runInit(["--yes", "--token", TOKEN, "--key", SRV, "--publish", "--wait", "30"], { dir, api, exec });
    expect(r.code).toBe(0);
    expect(exec).not.toHaveBeenCalled(); // already a dependency
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("NANOFLAGS_SDK_KEY=nf_srv_existing_key_000");
    expect(r.out).toContain("kept your existing NANOFLAGS_SDK_KEY");
    expect(readFileSync(join(dir, "nanoflags.js"), "utf8")).toContain("export const flags");
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: true, default: true });
    expect(api.calls.find((c) => c.path.endsWith("/publish"))!.body).toMatchObject({ expectedRevision: 3 });
    expect(r.out).toContain("✓ Published revision 4 to Development");
    expect(r.out).toContain("✓ revision 4 is live in Development");
  });

  it("refuses to publish where the environment needs a reviewed change", async () => {
    const dir = tempDir({ "package.json": pkg({ dependencies: { "@nanoflags/sdk": "0.8.1" } }) });
    const api = mockApi({ flagExists: true, reportAfter: 1, requireApproval: true });
    const r = await runInit(["--yes", "--token", TOKEN, "--key", SRV, "--publish"], { dir, api });
    expect(r.code).toBe(0);
    expect(api.calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    expect(r.out).toContain("publishes through a reviewed change");
  });

  it("a report without a configuration (revision 0) is not success when something is published", async () => {
    const dir = tempDir({ "package.json": pkg({ dependencies: { "@nanoflags/sdk": "0.8.1" } }) });
    const api = mockApi({ flagExists: true, reportAfter: 1, reportRevision: 0 });
    const r = await runInit(["--yes", "--token", TOKEN, "--key", SRV, "--wait", "6"], { dir, api });
    expect(r.code).toBe(1);
    expect(r.out).toContain("without a configuration loaded (revision 0)");
  });

  it("times out with troubleshooting", async () => {
    const dir = tempDir({ "package.json": pkg({ dependencies: { "@nanoflags/sdk": "0.8.1" } }) });
    const api = mockApi({ flagExists: true, reportAfter: Infinity });
    const r = await runInit(["--yes", "--token", TOKEN, "--key", SRV, "--wait", "9"], { dir, api });
    expect(r.code).toBe(1);
    expect(api.polls()).toBe(3);
    expect(r.out).toContain('No report from "acme-web" in Development after 9s');
    expect(r.out).toContain("node --env-file=.env");
  });

  it("browser apps need a client key; reuses a client key already in .env.local", async () => {
    const dir = tempDir({ "package.json": pkg({ devDependencies: { vite: "7" }, dependencies: { react: "19", "@nanoflags/sdk": "0.8.1" } }), ".env.local": `VITE_NANOFLAGS_KEY=${PUB}\n` });
    const api = mockApi({ flagExists: false, reportAfter: 1 });
    const bad = await runInit(["--yes", "--key", SRV], { dir, api });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("needs a client key");
    let url = "";
    const r = await runInit(["--wait", "0"], { dir, api, answers: (q, out) => {
      if (q.startsWith("Paste")) {
        url = /(https:\/\/\S+connect\S+)/.exec(out)![1]!;
        return connectionFor(out, { sdkKey: null, sdkKeyKind: "client" });
      }
      return "n";
    } });
    expect(r.code).toBe(0);
    expect(url).toContain("reuse=1");
    expect(r.out).toContain("VITE_NANOFLAGS_KEY already set (reusing this key)");
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/api/v1/projects/acme/flags")!.body).toMatchObject({ clientExposed: true });
    expect(existsSync(join(dir, "src/nanoflags.ts"))).toBe(false); // no TypeScript: .js
    expect(readFileSync(join(dir, "src/nanoflags.js"), "utf8")).toContain("import.meta.env.VITE_NANOFLAGS_KEY");
  });

  it("rejects a wrong connection string three times, and needs a key or a terminal", async () => {
    const dir = tempDir({ "package.json": pkg({}) });
    const api = mockApi({ flagExists: true, reportAfter: 1 });
    const r = await runInit([], { dir, api, answers: () => "nfcli1_nope" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("after 3 attempts");
    expect(api.calls).toHaveLength(0);
    const ci = await runInit(["--yes"], { dir, api });
    expect(ci.code).toBe(2);
    expect(ci.err).toContain("needs --key");
    const files = await runInit(["--yes", "--key", SRV, "--skip-install"], { dir, api });
    expect(files.code).toBe(0);
    expect(files.out).toContain("Install the SDK: npm install @nanoflags/sdk");
    expect(files.out).toContain("writing the files only");
    expect(existsSync(join(dir, "nanoflags.js"))).toBe(true);
  });

  it("never overwrites an existing client file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nanoflags-init-"));
    writeFileSync(join(dir, "package.json"), pkg({ dependencies: { "@nanoflags/sdk": "0.8.1" } }));
    writeFileSync(join(dir, "nanoflags.js"), "// mine\n");
    const api = mockApi({ flagExists: true, reportAfter: 1 });
    const r = await runInit(["--yes", "--key", SRV], { dir, api });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "nanoflags.js"), "utf8")).toBe("// mine\n");
    expect(r.out).toContain("already exists and was left as it is");
  });
});
