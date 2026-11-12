#!/usr/bin/env node
/**
 * Cross-language parity fixtures for the NanoFlags engine.
 *
 *   node packages/engine/fixtures/generate-parity.mjs        # writes packages/engine/fixtures/parity.json
 *   node packages/engine/fixtures/generate-parity.mjs --check  # exits 1 when parity.json is out of date
 *
 * Every expected result is produced by the TypeScript engine itself (`../src/index.ts`, loaded with Node's
 * built-in type stripping, Node >= 22.18), so a port in another language is correct when it reproduces all of
 * them. Deterministic: no clock, no Math.random (a seeded PRNG drives the generated identities).
 *
 * File layout (version 1):
 *   engineVersion            ENGINE_VERSION of the engine that produced the file
 *   murmur3[]                { input, seed, hash }           murmur3(input, seed)
 *   buckets[]                { seed, identity, bucket }      bucketOf(seed, identity)
 *   supportsEngine[]         { bundle, expected }            supportsEngine(bundle)
 *   clientBundle[]           { bundle, expected }            clientBundle(bundle)
 *   bundles[]                bundle documents referenced by index from the cases (some deliberately malformed)
 *   contexts[]               evaluation contexts referenced by index
 *   cases[]                  { name, bundle, flag, context, fallback, expected }
 *     bundle / context       index into bundles / contexts (bundle -1 = null bundle)
 *     expected               { value?, reason, ruleIndex?, ruleId?, inRollout?, bucket?, revision, trace?, error? }
 *       value absent         the engine returned `undefined` (a JSON-less value; ports return their null)
 *       trace absent         not recorded for this case (matrix rows after the first); compare when present
 *       error                true when the engine reported an evaluation error; the message is engine-specific,
 *                            so compare the trace without the detail of its last step
 *
 * JSON cannot carry `undefined`; contexts never contain it (an absent attribute is simply not there).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION, bucketOf, clientBundle, evaluate, murmur3, supportsEngine } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "parity.json");

/* ---------------- deterministic PRNG (mulberry32) ---------------- */
let state = 0x5eed1234;
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
function randomString(len) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.@:/ äöüßéπ日本語🙂";
  const chars = [...alphabet];
  let s = "";
  for (let i = 0; i < len; i++) s += pick(chars);
  return s;
}

/* ---------------- hashing vectors ---------------- */
const murmurInputs = [
  "", "a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "abcdefghi",
  "test", "Hello, world!", "The quick brown fox jumps over the lazy dog",
  "ππππππππ", "日本語", "🙂", "a🙂b", "user-123", "checkout-v2:user-42",
  "é", "é", // NFD and NFC spellings of é must hash alike (input is NFC-normalised)
  "Å", "Å", // Å via combining ring, and ANGSTROM SIGN (both normalise to U+00C5)
  "\u0000", "tab\tnew\nline", "x".repeat(255), "x".repeat(256), "ß".repeat(33),
];
const murmurSeeds = [0, 1, 42, 0x9747b28c, 0xffffffff];
const murmurCases = [];
for (const input of murmurInputs) for (const seed of murmurSeeds) murmurCases.push({ input, seed, hash: murmur3(input, seed) });
for (let i = 0; i < 200; i++) {
  const input = randomString(Math.floor(rand() * 24));
  const seed = Math.floor(rand() * 4294967296);
  murmurCases.push({ input, seed, hash: murmur3(input, seed) });
}

const bucketCases = [];
const bucketSeeds = ["checkout-v2", "flag", "", "seed-🙂", "nanoflags", "x"];
for (const seed of bucketSeeds) {
  for (let i = 0; i < 60; i++) {
    const identity = i < 20 ? `user-${i}` : randomString(1 + Math.floor(rand() * 20));
    bucketCases.push({ seed, identity, bucket: bucketOf(seed, identity) });
  }
}
// Search for identities that land on the edges of the range: buckets 0.00, 99.99 and the exact boundary 50.00.
for (const target of [0, 9999, 5000, 1, 9998]) {
  for (let i = 0, found = 0; i < 2_000_000 && found < 2; i++) {
    const identity = `edge-${i}`;
    if (murmur3(`edge-seed:${identity}`) % 10000 === target) {
      bucketCases.push({ seed: "edge-seed", identity, bucket: bucketOf("edge-seed", identity) });
      found++;
    }
  }
}

/* ---------------- supportsEngine / clientBundle ---------------- */
const engineInputs = [{}, { engine: 1 }, { engine: ENGINE_VERSION }, { engine: ENGINE_VERSION + 1 }, { engine: 0 }, { engine: -1 }, { engine: 1.5 }, { engine: "1" }, { engine: null }, { engine: true }, { engine: [1] }];
const supportsEngineCases = engineInputs.map((bundle) => ({ bundle, expected: supportsEngine(bundle) }));

const clientInputs = [
  {
    schema: 1, project: "p", environment: "e", revision: 3,
    flags: {
      pub: { type: "boolean", enabled: true, clientExposed: true, default: false, off: false, rules: [{ id: "r1", match: "all", conditions: [{ attribute: "", op: "segment", value: "beta" }], serve: { type: "fixed", value: true } }] },
      priv: { type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "r1", match: "all", conditions: [{ attribute: "", op: "segment", value: "internal" }], serve: { type: "fixed", value: true } }] },
      exposedFalse: { type: "string", enabled: true, clientExposed: false, default: "a", off: "b", rules: [] },
      exposedTruthy: { type: "string", enabled: true, clientExposed: "yes", default: "a", off: "b", rules: [] },
    },
    segments: {
      beta: { match: "any", conditions: [{ attribute: "", op: "segment", value: "staff" }, { attribute: "plan", op: "eq", value: "beta" }] },
      staff: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "beta" }, { attribute: "", op: "segment", value: "missing" }] },
      internal: { match: "all", conditions: [{ attribute: "email", op: "ends_with", value: "@corp.example" }] },
      unused: { match: "all", conditions: [] },
    },
  },
  { schema: 1, project: "p", environment: "e", revision: 1, flags: {}, segments: { a: { match: "all", conditions: [] } } },
];
const clientBundleCases = clientInputs.map((bundle) => ({ bundle, expected: clientBundle(bundle) }));

/* ---------------- evaluation cases ---------------- */
const bundles = [];
const contexts = [];
const contextIndex = new Map();
const cases = [];

function addBundle(b) {
  bundles.push(b);
  return bundles.length - 1;
}
function ctxIndex(ctx) {
  const k = JSON.stringify(ctx);
  if (!contextIndex.has(k)) {
    contexts.push(ctx);
    contextIndex.set(k, contexts.length - 1);
  }
  return contextIndex.get(k);
}
function expectedOf(e, withTrace) {
  const x = { reason: e.reason, revision: e.revision };
  if (e.value !== undefined) x.value = e.value;
  if (e.ruleIndex !== undefined) x.ruleIndex = e.ruleIndex;
  if (e.ruleId !== undefined) x.ruleId = e.ruleId;
  if (e.inRollout !== undefined) x.inRollout = e.inRollout;
  if (e.bucket !== undefined) x.bucket = e.bucket;
  if (e.error !== undefined) x.error = true;
  if (withTrace) x.trace = e.trace;
  return x;
}
function addCase(name, bundleIdx, flag, ctx, fallback, withTrace = true) {
  const b = bundleIdx === -1 ? null : bundles[bundleIdx];
  // The engine must never be handed shared mutable state across cases: evaluate a deep copy.
  const e = evaluate(b === null ? null : structuredClone(b), flag, structuredClone(ctx), fallback);
  cases.push({ name, bundle: bundleIdx, flag, context: ctxIndex(ctx), fallback, expected: expectedOf(e, withTrace) });
}
const base = (flags, segments = {}, extra = {}) => ({ schema: 1, engine: 1, project: "parity", environment: "test", revision: 7, flags, segments, ...extra });
const ruleFlag = (rules, extra = {}) => ({ type: "json", enabled: true, default: "default", off: "off", rules, ...extra });

// 1. Operator × comparison value × context value matrix (type coercions live here).
const sampleValues = [
  null, true, false, 0, 1, -1, 1.5, 10, 100, 1e21, 1e-7, -0.5, 9007199254740993,
  "10", " 10 ", "1e1", "0x10", "0b11", "0o7", ".5", "5.", "+5", "-0x10", "5_0", "Infinity", "-Infinity", "NaN",
  " 10 ", "﻿7", "١٢", "", " ", "abc", "ABC", "a", "bc", "b", "ab", "true", "null", "🙂x", "x🙂",
  [], [1], ["a"], ["10"], [1, "a", null], {}, { a: 1 }, { a: 1, b: [2] },
];
const comparisonValues = [
  null, true, false, 0, 1, 10, 1.5, -1, 9007199254740992, 1e21, "10", "1e1", "0x10", " ", "", "a", "abc", "b", "true", "🙂",
  [], [1], ["a"], [10, "10"], [null], [true, 1], ["abc", "x"], [{ a: 1 }], [[1]], {}, { a: 1 },
];
const ops = ["eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "exists", "not_exists", "matches_regex"];
const matrixContexts = [{}, ...sampleValues.map((v) => ({ key: "u", attr: v }))];
for (const op of ops) {
  const flags = {};
  const compare = op === "exists" || op === "not_exists" ? [undefined, ...comparisonValues.slice(0, 3)] : [undefined, ...comparisonValues];
  compare.forEach((value, i) => {
    const condition = value === undefined ? { attribute: "attr", op } : { attribute: "attr", op, value };
    flags[`f${i}`] = ruleFlag([{ id: `r-${op}`, match: "all", conditions: [condition], serve: { type: "fixed", value: "matched" } }]);
  });
  const b = addBundle(base(flags));
  compare.forEach((_, i) => {
    matrixContexts.forEach((ctx, j) => addCase(`matrix ${op} f${i} ctx${j}`, b, `f${i}`, ctx, "fallback", j === 1));
  });
}

// 2. Match modes and condition lists.
{
  const c1 = { attribute: "a", op: "eq", value: 1 };
  const c2 = { attribute: "b", op: "eq", value: 2 };
  const flags = {
    all: ruleFlag([{ id: "r", match: "all", conditions: [c1, c2], serve: { type: "fixed", value: 1 } }]),
    any: ruleFlag([{ id: "r", match: "any", conditions: [c1, c2], serve: { type: "fixed", value: 1 } }]),
    upper: ruleFlag([{ id: "r", match: "ANY", conditions: [c1, c2], serve: { type: "fixed", value: 1 } }]),
    missingMatch: ruleFlag([{ id: "r", conditions: [c1, c2], serve: { type: "fixed", value: 1 } }]),
    empty: ruleFlag([{ id: "r", match: "any", conditions: [], serve: { type: "fixed", value: "everyone" } }]),
    second: ruleFlag([
      { id: "first", match: "all", conditions: [c1], serve: { type: "fixed", value: "first" } },
      { id: "second", match: "all", conditions: [c2], serve: { type: "fixed", value: "second" } },
      { id: "third", match: "all", conditions: [], serve: { type: "fixed", value: "third" } },
    ]),
    noRules: ruleFlag([]),
    emptyStringConditions: ruleFlag([{ id: "r", match: "all", conditions: "", serve: { type: "fixed", value: "odd" } }]),
  };
  const b = addBundle(base(flags));
  const ctxs = [{}, { a: 1 }, { b: 2 }, { a: 1, b: 2 }, { a: "1", b: 2 }, { a: 1.0, b: 2.0 }];
  for (const f of Object.keys(flags)) for (const ctx of ctxs) addCase(`match ${f} ${JSON.stringify(ctx)}`, b, f, ctx, "fallback");
}

// 3. Enabled / off / default / truthiness of `enabled` / flag lookup.
{
  const flags = {};
  const enabledValues = [true, false, 1, 0, "", "false", null, [], {}];
  enabledValues.forEach((en, i) => (flags[`enabled${i}`] = { type: "string", enabled: en, default: "on-default", off: "off-value", rules: [] }));
  flags.noEnabled = { type: "string", default: "d", off: "o", rules: [] };
  flags.emptyObject = {};
  flags.nullFlag = null;
  flags.falseFlag = false;
  flags.zeroFlag = 0;
  flags.stringFlag = "x";
  flags.offNull = { type: "json", enabled: false, default: 1, off: null, rules: [] };
  flags.defaultObject = { type: "json", enabled: true, default: { nested: [1, 2, { x: "y" }] }, off: null, rules: [] };
  flags["constructor"] = { type: "string", enabled: true, default: "own-constructor", off: "o", rules: [] };
  const b = addBundle(base(flags));
  for (const f of [...Object.keys(flags), "missing", "toString", "__proto__", "hasOwnProperty"]) addCase(`flag ${f}`, b, f, { key: "u" }, "fallback");
  // Bundles without flags/segments, bundles that are not objects, revision variants.
  addCase("null bundle", -1, "x", {}, "fb");
  addCase("empty bundle object", addBundle({}), "x", {}, "fb");
  addCase("flags null", addBundle({ schema: 1, revision: 2, flags: null, segments: {} }), "x", {}, "fb");
  const one = { f: { type: "boolean", enabled: true, default: true, off: false, rules: [] } };
  for (const revision of [0, 1, 7, null, "5", "x", -3]) addCase(`revision ${JSON.stringify(revision)}`, addBundle({ ...base(one), revision }), "f", {}, false);
  const noRev = base(one);
  delete noRev.revision;
  addCase("revision missing", addBundle(noRev), "f", {}, false);
  for (const fallback of [null, 0, "", { a: 1 }, [1, 2], true]) addCase(`fallback ${JSON.stringify(fallback)}`, b, "missing", {}, fallback);
}

// 4. Malformed configurations (evaluation errors are caught, the fallback is served).
{
  const flags = {
    rulesMissing: { type: "string", enabled: true, default: "d", off: "o" },
    rulesNull: { type: "string", enabled: true, default: "d", off: "o", rules: null },
    ruleNull: { type: "string", enabled: true, default: "d", off: "o", rules: [null] },
    conditionsMissing: ruleFlag([{ id: "r", match: "all", serve: { type: "fixed", value: 1 } }]),
    conditionNull: ruleFlag([{ id: "r", match: "all", conditions: [null], serve: { type: "fixed", value: 1 } }]),
    serveMissing: ruleFlag([{ id: "r", match: "all", conditions: [] }]),
    serveNull: ruleFlag([{ id: "r", match: "all", conditions: [], serve: null }]),
    serveUnknownType: ruleFlag([{ id: "r", match: "all", conditions: [], serve: { type: "weird", percentage: 100, value: "v", otherwise: "o" } }]),
    fixedWithoutValue: ruleFlag([{ id: "r", match: "all", conditions: [], serve: { type: "fixed" } }]),
    noRuleId: ruleFlag([{ match: "all", conditions: [], serve: { type: "fixed", value: "x" } }]),
    nonMatchingFirstThenNull: ruleFlag([{ id: "r1", match: "all", conditions: [{ attribute: "a", op: "eq", value: 1 }], serve: { type: "fixed", value: 1 } }, null]),
    segmentWithoutConditions: ruleFlag([{ id: "r", match: "all", conditions: [{ attribute: "", op: "segment", value: "broken" }], serve: { type: "fixed", value: 1 } }]),
    numericAttribute: ruleFlag([{ id: "r", match: "all", conditions: [{ attribute: 5, op: "eq", value: "five" }], serve: { type: "fixed", value: 1 } }]),
    missingAttribute: ruleFlag([{ id: "r", match: "all", conditions: [{ op: "exists" }], serve: { type: "fixed", value: 1 } }]),
  };
  const b = addBundle(base(flags, { broken: { match: "all" } }));
  for (const f of Object.keys(flags)) {
    addCase(`malformed ${f}`, b, f, { key: "u", a: 1, 5: "five" }, "fallback");
    addCase(`malformed ${f} (no a)`, b, f, { key: "u" }, "fallback");
  }
}

// 5. Segments: membership, negation, nesting depth, cycles, unknown keys.
{
  const segments = {
    beta: { match: "any", conditions: [{ attribute: "plan", op: "eq", value: "beta" }, { attribute: "email", op: "ends_with", value: "@beta.example" }] },
    eu: { match: "all", conditions: [{ attribute: "region", op: "in", value: ["DE", "FR", "NL"] }] },
    betaEu: { match: "all", conditions: [{ attribute: "", op: "segment", value: "beta" }, { attribute: "", op: "segment", value: "eu" }] },
    notEu: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "eu" }] },
    everyone: { match: "all", conditions: [] },
    nobodyAny: { match: "any", conditions: [] },
    d1: { match: "all", conditions: [{ attribute: "", op: "segment", value: "d2" }] },
    d2: { match: "all", conditions: [{ attribute: "", op: "segment", value: "d3" }] },
    d3: { match: "all", conditions: [{ attribute: "", op: "segment", value: "d4" }] },
    d4: { match: "all", conditions: [{ attribute: "", op: "segment", value: "d5" }] },
    d5: { match: "all", conditions: [{ attribute: "plan", op: "exists" }] },
    n1: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "n2" }] },
    n2: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "n3" }] },
    n3: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "n4" }] },
    n4: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "n5" }] },
    n5: { match: "all", conditions: [{ attribute: "plan", op: "exists" }] },
    cycleA: { match: "any", conditions: [{ attribute: "", op: "segment", value: "cycleB" }, { attribute: "vip", op: "eq", value: true }] },
    cycleB: { match: "any", conditions: [{ attribute: "", op: "segment", value: "cycleA" }] },
    unknownRef: { match: "all", conditions: [{ attribute: "", op: "segment", value: "doesNotExist" }] },
    notUnknownRef: { match: "all", conditions: [{ attribute: "", op: "not_segment", value: "doesNotExist" }] },
    ["__proto__"]: { match: "all", conditions: [{ attribute: "plan", op: "eq", value: "proto" }] },
  };
  const seg = (op, value) => ruleFlag([{ id: `r-${op}-${value}`, match: "all", conditions: [{ attribute: "ignored", op, value }], serve: { type: "fixed", value: `${op}:${value}` } }]);
  const flags = {};
  for (const k of [...Object.keys(segments), "doesNotExist", "constructor", "toString"]) {
    flags[`in-${k}`] = seg("segment", k);
    flags[`out-${k}`] = seg("not_segment", k);
  }
  flags["segment-number-value"] = ruleFlag([{ id: "r", match: "all", conditions: [{ attribute: "", op: "segment", value: 1 }], serve: { type: "fixed", value: "x" } }]);
  flags["not-segment-null-value"] = ruleFlag([{ id: "r", match: "all", conditions: [{ attribute: "", op: "not_segment", value: null }], serve: { type: "fixed", value: "x" } }]);
  flags["segment-no-value"] = ruleFlag([{ id: "r", match: "all", conditions: [{ attribute: "", op: "segment" }], serve: { type: "fixed", value: "x" } }]);
  const b = addBundle(base(flags, segments));
  const noSegments = addBundle(base({ f: seg("segment", "beta"), g: seg("not_segment", "beta") }, undefined));
  delete bundles[noSegments].segments;
  const ctxs = [
    {}, { plan: "beta" }, { plan: "beta", region: "DE" }, { region: "FR" }, { email: "a@beta.example", region: "NL" },
    { plan: "free", region: "US" }, { vip: true }, { vip: "true" }, { plan: "proto" }, { plan: null },
  ];
  for (const f of Object.keys(flags)) for (const ctx of ctxs) addCase(`segment ${f} ${JSON.stringify(ctx)}`, b, f, ctx, "fallback");
  for (const f of ["f", "g"]) addCase(`segments missing ${f}`, noSegments, f, { plan: "beta" }, "fallback");
}

// 6. Rollouts: percentages (incl. coercions), bucketBy, seeds, identity types.
{
  const percentages = [0, 0.01, 1, 10, 33.33, 50, 66.67, 99.99, 100, -1, 101, "50", "abc", null, true, false, [50], [], {}, "", " 25 "];
  const flags = {};
  percentages.forEach((p, i) => {
    flags[`p${i}`] = ruleFlag([{ id: `roll${i}`, match: "all", conditions: [], serve: { type: "rollout", percentage: p, value: "in", otherwise: "out" } }]);
  });
  flags.pMissing = ruleFlag([{ id: "rm", match: "all", conditions: [], serve: { type: "rollout", value: "in", otherwise: "out" } }]);
  flags.byOrg = ruleFlag([{ id: "org", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: "org" } }]);
  flags.byNullBucketBy = ruleFlag([{ id: "nb", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: null } }]);
  flags.byNumericBucketBy = ruleFlag([{ id: "num", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: 5 } }]);
  flags.seeded = ruleFlag([{ id: "s", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: "shared-seed" } }]);
  flags.seededEmpty = ruleFlag([{ id: "se", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: "" } }]);
  flags.seededNull = ruleFlag([{ id: "sn", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: null } }]);
  flags.seededNumber = ruleFlag([{ id: "s42", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: 42 } }]);
  flags.jsonValues = ruleFlag([{ id: "jv", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: { variant: "B", n: [1, 2] }, otherwise: null } }]);
  flags.missingOtherwise = ruleFlag([{ id: "mo", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in" } }]);
  flags.conditional = ruleFlag([
    { id: "c1", match: "all", conditions: [{ attribute: "country", op: "eq", value: "SA" }], serve: { type: "rollout", percentage: 25, value: "sa-in", otherwise: "sa-out" } },
    { id: "c2", match: "all", conditions: [], serve: { type: "rollout", percentage: 75, value: "rest-in", otherwise: "rest-out" } },
  ]);
  const b = addBundle(base(flags));
  const identities = [
    "user-1", "user-2", "user-42", "日本語", "🙂", "é", "é", 0, 1, 1.5, -0, 1e21, 1e-7, 123456789012, true, false,
    [1, 2], ["a", null, ["b"]], {}, { a: 1 }, "", null,
  ];
  const ctxs = [{}, ...identities.map((key) => ({ key, org: key, 5: key, country: "SA" })), ...identities.slice(0, 6).map((key) => ({ key, country: "US" }))];
  for (const f of Object.keys(flags)) for (const ctx of ctxs) addCase(`rollout ${f} ${JSON.stringify(ctx)}`, b, f, ctx, "fallback");
  // A larger sample of random identities for the distribution itself.
  const dist = addBundle(base({ half: ruleFlag([{ id: "h", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: true, otherwise: false } }]), tenth: ruleFlag([{ id: "t", match: "all", conditions: [], serve: { type: "rollout", percentage: 10.5, value: true, otherwise: false } }]) }));
  for (let i = 0; i < 400; i++) {
    const key = i % 4 === 0 ? `id-${i}` : randomString(1 + Math.floor(rand() * 16));
    addCase(`distribution ${i}`, dist, i % 2 === 0 ? "half" : "tenth", { key }, null, i < 4);
  }
}

// 7. Context attribute lookup: own properties only, odd names, nested values are compared as JSON.
{
  const conds = [
    { attribute: "constructor", op: "exists" },
    { attribute: "toString", op: "not_exists" },
    { attribute: "__proto__", op: "eq", value: { a: 1 } },
    { attribute: "obj", op: "eq", value: { b: 2, a: 1 } },
    { attribute: "obj", op: "eq", value: { a: 1, b: 2 } },
    { attribute: "list", op: "eq", value: [1, "2", null] },
    { attribute: "list", op: "in", value: [[1, "2", null]] },
    { attribute: "", op: "eq", value: "empty-name" },
    { attribute: "dotted.name", op: "eq", value: "x" },
    { attribute: "num", op: "eq", value: 1 },
    { attribute: "num", op: "gte", value: "1" },
    { attribute: "big", op: "eq", value: 9007199254740992 },
    { attribute: "float", op: "eq", value: 0.30000000000000004 },
    { attribute: "float", op: "lt", value: 0.3 },
    { attribute: "unicode", op: "contains", value: "日本" },
    { attribute: "unicode", op: "starts_with", value: "🙂" },
    { attribute: "nfc", op: "eq", value: "é" },
  ];
  const flags = {};
  conds.forEach((c, i) => (flags[`c${i}`] = ruleFlag([{ id: `c${i}`, match: "all", conditions: [c], serve: { type: "fixed", value: true } }])));
  const b = addBundle(base(flags));
  const ctxs = [
    {},
    { constructor: "x", toString: null, ["__proto__"]: { a: 1 }, obj: { a: 1, b: 2 }, list: [1, "2", null], "": "empty-name", "dotted.name": "x", num: 1.0, big: 9007199254740993, float: 0.1 + 0.2, unicode: "🙂日本語", nfc: "é" },
    { obj: { b: 2, a: 1 }, num: true, big: 9007199254740992, float: 0.3, unicode: "日本", nfc: "é" },
  ];
  for (const f of Object.keys(flags)) for (const ctx of ctxs) addCase(`context ${f} ${Object.keys(ctx).length}`, b, f, ctx, false);
}

const doc = {
  description: "Generated by packages/engine/fixtures/generate-parity.mjs from packages/engine/src/index.ts. Do not edit by hand; see the generator for the format.",
  formatVersion: 1,
  engineVersion: ENGINE_VERSION,
  counts: { murmur3: murmurCases.length, buckets: bucketCases.length, supportsEngine: supportsEngineCases.length, clientBundle: clientBundleCases.length, cases: cases.length },
  murmur3: murmurCases,
  buckets: bucketCases,
  supportsEngine: supportsEngineCases,
  clientBundle: clientBundleCases,
  bundles,
  contexts,
  cases,
};
const text = JSON.stringify(doc) + "\n";
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    /* missing */
  }
  if (current !== text) {
    console.error("parity.json is out of date: run node packages/engine/fixtures/generate-parity.mjs");
    process.exit(1);
  }
  console.log(`parity.json is up to date (${cases.length} evaluation cases).`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${JSON.stringify(doc.counts)} (${(text.length / 1024).toFixed(0)} KB)`);
}
