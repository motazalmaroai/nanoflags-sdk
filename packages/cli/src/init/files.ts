import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Detection, Framework } from "./detect.js";

export const DEFAULT_EDGE = "https://edge.nanoflags.io";

/* ---------------- .env ---------------- */

export interface EnvPlan {
  /** Relative to the project directory. */
  file: string;
  keyVar: string;
  baseUrlVar: string;
  /** How code reads a variable, e.g. `process.env.X` or `import.meta.env.X`. */
  read: (name: string) => string;
}

export function envPlan(f: Framework): EnvPlan {
  if (f === "vite" || f === "vite-react") return { file: ".env.local", keyVar: "VITE_NANOFLAGS_KEY", baseUrlVar: "VITE_NANOFLAGS_BASE_URL", read: (n) => `import.meta.env.${n}` };
  if (f === "react") return { file: ".env.local", keyVar: "REACT_APP_NANOFLAGS_KEY", baseUrlVar: "REACT_APP_NANOFLAGS_BASE_URL", read: (n) => `process.env.${n}` };
  if (f === "next-app" || f === "next-pages") return { file: ".env.local", keyVar: "NANOFLAGS_SDK_KEY", baseUrlVar: "NANOFLAGS_BASE_URL", read: (n) => `process.env.${n}` };
  return { file: ".env", keyVar: "NANOFLAGS_SDK_KEY", baseUrlVar: "NANOFLAGS_BASE_URL", read: (n) => `process.env.${n}` };
}

/** `NAME=value` pairs of a dotenv file (last one wins, like dotenv). Quotes are removed; comments and `export ` ignored. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out.set(m[1]!, v);
  }
  return out;
}

export type EnvOutcome = { name: string; status: "added" | "unchanged" | "replaced" | "kept" };

/**
 * Adds `wanted` to the dotenv file. A variable that already has a different value is only replaced when
 * `replace(name, current)` says so; otherwise the existing value is kept. Never touches other lines.
 */
export async function mergeEnv(path: string, wanted: Array<[string, string]>, replace: (name: string, current: string) => Promise<boolean>): Promise<EnvOutcome[]> {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const current = parseEnv(before);
  let lines = before === "" ? [] : before.replace(/\r?\n$/, "").split(/\r?\n/);
  const outcomes: EnvOutcome[] = [];
  const append: string[] = [];
  for (const [name, value] of wanted) {
    if (!current.has(name)) {
      append.push(`${name}=${value}`);
      outcomes.push({ name, status: "added" });
    } else if (current.get(name) === value) outcomes.push({ name, status: "unchanged" });
    else if (await replace(name, current.get(name)!)) {
      const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
      lines = lines.map((l) => (re.test(l) ? `${name}=${value}` : l));
      outcomes.push({ name, status: "replaced" });
    } else outcomes.push({ name, status: "kept" });
  }
  if (append.length > 0) {
    if (lines.length > 0 && lines.at(-1)!.trim() !== "") lines.push("");
    lines.push("# NanoFlags (written by `nanoflags init`)", ...append);
  }
  if (outcomes.some((o) => o.status === "added" || o.status === "replaced")) writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return outcomes;
}

/* ---------------- .gitignore ---------------- */

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

/** Whether `.gitignore` (top-level patterns only, last match wins) ignores the file name `name` at the root. */
export function isIgnored(gitignore: string, name: string): boolean {
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    line = line.replace(/^\//, "").replace(/\/$/, "");
    if (line.includes("/") && !line.startsWith("**/")) continue;
    line = line.replace(/^\*\*\//, "");
    if (globToRegExp(line).test(name)) ignored = !negate;
  }
  return ignored;
}

/** Makes sure git ignores the env file. Returns true when .gitignore was created or changed. */
export function ensureIgnored(dir: string, file: string): boolean {
  const path = join(dir, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (isIgnored(text, file)) return false;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${text}${sep}${text === "" ? "" : "\n"}# NanoFlags SDK key (written by \`nanoflags init\`)\n${file}\n`);
  return true;
}

/* ---------------- client file ---------------- */

export interface ClientFile {
  /** Relative path. */
  path: string;
  /** Module specifier to import it from application code, relative to a typical caller. */
  importHint: string;
  content: string;
}

export function clientFile(d: Detection, f: Framework, edgeUrl: string): ClientFile {
  const env = envPlan(f);
  const ext = d.typescript ? "ts" : "js";
  const base = edgeUrl === DEFAULT_EDGE ? `"${DEFAULT_EDGE}"` : `"${edgeUrl}"`;
  const header = `// Written by \`nanoflags init\`. One NanoFlags client for the whole app: flags are evaluated locally and
// synchronously; new revisions arrive in the background. Docs: https://nanoflags.io/docs`;
  if (f === "next-app" || f === "next-pages") {
    const path = `${d.srcDir ? "src/" : ""}lib/nanoflags.${ext}`;
    const ts = d.typescript;
    return {
      path,
      importHint: "@/lib/nanoflags",
      content: `${header}
// Server-side only: ${env.keyVar} is a server key. Never import this file from a "use client" component.
import { createClient${ts ? ", type NanoFlagsClient" : ""} } from "@nanoflags/sdk";

${ts ? "const g = globalThis as typeof globalThis & { __nanoflags?: NanoFlagsClient };" : "const g = globalThis;"}

function create()${ts ? ": NanoFlagsClient" : ""} {
  const client = createClient({
    sdkKey: ${env.read(env.keyVar)} ?? "",
    baseUrl: ${env.read(env.baseUrlVar)} || ${base},
    service: "${d.service}",
  });
  client.on("error", (e) => console.warn(\`[nanoflags] \${e.message}\`));
  return client;
}

// Reused across hot reloads in development, one per server process in production.
export const flags${ts ? ": NanoFlagsClient" : ""} = (g.__nanoflags ??= create());

/** The client once its first configuration has loaded (never rejects: on failure every accessor returns its fallback). */
export async function getFlags()${ts ? ": Promise<NanoFlagsClient>" : ""} {
  await flags.ready();
  return flags;
}
`,
    };
  }
  if (f === "vite" || f === "vite-react" || f === "react") {
    const path = `src/nanoflags.${ext}`;
    return {
      path,
      importHint: "./nanoflags",
      content: `${header}
// ${env.keyVar} is a client key (nf_pub_…): it only receives flags marked client-exposed.
import { createClient } from "@nanoflags/sdk";

export const flags = createClient({
  sdkKey: ${env.read(env.keyVar)} ?? "",
  baseUrl: ${env.read(env.baseUrlVar)} || ${base},
  service: "${d.service}",
});

flags.on("error", (e) => console.warn(\`[nanoflags] \${e.message}\`));
`,
    };
  }
  // Node: ESM (TypeScript or "type": "module") or CommonJS.
  const esm = d.typescript || d.esm;
  const path = `${d.srcDir ? "src/" : ""}nanoflags.${ext}`;
  const body = `const flags = createClient({
  sdkKey: process.env.${env.keyVar} ?? "",
  baseUrl: process.env.${env.baseUrlVar} || ${base},
  service: "${d.service}",
});

flags.on("error", (e) => console.warn(\`[nanoflags] \${e.message}\`));
// The live connection keeps the process alive: call flags.close() on shutdown.
`;
  return {
    path,
    importHint: d.typescript ? "./nanoflags.js" : "./nanoflags.js",
    content: esm
      ? `${header}\nimport { createClient } from "@nanoflags/sdk";\n\nexport ${body}`
      : `${header}\nconst { createClient } = require("@nanoflags/sdk");\n\n${body}\nmodule.exports = { flags };\n`,
  };
}

/** Writes the client file unless a file already exists there. Returns "written" | "exists-same" | "exists-different". */
export function writeClientFile(dir: string, file: ClientFile): "written" | "exists-same" | "exists-different" {
  const path = join(dir, file.path);
  if (existsSync(path)) return readFileSync(path, "utf8") === file.content ? "exists-same" : "exists-different";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.content);
  return "written";
}

/* ---------------- usage snippet ---------------- */

/** How to read the flag in this framework, with an explicit fallback. */
export function usageSnippet(f: Framework, file: ClientFile, flagKey: string, d: Detection): string {
  if (f === "next-app")
    return `// app/page.${d.typescript ? "tsx" : "jsx"} (a Server Component)
import { getFlags } from "${file.importHint}";

export const dynamic = "force-dynamic"; // evaluate per request, not at build time

export default async function Page() {
  const flags = await getFlags();
  const showBanner = flags.boolean("${flagKey}", false, { key: "user-123" });
  return <main>{showBanner && <p>Welcome to the new experience!</p>}</main>;
}`;
  if (f === "next-pages")
    return `// pages/index.${d.typescript ? "tsx" : "jsx"}
import { getFlags } from "${file.importHint}";

export async function getServerSideProps() {
  const flags = await getFlags();
  return { props: { showBanner: flags.boolean("${flagKey}", false, { key: "user-123" }) } };
}

export default function Home({ showBanner }${d.typescript ? ": { showBanner: boolean }" : ""}) {
  return <main>{showBanner && <p>Welcome to the new experience!</p>}</main>;
}`;
  if (f === "vite-react" || f === "react")
    return `// src/App.${d.typescript ? "tsx" : "jsx"}
import { NanoFlagsProvider, useFlag } from "@nanoflags/sdk/react";
import { flags } from "${file.importHint}";

export default function App() {
  return (
    <NanoFlagsProvider client={flags} context={{ key: "user-123" }}>
      <Banner />
    </NanoFlagsProvider>
  );
}

function Banner() {
  const show = useFlag("${flagKey}", false); // false until the configuration loads, or if it cannot
  return show ? <p>Welcome to the new experience!</p> : null;
}`;
  if (f === "vite")
    return `// src/main.${d.typescript ? "ts" : "js"}
import { flags } from "${file.importHint}";

await flags.ready();
const render = () => document.body.classList.toggle("welcome-banner", flags.boolean("${flagKey}", false, { key: "user-123" }));
render();
flags.on("update", render);`;
  const esm = d.typescript || d.esm;
  return `// ${esm ? "server" : "server.js"}  (run with: node --env-file=${envPlan(f).file} …)
${esm ? `import { flags } from "${file.importHint}";` : `const { flags } = require("./nanoflags.js");`}

${esm ? "await flags.ready();" : "flags.ready().then(() => {"}
${esm ? "" : "  "}const showBanner = flags.boolean("${flagKey}", false, { key: "user-123" });
${esm ? "" : "  "}console.log("${flagKey} =", showBanner, "revision", flags.revision);${esm ? "" : "\n});"}`;
}
