#!/usr/bin/env node
/**
 * Extra parity fixtures for the Go port of the NanoFlags engine (supplements
 * packages/engine/fixtures/parity.json, which is shared by every port).
 *
 *   node packages/sdk-go/internal/testdata/generate-extra.mjs           # writes extra.json next to this file
 *   node packages/sdk-go/internal/testdata/generate-extra.mjs --check   # exits 1 when extra.json is out of date
 *
 * Covers JavaScript corner cases the shared file leaves out — `rules` / `conditions` that are strings or
 * array-like objects, operators named like Object.prototype members, segments stored as an array,
 * non-object bundles, lone UTF-16 surrogates — and a seeded fuzz section. Unlike the shared file it
 * records the evaluation error message (`expected.errorMessage`), so the Go port's emulation of V8's
 * TypeError messages is checked too.
 *
 * Same layout as parity.json (bundles[], contexts[], cases[] with indexes). Requires Node >= 22.18
 * (built-in TypeScript type stripping). Deterministic.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/sdk-go/internal/testdata in the monorepo, go/internal/testdata in the public repository.
const engineSrc = [join(here, "../../../engine/src/index.ts"), join(here, "../../../packages/engine/src/index.ts")].find(existsSync);
if (!engineSrc) throw new Error("packages/engine/src/index.ts not found");
const { evaluate } = await import(pathToFileURL(engineSrc).href);
const out = join(here, "extra.json");

let state = 0x60a11e;
function rand() {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const bundles = [];
const contexts = [];
const cases = [];
const ctxSeen = new Map();
const addBundle = (b) => (bundles.push(b), bundles.length - 1);
function ctxIndex(ctx) {
  const k = JSON.stringify(ctx);
  if (!ctxSeen.has(k)) {
    contexts.push(ctx);
    ctxSeen.set(k, contexts.length - 1);
  }
  return ctxSeen.get(k);
}
function addCase(name, bi, flag, ctx, fallback) {
  // Round-trip through JSON so the engine sees exactly what the Go port parses.
  const b = bi === -1 ? null : JSON.parse(JSON.stringify(bundles[bi]));
  const e = evaluate(b, flag, JSON.parse(JSON.stringify(ctx)), fallback);
  const x = { reason: e.reason, revision: e.revision };
  if (e.value !== undefined) x.value = e.value;
  if (e.ruleIndex !== undefined) x.ruleIndex = e.ruleIndex;
  if (e.ruleId !== undefined) x.ruleId = e.ruleId;
  if (e.inRollout !== undefined) x.inRollout = e.inRollout;
  if (e.bucket !== undefined) x.bucket = e.bucket;
  if (e.error !== undefined) {
    x.error = true;
    x.errorMessage = e.error;
  }
  x.trace = e.trace;
  cases.push({ name, bundle: bi, flag, context: ctxIndex(ctx), fallback, expected: x });
}
const base = (flags, segments = {}, extra = {}) => ({ schema: 1, engine: 1, project: "extra", environment: "test", revision: 9, flags, segments, ...extra });
const fixed = (value) => ({ type: "fixed", value });
const flagWith = (rules, extra = {}) => ({ type: "json", enabled: true, default: "default", off: "off", rules, ...extra });
const rule = (conditions, serve = fixed("hit"), match = "all", id = "r") => ({ id, match, conditions, serve });
const eq = (attribute, value) => ({ attribute, op: "eq", value });

// 1. Odd shapes of rules, conditions, serve and flags.
{
  const flags = {
    rulesString: { type: "json", enabled: true, default: "d", off: "o", rules: "ab" },
    rulesEmptyString: { type: "json", enabled: true, default: "d", off: "o", rules: "" },
    rulesNumber: { type: "json", enabled: true, default: "d", off: "o", rules: 5 },
    rulesTrue: { type: "json", enabled: true, default: "d", off: "o", rules: true },
    rulesObjectLen0: { type: "json", enabled: true, default: "d", off: "o", rules: { length: 0 } },
    rulesObjectLen1: { type: "json", enabled: true, default: "d", off: "o", rules: { length: 1, 0: rule([]) } },
    rulesObjectLenString: { type: "json", enabled: true, default: "d", off: "o", rules: { length: "1", 0: rule([], fixed("via-string-length")) } },
    rulesObjectLenArray: { type: "json", enabled: true, default: "d", off: "o", rules: { length: [1], 0: rule([], fixed("via-array-length")) } },
    rulesObjectLenObject: { type: "json", enabled: true, default: "d", off: "o", rules: { length: {}, 0: rule([]) } },
    rulesObjectLenNull: { type: "json", enabled: true, default: "d", off: "o", rules: { length: null } },
    rulesObjectMissingIndex: { type: "json", enabled: true, default: "d", off: "o", rules: { length: 2, 1: rule([]) } },
    rulesArrayWithString: flagWith(["x"]),
    rulesArrayWithNumber: flagWith([7]),
    rulesArrayWithArray: flagWith([[]]),
    conditionsString: flagWith([rule("abc")]),
    conditionsStringAny: flagWith([rule("abc", fixed(1), "any")]),
    conditionsNumber: flagWith([rule(3)]),
    conditionsObjectLen0: flagWith([rule({ length: 0 })]),
    conditionsObjectLen1: flagWith([rule({ length: 1, 0: eq("a", 1) })]),
    conditionsObjectWithEvery: flagWith([rule({ length: 1, every: true })]),
    conditionsNull: flagWith([rule(null)]),
    conditionPrimitives: flagWith([rule([5, "abc", true, [], {}])]),
    conditionPrimitivesAny: flagWith([rule([5, "abc", true, [], {}], fixed(1), "any")]),
    anyShortCircuitThenNull: flagWith([rule([eq("a", 1), null], fixed("short"), "any")]),
    allShortCircuitThenNull: flagWith([rule([eq("a", 2), null], fixed("short"), "all")]),
    serveString: flagWith([rule([], "abc")]),
    serveArray: flagWith([rule([], [])]),
    serveNumber: flagWith([rule([], 4)]),
    serveTypeArray: flagWith([rule([], { type: ["fixed"], value: "arr", percentage: 100, otherwise: "o" })]),
    rollupBucketByObject: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: { a: 1 } })]),
    rollupBucketByArray: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: ["k", "e", "y"] })]),
    rollupBucketByKeyArray: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: ["key"] })]),
    rollupSeedObject: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: { s: 1 } })]),
    rollupSeedArray: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: [1, [2, null]] })]),
    rollupSeedBool: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out", seed: false })]),
    ruleIdObject: flagWith([rule([], fixed(1), "all", { id: 1 })]),
    ruleIdNumber: flagWith([rule([], fixed(1), "all", 3)]),
    ruleIdNull: flagWith([rule([], fixed(1), "all", null)]),
    matchArrayAny: flagWith([rule([eq("a", 9), eq("a", 1)], fixed(1), ["any"])]),
    flagArray: [],
    flagTrue: true,
    flagNumber: 5,
    flagString: "flag",
    enabledString: { enabled: "no", off: "o", default: "d", rules: [] },
    offUndefined: { enabled: false },
    defaultUndefined: { enabled: true, rules: [] },
  };
  for (const pct of ["0x32", " 50 ", ["50"], "1e2", "5e-1", " 50 ", "50%", "Infinity", "-Infinity", "+50", "0b110010", "0o62", "-0x32", 1e-7, 1e21, 33.333333333333336]) {
    flags[`pct ${JSON.stringify(pct)}`] = flagWith([rule([], { type: "rollout", percentage: pct, value: "in", otherwise: "out" })]);
  }
  const b = addBundle(base(flags));
  const ctxs = [{}, { key: "user-1", a: 1 }, { key: 7, a: 2, "[object Object]": "obj", "k,e,y": "kk" }, { key: "u", "1,2,": "x" }];
  for (const f of [...Object.keys(flags), "length", "0"]) for (const ctx of ctxs) addCase(`shape ${f} ${JSON.stringify(ctx)}`, b, f, ctx, "fallback");
}

// 2. Operators named like Object.prototype members and other odd operator values (trace wording).
{
  const ops = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
    "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "regex", "", ["eq"], ["segment"], 5, null, true, { a: 1 }];
  const flags = {};
  ops.forEach((op, i) => {
    flags[`op${i}`] = flagWith([rule([{ attribute: "a", op, value: ["x", null, [1, [2]]] }]), rule([{ attribute: "a", op, value: 1 }], fixed("second"), "any")]);
  });
  flags.attrObject = flagWith([rule([{ attribute: { x: 1 }, op: "eq", value: "obj" }])]);
  flags.attrArray = flagWith([rule([{ attribute: [1, 2, null], op: "eq", value: "x" }])]);
  flags.attrNull = flagWith([rule([{ attribute: null, op: "exists" }])]);
  flags.attrMissingEq = flagWith([rule([{ op: "eq", value: 1 }])]);
  flags.valueObjectDescribe = flagWith([rule([{ attribute: "a", op: "neq", value: { a: [1] } }])]);
  flags.valueNestedArrays = flagWith([rule([{ attribute: "a", op: "in", value: [[1, [2, [3]]], null, true, { b: 1 }] }])]);
  const b = addBundle(base(flags));
  const ctxs = [{ a: 1 }, { a: "x", "[object Object]": "obj", "1,2,": "x", null: 1, undefined: 1 }];
  for (const f of Object.keys(flags)) for (const ctx of ctxs) addCase(`op ${f} ${JSON.stringify(ctx)}`, b, f, ctx, false);
}

// 3. Segments stored as an array or holding non-objects; segment refs to "length" / indexes.
{
  const ref = (op, value) => flagWith([rule([{ attribute: "", op, value }], fixed(`${op}:${value}`))]);
  const flags = {};
  for (const v of ["0", "1", "2", "3", "length", "x"]) {
    flags[`in-${v}`] = ref("segment", v);
    flags[`out-${v}`] = ref("not_segment", v);
  }
  const arr = addBundle(base(flags, [{ match: "all", conditions: [] }, { match: "any", conditions: [eq("plan", "pro")] }, null, 5]));
  const odd = addBundle(base(flags, { 0: "str", 1: [], 2: { match: "any" }, 3: { match: "all", conditions: { length: 0 } }, length: { match: "all", conditions: [] } }));
  const str = addBundle(base(flags, "segments"));
  for (const bi of [arr, odd, str]) for (const f of Object.keys(flags)) for (const ctx of [{}, { plan: "pro" }]) addCase(`segments#${bi} ${f} ${JSON.stringify(ctx)}`, bi, f, ctx, "fb");
}

// 4. Bundles that are not plain bundle objects; revision shapes.
{
  const one = { f: { type: "boolean", enabled: true, default: true, off: false, rules: [] } };
  for (const b of ["bundle", "", 0, 5, true, false, [], [one], { flags: "ff" }, { flags: [one] }, { flags: one, revision: {} }, { flags: one, revision: [5] }, { flags: one, revision: true },
    { flags: one, revision: "0x10" }, { flags: one, revision: 1.5 }, { flags: one, revision: 1e21 }, { flags: one, revision: [] }]) {
    const bi = addBundle(b);
    for (const f of ["f", "0", "length"]) addCase(`bundle ${JSON.stringify(b).slice(0, 60)} ${f}`, bi, f, {}, "fb");
  }
}

// 5. Lone surrogates and other string edge cases (bucketing hashes U+FFFD for a lone surrogate).
{
  const flags = {
    roll: flagWith([rule([], { type: "rollout", percentage: 50, value: "in", otherwise: "out" })]),
    contains: flagWith([rule([{ attribute: "s", op: "contains", value: "\ud83d" }])]),
    startsLow: flagWith([rule([{ attribute: "s", op: "ends_with", value: "\ude00" }])]),
    eqLone: flagWith([rule([eq("s", "\udc00")])]),
    eqObjLone: flagWith([rule([eq("s", { k: "\ud800" })])]),
    fallbackish: flagWith([rule([], fixed("\ud800x\u0001\u001f "))]),
  };
  const b = addBundle(base(flags));
  for (const s of ["\ud800", "\udc00", "a\ud800b", "😀", "x😀", "\ud83d", "\ude00", "é", "é", { k: "\ud800" }]) {
    for (const f of Object.keys(flags)) addCase(`string ${JSON.stringify(s)} ${f}`, b, f, { key: s, s }, "\udfff");
  }
}

// 6. Seeded fuzz over odd values (property-style coverage of every path).
{
  const scalars = [null, true, false, 0, -1, 1, 2.5, 1e21, 1e-7, "", " ", "a", "ab", "10", " 1e1 ", "0x1f", "Infinity", "abc", "😀", "key", "any", "all", "segment", "fixed", "rollout"];
  const anyValue = (d = 0) => {
    const r = rand();
    if (d > 2 || r < 0.6) return pick(scalars);
    if (r < 0.8) return Array.from({ length: Math.floor(rand() * 3) }, () => anyValue(d + 1));
    const o = {};
    for (let i = Math.floor(rand() * 3); i > 0; i--) o[pick(["a", "b", "key", "0", "length", "match", "conditions", "value"])] = anyValue(d + 1);
    return o;
  };
  const ops = ["eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "exists", "not_exists", "segment", "not_segment", "constructor", "x"];
  const cond = () => (rand() < 0.05 ? anyValue() : { attribute: pick(["a", "b", "key", "", "constructor", "__proto__"]), op: pick(ops), ...(rand() < 0.9 ? { value: rand() < 0.3 ? pick(["s1", "s2", "s3", "0"]) : anyValue() } : {}) });
  const conds = () => (rand() < 0.05 ? anyValue() : Array.from({ length: Math.floor(rand() * 4) }, cond));
  const serve = () => {
    if (rand() < 0.05) return anyValue();
    if (rand() < 0.5) return { type: "fixed", value: anyValue() };
    const s = { type: rand() < 0.9 ? "rollout" : anyValue(), percentage: rand() < 0.8 ? Math.round(rand() * 10000) / 100 : anyValue(), value: anyValue(), otherwise: anyValue() };
    if (rand() < 0.3) s.bucketBy = pick(["a", "b", "key", null, 0]);
    if (rand() < 0.3) s.seed = rand() < 0.8 ? pick(["s", "", "seed-😀"]) : anyValue();
    return s;
  };
  const flag = () => {
    if (rand() < 0.04) return anyValue();
    return { type: "json", enabled: rand() < 0.85 ? true : anyValue(), default: anyValue(), off: anyValue(), rules: rand() < 0.04 ? anyValue() : Array.from({ length: Math.floor(rand() * 4) }, () => (rand() < 0.03 ? anyValue() : { id: rand() < 0.9 ? `r${Math.floor(rand() * 9)}` : anyValue(), match: rand() < 0.9 ? pick(["all", "any"]) : anyValue(), conditions: conds(), serve: serve() })) };
  };
  const seg = () => (rand() < 0.05 ? anyValue() : { match: pick(["all", "any"]), conditions: conds() });
  for (let i = 0; i < 150; i++) {
    const flags = { a: flag(), b: flag(), c: flag() };
    const segments = rand() < 0.05 ? anyValue() : { s1: seg(), s2: seg(), s3: { match: "any", conditions: [{ attribute: "", op: "segment", value: "s1" }, { attribute: "", op: "not_segment", value: "s2" }] } };
    const bi = addBundle({ schema: 1, project: "fuzz", environment: "e", revision: Math.floor(rand() * 50), flags, segments });
    for (let j = 0; j < 20; j++) {
      const ctx = {};
      for (const k of ["a", "b", "key", "", "constructor", "__proto__"]) if (rand() < 0.5) ctx[k] = anyValue();
      addCase(`fuzz ${i}.${j}`, bi, pick(["a", "b", "c", "d"]), ctx, anyValue());
    }
  }
}

const doc = {
  description: "Generated by packages/sdk-go/internal/testdata/generate-extra.mjs from packages/engine/src/index.ts. Do not edit by hand.",
  formatVersion: 1,
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
    console.error("extra.json is out of date: run node packages/sdk-go/internal/testdata/generate-extra.mjs");
    process.exit(1);
  }
  console.log(`extra.json is up to date (${cases.length} cases).`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${cases.length} cases (${(text.length / 1024).toFixed(0)} KB)`);
}
