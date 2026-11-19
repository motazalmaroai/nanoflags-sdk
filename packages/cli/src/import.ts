/**
 * `nanoflags import <file> --project <key> [--env-map src=target,…] [--format …] [--conflict skip|rename|overwrite]
 *  [--dry-run] [--json] [--label <text>]`
 *
 * Sends the file to the Management API (`POST /api/v1/projects/{project}/imports`) with an API token
 * (`NANOFLAGS_API_TOKEN`, scope flags:write; segments:write when the file has segments). The server converts it,
 * checks fidelity and writes drafts only. This command never publishes.
 *
 * `nanoflags import verify <file> --contexts <file.jsonl> --project <key> [--env-map …] [--format …] [--flags a,b]
 *  [--json]` is the side-by-side comparison: a dry run (nothing is written) that also sends your sample contexts; the
 * server evaluates each of them with the source's semantics and with the NanoFlags engine on the drafts the import of
 * this file would produce, and answers every context whose value differs. Nothing is written, so the conflict policy
 * defaults to overwrite: flags that already exist (for example after an earlier import) are compared too, against
 * this file's conversion, not against the drafts stored in the project. Exit 1 when a context differs, when nothing
 * could be compared, or when some flag/environment pairs were left unchecked by the evaluation budget; 0 when every
 * pair was compared and agrees (differences decided by percentages on both sides are listed but do not fail).
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { CliError, EXIT, clip, table } from "./util.js";

export const IMPORT_FORMATS = ["auto", "flagd", "nanoflags", "csv", "launchdarkly", "unleash", "flagsmith", "growthbook", "statsig"] as const;
const MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024;
/** Same limit as the API (`COMPARE_LIMITS.contexts` in the importer). */
export const MAX_CONTEXTS = 1000;

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

function readSource(o: Pick<ImportOptions, "file" | "format" | "project" | "token" | "conflict">, command: string): { content: string; format: string } {
  if (!/^nf_api_[0-9a-f]{48}$/.test(o.token)) throw new CliError(`\`${command}\` needs a Management API token: set NANOFLAGS_API_TOKEN (nf_api_…, scope flags:write; also segments:write when the file has segments).`, EXIT.usage);
  if (!o.project) throw new CliError(`\`${command}\` needs --project <key>.\nRun \`nanoflags --help\` for usage.`, EXIT.usage);
  if (o.format !== undefined && !(IMPORT_FORMATS as readonly string[]).includes(o.format)) throw new CliError(`--format must be one of ${IMPORT_FORMATS.join(", ")}.`, EXIT.usage);
  if (o.conflict !== undefined && !["skip", "rename", "overwrite"].includes(o.conflict)) throw new CliError("--conflict must be skip, rename or overwrite.", EXIT.usage);
  let size: number;
  try {
    size = statSync(o.file).size;
  } catch {
    throw new CliError(`Cannot read ${o.file}.`, EXIT.usage);
  }
  if (size > MAX_BYTES) throw new CliError(`${o.file} is larger than 4 MB; split it into several imports.`, EXIT.usage);
  return { content: readFileSync(o.file, "utf8"), format: o.format ?? (/\.csv$/i.test(o.file) ? "csv" : "auto") };
}

async function postImport(o: Pick<ImportOptions, "baseUrl" | "project" | "token" | "fetch" | "userAgent">, text: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await o.fetch(`${o.baseUrl}/api/v1/projects/${encodeURIComponent(o.project)}/imports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": o.userAgent, ...headers },
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
  return json;
}

export async function runImportCommand(o: ImportOptions): Promise<number> {
  const { content, format } = readSource(o, "import");
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
  const r = (await postImport(o, text, idem)) as Result;
  if (o.json) {
    o.out(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    report(r, o.out);
  }
  if (!r.dryRun && r.import && (r.import.status !== "completed" || r.failures.length > 0)) return EXIT.failed;
  return EXIT.ok;
}

/* ---------------- import verify (side-by-side comparison) */

export interface VerifyOptions extends Omit<ImportOptions, "dryRun" | "label" | "renameSuffix"> {
  contexts: string;
  flags?: string;
}

interface Comparison {
  method: string;
  contexts: number;
  flags: { flag: string; sourceKey: string; environment: string; status: string; compared: number; differs: number; splitDiffers: number; sourceErrors: number; note?: string }[];
  differences: { index: number; flag: string; environment: string; kind: string; source: unknown; nanoflags: unknown; note?: string; context: Record<string, unknown> }[];
  summary: { evaluations: number; same: number; differs: number; splitOnly: number; notCompared: number; skipped: number; differingContexts: number; unchecked: number };
  caveats: string[];
}

/** Sample contexts: JSON Lines (one object per line; blank lines ignored) or one JSON array of objects. */
export function parseContexts(text: string, file = "contexts"): Record<string, unknown>[] {
  const t = text.replace(/^\uFEFF/, "").trim();
  if (t === "") throw new CliError(`${file} has no contexts.`, EXIT.usage);
  let list: unknown[];
  if (t.startsWith("[")) {
    try {
      list = JSON.parse(t) as unknown[];
    } catch (e) {
      throw new CliError(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, EXIT.usage);
    }
    if (!Array.isArray(list)) throw new CliError(`${file} must be a JSON array or JSON Lines.`, EXIT.usage);
  } else {
    list = [];
    t.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        list.push(JSON.parse(line));
      } catch {
        throw new CliError(`${file}:${i + 1}: not valid JSON (one context object per line).`, EXIT.usage);
      }
    });
  }
  list.forEach((c, i) => {
    if (typeof c !== "object" || c === null || Array.isArray(c)) throw new CliError(`${file}: context ${i + 1} is not a JSON object.`, EXIT.usage);
  });
  if (list.length > MAX_CONTEXTS) throw new CliError(`${file} has ${list.length} contexts; at most ${MAX_CONTEXTS} are compared at once. Split the file.`, EXIT.usage);
  return list as Record<string, unknown>[];
}

export async function runVerifyCommand(o: VerifyOptions): Promise<number> {
  if (!o.contexts) throw new CliError("`import verify` needs --contexts <file> (JSON Lines: one context object per line).\nRun `nanoflags --help` for usage.", EXIT.usage);
  const { content, format } = readSource(o, "import verify");
  let ctxText: string;
  try {
    ctxText = readFileSync(o.contexts, "utf8");
  } catch {
    throw new CliError(`Cannot read ${o.contexts}.`, EXIT.usage);
  }
  const contexts = parseContexts(ctxText, o.contexts);
  const flags = (o.flags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const body = {
    format,
    content,
    ...(o.envMap !== undefined ? { envMap: parseEnvMap(o.envMap) } : {}),
    // A dry run writes nothing: compare existing flags too (with skip, every flag already imported would be skipped).
    conflict: o.conflict ?? "overwrite",
    dryRun: true,
    contexts,
    ...(flags.length ? { compareFlags: flags } : {}),
  };
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new CliError("The file and the contexts together are larger than 4 MB; use fewer contexts or split the file.", EXIT.usage);
  const r = (await postImport(o, text, {})) as Result & { comparison?: Comparison };
  const c = r.comparison;
  if (!c) throw new CliError("The server did not answer a comparison (it may not support `import verify` yet).", EXIT.failed);
  if (o.json) o.out(`${JSON.stringify({ source: r.source, envMap: r.envMap, comparison: c, warnings: r.warnings }, null, 2)}\n`);
  else verifyReport(r, c, o.out);
  return verifyFailures(c).length ? EXIT.failed : EXIT.ok;
}

/** Why `import verify` fails (exit 1); empty when every flag/environment pair was compared and agrees. */
function verifyFailures(c: Comparison): string[] {
  const s = c.summary;
  const out: string[] = [];
  if (s.differs > 0) out.push(`${s.differs} flag/environment pair(s) answer a context differently`);
  if (s.same + s.differs + s.splitOnly === 0) out.push("nothing could be compared");
  if (s.unchecked > 0) out.push(`${s.unchecked} flag/environment pair(s) were not compared (evaluation budget); narrow --flags or use fewer contexts`);
  return out;
}

const short = (v: unknown) => clip(JSON.stringify(v) ?? "null", 40);

function verifyReport(r: Result, c: Comparison, out: (t: string) => void): void {
  out(`Side-by-side comparison (dry run, nothing written) · source ${r.source} (${c.method}) · environments ${Object.entries(r.envMap).map(([s, t]) => `${s}→${t}`).join(", ") || "none mapped"}\n`);
  const s = c.summary;
  out(`${c.contexts} contexts · ${s.evaluations} evaluations · flag/environment pairs: ${s.same} same, ${s.differs} differ, ${s.splitOnly} differ only by percentage, ${s.notCompared} not compared, ${s.skipped} skipped\n`);
  const rows = c.flags.filter((f) => f.status !== "same");
  if (rows.length) out(`\n${table(["FLAG", "ENV", "STATUS", "DIFFER", "SPLIT", "ERRORS", "NOTE"], rows.slice(0, 60).map((f) => [f.flag, f.environment, f.status.replace("_", " "), String(f.differs), String(f.splitDiffers), String(f.sourceErrors), clip(f.note ?? "", 60)]))}\n`);
  const real = c.differences.filter((d) => d.kind !== "split");
  if (real.length) {
    out(`\nContexts that would get a different value (${s.differingContexts}${real.length < c.differences.length || s.differingContexts > real.length ? ", first shown" : ""}):\n`);
    for (const d of real.slice(0, 50)) out(`  #${d.index + 1} ${d.flag} (${d.environment}) [${d.kind}] source ${short(d.source)} → NanoFlags ${short(d.nanoflags)}  ${clip(JSON.stringify(d.context), 80)}${d.note ? `  ${clip(d.note, 80)}` : ""}\n`);
  } else if (s.differs === 0 && s.same + s.splitOnly > 0) out("\nEvery compared context gets the same value from the targeting.\n");
  const important = r.warnings.filter((w) => w.severity === "unsupported" || w.severity === "error");
  if (important.length) out(`\n${important.length} unsupported source feature(s) explain expected differences; run \`nanoflags import --dry-run\` to list them.\n`);
  for (const cv of c.caveats) out(`  · ${cv}\n`);
  const failures = verifyFailures(c);
  if (failures.length) out(`\nFailed: ${failures.join("; ")}.\n`);
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
