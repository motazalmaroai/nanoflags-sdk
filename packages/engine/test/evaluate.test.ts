import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  bucketOf,
  evaluate,
  matchCondition,
  matchSegment,
  type Bundle,
  type Condition,
  type Context,
  type FlagConfig,
  type JsonValue,
  type Operator,
  type Segment,
} from "../src/index";

const cond = (attribute: string, op: Operator, value?: JsonValue): Condition => ({ attribute, op, ...(value === undefined ? {} : { value }) });
const m = (c: Condition, ctx: Context, segments: Record<string, Segment> = {}) => matchCondition(c, ctx, segments);

function bundle(flags: Record<string, FlagConfig>, segments: Record<string, Segment> = {}, revision = 7): Bundle {
  return { schema: 1, project: "commerce", environment: "production", revision, flags, segments };
}

describe("operators", () => {
  it("eq / neq", () => {
    expect(m(cond("region", "eq", "US"), { region: "US" })).toBe(true);
    expect(m(cond("region", "eq", "US"), { region: "DE" })).toBe(false);
    expect(m(cond("region", "eq", "US"), {})).toBe(false);
    expect(m(cond("signedIn", "eq", true), { signedIn: true })).toBe(true);
    expect(m(cond("signedIn", "eq", true), { signedIn: "true" })).toBe(false); // no type coercion
    expect(m(cond("n", "eq", 1), { n: 1 })).toBe(true);
    expect(m(cond("n", "eq", 1), { n: "1" })).toBe(false);
    expect(m(cond("tags", "eq", ["a", "b"]), { tags: ["a", "b"] })).toBe(true);
    expect(m(cond("v", "eq", null), { v: null })).toBe(true);

    expect(m(cond("region", "neq", "US"), { region: "DE" })).toBe(true);
    expect(m(cond("region", "neq", "US"), { region: "US" })).toBe(false);
    // A missing attribute never matches a comparison, including the negative ones.
    expect(m(cond("region", "neq", "US"), {})).toBe(false);
  });

  it("in / not_in", () => {
    expect(m(cond("region", "in", ["US", "CA"]), { region: "CA" })).toBe(true);
    expect(m(cond("region", "in", ["US", "CA"]), { region: "DE" })).toBe(false);
    expect(m(cond("region", "in", ["US"]), {})).toBe(false);
    expect(m(cond("region", "in", "US"), { region: "US" })).toBe(false); // value must be a list
    expect(m(cond("n", "in", [1, 2]), { n: 2 })).toBe(true);

    expect(m(cond("region", "not_in", ["US", "CA"]), { region: "DE" })).toBe(true);
    expect(m(cond("region", "not_in", ["US", "CA"]), { region: "US" })).toBe(false);
    expect(m(cond("region", "not_in", ["US"]), {})).toBe(false);
    expect(m(cond("region", "not_in", "US"), { region: "DE" })).toBe(false);
  });

  it("contains / starts_with / ends_with", () => {
    const ctx = { email: "ada@example.com" };
    expect(m(cond("email", "contains", "@example"), ctx)).toBe(true);
    expect(m(cond("email", "contains", "@other"), ctx)).toBe(false);
    expect(m(cond("email", "starts_with", "ada@"), ctx)).toBe(true);
    expect(m(cond("email", "starts_with", "bob@"), ctx)).toBe(false);
    expect(m(cond("email", "ends_with", "@example.com"), ctx)).toBe(true);
    expect(m(cond("email", "ends_with", "@example.org"), ctx)).toBe(false);
    // Strings only — no coercion of numbers, no match on missing attributes.
    for (const op of ["contains", "starts_with", "ends_with"] as const) {
      expect(m(cond("n", op, "1"), { n: 123 })).toBe(false);
      expect(m(cond("email", op, 1), ctx)).toBe(false);
      expect(m(cond("missing", op, "a"), ctx)).toBe(false);
    }
  });

  it("gt / gte / lt / lte", () => {
    expect(m(cond("age", "gt", 18), { age: 19 })).toBe(true);
    expect(m(cond("age", "gt", 18), { age: 18 })).toBe(false);
    expect(m(cond("age", "gte", 18), { age: 18 })).toBe(true);
    expect(m(cond("age", "gte", 18), { age: 17 })).toBe(false);
    expect(m(cond("age", "lt", 18), { age: 17 })).toBe(true);
    expect(m(cond("age", "lt", 18), { age: 18 })).toBe(false);
    expect(m(cond("age", "lte", 18), { age: 18 })).toBe(true);
    expect(m(cond("age", "lte", 18), { age: 19 })).toBe(false);
    // Numeric strings compare numerically (not lexicographically).
    expect(m(cond("version", "gt", "9"), { version: "10" })).toBe(true);
    expect(m(cond("age", "gte", "18"), { age: 18 })).toBe(true);
    // Non-numeric or missing values never match.
    for (const op of ["gt", "gte", "lt", "lte"] as const) {
      expect(m(cond("age", op, 18), {})).toBe(false);
      expect(m(cond("age", op, 18), { age: "old" })).toBe(false);
      expect(m(cond("age", op, 18), { age: "" })).toBe(false);
      expect(m(cond("age", op, 18), { age: true })).toBe(false);
      expect(m(cond("age", op, "x"), { age: 1 })).toBe(false);
      expect(m(cond("age", op), { age: 1 })).toBe(false);
    }
  });

  it("exists / not_exists", () => {
    expect(m(cond("plan", "exists"), { plan: "pro" })).toBe(true);
    expect(m(cond("plan", "exists"), { plan: false })).toBe(true);
    expect(m(cond("plan", "exists"), { plan: "" })).toBe(true);
    expect(m(cond("plan", "exists"), { plan: null })).toBe(false);
    expect(m(cond("plan", "exists"), {})).toBe(false);
    expect(m(cond("plan", "not_exists"), {})).toBe(true);
    expect(m(cond("plan", "not_exists"), { plan: null })).toBe(true);
    expect(m(cond("plan", "not_exists"), { plan: 0 })).toBe(false);
  });

  it("does not read inherited Object.prototype members as context attributes", () => {
    expect(m(cond("constructor", "exists"), {})).toBe(false);
    expect(m(cond("toString", "exists"), {})).toBe(false);
    expect(m(cond("__proto__", "exists"), {})).toBe(false);
    expect(m(cond("constructor", "not_exists"), {})).toBe(true);
  });

  it("unknown operator never matches", () => {
    expect(m({ attribute: "a", op: "regex" as Operator, value: ".*" }, { a: "x" })).toBe(false);
  });
});

describe("segments", () => {
  const segments: Record<string, Segment> = {
    staff: { match: "all", conditions: [cond("email", "ends_with", "@nanoflags.dev")] },
    beta: { match: "any", conditions: [cond("", "segment", "staff"), cond("beta", "eq", true)] },
    everyone: { match: "all", conditions: [] },
  };

  it("segment / not_segment", () => {
    expect(m(cond("", "segment", "staff"), { email: "a@nanoflags.dev" }, segments)).toBe(true);
    expect(m(cond("", "segment", "staff"), { email: "a@example.com" }, segments)).toBe(false);
    expect(m(cond("", "not_segment", "staff"), { email: "a@example.com" }, segments)).toBe(true);
    expect(m(cond("", "not_segment", "staff"), { email: "a@nanoflags.dev" }, segments)).toBe(false);
    expect(m(cond("", "segment", "everyone"), {}, segments)).toBe(true);
  });

  it("nested segments resolve", () => {
    expect(m(cond("", "segment", "beta"), { email: "a@nanoflags.dev" }, segments)).toBe(true);
    expect(m(cond("", "segment", "beta"), { beta: true }, segments)).toBe(true);
    expect(m(cond("", "segment", "beta"), { email: "x@example.com" }, segments)).toBe(false);
    expect(matchSegment(segments.beta!, { email: "a@nanoflags.dev" }, segments)).toBe(true);
    expect(matchSegment(segments.staff!, { email: "nope" })).toBe(false);
  });

  it("an unknown segment never matches — for segment and not_segment alike", () => {
    expect(m(cond("", "segment", "ghost"), { key: "u" }, segments)).toBe(false);
    expect(m(cond("", "not_segment", "ghost"), { key: "u" }, segments)).toBe(false);
    expect(m(cond("", "segment", 42), { key: "u" }, segments)).toBe(false);
    expect(m(cond("", "segment"), { key: "u" }, segments)).toBe(false);
    // Inherited names are not segments.
    expect(m(cond("", "segment", "constructor"), { key: "u" }, segments)).toBe(false);
    expect(m(cond("", "segment", "__proto__"), { key: "u" }, segments)).toBe(false);
  });

  it("nesting guard: cycles terminate and do not match", () => {
    const cyclic: Record<string, Segment> = {
      a: { match: "all", conditions: [cond("", "segment", "b")] },
      b: { match: "all", conditions: [cond("", "segment", "a")] },
      self: { match: "any", conditions: [cond("", "segment", "self")] },
    };
    expect(m(cond("", "segment", "a"), { key: "u" }, cyclic)).toBe(false);
    expect(m(cond("", "segment", "self"), { key: "u" }, cyclic)).toBe(false);
    const flag: FlagConfig = { type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "r", match: "all", conditions: [cond("", "segment", "a")], serve: { type: "fixed", value: true } }] };
    const res = evaluate(bundle({ f: flag }, cyclic), "f", { key: "u" }, true);
    expect(res.reason).toBe("default");
    expect(res.value).toBe(false);
  });

  it("nesting guard: chains deeper than the limit do not match, shallow chains do", () => {
    const chain = (n: number): Record<string, Segment> => {
      const s: Record<string, Segment> = { s0: { match: "all", conditions: [cond("x", "eq", 1)] } };
      for (let i = 1; i <= n; i++) s[`s${i}`] = { match: "all", conditions: [cond("", "segment", `s${i - 1}`)] };
      return s;
    };
    expect(m(cond("", "segment", "s3"), { x: 1 }, chain(3))).toBe(true);
    expect(m(cond("", "segment", "s4"), { x: 1 }, chain(4))).toBe(false);
    expect(m(cond("", "segment", "s10"), { x: 1 }, chain(10))).toBe(false);
  });
});

describe("evaluate", () => {
  const checkout: FlagConfig = {
    type: "boolean",
    enabled: true,
    default: false,
    off: false,
    clientExposed: false,
    rules: [
      {
        id: "r1",
        match: "all",
        conditions: [cond("signedIn", "eq", true), cond("region", "in", ["US"])],
        serve: { type: "rollout", percentage: 10, value: true, otherwise: false },
      },
    ],
  };
  const ranking: FlagConfig = {
    type: "string",
    enabled: true,
    default: "relevance-v2",
    off: "relevance-v1",
    clientExposed: true,
    rules: [
      { id: "staff", match: "all", conditions: [cond("", "segment", "staff")], serve: { type: "fixed", value: "experimental" } },
      { id: "any", match: "any", conditions: [cond("plan", "eq", "pro"), cond("region", "eq", "DE")], serve: { type: "fixed", value: "relevance-v3" } },
    ],
  };
  const b = bundle({ "checkout-v2": checkout, "search-ranking": ranking, disabled: { ...ranking, enabled: false } }, { staff: { match: "all", conditions: [cond("email", "ends_with", "@nanoflags.dev")] } });

  it("flag_not_found returns the fallback", () => {
    const r = evaluate(b, "nope", { key: "u" }, "fb");
    expect(r).toMatchObject({ flagKey: "nope", value: "fb", reason: "flag_not_found", revision: 7 });
    expect(r.trace.at(-1)?.kind).toBe("result");
  });

  it("flag_not_found when no bundle is loaded (null / undefined), revision 0", () => {
    expect(evaluate(null, "checkout-v2", { key: "u" }, true)).toMatchObject({ value: true, reason: "flag_not_found", revision: 0 });
    expect(evaluate(undefined, "checkout-v2", {}, 3)).toMatchObject({ value: 3, reason: "flag_not_found", revision: 0 });
  });

  it("flag keys that collide with Object.prototype members are not found", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(evaluate(b, key, { key: "u" }, "fb")).toMatchObject({ value: "fb", reason: "flag_not_found" });
    }
  });

  it("disabled flag short-circuits to `off` without evaluating rules", () => {
    const r = evaluate(b, "disabled", { email: "a@nanoflags.dev", plan: "pro" }, "fb");
    expect(r).toMatchObject({ value: "relevance-v1", reason: "off" });
    expect(r.ruleIndex).toBeUndefined();
    expect(r.trace.some((t) => t.kind === "rule")).toBe(false);
  });

  it("default when no rule matches", () => {
    const r = evaluate(b, "search-ranking", { key: "u", plan: "free" }, "fb");
    expect(r).toMatchObject({ value: "relevance-v2", reason: "default" });
    expect(r.trace.filter((t) => t.kind === "rule")).toHaveLength(2);
    expect(r.trace.filter((t) => t.kind === "rule").every((t) => t.matched === false)).toBe(true);
  });

  it("first matching rule wins; fixed serve; match any", () => {
    expect(evaluate(b, "search-ranking", { email: "a@nanoflags.dev", plan: "pro" }, "fb")).toMatchObject({ value: "experimental", reason: "rule_match", ruleIndex: 0, ruleId: "staff" });
    expect(evaluate(b, "search-ranking", { plan: "pro" }, "fb")).toMatchObject({ value: "relevance-v3", reason: "rule_match", ruleIndex: 1, ruleId: "any" });
    expect(evaluate(b, "search-ranking", { region: "DE" }, "fb")).toMatchObject({ value: "relevance-v3", ruleIndex: 1 });
  });

  it("match all requires every condition", () => {
    expect(evaluate(b, "checkout-v2", { key: "u", signedIn: true, region: "DE" }, true)).toMatchObject({ value: false, reason: "default" });
    expect(evaluate(b, "checkout-v2", { key: "u", signedIn: false, region: "US" }, true)).toMatchObject({ value: false, reason: "default" });
  });

  it("a rule without conditions matches every context", () => {
    const f: FlagConfig = { type: "number", enabled: true, default: 0, off: -1, rules: [{ id: "all", match: "all", conditions: [], serve: { type: "fixed", value: 5 } }] };
    expect(evaluate(bundle({ f }), "f", {}, 9)).toMatchObject({ value: 5, reason: "rule_match", ruleIndex: 0 });
    const g: FlagConfig = { ...f, rules: [{ id: "all", match: "any", conditions: [], serve: { type: "fixed", value: 6 } }] };
    expect(evaluate(bundle({ g }), "g", {}, 9)).toMatchObject({ value: 6, reason: "rule_match" });
  });

  it("rollout: bucket decides between value and otherwise, and is reported", () => {
    let inside = 0;
    for (let i = 0; i < 5000; i++) {
      const key = `user-${i}`;
      const r = evaluate(b, "checkout-v2", { key, signedIn: true, region: "US" }, false);
      expect(r.reason).toBe("rule_match");
      expect(r.ruleId).toBe("r1");
      expect(r.bucket).toBe(bucketOf("checkout-v2", key));
      expect(r.inRollout).toBe(r.bucket! < 10);
      expect(r.value).toBe(r.inRollout);
      if (r.inRollout) inside++;
    }
    expect(inside / 5000).toBeGreaterThan(0.08);
    expect(inside / 5000).toBeLessThan(0.12);
  });

  it("rollout: custom seed and bucketBy", () => {
    const f: FlagConfig = { type: "string", enabled: true, default: "d", off: "o", rules: [{ id: "r", match: "all", conditions: [], serve: { type: "rollout", percentage: 50, value: "in", otherwise: "out", bucketBy: "orgId", seed: "shared-seed" } }] };
    const bb = bundle({ f });
    for (let i = 0; i < 200; i++) {
      const r = evaluate(bb, "f", { key: `user-${i}`, orgId: `org-${i % 7}` }, "fb");
      expect(r.bucket).toBe(bucketOf("shared-seed", `org-${i % 7}`));
      expect(r.value).toBe(r.bucket! < 50 ? "in" : "out");
    }
    // Numeric identities are stringified.
    expect(evaluate(bb, "f", { orgId: 42 }, "fb").bucket).toBe(bucketOf("shared-seed", "42"));
  });

  it("rollout: missing bucket key is treated as outside the allocation", () => {
    const f: FlagConfig = { ...checkout, rules: [{ ...checkout.rules[0]!, serve: { type: "rollout", percentage: 100, value: true, otherwise: false } }] };
    const bb = bundle({ f });
    for (const ctx of [{ signedIn: true, region: "US" }, { key: "", signedIn: true, region: "US" }, { key: null as unknown as string, signedIn: true, region: "US" }] satisfies Context[]) {
      const r = evaluate(bb, "f", ctx, true);
      expect(r).toMatchObject({ value: false, reason: "rule_match", ruleIndex: 0, inRollout: false });
      expect(r.bucket).toBeUndefined();
      expect(r.trace.some((t) => t.kind === "allocation" && t.title === "Allocation skipped")).toBe(true);
    }
    expect(evaluate(bb, "f", { key: "u", signedIn: true, region: "US" }, false).value).toBe(true);
  });

  it("never throws: malformed configuration returns the fallback with reason error", () => {
    const broken = bundle({ f: { type: "boolean", enabled: true, default: false, off: false, rules: null as unknown as [] } });
    const r = evaluate(broken, "f", { key: "u" }, true);
    expect(r.reason).toBe("error");
    expect(r.value).toBe(true);
    expect(typeof r.error).toBe("string");
    const noFlags = { schema: 1, project: "p", environment: "e", revision: 3 } as unknown as Bundle;
    expect(evaluate(noFlags, "f", {}, "fb")).toMatchObject({ value: "fb", revision: 3 });
  });

  it("trace explains the decision", () => {
    const r = evaluate(b, "checkout-v2", { key: "user-1", signedIn: true, region: "US" }, false);
    expect(r.trace.map((t) => t.kind)).toEqual(["config", "rule", "allocation", "result"]);
    expect(r.trace[0]!.detail).toBe("r7");
    expect(r.trace[1]!.detail).toBe("signedIn = true AND region in US");
  });
});

/* ---------------- properties ---------------- */

const jsonScalar = fc.oneof(fc.string(), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean(), fc.constant(null));
const attrName = fc.constantFrom("key", "region", "plan", "age", "email", "signedIn", "constructor", "__proto__", "toString");
const opArb = fc.constantFrom<Operator>("eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "exists", "not_exists", "segment", "not_segment");
const condArb: fc.Arbitrary<Condition> = fc.record({
  attribute: attrName,
  op: opArb,
  value: fc.oneof(jsonScalar, fc.array(jsonScalar, { maxLength: 4 }), fc.constantFrom<JsonValue>("s1", "s2", "ghost", "constructor")),
});
const segArb: fc.Arbitrary<Segment> = fc.record({ match: fc.constantFrom<"all" | "any">("all", "any"), conditions: fc.array(condArb, { maxLength: 3 }) });
const serveArb = fc.oneof(
  fc.record({ type: fc.constant("fixed" as const), value: jsonScalar }),
  fc.record({ type: fc.constant("rollout" as const), percentage: fc.double({ min: 0, max: 100, noNaN: true }), value: jsonScalar, otherwise: jsonScalar, bucketBy: fc.option(attrName, { nil: undefined }), seed: fc.option(fc.string(), { nil: undefined }) }),
);
const flagArb: fc.Arbitrary<FlagConfig> = fc.record({
  type: fc.constantFrom<FlagConfig["type"]>("boolean", "string", "number", "json"),
  enabled: fc.boolean(),
  rules: fc.array(fc.record({ id: fc.string(), match: fc.constantFrom<"all" | "any">("all", "any"), conditions: fc.array(condArb, { maxLength: 3 }), serve: serveArb }), { maxLength: 4 }),
  default: jsonScalar,
  off: jsonScalar,
});
const bundleArb: fc.Arbitrary<Bundle> = fc.record({
  schema: fc.constant(1 as const),
  project: fc.constant("p"),
  environment: fc.constant("e"),
  revision: fc.nat(1000),
  flags: fc.dictionary(fc.constantFrom("a", "b", "c"), flagArb),
  segments: fc.dictionary(fc.constantFrom("s1", "s2"), segArb),
});
const ctxArb: fc.Arbitrary<Context> = fc.dictionary(attrName, jsonScalar).map((d) => {
  const ctx: Context = {};
  for (const [k, v] of Object.entries(d)) Object.defineProperty(ctx, k, { value: v, enumerable: true, writable: true, configurable: true });
  return ctx;
}) as fc.Arbitrary<Context>;
const flagKeyArb = fc.oneof(fc.constantFrom("a", "b", "c", "constructor", "__proto__", "toString"), fc.string());

describe("properties", () => {
  it("determinism: the same input always produces the same output (deep-equal, incl. trace)", () => {
    fc.assert(
      fc.property(bundleArb, flagKeyArb, ctxArb, jsonScalar, (bundle, key, ctx, fallback) => {
        const input = JSON.stringify({ bundle, ctx });
        const first = evaluate(bundle, key, ctx, fallback);
        const second = evaluate(structuredClone(bundle), key, { ...ctx }, fallback);
        expect(second).toEqual(first);
        // Evaluation does not mutate its inputs.
        expect(JSON.stringify({ bundle, ctx })).toBe(input);
      }),
      { numRuns: 500 },
    );
  });

  it("never throws and the value always comes from the flag or the fallback", () => {
    fc.assert(
      fc.property(bundleArb, flagKeyArb, ctxArb, (bundle, key, ctx) => {
        const fallback = "__fallback__";
        const r = evaluate<JsonValue>(bundle, key, ctx, fallback);
        expect(r.flagKey).toBe(key);
        expect(r.revision).toBe(bundle.revision);
        const flag = Object.prototype.hasOwnProperty.call(bundle.flags, key) ? bundle.flags[key] : undefined;
        if (!flag) {
          expect(r).toMatchObject({ reason: "flag_not_found", value: fallback });
        } else if (!flag.enabled) {
          expect(r.reason).toBe("off");
          expect(r.value).toEqual(flag.off);
        } else if (r.reason === "default") {
          expect(r.value).toEqual(flag.default);
        } else {
          expect(r.reason).toBe("rule_match");
          const serve = flag.rules[r.ruleIndex!]!.serve;
          const candidates = serve.type === "fixed" ? [serve.value] : [serve.value, serve.otherwise];
          expect(candidates).toContainEqual(r.value);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("exists and not_exists are complementary; eq and neq are exclusive", () => {
    fc.assert(
      fc.property(ctxArb, attrName, jsonScalar, (ctx, attribute, value) => {
        expect(matchCondition({ attribute, op: "exists" }, ctx, {})).toBe(!matchCondition({ attribute, op: "not_exists" }, ctx, {}));
        expect(matchCondition({ attribute, op: "eq", value }, ctx, {}) && matchCondition({ attribute, op: "neq", value }, ctx, {})).toBe(false);
      }),
    );
  });
});
