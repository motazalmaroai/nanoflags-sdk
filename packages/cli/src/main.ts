import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluate, type Bundle, type Context, type JsonValue } from "@nanoflags/engine";
import { Api, ApiError, DEFAULT_BASE_URL, explain, isExport, keyKind, type ExportData, type ScenarioRun } from "./api.js";
import type { Json, SiteReport } from "./cleanup.js";
import type { CodeRef } from "./refs.js";
import { CliError, DEFAULT_MAX_FILE_BYTES, EXIT, clip, show, table, unifiedDiff, walk } from "./util.js";

export const VERSION = "0.2.0";

export interface Io {
  env: Record<string, string | undefined>;
  cwd: string;
  fetch: typeof fetch;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const HELP = `nanoflags ${VERSION} — NanoFlags command line

Usage: nanoflags <command> [options]

Commands
  export [--out <file>]                         Download flags, segments and drafts as JSON
  flags list [--json]                           List the project's flags
  flags create <key> --type boolean|string|number|json [--default <json>] [--description <text>] [--name <text>] [--json]
                                                Create a flag in the key's project (admin key); nothing is published
  eval <flag> [--context <json>] [--source draft|published] [--fallback <json>] [--json]
                                                Evaluate one flag locally and print value, reason and trace
  scenarios run [--source draft|revision] [--commit <sha>] [--run-url <url>] [--json]
                                                Run the saved scenarios; exit 1 when one fails
  publish --expected-revision <n> [--note <text>]
                                                Publish the draft of the key's environment (admin key)
  refs scan [dir] --repo <owner/name> [--commit <sha>] [--dry-run] [--json]
                                                Find flag references in source files and upload them
  cleanup <flag> --value <json> [dir] [--write] Propose (or apply) the removal of a resolved flag from code

Global options
  --key <key>          CI or admin key. Default: $NANOFLAGS_KEY. Prefer the environment variable:
                       command-line arguments are visible to other processes.
  --sdk-key <key>      Optional server SDK key for \`eval --source published\` (reads /v1/bundle instead of
                       /v1/ci/published with --key). Default: $NANOFLAGS_SDK_KEY
  --base-url <url>     Default: $NANOFLAGS_BASE_URL or ${DEFAULT_BASE_URL}
  --export <file>      Read a saved \`nanoflags export\` instead of calling the API (eval, flags list, refs scan, cleanup)
  -h, --help           -v, --version

Exit codes: 0 ok · 1 a check failed (failing scenario, publish refused) · 2 usage, configuration or key problem · 3 NanoFlags unreachable
`;

const OPTIONS = {
  key: { type: "string" },
  "sdk-key": { type: "string" },
  "base-url": { type: "string" },
  out: { type: "string" },
  context: { type: "string" },
  source: { type: "string" },
  fallback: { type: "string" },
  environment: { type: "string" },
  commit: { type: "string" },
  "run-url": { type: "string" },
  json: { type: "boolean" },
  "expected-revision": { type: "string" },
  type: { type: "string" },
  default: { type: "string" },
  description: { type: "string" },
  name: { type: "string" },
  note: { type: "string" },
  repo: { type: "string" },
  "dry-run": { type: "boolean" },
  value: { type: "string" },
  write: { type: "boolean" },
  export: { type: "string" },
  "max-file-size": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

interface Run {
  io: Io;
  values: Values;
  args: string[];
}

function usage(message: string): CliError {
  return new CliError(`${message}\nRun \`nanoflags --help\` for usage.`, EXIT.usage);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw usage(`${what} must be valid JSON, got: ${clip(text, 80)}`);
  }
}

function baseUrl(r: Run): string {
  const raw = (r.values["base-url"] || r.io.env.NANOFLAGS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(`--base-url is not a URL: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  // The key travels in a header: never send it over plain HTTP to another machine.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw usage(`--base-url must use https (http is only accepted for localhost): ${raw}`);
  return raw;
}

function key(r: Run): string {
  const k = (r.values.key ?? r.io.env.NANOFLAGS_KEY ?? "").trim();
  if (k === "") throw usage("No key. Set NANOFLAGS_KEY (or pass --key) to a NanoFlags CI or admin key.");
  return k;
}

function api(r: Run): Api {
  return new Api({ baseUrl: baseUrl(r), key: key(r), fetch: r.io.fetch, userAgent: `nanoflags-cli/${VERSION}` });
}

function path(r: Run, p: string): string {
  return isAbsolute(p) ? p : resolve(r.io.cwd, p);
}

async function loadExport(r: Run): Promise<ExportData> {
  const file = r.values.export;
  if (file !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path(r, file), "utf8"));
    } catch (e) {
      throw usage(`Could not read --export ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isExport(parsed)) throw usage(`--export ${file} is not a NanoFlags export.`);
    return parsed;
  }
  const k = key(r);
  try {
    const data = await api(r).export();
    if (!isExport(data)) throw new CliError("The export has an unexpected shape.", EXIT.unavailable);
    return data;
  } catch (e) {
    throw explain(e, k, "read the project export");
  }
}

/* ---------------- export / flags list ---------------- */

async function cmdExport(r: Run): Promise<number> {
  const data = await loadExport(r);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (r.values.out !== undefined) {
    writeFileSync(path(r, r.values.out), text);
    r.io.err(`Wrote ${r.values.out} (${data.flags.length} flags, ${data.segments?.length ?? 0} segments, ${Object.keys(data.drafts ?? {}).length} environments).\n`);
  } else r.io.out(text);
  return EXIT.ok;
}

async function cmdFlagsList(r: Run): Promise<number> {
  const data = await loadExport(r);
  if (r.values.json) {
    r.io.out(`${JSON.stringify(data.flags, null, 2)}\n`);
    return EXIT.ok;
  }
  const draft = data.drafts?.[data.key_environment]?.flags ?? {};
  const rows = data.flags.map((f) => {
    const cfg = Object.prototype.hasOwnProperty.call(draft, f.key) ? (draft[f.key] as { enabled?: boolean }) : undefined;
    return [f.key, f.type, f.purpose ?? "", f.permanent ? "permanent" : "temporary", f.client_exposed ? "yes" : "no", f.archived ? "archived" : cfg === undefined ? "-" : cfg.enabled ? "on" : "off"];
  });
  r.io.out(`${data.project.key} · ${data.flags.length} flags · state shown for ${data.key_environment} (draft)\n\n`);
  r.io.out(`${table(["KEY", "TYPE", "PURPOSE", "LIFETIME", "CLIENT", "STATE"], rows)}\n`);
  return EXIT.ok;
}

/* ---------------- flags create ---------------- */

const FLAG_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FLAG_TYPES = ["boolean", "string", "number", "json"] as const;
type FlagType = (typeof FLAG_TYPES)[number];

/** `--default` as a JSON value. For string flags a bare word is accepted as the string itself (`--default blue`). */
export function parseDefault(type: FlagType, raw: string | undefined): JsonValue {
  if (raw === undefined) {
    if (type === "boolean") return false;
    throw usage(`flags create needs --default for a ${type} flag: the value every environment's draft starts with (JSON, e.g. ${type === "string" ? "'\"blue\"'" : type === "number" ? "0" : "'{}'"}).`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    if (type !== "string") throw usage(`--default must be valid JSON for a ${type} flag, got: ${clip(raw, 80)}`);
    value = raw;
  }
  const ok = type === "boolean" ? typeof value === "boolean" : type === "string" ? typeof value === "string" : type === "number" ? typeof value === "number" && Number.isFinite(value) : true;
  if (!ok) throw usage(`--default must be a ${type} value for a ${type} flag, got: ${clip(raw, 80)}`);
  return value as JsonValue;
}

const CREATE_HELP: Record<string, string> = {
  CONFLICT: "Choose another key, or use the existing flag (`nanoflags flags list`).",
  INVALID_VALUE: "The default does not match the flag type.",
  INVALID: "Check the key, name and description.",
};

async function cmdFlagsCreate(r: Run): Promise<number> {
  const flagKey = r.args[0];
  if (!flagKey || r.args.length > 1) throw usage("Usage: nanoflags flags create <key> --type boolean|string|number|json [--default <json>] [--description <text>] [--name <text>]");
  if (!FLAG_KEY.test(flagKey)) throw usage(`The flag key must start with a lowercase letter or digit and use only lowercase letters, digits, hyphens and underscores (max 63), got "${clip(flagKey, 80)}".`);
  const type = r.values.type ?? "boolean";
  if (!(FLAG_TYPES as readonly string[]).includes(type)) throw usage(`--type must be one of ${FLAG_TYPES.join(", ")}, got "${type}".`);
  const value = parseDefault(type as FlagType, r.values.default);
  const description = r.values.description ?? "";
  if (description.length > 2000) throw usage("--description is limited to 2000 characters.");
  const name = r.values.name;
  if (name !== undefined && (name.trim() === "" || name.length > 120)) throw usage("--name must be 1–120 characters.");
  const k = key(r);
  const kind = keyKind(k);
  if (kind !== "admin" && kind !== "unknown") throw usage(`flags create needs an admin key; this is a ${kind} key.`);
  try {
    const res = await api(r).createFlag({ key: flagKey, type: type as FlagType, default: value, description, ...(name !== undefined ? { name: name.trim() } : {}) });
    if (r.values.json) r.io.out(`${JSON.stringify(res, null, 2)}\n`);
    else {
      r.io.out(`Created ${res.key} (${res.type}, default ${JSON.stringify(res.default ?? value)}).\n`);
      r.io.out(`Every environment's draft now has it${Array.isArray(res.environments) && res.environments.length ? ` (${res.environments.join(", ")})` : ""}. Nothing was published.\n`);
    }
    return EXIT.ok;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const help = e instanceof ApiError && typeof err.code === "string" ? CREATE_HELP[err.code] : undefined;
    if (help) {
      r.io.err(`Flag not created: ${err.message ?? err.code} [${err.code}]\n${help}\n`);
      return EXIT.failed;
    }
    throw explain(e, k, "create flags");
  }
}

/* ---------------- eval ---------------- */

function isBundle(v: unknown): v is Bundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return typeof b.flags === "object" && b.flags !== null && typeof b.segments === "object" && b.segments !== null;
}

async function cmdEval(r: Run): Promise<number> {
  const flag = r.args[0];
  if (!flag || r.args.length > 1) throw usage("Usage: nanoflags eval <flag> [--context '{\"key\":\"u1\"}'] [--source draft|published]");
  const source = r.values.source ?? "draft";
  if (source !== "draft" && source !== "published") throw usage(`--source must be draft or published, got "${source}".`);
  const ctx = r.values.context === undefined ? {} : parseJson(r.values.context, "--context");
  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) throw usage("--context must be a JSON object.");
  const fallback = (r.values.fallback === undefined ? null : parseJson(r.values.fallback, "--fallback")) as JsonValue;

  let bundle: Bundle;
  let label: string;
  if (source === "draft") {
    const data = await loadExport(r);
    const env = r.values.environment ?? data.key_environment;
    const draft = data.drafts?.[env];
    if (!isBundle(draft)) throw usage(`The export has no draft for environment "${env}". Available: ${Object.keys(data.drafts ?? {}).join(", ") || "none"}.`);
    bundle = { schema: 1, project: data.project.key, environment: env, revision: 0, flags: draft.flags as Bundle["flags"], segments: draft.segments as Bundle["segments"] };
    label = `draft of ${env}`;
  } else {
    if (r.values.environment !== undefined) throw usage("--environment only applies to --source draft: a key reads the published configuration of its own environment.");
    // With an SDK key: the bundle SDKs receive (`GET /v1/bundle`). Otherwise the CI / admin key reads the same
    // published revision from the database (`GET /v1/ci/published`).
    const sdkKey = (r.values["sdk-key"] ?? r.io.env.NANOFLAGS_SDK_KEY ?? "").trim();
    const main = (r.values.key ?? r.io.env.NANOFLAGS_KEY ?? "").trim();
    const k = sdkKey !== "" ? sdkKey : keyKind(main) === "server" || keyKind(main) === "client" ? main : "";
    if (k === "" && main === "") throw usage("--source published needs a key: NANOFLAGS_KEY (a CI or admin key of the environment) or NANOFLAGS_SDK_KEY (--sdk-key, a server SDK key).");
    const useSdk = k !== "";
    const used = useSdk ? k : main;
    try {
      const client = new Api({ baseUrl: baseUrl(r), key: used, fetch: r.io.fetch, userAgent: `nanoflags-cli/${VERSION}` });
      const res = useSdk ? await client.bundle() : await client.published();
      if (!isBundle(res.bundle)) throw new CliError("The published bundle has an unexpected shape.", EXIT.unavailable);
      bundle = res.bundle;
      label = `published r${res.revision}`;
    } catch (e) {
      if (!useSdk && e instanceof ApiError && e.code === "INVALID_STATE") throw new CliError(`Nothing is published in this key's environment yet. ${e.message}`, EXIT.usage);
      throw explain(e, used, "read the published configuration");
    }
  }

  const result = evaluate(bundle, flag, ctx as Context, fallback);
  if (r.values.json) r.io.out(`${JSON.stringify({ source: label, ...result }, null, 2)}\n`);
  else {
    const rule = result.ruleId !== undefined ? ` · rule ${result.ruleId} (#${(result.ruleIndex ?? 0) + 1})` : "";
    const rollout = result.inRollout === undefined ? "" : ` · ${result.inRollout ? "inside" : "outside"} rollout${result.bucket === undefined ? "" : ` (bucket ${result.bucket.toFixed(2)})`}`;
    r.io.out(`${flag} = ${JSON.stringify(result.value)}\n`);
    r.io.out(`reason: ${result.reason}${rule}${rollout}\n`);
    r.io.out(`source: ${label}\n`);
    r.io.out(`trace:\n${result.trace.map((t) => `  ${t.kind.padEnd(10)} ${t.title} — ${t.detail}`).join("\n")}\n`);
    if (result.reason === "flag_not_found") r.io.err(`Note: "${flag}" is not in this configuration; the value above is the fallback.\n`);
  }
  // Not finding the flag is an answer, not a failure of the command.
  return EXIT.ok;
}

/* ---------------- scenarios run ---------------- */

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function scenariosMarkdown(run: ScenarioRun, meta: { commit?: string; runUrl?: string }): string {
  const lines = [
    `### NanoFlags scenarios: ${run.failed === 0 ? "passed" : "FAILED"}`,
    "",
    `**${run.passed} passed, ${run.failed} failed** · source \`${run.source}\`${run.checksum ? ` · checksum \`${run.checksum}\`` : ""}${run.publishedRevision != null ? ` · published r${run.publishedRevision}` : ""}${meta.commit ? ` · commit \`${meta.commit.slice(0, 12)}\`` : ""}`,
    "",
  ];
  if (run.results.length === 0) lines.push("No scenarios are included in CI for this project.");
  else {
    lines.push("| Result | Scenario | Flag | Expected | Actual | Reason |", "| --- | --- | --- | --- | --- | --- |");
    for (const s of run.results) lines.push(`| ${s.passed ? "pass" : "**FAIL**"} | ${cell(s.name)} | \`${cell(s.flag)}\` | \`${cell(show(s.expected))}\` | \`${cell(show(s.actual))}\` | ${cell(s.reason ?? "")} |`);
  }
  return `${lines.join("\n")}\n\n`;
}

async function cmdScenariosRun(r: Run): Promise<number> {
  const source = r.values.source ?? "draft";
  if (source !== "draft" && source !== "revision") throw usage(`--source must be draft or revision, got "${source}".`);
  const commit = r.values.commit || r.io.env.GITHUB_SHA;
  const runUrl = r.values["run-url"] || (r.io.env.GITHUB_SERVER_URL && r.io.env.GITHUB_REPOSITORY && r.io.env.GITHUB_RUN_ID ? `${r.io.env.GITHUB_SERVER_URL}/${r.io.env.GITHUB_REPOSITORY}/actions/runs/${r.io.env.GITHUB_RUN_ID}` : undefined);
  const k = key(r);
  let run: ScenarioRun;
  try {
    run = await api(r).runScenarios({ source, ...(commit ? { commit } : {}), ...(runUrl ? { runUrl } : {}) });
  } catch (e) {
    throw explain(e, k, "run scenarios");
  }
  if (!run || !Array.isArray(run.results)) throw new CliError("The scenario run has an unexpected shape.", EXIT.unavailable);
  // Trust the individual results over the counters when deciding the exit code.
  const failed = Math.max(Number(run.failed) || 0, run.results.filter((s) => !s.passed).length);
  const passed = run.results.filter((s) => s.passed).length;
  const normalized: ScenarioRun = { ...run, passed, failed };

  if (r.values.json) r.io.out(`${JSON.stringify(normalized, null, 2)}\n`);
  else {
    if (run.results.length === 0) r.io.out("No scenarios are included in CI for this project.\n");
    else r.io.out(`${table(["RESULT", "SCENARIO", "FLAG", "EXPECTED", "ACTUAL", "REASON"], run.results.map((s) => [s.passed ? "pass" : "FAIL", clip(s.name, 48), s.flag, clip(show(s.expected), 32), clip(show(s.actual), 32), s.reason ?? ""]))}\n`);
    r.io.out(`\n${passed} passed, ${failed} failed · source ${run.source}${run.checksum ? ` · checksum ${run.checksum}` : ""}${run.publishedRevision != null ? ` · published r${run.publishedRevision}` : ""}\n`);
  }
  const summary = r.io.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, scenariosMarkdown(normalized, { ...(commit ? { commit } : {}), ...(runUrl ? { runUrl } : {}) }));
    } catch (e) {
      r.io.err(`Could not write the job summary: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (failed > 0) {
    r.io.err(`${failed} scenario${failed === 1 ? "" : "s"} failed.\n`);
    return EXIT.failed;
  }
  return EXIT.ok;
}

/* ---------------- publish ---------------- */

const PUBLISH_HELP: Record<string, string> = {
  DESTINATION_CHANGED: "Someone published in the meantime. Review the new revision, then run again with its number as --expected-revision.",
  CHANGE_REQUIRED: "This environment only accepts reviewed changes. Publish it from the dashboard; an admin key cannot bypass review.",
  SCENARIOS_REQUIRED: "Run `nanoflags scenarios run --source draft` and fix the failing scenarios (or the draft), then publish again.",
  NO_CHANGES: "There is nothing to publish.",
};

async function cmdPublish(r: Run): Promise<number> {
  const raw = r.values["expected-revision"];
  if (raw === undefined || !/^\d+$/.test(raw)) throw usage("publish needs --expected-revision <n>: the revision you believe is currently published (see `nanoflags export`). It prevents publishing over someone else's change.");
  const k = key(r);
  const kind = keyKind(k);
  if (kind !== "admin" && kind !== "unknown") throw usage(`publish needs an admin key; this is a ${kind} key. ${kind === "ci" ? "CI keys can run scenarios and upload references, never publish." : ""}`.trim());
  try {
    const res = await api(r).publish({ expectedRevision: Number(raw), ...(r.values.note ? { note: r.values.note } : {}) });
    if (r.values.json) r.io.out(`${JSON.stringify(res, null, 2)}\n`);
    else r.io.out(`Published r${res.revision} (checksum ${res.checksum}).\n`);
    return EXIT.ok;
  } catch (e) {
    const err = e as { code?: string; message?: string; status?: number };
    const help = typeof err.code === "string" ? PUBLISH_HELP[err.code] : undefined;
    if (help) {
      r.io.err(`Publish refused: ${err.message ?? err.code} [${err.code}]\n${help}\n`);
      return EXIT.failed;
    }
    throw explain(e, k, "publish");
  }
}

/* ---------------- refs scan ---------------- */

function directory(r: Run, arg: string | undefined): string {
  const dir = path(r, arg ?? ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`Not a directory: ${arg ?? "."}`);
  return dir;
}

function maxBytes(r: Run): number {
  const raw = r.values["max-file-size"];
  if (raw === undefined) return DEFAULT_MAX_FILE_BYTES;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw usage("--max-file-size must be a positive number of bytes.");
  return Number(raw);
}

const MAX_REFS = 5000;

async function cmdRefsScan(r: Run): Promise<number> {
  if (r.args.length > 1) throw usage("Usage: nanoflags refs scan [dir] --repo <owner/name> [--commit <sha>] [--dry-run]");
  const dry = r.values["dry-run"] === true;
  const repo = r.values.repo || r.io.env.GITHUB_REPOSITORY || undefined;
  if (!dry && !repo) throw usage("refs scan needs --repo <owner/name> (or run with --dry-run).");
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw usage(`--repo must look like owner/name, got "${repo}".`);
  const commit = r.values.commit || r.io.env.GITHUB_SHA || null;
  const dir = directory(r, r.args[0]);
  const data = await loadExport(r);
  const keys = new Set(data.flags.map((f) => f.key));

  const { scanText } = await import("./refs.js"); // loads the TypeScript compiler: only when it is needed
  const { files, tooLarge } = walk(dir, maxBytes(r));
  const refs: CodeRef[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    refs.push(...scanText(file, text, keys));
  }
  for (const f of tooLarge) r.io.err(`Skipped ${f}: larger than the file size cap.\n`);
  const truncated = refs.length > MAX_REFS;
  const upload = truncated ? refs.slice(0, MAX_REFS) : refs;
  if (truncated) r.io.err(`Found ${refs.length} references; only the first ${MAX_REFS} are uploaded.\n`);

  const flagsSeen = new Set(refs.map((x) => x.flag));
  if (r.values.json) r.io.out(`${JSON.stringify({ repo: repo ?? null, commit, files: files.length, refs: upload }, null, 2)}\n`);
  else {
    if (refs.length > 0) r.io.out(`${table(["FLAG", "LOCATION", "CODE"], refs.map((x) => [x.flag, `${x.path}:${x.line}`, clip(x.snippet, 80)]))}\n\n`);
    r.io.out(`${refs.length} reference${refs.length === 1 ? "" : "s"} to ${flagsSeen.size} of ${keys.size} flags in ${files.length} files.\n`);
  }
  if (dry) {
    r.io.err("Dry run: nothing was uploaded.\n");
    return EXIT.ok;
  }
  const k = key(r);
  try {
    const res = await api(r).putCodeRefs({ repo: repo!, commit, refs: upload });
    r.io.err(`Uploaded: ${res.stored} reference${res.stored === 1 ? "" : "s"} stored for ${repo}${commit ? ` at ${commit.slice(0, 12)}` : ""}. Earlier references for this repository were replaced.\n`);
  } catch (e) {
    throw explain(e, k, "upload code references");
  }
  return EXIT.ok;
}

/* ---------------- cleanup ---------------- */

function matchesType(type: string, v: Json): boolean {
  if (type === "boolean") return typeof v === "boolean";
  if (type === "string") return typeof v === "string";
  if (type === "number") return typeof v === "number";
  return true;
}

async function cmdCleanup(r: Run): Promise<number> {
  const flag = r.args[0];
  if (!flag || r.args.length > 2) throw usage("Usage: nanoflags cleanup <flag> --value <json> [dir] [--write]");
  if (r.values.value === undefined) throw usage("cleanup needs --value <json>: the value the flag is permanently resolved to, e.g. --value true or --value '\"v2\"'.");
  const value = parseJson(r.values.value, "--value") as Json;
  const dir = directory(r, r.args[1]);
  const data = await loadExport(r);
  const meta = data.flags.find((f) => f.key === flag);
  if (!meta) throw usage(`Unknown flag "${flag}" in project ${data.project.key}.`);
  if (meta.permanent) {
    throw new CliError(`"${flag}" is marked permanent (${meta.purpose ?? "long-lived"}): it is meant to stay in code. Nothing was changed.\nIf it really should go, clear "permanent" on the flag in the dashboard first.`, EXIT.usage);
  }
  if (!matchesType(meta.type, value)) throw usage(`"${flag}" is a ${meta.type} flag; --value ${r.values.value} is not a ${meta.type}.`);

  const write = r.values.write === true;
  const { cleanupText } = await import("./cleanup.js");
  const { files, tooLarge } = walk(dir, maxBytes(r));
  const transformed: Array<SiteReport & { path: string }> = [];
  const skipped: Array<SiteReport & { path: string }> = [];
  const unreachable: Array<SiteReport & { path: string }> = [];
  let changedFiles = 0;
  for (const file of files) {
    const full = join(dir, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(flag)) continue;
    const res = cleanupText(file, text, flag, value);
    transformed.push(...res.transformed.map((s) => ({ ...s, path: file })));
    unreachable.push(...res.unreachable.map((s) => ({ ...s, path: file })));
    skipped.push(...res.skipped.map((s) => ({ ...s, path: file })));
    if (res.output === text) continue;
    changedFiles++;
    if (write) writeFileSync(full, res.output);
    else r.io.out(unifiedDiff(file, text, res.output));
  }
  for (const f of tooLarge) r.io.err(`Skipped ${f}: larger than the file size cap.\n`);

  const e = r.io.err;
  e(`\n${flag} → ${JSON.stringify(value)}\n`);
  e(`${write ? "Rewrote" : "Would rewrite"} ${transformed.length} reference${transformed.length === 1 ? "" : "s"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}.\n`);
  for (const s of transformed) e(`  ${s.path}:${s.line}  ${clip(s.snippet, 100)}\n`);
  if (skipped.length > 0) {
    e(`\nNOT transformed (${skipped.length}) — review these by hand:\n`);
    for (const s of skipped) e(`  ${s.path}:${s.line}  ${clip(s.snippet, 100)}\n      ${s.reason}${s.removed ? " (it was inside code that this cleanup removes)" : ""}\n`);
  }
  if (unreachable.length > 0) {
    e(`\nNow unreachable (${unreachable.length}) — code after a return/throw that the cleanup exposed; delete it if it is no longer needed (line numbers after the cleanup):\n`);
    for (const s of unreachable) e(`  ${s.path}:${s.line}  ${clip(s.snippet, 100)}\n`);
  }
  if (transformed.length === 0 && skipped.length === 0) e("No references found. Only calls with the flag key as a string literal are recognised.\n");
  e(
    write
      ? "\nFiles were edited in place. Nothing was committed or pushed: review the changes (git diff), run your tests, then commit.\n"
      : "\nDry run: no file was changed. Re-run with --write to apply. This command never commits, pushes or opens pull requests.\n",
  );
  return EXIT.ok;
}

/* ---------------- dispatch ---------------- */

export async function main(argv: string[], io: Io): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values as Values;
    positionals = parsed.positionals;
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\nRun \`nanoflags --help\` for usage.\n`);
    return EXIT.usage;
  }
  if (values.version) {
    io.out(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [command, sub] = positionals;
  if (values.help || command === undefined || command === "help") {
    io.out(HELP);
    return command === undefined && !values.help ? EXIT.usage : EXIT.ok;
  }
  const run = (skip: number): Run => ({ io, values, args: positionals.slice(skip) });
  try {
    if (command === "export") return await cmdExport(run(1));
    if (command === "flags" && sub === "list") return await cmdFlagsList(run(2));
    if (command === "flags" && sub === "create") return await cmdFlagsCreate(run(2));
    if (command === "eval") return await cmdEval(run(1));
    if (command === "scenarios" && sub === "run") return await cmdScenariosRun(run(2));
    if (command === "publish") return await cmdPublish(run(1));
    if (command === "refs" && sub === "scan") return await cmdRefsScan(run(2));
    if (command === "cleanup") return await cmdCleanup(run(1));
    throw usage(`Unknown command: ${positionals.slice(0, 2).join(" ")}`);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`${e.message}\n`);
      return e.exitCode;
    }
    io.err(`Unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return EXIT.failed;
  }
}
