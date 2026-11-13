/**
 * `nanoflags import <file> --project <key> [--env-map src=target,…] [--format …] [--conflict skip|rename|overwrite]
 *  [--dry-run] [--json] [--label <text>]`
 *
 * Sends the file to the Management API (`POST /api/v1/projects/{project}/imports`) with an API token
 * (`NANOFLAGS_API_TOKEN`, scope flags:write; segments:write when the file has segments). The server converts it,
 * checks fidelity and writes drafts only. This command never publishes.
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { CliError, EXIT, clip, table } from "./util.js";

export const IMPORT_FORMATS = ["auto", "flagd", "nanoflags", "csv", "launchdarkly", "unleash", "flagsmith", "growthbook"] as const;
const MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;

export interface ImportOptions {
  file: string;
  project: string;
  token: string;
  baseUrl: string;
  envMap?: string;
  format?: string;
  conflict?: string;
  renameSuffix?: string;
  label?: string;
  dryRun: boolean;
  json: boolean;
  fetch: typeof fetch;
  userAgent: string;
  out: (t: string) => void;
  err: (t: string) => void;
}

interface Warning {
  severity: string;
  code: string;
  message: string;
  flag?: string;
  segment?: string;
  environment?: string;
}
interface Result {
  dryRun: boolean;
  source: string;
  sourceEnvironments: string[];
  envMap: Record<string, string>;
  counts: { flags: Record<string, number>; segments: Record<string, number> };
  items: { kind: string; key: string; sourceKey: string; action: string; note?: string }[];
  conflicts: { kind: string; key: string; resolution: string; finalKey: string; note: string }[];
  warnings: Warning[];
  invalid: { kind: string; key: string; problems: string[] }[];
  fidelity: { method: string; summary: Record<string, number>; caveats: string[]; flags: { flag: string; environment: string; status: string; contexts: number; matched: number; note?: string }[] };
  import: { id: string; status: string; created: number; overwritten: number; skipped: number; failed: number } | null;
  failures: { kind: string; key: string; error: string }[];
}

export function parseEnvMap(raw: string | undefined): Record<string, string | null> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const out: Record<string, string | null> = {};
  for (const part of raw.split(",")) {
    const m = /^\s*([^=\s]+)\s*=\s*([^=\s]*)\s*$/.exec(part);
    if (!m) throw new CliError(`--env-map must look like "source=target,other=target2" (got "${part}").\nRun \`nanoflags --help\` for usage.`, EXIT.usage);
    out[m[1]!] = m[2] === "" || m[2] === "-" ? null : m[2]!;
  }
  return out;
}

export async function runImportCommand(o: ImportOptions): Promise<number> {
  if (!/^nf_api_[0-9a-f]{48}$/.test(o.token)) throw new CliError("`import` needs a Management API token: set NANOFLAGS_API_TOKEN (nf_api_…, scope flags:write; also segments:write when the file has segments).", EXIT.usage);
  if (!o.project) throw new CliError("`import` needs --project <key>.\nRun `nanoflags --help` for usage.", EXIT.usage);
  if (o.format !== undefined && !(IMPORT_FORMATS as readonly string[]).includes(o.format)) throw new CliError(`--format must be one of ${IMPORT_FORMATS.join(", ")}.`, EXIT.usage);
  if (o.conflict !== undefined && !["skip", "rename", "overwrite"].includes(o.conflict)) throw new CliError("--conflict must be skip, rename or overwrite.", EXIT.usage);
  let size: number;
  try {
    size = statSync(o.file).size;
  } catch {
    throw new CliError(`Cannot read ${o.file}.`, EXIT.usage);
  }
  if (size > MAX_BYTES) throw new CliError(`${o.file} is larger than 4 MB; split it into several imports.`, EXIT.usage);
  const content = readFileSync(o.file, "utf8");
  const format = o.format ?? (/\.csv$/i.test(o.file) ? "csv" : "auto");
  const body = {
    format,
    content,
    ...(o.envMap !== undefined ? { envMap: parseEnvMap(o.envMap) } : {}),
    ...(o.conflict ? { conflict: o.conflict } : {}),
    ...(o.renameSuffix ? { renameSuffix: o.renameSuffix } : {}),
    ...(o.label ? { label: o.label } : {}),
    dryRun: o.dryRun,
  };
  const text = JSON.stringify(body);
  // Re-running the same apply (same file and options) is answered from the first run instead of importing twice.
  const idem: Record<string, string> = o.dryRun ? {} : { "Idempotency-Key": `cli-import-${createHash("sha256").update(`${o.project}\n${text}`).digest("hex").slice(0, 40)}` };
  let res: Response;
  try {
    res = await o.fetch(`${o.baseUrl}/api/v1/projects/${encodeURIComponent(o.project)}/imports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": o.userAgent, ...idem },
      body: text,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new CliError(`Could not reach ${o.baseUrl}: ${e instanceof Error ? e.message : String(e)}`, EXIT.unavailable);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const msg = `${err?.message ?? `HTTP ${res.status}`}${err?.code ? ` [${err.code}]` : ""}`;
    if (res.status === 401) throw new CliError(`The API token was rejected: ${msg}`, EXIT.usage);
    if (res.status === 403) throw new CliError(`Not allowed: ${msg}`, EXIT.usage);
    if (res.status >= 500) throw new CliError(`NanoFlags could not import right now: ${msg}`, EXIT.unavailable);
    throw new CliError(`Import refused: ${msg}`, EXIT.failed);
  }
  const r = json as Result;
  if (o.json) {
    o.out(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    report(r, o.out);
  }
  if (!r.dryRun && r.import && (r.import.status !== "completed" || r.failures.length > 0)) return EXIT.failed;
  return EXIT.ok;
}

function report(r: Result, out: (t: string) => void): void {
  out(`${r.dryRun ? "Dry run (nothing written)" : "Imported into drafts (nothing published)"} · source ${r.source} · environments ${Object.entries(r.envMap).map(([s, t]) => `${s}→${t}`).join(", ") || "none mapped"}\n\n`);
  const c = r.counts;
  out(`${table(["", "CREATE", "OVERWRITE", "SKIP"], [["flags", String(c.flags.create), String(c.flags.overwrite), String(c.flags.skip)], ["segments", String(c.segments.create), String(c.segments.overwrite), String(c.segments.skip)]])}\n`);
  if (r.conflicts.length) {
    out(`\nConflicts with existing keys (${r.conflicts.length}):\n`);
    for (const x of r.conflicts) out(`  ${x.kind} ${x.key} → ${x.resolution}${x.finalKey !== x.key ? ` as ${x.finalKey}` : ""}  ${clip(x.note, 100)}\n`);
  }
  const important = r.warnings.filter((w) => w.severity !== "info");
  if (important.length) {
    out(`\nWarnings (${important.length}; ${r.warnings.length - important.length} info not shown, use --json):\n`);
    for (const w of important.slice(0, 50)) out(`  [${w.severity}] ${w.flag ?? w.segment ?? ""}${w.environment ? ` (${w.environment})` : ""}: ${clip(w.message, 160)}\n`);
  }
  const f = r.fidelity;
  out(`\nFidelity (${f.method}): ${Object.entries(f.summary).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ") || "nothing to compare"}\n`);
  const notable = f.flags.filter((x) => x.status !== "equivalent");
  if (notable.length) out(`${table(["FLAG", "ENV", "STATUS", "MATCHED", "NOTE"], notable.slice(0, 40).map((x) => [x.flag, x.environment, x.status, `${x.matched}/${x.contexts}`, clip(x.note ?? "", 70)]))}\n`);
  for (const cv of f.caveats) out(`  · ${cv}\n`);
  if (r.import) {
    out(`\nImport ${r.import.id}: ${r.import.status} — ${r.import.created} created, ${r.import.overwritten} overwritten, ${r.import.skipped} skipped, ${r.import.failed} failed.\n`);
    for (const x of r.failures.slice(0, 50)) out(`  failed ${x.kind} ${x.key}: ${clip(x.error, 140)}\n`);
    out("Review the drafts in the dashboard and publish through the normal review.\n");
  } else out("\nRe-run without --dry-run to write the drafts.\n");
}
