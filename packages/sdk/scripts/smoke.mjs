#!/usr/bin/env node
/**
 * Integration smoke test: SDK → a NanoFlags edge → your project's published configuration.
 *
 *   NANOFLAGS_SDK_KEY=nf_srv_… pnpm --filter @nanoflags/sdk smoke   # builds, then runs this file
 *
 * Environment:
 *   NANOFLAGS_SDK_KEY   required — a server SDK key of the environment to test. Never commit it.
 *   NANOFLAGS_BASE_URL  optional — edge URL, default https://edge.nanoflags.io
 *
 * The flag keys below (checkout-v2, search-ranking) are examples; flags your environment does not
 * define are reported as `flag_not_found` and fall back to the default.
 */
import { createClient } from "../dist/index.js";

const baseUrl = process.env.NANOFLAGS_BASE_URL || "https://edge.nanoflags.io";
const sdkKey = process.env.NANOFLAGS_SDK_KEY;
if (!sdkKey) {
  console.error("NANOFLAGS_SDK_KEY is not set. Export a server SDK key (nf_srv_…) for the environment to test, e.g.\n  NANOFLAGS_SDK_KEY=nf_srv_… pnpm --filter @nanoflags/sdk smoke");
  process.exit(2);
}

let requests = 0;
const countingFetch = (input, init) => {
  requests++;
  return fetch(input, init);
};

const client = createClient({ sdkKey, baseUrl, service: "sdk-smoke", fetch: countingFetch, events: { sampleRate: 1, flushIntervalMs: 60_000 } });
client.on("error", (e) => console.error(`[error] ${e.code}: ${e.message}`));
client.on("update", (e) => console.log(`[update] revision ${e.revision} (from ${e.source})`));

await client.ready();
console.log(`status=${client.status} revision=${client.revision}`);
if (client.status === "not-ready") {
  console.error("No bundle could be loaded from " + baseUrl + ". Check NANOFLAGS_SDK_KEY and NANOFLAGS_BASE_URL.");
  client.close();
  process.exit(1);
}

const before = requests;
const eligible = { signedIn: true, region: "US" };
const result = client.evaluate("checkout-v2", false, { key: "user-1", ...eligible });
console.log(`checkout-v2 for user-1 → ${result.value} (reason=${result.reason}, rule=${result.ruleId ?? "-"}, bucket=${result.bucket ?? "-"}, inRollout=${result.inRollout ?? "-"}, revision=${result.revision})`);
for (const step of result.trace) console.log(`    ${step.kind.padEnd(10)} ${step.title} — ${step.detail}`);

let inside = 0;
const n = 2000;
for (let i = 0; i < n; i++) if (client.boolean("checkout-v2", false, { key: `user-${i}`, ...eligible })) inside++;
console.log(`checkout-v2 enabled for ${inside}/${n} eligible users (${((inside / n) * 100).toFixed(1)}%)`);
console.log(`checkout-v2 for a signed-out user → ${client.boolean("checkout-v2", false, { key: "user-1", signedIn: false, region: "US" })}`);
console.log(`search-ranking → ${client.string("search-ranking", "fallback", { key: "user-1" })}`);
console.log(`type mismatch (search-ranking as boolean) → ${client.boolean("search-ranking", false)} (fallback)`);
console.log(`unknown flag → ${client.evaluate("does-not-exist", "fallback").reason}`);
console.log(`network requests caused by ${n + 6} evaluations: ${requests - before}`);

await client.flush(); // service report + one batch of sampled events
console.log("events flushed for service sdk-smoke");
client.close();
