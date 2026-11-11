import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { main, type Io } from "../src/main";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const EXPORT = JSON.parse(readFileSync(join(FIXTURES, "export.json"), "utf8")) as Record<string, unknown>;
export const BASE = "https://edge.test";
export const ADMIN_KEY = "nf_adm_test_0000000000000000";
export const CI_KEY = "nf_ci_test_0000000000000000";
export const SERVER_KEY = "nf_srv_test_0000000000000000";

export interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Reply = Response | Error | ((call: Call) => Response);

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const apiError = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

/** Runs the CLI in-process with a scripted edge. Routes are keyed by "METHOD /path". */
export async function cli(argv: string[], opts: { routes?: Record<string, Reply>; env?: Record<string, string | undefined>; cwd?: string } = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Reply> = { "GET /v1/admin/export": json(EXPORT), ...opts.routes };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url.origin !== BASE) throw new Error(`unexpected origin ${url.origin}`);
    const reply = routes[`${call.method} ${call.path}`] ?? apiError(404, "not_found", "Unknown endpoint.");
    const r = typeof reply === "function" ? reply(call) : reply;
    if (r instanceof Error) throw r;
    return r.clone();
  });
  let out = "";
  let err = "";
  const io: Io = {
    env: { NANOFLAGS_KEY: ADMIN_KEY, NANOFLAGS_BASE_URL: BASE, ...opts.env },
    cwd: opts.cwd ?? FIXTURES,
    fetch: fetch as unknown as typeof globalThis.fetch,
    out: (t) => void (out += t),
    err: (t) => void (err += t),
  };
  const code = await main(argv, io);
  return { code, out, err, calls };
}

/** A throw-away copy of the fixture repository, plus directories that must be skipped. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nanoflags-cli-"));
  cpSync(join(FIXTURES, "repo"), dir, { recursive: true });
  for (const skipped of ["node_modules/pkg", "dist", "build", ".next/server", ".git/hooks"]) {
    mkdirSync(join(dir, skipped), { recursive: true });
    writeFileSync(join(dir, skipped, "index.js"), 'flags.boolean("checkout-v2", false);\n');
  }
  return dir;
}

export function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nanoflags-cli-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
