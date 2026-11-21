#!/usr/bin/env node
/**
 * Conformance vectors for the version (`semver_*`) and date (`before` / `after`) operators.
 *
 *   node packages/engine/fixtures/generate-operators.mjs          # writes operators.json next to this file
 *   node packages/engine/fixtures/generate-operators.mjs --check  # exits 1 when operators.json is out of date
 *
 * The expectations here are written by hand from the contract (RUNTIME.md, "Version and date operators"); this script
 * deliberately does NOT import the engine. The engine's tests check it against every case, generate-parity.mjs embeds
 * every case in parity.json, and each SDK port runs parity.json, so all engines agree on these vectors.
 *
 * Case: { op, actual, value, expected, note? } — the condition { attribute: "attr", op, value } evaluated against the
 * context { attr: actual }. actual "__absent__" means the context has no "attr".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "operators.json");
const cases = [];
const SEMVER = ["semver_eq", "semver_neq", "semver_gt", "semver_gte", "semver_lt", "semver_lte"];
const truth = { semver_eq: (c) => c === 0, semver_neq: (c) => c !== 0, semver_gt: (c) => c > 0, semver_gte: (c) => c >= 0, semver_lt: (c) => c < 0, semver_lte: (c) => c <= 0, before: (c) => c < 0, after: (c) => c > 0 };
/** cmp: -1 / 0 / 1 for two valid inputs (actual vs value); null when either is invalid, which makes every operator false. */
function add(ops, actual, value, cmp, note) {
  for (const op of ops) cases.push({ op, actual, value, expected: cmp === null ? false : truth[op](cmp), ...(note ? { note } : {}) });
}
const sv = (a, b, cmp, note) => add(SEMVER, a, b, cmp, note);
const dt = (a, b, cmp, note) => add(["before", "after"], a, b, cmp, note);

/* ---------------- versions ---------------- */
const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
chain.forEach((a, i) => chain.forEach((b, j) => sv(a, b, Math.sign(i - j), "SemVer 2.0 precedence example")));
sv("4.10", "4.9", 1, "missing patch is 0; 10 > 9 numerically");
sv("4.10.0", "4.9.0", 1);
sv("4.10", "4.10.0", 0, "lenient: 4.10 = 4.10.0");
sv("4", "4.0.0", 0, "lenient: 4 = 4.0.0");
sv("4.2", "4.10", -1);
sv("1.2.3", "1.2.3", 0);
sv("1.2.3", "1.2.4", -1);
sv("1.3.0", "1.2.9", 1);
sv("2.0.0", "1.99.99", 1);
sv("0.0.1", "0.0.0", 1);
sv("v1.2.3", "1.2.3", 0, "leading v");
sv("V1.2.3", "v1.2.3", 0, "leading V");
sv("v4.10", "4.9.9", 1);
sv("1.2.3+build.5", "1.2.3", 0, "build metadata ignored");
sv("1.2.3+build.5", "1.2.3+build.6", 0, "build metadata ignored");
sv("1.2.3-rc.1+build.5", "1.2.3-rc.1", 0, "build metadata ignored");
sv("1.2.3+exp.sha.5114f85", "1.2.4", -1);
sv("1.0.0-0", "1.0.0", -1, "numeric prerelease");
sv("1.0.0-0", "1.0.0-a", -1, "numeric identifiers sort before alphanumeric ones");
sv("1.0.0-2", "1.0.0-10", -1, "numeric identifiers compare numerically");
sv("1.0.0-a2", "1.0.0-a10", 1, "alphanumeric identifiers compare in ASCII order");
sv("1.0.0-Beta", "1.0.0-beta", -1, "ASCII order: uppercase before lowercase");
sv("1.0.0-alpha-1", "1.0.0-alpha-2", -1, "hyphens inside identifiers");
sv("1.0.0-x.7.z.92", "1.0.0-x.7.z.92", 0);
sv("1.0.0-alpha.1", "1.0.0-alpha.1.0", -1, "fewer identifiers sort first");
sv("4.10-beta", "4.10.0-beta", 0, "lenient core with a prerelease");
sv("1.2-3.4", "1.2.0-3.4", 0, "1.2-3.4 is 1.2.0 with prerelease 3.4");
sv("2026.01.05", "2026.1.5", 0, "lenient: leading zeros are ignored");
sv("1.0.0-01", "1.0.0-1", 0, "lenient: leading zeros in numeric prerelease identifiers are ignored");
sv("007", "7.0.0", 0, "lenient: leading zeros are ignored");
sv("99999999999999999999.0.0", "99999999999999999998.0.0", 1, "numbers beyond 64 bits");
sv("1.18446744073709551616.0", "1.18446744073709551615.0", 1, "2^64 vs 2^64-1");
sv("9007199254740993.0.0", "9007199254740992.0.0", 1, "numbers beyond 2^53");
sv("1.0.0-99999999999999999999", "1.0.0-99999999999999999998", 1, "huge numeric prerelease identifiers");
sv("1.0.0-99999999999999999999", "1.0.0-a", -1);
sv("0000000000000000000001.0.0", "1.0.0", 0);
const badVersions = [
  ["", "empty"], [" 1.2.3", "leading space"], ["1.2.3 ", "trailing space"], ["1.2.3.4", "four numbers"], ["1..2", "empty number"],
  ["1.", "trailing dot"], [".1", "leading dot"], ["1.2.3-", "empty prerelease"], ["1.2.3+", "empty build metadata"],
  ["1.2.3-a..b", "empty identifier"], ["1.2.3-a_b", "underscore"], ["vv1.2.3", "double v"], ["v", "only v"], ["x1.2.3", "other prefix"],
  ["1.2.x", "wildcard"], ["^1.2.3", "range"], [">=1.2.3", "range"], ["1.2.3-α", "non-ASCII"], ["１.２.３", "fullwidth digits"],
  ["-1.0.0", "negative"], ["1.2.3+b+c", "two plus signs"], ["1.2.3\n", "newline"], ["1." + "1".repeat(300), "longer than 256 characters"],
];
for (const [bad, why] of badVersions) {
  sv(bad, "1.2.3", null, `invalid: ${why}`);
  sv("1.2.3", bad, null, `invalid comparison value: ${why}`);
}
for (const v of [null, 4, 4.1, true, [], ["1.2.3"], { v: "1.2.3" }]) {
  sv(v, "1.2.3", null, "versions must be strings");
  sv("1.2.3", v, null, "versions must be strings");
}
sv("__absent__", "1.2.3", null, "attribute missing");

/* ---------------- dates ---------------- */
dt("2026-01-01", "2026-01-02", -1);
dt("2026-01-02", "2026-01-01", 1);
dt("2026-01-01", "2026-01-01T00:00:00Z", 0, "a date is 00:00 UTC");
dt("2026-01-01", "2026-01-01T00:00:00.001Z", -1);
dt("2026-01-01T03:00:00+03:00", "2026-01-01T00:00:00Z", 0, "offsets");
dt("2026-01-01T02:59:59+03:00", "2026-01-01", -1);
dt("2025-12-31T21:00:00-03:00", "2026-01-01", 0, "a negative offset crosses the year");
dt("2025-12-31T21:00:01-03:00", "2026-01-01", 1, "a negative offset crosses the year");
dt("2026-01-01T05:45:00+05:45", "2026-01-01", 0, "45-minute offset");
dt("2026-06-15T12:00:00-00:00", "2026-06-15T12:00:00Z", 0);
dt("2026-06-15t12:00:00z", "2026-06-15T12:00:00Z", 0, "lowercase t and z");
dt("2026-06-15 12:00:00Z", "2026-06-15T12:00:00Z", 0, "space separator (RFC 3339 note)");
dt("2026-06-15T12:00Z", "2026-06-15T12:00:00Z", 0, "seconds are optional");
dt("2026-06-15T12:00:00.5Z", "2026-06-15T12:00:00.499Z", 1, "a fraction of .5 is 500 ms");
dt("2026-06-15T12:00:00.1239Z", "2026-06-15T12:00:00.123Z", 0, "fractions beyond milliseconds are truncated");
dt("2026-06-15T12:00:00.123456789Z", "2026-06-15T12:00:00.124Z", -1);
dt("2024-02-29", "2024-03-01", -1, "leap day");
dt("2024-02-29T23:59:59Z", "2024-03-01", -1, "leap day");
dt("2024-02-28T23:00:00-02:00", "2024-02-29T01:00:00Z", 0, "an offset moves into the leap day");
dt("2000-02-29", "2000-03-01", -1, "2000 is a leap year");
dt("2023-02-29", "2024-01-01", null, "2023 is not a leap year");
dt("1900-02-29", "2024-01-01", null, "1900 is not a leap year");
dt("2100-02-29", "2024-01-01", null, "2100 is not a leap year");
dt("0000-01-01", "1970-01-01", -1, "year 0");
dt("0000-02-29", "0000-03-01", -1, "year 0 is a leap year");
dt("9999-12-31T23:59:59.999Z", "2026-01-01", 1);
dt("1969-12-31T23:59:59Z", "1970-01-01", -1, "before the epoch");
dt(1767225600, "2026-01-01", 0, "epoch seconds");
dt(1767225600000, "2026-01-01", 0, "epoch milliseconds (magnitude >= 1e12)");
dt(1767225599, "2026-01-01", -1);
dt(1767225600001, "2026-01-01", 1);
dt(1767225600.5, 1767225600500, 0, "fractional seconds");
dt(999999999999, 1000000000, 1, "999999999999 is seconds (below 1e12)");
dt(1000000000000, 1000000000, 0, "1e12 is milliseconds");
dt(0, "1970-01-01", 0);
dt(-86400, "1969-12-31", 0, "negative seconds");
dt(-1000000000000, -1000000000, 0, "negative milliseconds");
dt(1e300, "9999-12-31", 1, "huge numbers are valid");
const badDates = [
  ["2026-13-01", "month 13"], ["2026-00-10", "month 0"], ["2026-04-31", "April 31"], ["2026-01-00", "day 0"], ["2026-01-32", "day 32"],
  ["2026-01-01T24:00:00Z", "hour 24"], ["2026-01-01T10:60:00Z", "minute 60"], ["2026-01-01T10:00:60Z", "second 60"],
  ["2026-01-01T10:00:00", "no offset"], ["2026-01-01T10:00:00+24:00", "offset of 24 hours"], ["2026-01-01T10:00:00+03:60", "offset minute 60"],
  ["2026-01-01T10:00:00+0300", "offset without a colon"], ["2026-1-1", "single digits"], ["26-01-01", "two-digit year"],
  ["+2026-01-01", "extended year"], ["2026/01/01", "slashes"], ["01/02/2026", "US date"], ["2026-01-01T10Z", "hour only"],
  ["2026-01-01T10:00:00.Z", "empty fraction"], ["2026-01-01T10:00:00.1234567890Z", "fraction longer than 9 digits"],
  ["1767225600", "numeric string"], ["", "empty"], [" 2026-01-01", "leading space"], ["2026-01-01 ", "trailing space"],
  ["tomorrow", "words"], ["2026-01-01T10:00:00Z[Asia/Riyadh]", "zone name"], ["２０２６-01-01", "fullwidth digits"],
  ["2026-01-01T", "dangling T"], ["2026-01-01\n", "trailing newline"], ["2026-01-01T10:00:00Z\n", "trailing newline"],
];
for (const [bad, why] of badDates) {
  dt(bad, "2026-01-01", null, `invalid: ${why}`);
  dt("2026-01-01", bad, null, `invalid comparison value: ${why}`);
}
for (const v of [null, true, [], [1767225600], { t: 1 }]) {
  dt(v, "2026-01-01", null, "dates must be strings or numbers");
  dt("2026-01-01", v, null, "dates must be strings or numbers");
}
dt("__absent__", "2026-01-01", null, "attribute missing");

const text = `{\n"description": ${JSON.stringify("Conformance vectors for the semver_* and before/after operators. Hand-written from RUNTIME.md (Version and date operators) by generate-operators.mjs, which does not use the engine. Case: the condition { attribute: 'attr', op, value } against the context { attr: actual }; actual '__absent__' = no attribute. Every NanoFlags engine must reproduce every case.")},\n"version": 1,\n"cases": [\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]\n}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch {}
  if (current !== text) { console.error("operators.json is out of date: run node packages/engine/fixtures/generate-operators.mjs"); process.exit(1); }
  console.log(`operators.json up to date (${cases.length} cases)`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out} (${cases.length} cases)`);
}
