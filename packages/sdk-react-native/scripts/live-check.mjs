#!/usr/bin/env node
/**
 * Live check of the BUILT React Native package against the hosted edge, in a React-Native-like Node environment
 * (./rn-env.mjs: RN WebSocket signature with headers, AppState shim, no WebCrypto).
 *
 *   pnpm build
 *   NANOFLAGS_SDK_KEY=<public demo browser key> node --use-env-proxy --import ./scripts/rn-env.mjs scripts/live-check.mjs [--toggles 5] [--gap 4000]
 *
 * Uses the public live demo (`POST /v1/demo/toggle`, rate limited — keep it gentle) and restores the original value.
 *   1. default client (official edge: embedded keys, signatures required) → ready, live socket, signed bundle persisted;
 *   2. toggles `demo-accent` N times: toggle returned → `update` in the app, and the SDK's commit → update latency;
 *   3. lifecycle: background closes the socket and nothing arrives; foreground revalidates and catches up;
 *   4. offline start from the persisted bundle (re-verified with the pure-JS Ed25519);
 *   5. restores the original value.
 * Exit code 0 when every check passed.
 */
import { performance } from "node:perf_hooks";
import { AppState } from "react-native";
import { OFFICIAL_EDGE_URL, createClient, memoryStorage } from "../dist/index.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const TOGGLES = opt("toggles", 5);
const GAP_MS = opt("gap", 4000);
const KEY = process.env.NANOFLAGS_SDK_KEY;
if (!KEY) {
  console.error("Set NANOFLAGS_SDK_KEY to the public demo browser key (nf_pub_…).");
  process.exit(2);
}
const UA = "nanoflags-react-native-livecheck";
const COLORS = ["blue", "orange", "green"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (xs) => (xs.length ? `median ${Math.round(median(xs))} ms (min ${Math.round(Math.min(...xs))}, max ${Math.round(Math.max(...xs))}, n=${xs.length})` : "n/a");

async function demoState() {
  const res = await fetch(`${OFFICIAL_EDGE_URL}/v1/demo`, { headers: { "User-Agent": UA } });
  return res.json();
}

/** POST /v1/demo/toggle, honouring 429 Retry-After (at most 3 attempts). */
async function toggle(flag, value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${OFFICIAL_EDGE_URL}/v1/demo/toggle`, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ flag, value }) });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 429) return { httpStatus: res.status, ...body };
    const wait = Math.min(60_000, Number(body.retryAfterMs ?? 10_000) + 250);
    console.log(`  rate limited (${body.scope ?? "?"}), waiting ${wait} ms`);
    await sleep(wait);
  }
  return { httpStatus: 429 };
}

const storage = memoryStorage();
const updates = [];
const errors = [];
let waiters = [];
const t0 = performance.now();
const client = createClient({ sdkKey: KEY, service: "rn-livecheck", storage, events: false });
client.on("update", (u) => {
  const at = performance.now();
  updates.push({ at, u });
  for (const w of waiters.splice(0)) w({ at, u });
});
let phase = "start";
client.on("error", (e) => errors.push(Object.assign(e, { phase })));
const nextUpdate = (pred, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const w = (x) => {
      if (pred(x.u)) {
        clearTimeout(timer);
        resolve(x);
      } else waiters.push(w);
    };
    waiters.push(w);
  });

let original = null;
try {
  // ---- 0. Cloudflare and the User-Agent (one request): a default library agent vs ours.
  const libraryUa = await fetch(`${OFFICIAL_EDGE_URL}/v1/bundle`, { headers: { Authorization: `Bearer ${KEY}`, "User-Agent": "okhttp/4.12.0" } });
  const libraryBody = await libraryUa.text();
  console.log(`edge answer to User-Agent okhttp/4.12.0 (Android's default): HTTP ${libraryUa.status}${libraryUa.status === 403 ? ` (${libraryBody.slice(0, 40).trim()})` : ""}`);

  // ---- 1. default configuration
  phase = "default";
  await client.ready();
  const readyMs = performance.now() - t0;
  console.log(`first load attempt finished after ${Math.round(readyMs)} ms: status ${client.status}, revision r${client.revision}`);
  // The HTTP answer can be the edge's unsigned fallback while a revision is being distributed (refused on the
  // official edge); the live socket's `hello` then delivers the signed revision.
  const readyUntil = Date.now() + 15_000;
  while (client.status !== "ready" && Date.now() < readyUntil) await sleep(50);
  check(client.status === "ready", `verified configuration in use after ${Math.round(performance.now() - t0)} ms (r${client.revision}, via ${updates[0]?.u.transport ?? "?"})`);
  const until = Date.now() + 15_000;
  while (client.transport !== "live" && Date.now() < until) await sleep(50);
  check(client.transport === "live", `live socket open after ${Math.round(performance.now() - t0)} ms`);
  const opened = globalThis.WebSocket.opened?.[0];
  check(opened && opened.headers["User-Agent"]?.startsWith("nanoflags-react-native/") && !opened.url.includes(KEY), `socket via the React Native WebSocket signature: ${opened?.url}, protocols [${opened?.protocols?.[0]}, key.<redacted>], User-Agent ${opened?.headers["User-Agent"]}`);
  const stored = JSON.parse([...storage.entries.values()][0] ?? "{}");
  check(stored.sig?.kid === "k1" && stored.bundle?.revision === client.revision, `bundle verified (pure-JS Ed25519, kid ${stored.sig?.kid}, environment ${stored.sig?.environmentId?.slice(0, 8)}…) and persisted`);
  check(typeof globalThis.crypto === "undefined", "WebCrypto absent in this environment (as on Hermes)");
  const values = client.allFlags({ key: "rn-livecheck" });
  console.log("allFlags:", JSON.stringify(values));
  const detail = client.detail("demo-accent", "none");
  console.log(`detail demo-accent: value=${JSON.stringify(detail.value)} reason=${detail.reason} revision=r${detail.revision}`);
  check(typeof values["demo-accent"] === "string" && typeof values["demo-new-checkout"] === "boolean", "demo flags present in the client view");
  original = values["demo-accent"];

  // ---- 2. toggles over the live socket
  phase = "toggles";
  const appMs = [];
  const sdkMs = [];
  const roundTripMs = [];
  let current = original;
  for (let i = 0; i < TOGGLES; i++) {
    const value = COLORS[(COLORS.indexOf(current) + 1) % COLORS.length];
    const wait = nextUpdate((u) => client.string("demo-accent", "") === value, 15_000);
    const sent = performance.now();
    const r = await toggle("demo-accent", value);
    const returned = performance.now();
    if (r.status !== "published") {
      console.log(`  toggle ${i + 1}: ${JSON.stringify({ httpStatus: r.httpStatus, status: r.status, error: r.error })}`);
      if (r.status === "unchanged") current = value;
      await sleep(GAP_MS);
      continue;
    }
    const got = await wait;
    if (!got) {
      check(false, `toggle ${i + 1} → ${value} (r${r.revision}) reached the app`);
    } else {
      appMs.push(got.at - returned);
      roundTripMs.push(got.at - sent);
      if (got.u.latencyMs !== null) sdkMs.push(got.u.latencyMs);
      console.log(`  toggle ${i + 1}: ${value} r${r.revision} via ${got.u.transport}: toggle returned → update ${Math.round(got.at - returned)} ms, commit → update (SDK) ${got.u.latencyMs ?? "n/a"} ms, sent → update ${Math.round(got.at - sent)} ms`);
      check(got.u.transport === "live" && client.string("demo-accent", "") === value, `toggle ${i + 1} applied from the live push`);
    }
    current = value;
    await sleep(GAP_MS);
  }
  console.log(`toggle returned → update in the app: ${fmt(appMs)}`);
  console.log(`commit → update (SDK latencyMs):     ${fmt(sdkMs)}`);
  console.log(`toggle sent → update:                ${fmt(roundTripMs)}`);

  // ---- 3. lifecycle: background / foreground
  phase = "lifecycle";
  AppState.set("background");
  await sleep(300);
  check(client.transport !== "live" && client.lifecycle.paused, `background: socket closed (transport ${client.transport}), paused`);
  const before = updates.length;
  const bgValue = COLORS[(COLORS.indexOf(current) + 1) % COLORS.length];
  const r = await toggle("demo-accent", bgValue);
  if (r.status === "published") {
    current = bgValue;
    await sleep(3000);
    check(updates.length === before && client.string("demo-accent", "") !== bgValue, `background: r${r.revision} published, nothing received while paused`);
    const fg = performance.now();
    const caught = nextUpdate((u) => client.string("demo-accent", "") === bgValue, 15_000);
    AppState.set("active");
    const got = await caught;
    check(got !== null, `foreground: caught up to r${r.revision} in ${got ? Math.round(got.at - fg) : "?"} ms via ${got?.u.transport ?? "?"} (revalidation on resume)`);
    const until2 = Date.now() + 15_000;
    while (client.transport !== "live" && Date.now() < until2) await sleep(50);
    check(client.transport === "live", "foreground: live socket open again");
  } else {
    console.log(`  background toggle not published: ${JSON.stringify({ httpStatus: r.httpStatus, status: r.status })}`);
    AppState.set("active");
  }

  // ---- 4. offline start from the persisted bundle
  const offline = createClient({
    sdkKey: KEY,
    storage,
    events: false,
    appState: null,
    fetch: async () => {
      throw new TypeError("Network request failed");
    },
    streaming: false,
    pollIntervalMs: 0,
  });
  const offErrors = [];
  offline.on("error", (e) => offErrors.push(e));
  await offline.ready();
  check(offline.status === "stale" && offline.revision !== null && !offErrors.some((e) => e.code === "signature"), `offline start: persisted r${offline.revision} re-verified and used (status ${offline.status}), demo-accent=${offline.string("demo-accent", "?")}`);
  offline.close();
} finally {
  // ---- 5. restore
  phase = "restore";
  if (original !== null) {
    const state = await demoState().catch(() => null);
    if (state?.values?.["demo-accent"] !== original) {
      const r = await toggle("demo-accent", original);
      console.log(`restored demo-accent=${original}: ${r.status ?? r.httpStatus}${r.revision ? ` (r${r.revision})` : ""}`);
    } else console.log(`demo-accent already at its original value (${original})`);
  }
  client.close();
}
for (const e of errors) console.log(`  client error during ${e.phase} [${e.code}] ${e.message}`);
// "not signed" = the edge's unsigned fallback while a revision is still being distributed: refused (as required on the
// official edge) and fetched again; not a verification failure.
const badSignatures = errors.filter((e) => e.code === "signature" && !/not signed/.test(e.message));
check(badSignatures.length === 0, `no bundle failed verification (${errors.length} client errors in total${errors.length ? `: ${[...new Set(errors.map((e) => e.code))].join(", ")}` : ""})`);
console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
