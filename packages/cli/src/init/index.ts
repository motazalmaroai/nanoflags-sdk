import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ApiError, ManagementApi, type ManagedEnvironment } from "../api.js";
import { CliError, EXIT } from "../util.js";
import { connectUrl, decodeConnection, oneTimeCode, type Connection } from "./connect.js";
import { detect, FRAMEWORK_LABEL, FRAMEWORKS, installCommand, keyKindFor, readPackageJson, type Detection, type Framework } from "./detect.js";
import { clientFile, DEFAULT_EDGE, ensureIgnored, envPlan, mergeEnv, parseEnv, usageSnippet, writeClientFile } from "./files.js";

export const WELCOME_FLAG = "welcome-banner";
export const DEFAULT_APP_URL = "https://app.nanoflags.io";
const API_TOKEN = /^nf_api_[0-9a-f]{48}$/;
const POLL_MS = 3_000;

export interface InitIo {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Asks the person in the terminal; undefined when there is no terminal (CI). `secret` hides what is typed. */
  prompt?: (question: string, o?: { secret?: boolean }) => Promise<string>;
  /** Opens a URL in the browser (best effort). */
  open?: (url: string) => void;
  /** Runs a command in `cwd` with inherited output; resolves with the exit code. */
  exec?: (cmd: string, args: string[], cwd: string) => Promise<number>;
}

export interface InitOptions {
  yes: boolean;
  framework?: string;
  /** SDK key to use instead of creating one. */
  key?: string;
  token?: string;
  project?: string;
  environment?: string;
  baseUrl?: string;
  appUrl?: string;
  /** Seconds to wait for the first report; 0 skips. */
  wait?: string;
  publish: boolean;
  skipInstall: boolean;
  userAgent: string;
}

function usage(message: string): CliError {
  return new CliError(`${message}\nRun \`nanoflags --help\` for usage.`, EXIT.usage);
}

function checkUrl(raw: string, what: string): string {
  const s = raw.replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw usage(`${what} is not a URL: ${raw}`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw usage(`${what} must use https (http is only accepted for localhost): ${raw}`);
  return s;
}

async function yesNo(io: InitIo, interactive: boolean, question: string, fallback: boolean): Promise<boolean> {
  if (!interactive || !io.prompt) return fallback;
  const a = (await io.prompt(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return a === "" ? fallback : a === "y" || a === "yes";
}

/** API failures of the init steps, as one line a person can act on. */
function why(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "the API token was rejected (expired after its hour, or revoked). Run `init` again to get a new one.";
    if (e.code === "INSUFFICIENT_SCOPE") return `the API token lacks a scope (${e.message}).`;
    return `${e.message} [${e.code}] — see https://nanoflags.io/docs/errors#${e.code.toLowerCase().replace(/_/g, "-")}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const KEY_PREFIX = { server: "nf_srv_", client: "nf_pub_" } as const;

export async function runInit(io: InitIo, o: InitOptions): Promise<number> {
  const startedAt = io.now();
  const interactive = !o.yes && io.prompt !== undefined;
  const say = (s = "") => io.out(`${s}\n`);

  // 1. Detect.
  let d: Detection;
  try {
    d = detect(io.cwd);
  } catch (e) {
    throw usage(e instanceof Error ? e.message : String(e));
  }
  if (o.framework !== undefined && !(FRAMEWORKS as readonly string[]).includes(o.framework)) throw usage(`--framework must be one of ${FRAMEWORKS.join(", ")}, got "${o.framework}".`);
  const framework = (o.framework as Framework | undefined) ?? d.framework;
  const kind = keyKindFor(framework);
  const plan = envPlan(framework);
  say(`NanoFlags init · ${FRAMEWORK_LABEL[framework]} · ${d.packageManager} · ${d.typescript ? "TypeScript" : "JavaScript"}`);
  if (d.unsupported && o.framework === undefined) say(`  ${d.unsupported} detected: init has no template for it yet, so it writes a plain ${FRAMEWORK_LABEL[framework]} client. Pass --framework to choose another, or follow https://nanoflags.io/docs/sdk.`);

  // 2. What we already have: an SDK key in the env file, --key, --token.
  const envPath = join(io.cwd, plan.file);
  const existing = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")).get(plan.keyVar) : undefined;
  let sdkKey = o.key?.trim() || (existing?.startsWith(KEY_PREFIX[kind]) ? existing : undefined);
  if (sdkKey !== undefined && !sdkKey.startsWith(KEY_PREFIX[kind]))
    throw usage(kind === "client" ? `${FRAMEWORK_LABEL[framework]} runs in the browser and needs a client key (nf_pub_…). Never ship a server key (nf_srv_…) to a browser.` : `${FRAMEWORK_LABEL[framework]} needs a server SDK key (nf_srv_…), got a key starting with "${sdkKey.slice(0, 7)}".`);
  const reused = sdkKey !== undefined && sdkKey === existing && !o.key;
  let token = (o.token ?? io.env.NANOFLAGS_API_TOKEN ?? "").trim() || undefined;
  if (token !== undefined && !API_TOKEN.test(token)) throw usage("The API token must look like nf_api_<48 hex characters>.");
  let project = o.project;
  let envKey = o.environment ?? "development";
  const appUrl = checkUrl(o.appUrl ?? io.env.NANOFLAGS_APP_URL ?? DEFAULT_APP_URL, "--app-url");
  let edgeUrl = o.baseUrl ?? io.env.NANOFLAGS_BASE_URL;
  const wantPublishFlag = o.publish;

  // 3. Sign in through the browser when we have no token.
  let conn: Connection | null = null;
  if (token === undefined) {
    if (!interactive) {
      if (sdkKey === undefined) throw usage("Without a terminal, init needs --key <SDK key> (writes the files) and --token <nf_api_… token> (creates the flag and waits for the first report). Or run it in a terminal to sign in through the browser.");
      say("  No API token: writing the files only (no flag is created, nothing is watched). Pass --token to do the rest.");
    } else {
      const code = oneTimeCode();
      const url = connectUrl(appUrl, { code, framework, kind, reuseKey: sdkKey !== undefined, publish: wantPublishFlag, project, environment: envKey });
      say("");
      say(`Sign in to connect this project. Your one-time code is ${code}.`);
      say(`  ${url}`);
      say("  The page shows the same code: check that it matches, confirm, then copy the connection string.");
      io.open?.(url);
      for (let attempt = 1; conn === null; attempt++) {
        const raw = await io.prompt!("Paste the connection string: ", { secret: true });
        try {
          conn = decodeConnection(raw, code);
        } catch (e) {
          io.err(`${e instanceof Error ? e.message : String(e)}\n`);
          if (attempt >= 3) throw new CliError("No valid connection string after 3 attempts. Run `init` again.", EXIT.usage);
        }
      }
      token = conn.token;
      project = conn.project.key;
      envKey = conn.environment.key;
      sdkKey = conn.sdkKey ?? sdkKey;
      edgeUrl ??= conn.edgeUrl ?? undefined;
      say(`Connected to ${conn.project.name} · ${conn.environment.name}${conn.sdkKey ? ` · new ${kind} key ${conn.sdkKey.slice(0, 12)}…` : ""}.`);
    }
  }
  if (sdkKey === undefined) throw usage(`No SDK key. The Management API cannot create SDK keys: pass --key <${KEY_PREFIX[kind]}…> (Settings → SDK keys), or run init in a terminal to create one in the browser.`);
  const edge = checkUrl(edgeUrl ?? DEFAULT_EDGE, "--base-url");

  // 4. Project and environment (with a token).
  const mgmt = token === undefined ? null : new ManagementApi({ baseUrl: edge, key: token, fetch: io.fetch, userAgent: o.userAgent });
  let env: ManagedEnvironment | null = null;
  if (mgmt) {
    try {
      if (project === undefined) {
        const list = await mgmt.projects();
        if (list.data.length !== 1) throw usage(list.data.length === 0 ? "This token sees no project." : `This token sees ${list.data.length} projects; pass --project <key> (${list.data.slice(0, 10).map((p) => p.key).join(", ")}).`);
        project = list.data[0]!.key;
      }
      env = await mgmt.environment(project, envKey);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(`Could not read the ${envKey} environment of ${project ?? "the project"}: ${why(e)}`, e instanceof ApiError && e.status < 500 ? EXIT.usage : EXIT.unavailable);
    }
  }
  const envName = env?.name ?? envKey;

  // 5. Install the SDK.
  say("");
  if (d.hasSdk) say("✓ @nanoflags/sdk is already installed");
  else {
    const [cmd, args] = installCommand(d.packageManager);
    const line = `${cmd} ${args.join(" ")}`;
    if (o.skipInstall || !io.exec) say(`• Install the SDK: ${line}`);
    else {
      say(`• ${line}`);
      const code = await io.exec(cmd, args, io.cwd).catch(() => -1);
      say(code === 0 ? "✓ Installed @nanoflags/sdk" : `! The install did not finish (exit ${code}). Run it yourself: ${line}`);
    }
  }

  // 6. .env (never overwrite a value without asking) and .gitignore.
  const wanted: Array<[string, string]> = [[plan.keyVar, sdkKey]];
  if (edge !== DEFAULT_EDGE) wanted.push([plan.baseUrlVar, edge]);
  const outcomes = await mergeEnv(envPath, wanted, (name, current) => yesNo(io, interactive, `${plan.file} already sets ${name} (${current.slice(0, 12)}…). Replace it?`, false));
  for (const r of outcomes) {
    if (r.status === "added") say(`✓ ${plan.file}: added ${r.name}`);
    else if (r.status === "replaced") say(`✓ ${plan.file}: replaced ${r.name}`);
    else if (r.status === "unchanged") say(`✓ ${plan.file}: ${r.name} already set${reused && r.name === plan.keyVar ? " (reusing this key)" : ""}`);
    else say(`! ${plan.file}: kept your existing ${r.name}. The app uses that value, not the new one.`);
  }
  if (ensureIgnored(io.cwd, plan.file)) say(`✓ .gitignore: added ${plan.file} (it holds your SDK key)`);

  // 7. Client file.
  const file = clientFile(d, framework, edge);
  const written = writeClientFile(io.cwd, file);
  say(written === "written" ? `✓ Wrote ${file.path}` : written === "exists-same" ? `✓ ${file.path} is up to date` : `! ${file.path} already exists and was left as it is. Compare it with: https://nanoflags.io/docs#init`);

  // 8. The welcome-banner flag (draft only unless confirmed).
  let published: number | null = null;
  if (mgmt && project !== undefined && env) {
    try {
      let flag = await mgmt.flag(project, WELCOME_FLAG).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      });
      if (flag === null) {
        flag = await mgmt.createFlag(project, { key: WELCOME_FLAG, type: "boolean", name: "Welcome banner", description: "Created by `nanoflags init`.", initialValue: false, clientExposed: kind === "client", purpose: "release" }, randomUUID());
        say(`✓ Created the flag ${WELCOME_FLAG} (boolean, off; draft only, nothing published)`);
      } else say(`✓ The flag ${WELCOME_FLAG} exists`);
      if (kind === "client" && !flag.clientExposed) {
        if (await yesNo(io, interactive, `${WELCOME_FLAG} is not client-exposed, so a browser key never receives it. Mark it client-exposed?`, false)) {
          await mgmt.updateFlag(project, WELCOME_FLAG, { clientExposed: true });
          say(`✓ ${WELCOME_FLAG} is now client-exposed`);
        } else say(`! ${WELCOME_FLAG} is not client-exposed: your browser app will get its fallback (see https://nanoflags.io/docs/why-default#client-exposed).`);
      }
      const direct = !env.isProtected && !env.requireApproval && !env.requireScenarios;
      const publish = wantPublishFlag || (await yesNo(io, interactive, `Turn ${WELCOME_FLAG} on in ${envName} and publish a new revision now?`, false));
      if (publish && !direct) say(`! ${envName} publishes through a reviewed change, so init does not publish. Open ${appUrl}/app/flags/${WELCOME_FLAG}`);
      else if (publish) {
        await mgmt.updateConfig(project, WELCOME_FLAG, env.key, { enabled: true, default: true });
        const fresh = await mgmt.environment(project, env.key);
        const res = await mgmt.publish(project, env.key, { expectedRevision: fresh.publishedRevision, note: `nanoflags init: ${WELCOME_FLAG} on` }, randomUUID());
        published = res.revision;
        say(`✓ Published revision ${res.revision} to ${envName} (${WELCOME_FLAG} on)`);
      } else say(`• Nothing was published. To turn it on: ${appUrl}/app/flags/${WELCOME_FLAG} → on in ${envName} → Review & publish.`);
    } catch (e) {
      say(`! The ${WELCOME_FLAG} step did not finish: ${why(e)}`);
    }
  }

  // 9. How to use it.
  say("");
  say(`Use the flag (${FRAMEWORK_LABEL[framework]}):`);
  say("");
  say(usageSnippet(framework, file, WELCOME_FLAG, d));
  say("");

  // 10. Wait for the first report.
  const waitRaw = o.wait ?? (interactive && mgmt ? "300" : "0");
  const waitS = Number(waitRaw);
  if (!Number.isInteger(waitS) || waitS < 0 || waitS > 3600) throw usage(`--wait must be 0–3600 seconds, got "${waitRaw}".`);
  if (waitS === 0 || !mgmt || project === undefined || !env) {
    say(`Next: start your app. The welcome page shows the revision it reports: ${appUrl}/app/welcome`);
    return EXIT.ok;
  }
  const pkg = readPackageJson(io.cwd) as { scripts?: Record<string, unknown> } | null;
  const script = pkg?.scripts && typeof pkg.scripts.dev === "string" ? "dev" : pkg?.scripts && typeof pkg.scripts.start === "string" ? "start" : null;
  const runLine = script ? `${d.packageManager === "npm" ? "npm run" : d.packageManager} ${script}` : "your app";
  say(`Start ${script ? `it (${runLine})` : runLine} in another terminal and evaluate the flag once. Waiting up to ${waitS}s for service "${d.service}" to report from ${envName}…`);
  const deadline = io.now() + waitS * 1000;
  // Nothing published yet: a report of revision 0 is all there can be.
  const nothingPublished = published === null && env.publishedRevision === 0;
  let sawEmpty = false;
  while (io.now() < deadline) {
    try {
      const insights = await mgmt.insights(project, env.key);
      const hit = insights.services.find((s) => s.service === d.service && Date.parse(s.lastSeenAt) >= startedAt - 5_000);
      if (hit && hit.revision === 0 && nothingPublished) {
        say(`✓ ${hit.service} is connected to ${envName} (${hit.sdk || "sdk"}). Nothing is published there yet: publish once and it receives revision 1.`);
        return EXIT.ok;
      }
      if (hit && hit.revision > 0) {
        say(`✓ revision ${hit.revision} is live in ${envName} (${hit.service}, ${hit.sdk || "sdk"})`);
        if (published !== null && hit.revision < published) say(`  Revision ${published} was just published; the app picks it up within seconds.`);
        return EXIT.ok;
      }
      if (hit) sawEmpty = true;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 402 || e.status === 403)) {
        say(`! Cannot watch for reports with this token (${why(e)}). Check ${appUrl}/app/welcome instead.`);
        return EXIT.ok;
      }
      /* transient: keep polling */
    }
    await io.sleep(POLL_MS);
  }
  if (sawEmpty) say(`"${d.service}" reported from ${envName}, but without a configuration loaded (revision 0) after ${waitS}s: the key or the edge URL is probably wrong. Check:`);
  else say(`No report from "${d.service}" in ${envName} after ${waitS}s. Check:`);
  say(`  • the app is running and evaluates a flag (the first report goes out about 10 s after start)`);
  say(`  • it reads ${plan.keyVar} from ${plan.file}${framework === "node" ? ` (node --env-file=${plan.file} …)` : " (restart the dev server after changing it)"}`);
  say(`  • the browser console or server log shows no [nanoflags] errors (https://nanoflags.io/docs/errors)`);
  say(`  • service: "${d.service}" in ${file.path} was not renamed`);
  say(`The welcome page keeps watching: ${appUrl}/app/welcome`);
  return EXIT.failed;
}
