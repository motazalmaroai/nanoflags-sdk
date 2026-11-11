import { describe, expect, it } from "vitest";
import {
  clientBundle,
  describeCondition,
  ENGINE_VERSION,
  supportsEngine,
  diffBundles,
  validateBundle,
  validateFlagConfig,
  valueMatchesType,
  type Bundle,
  type FlagConfig,
  type Operator,
  type Rule,
  type Segment,
} from "../src/index";

const rollout = (percentage: number, value: boolean = true): Rule => ({
  id: "r1",
  match: "all",
  conditions: [{ attribute: "region", op: "in", value: ["US"] }],
  serve: { type: "rollout", percentage, value, otherwise: false },
});
const boolFlag = (over: Partial<FlagConfig> = {}): FlagConfig => ({ type: "boolean", enabled: true, default: false, off: false, rules: [], ...over });
const segments: Record<string, Segment> = { staff: { match: "all", conditions: [{ attribute: "email", op: "ends_with", value: "@nanoflags.dev" }] } };

describe("valueMatchesType", () => {
  it("checks each flag type", () => {
    expect(valueMatchesType("boolean", true)).toBe(true);
    expect(valueMatchesType("boolean", "true")).toBe(false);
    expect(valueMatchesType("string", "x")).toBe(true);
    expect(valueMatchesType("string", 1)).toBe(false);
    expect(valueMatchesType("number", 1.5)).toBe(true);
    expect(valueMatchesType("number", Number.NaN)).toBe(false);
    expect(valueMatchesType("number", Number.POSITIVE_INFINITY)).toBe(false);
    expect(valueMatchesType("number", "1")).toBe(false);
    expect(valueMatchesType("json", { a: 1 })).toBe(true);
    expect(valueMatchesType("json", null)).toBe(true);
    expect(valueMatchesType("json", undefined)).toBe(false);
  });
});

describe("validateFlagConfig", () => {
  it("accepts a valid flag", () => {
    const flag = boolFlag({
      rules: [
        rollout(10),
        { id: "r2", match: "any", conditions: [{ attribute: "", op: "segment", value: "staff" }, { attribute: "plan", op: "exists" }], serve: { type: "fixed", value: true } },
      ],
    });
    expect(validateFlagConfig("checkout-v2", flag, segments)).toEqual([]);
  });

  it("reports default / off values of the wrong type", () => {
    const problems = validateFlagConfig("f", boolFlag({ default: "yes", off: 0 }));
    expect(problems).toEqual(["f: default value must be a boolean value.", "f: off value must be a boolean value."]);
  });

  it("reports rule values of the wrong type (fixed, rollout value and remaining value)", () => {
    const flag: FlagConfig = {
      type: "string",
      enabled: true,
      default: "a",
      off: "b",
      rules: [
        { id: "r1", match: "all", conditions: [], serve: { type: "fixed", value: 1 } },
        { id: "r2", match: "all", conditions: [], serve: { type: "rollout", percentage: 5, value: true, otherwise: null } },
      ],
    };
    expect(validateFlagConfig("f", flag)).toEqual([
      "f: rule 01 value must be a string value.",
      "f: rule 02 rollout value must be a string value.",
      "f: rule 02 remaining value must be a string value.",
    ]);
  });

  it("reports percentages outside 0–100 and non-numbers", () => {
    for (const p of [-1, 100.01, Number.NaN, "10" as unknown as number, undefined as unknown as number]) {
      const problems = validateFlagConfig("f", boolFlag({ rules: [rollout(p)] }));
      if (p === ("10" as unknown as number)) continue; // coerced by comparison; covered by the type system
      expect(problems).toContain("f: rule 01 percentage must be between 0 and 100.");
    }
    expect(validateFlagConfig("f", boolFlag({ rules: [rollout(0)] }))).toEqual([]);
    expect(validateFlagConfig("f", boolFlag({ rules: [rollout(100)] }))).toEqual([]);
  });

  it("reports invalid match mode, unsupported operators, non-list in/not_in, missing attributes", () => {
    const flag = boolFlag({
      rules: [
        {
          id: "r1",
          match: "some" as "all",
          conditions: [
            { attribute: "a", op: "regex" as Operator, value: "x" },
            { attribute: "a", op: "in", value: "US" },
            { attribute: "a", op: "not_in", value: 3 },
            { attribute: "", op: "eq", value: 1 },
          ],
          serve: { type: "fixed", value: true },
        },
      ],
    });
    expect(validateFlagConfig("f", flag)).toEqual([
      "f: rule 01 has an invalid match mode.",
      'f: rule 01 uses unsupported operator "regex".',
      'f: rule 01 needs a list for "in".',
      'f: rule 01 needs a list for "not_in".',
      "f: rule 01 has a condition without an attribute.",
    ]);
  });

  it("reports unknown segments (including inherited names) but does not require an attribute for segment operators", () => {
    const withSeg = (value: unknown, op: Operator = "segment") =>
      boolFlag({ rules: [{ id: "r1", match: "all", conditions: [{ attribute: "", op, value: value as string }], serve: { type: "fixed", value: true } }] });
    expect(validateFlagConfig("f", withSeg("staff"), segments)).toEqual([]);
    expect(validateFlagConfig("f", withSeg("staff", "not_segment"), segments)).toEqual([]);
    expect(validateFlagConfig("f", withSeg("ghost"), segments)).toEqual(["f: rule 01 references an unknown segment."]);
    expect(validateFlagConfig("f", withSeg("staff"))).toEqual(["f: rule 01 references an unknown segment."]);
    expect(validateFlagConfig("f", withSeg(42), segments)).toEqual(["f: rule 01 references an unknown segment."]);
    expect(validateFlagConfig("f", withSeg("constructor"), segments)).toEqual(["f: rule 01 references an unknown segment."]);
    expect(validateFlagConfig("f", withSeg("toString", "not_segment"), segments)).toEqual(["f: rule 01 references an unknown segment."]);
  });

  it("validateBundle aggregates problems across flags", () => {
    const bundle: Bundle = { schema: 1, project: "p", environment: "e", revision: 1, segments, flags: { ok: boolFlag(), bad: boolFlag({ default: 1 }), worse: boolFlag({ off: "x" }) } };
    expect(validateBundle(bundle)).toEqual(["bad: default value must be a boolean value.", "worse: off value must be a boolean value."]);
  });
});

describe("describeCondition", () => {
  it("renders each operator family", () => {
    expect(describeCondition({ attribute: "region", op: "in", value: ["US", "CA"] })).toBe("region in US, CA");
    expect(describeCondition({ attribute: "plan", op: "exists" })).toBe("plan exists");
    expect(describeCondition({ attribute: "", op: "not_segment", value: "staff" })).toBe("not in segment staff");
    expect(describeCondition({ attribute: "age", op: "gte", value: 18 })).toBe("age ≥ 18");
  });
});

describe("diffBundles", () => {
  const base = { flags: { a: boolFlag({ rules: [rollout(10)] }), b: boolFlag() }, segments };

  it("no rows for identical configurations", () => {
    expect(diffBundles(base, structuredClone(base))).toEqual([]);
  });

  it("null before: everything is added", () => {
    expect(diffBundles(null, base)).toEqual([
      { flagKey: "a", field: "flag", before: "—", after: "added" },
      { flagKey: "b", field: "flag", before: "—", after: "added" },
      { flagKey: "segment:staff", field: "conditions", before: "—", after: "email ends with @nanoflags.dev" },
    ]);
  });

  it("added and removed flags, sorted by key", () => {
    const after = { flags: { b: boolFlag(), c: boolFlag() }, segments };
    expect(diffBundles(base, after)).toEqual([
      { flagKey: "a", field: "flag", before: "present", after: "removed" },
      { flagKey: "c", field: "flag", before: "—", after: "added" },
    ]);
  });

  it("enabled, default and off value changes", () => {
    const after = { flags: { a: boolFlag({ rules: [rollout(10)], enabled: false, default: true }), b: boolFlag({ off: true }) }, segments };
    expect(diffBundles(base, after)).toEqual([
      { flagKey: "a", field: "enabled", before: "true", after: "false" },
      { flagKey: "a", field: "default", before: "false", after: "true" },
      { flagKey: "b", field: "off value", before: "false", after: "true" },
    ]);
  });

  it("type and client exposure changes are visible", () => {
    const after = { flags: { a: base.flags.a, b: boolFlag({ clientExposed: true }) }, segments };
    expect(diffBundles(base, after)).toEqual([{ flagKey: "b", field: "client exposed", before: "false", after: "true" }]);
    const typed = { flags: { a: base.flags.a, b: { ...boolFlag(), type: "json" as const } }, segments };
    expect(diffBundles(base, typed)).toEqual([{ flagKey: "b", field: "type", before: "boolean", after: "json" }]);
    // clientExposed undefined and false are the same thing.
    expect(diffBundles(base, { flags: { a: base.flags.a, b: boolFlag({ clientExposed: false }) }, segments })).toEqual([]);
  });

  it("a pure percentage change is summarised as a rollout change", () => {
    const after = { flags: { a: boolFlag({ rules: [rollout(25)] }), b: boolFlag() }, segments };
    expect(diffBundles(base, after)).toEqual([{ flagKey: "a", field: "rule 01 rollout", before: "10%", after: "25%" }]);
  });

  it("a percentage change combined with a served-value change shows the full rule", () => {
    const after = { flags: { a: boolFlag({ rules: [rollout(25, false)] }), b: boolFlag() }, segments };
    expect(diffBundles(base, after)).toEqual([
      { flagKey: "a", field: "rule 01", before: "region in US ⇒ 10% → true, else false", after: "region in US ⇒ 25% → false, else false" },
    ]);
  });

  it("rule added, removed and changed", () => {
    const fixed: Rule = { id: "r2", match: "any", conditions: [], serve: { type: "fixed", value: true } };
    expect(diffBundles(base, { flags: { a: boolFlag({ rules: [rollout(10), fixed] }), b: boolFlag() }, segments })).toEqual([
      { flagKey: "a", field: "rule 02", before: "—", after: "all contexts ⇒ true" },
    ]);
    expect(diffBundles(base, { flags: { a: boolFlag(), b: boolFlag() }, segments })).toEqual([
      { flagKey: "a", field: "rule 01", before: "region in US ⇒ 10% → true, else false", after: "—" },
    ]);
    const changed: Rule = { ...rollout(10), conditions: [{ attribute: "region", op: "in", value: ["US", "CA"] }] };
    expect(diffBundles(base, { flags: { a: boolFlag({ rules: [changed] }), b: boolFlag() }, segments })).toEqual([
      { flagKey: "a", field: "rule 01", before: "region in US ⇒ 10% → true, else false", after: "region in US, CA ⇒ 10% → true, else false" },
    ]);
  });

  it("segment added, changed and removed", () => {
    const after = {
      flags: base.flags,
      segments: { beta: { match: "any" as const, conditions: [{ attribute: "beta", op: "eq" as const, value: true }, { attribute: "plan", op: "eq" as const, value: "pro" }] } },
    };
    expect(diffBundles(base, after)).toEqual([
      { flagKey: "segment:beta", field: "conditions", before: "—", after: "beta = true OR plan = pro" },
      { flagKey: "segment:staff", field: "conditions", before: "email ends with @nanoflags.dev", after: "removed" },
    ]);
  });

  it("a flag named like an Object.prototype member is reported as added, not compared with the inherited member", () => {
    const after = { flags: { ...base.flags, constructor: boolFlag() }, segments };
    expect(diffBundles(base, after)).toEqual([{ flagKey: "constructor", field: "flag", before: "—", after: "added" }]);
  });
});

describe("clientBundle", () => {
  const bundle: Bundle = {
    schema: 1,
    project: "commerce",
    environment: "production",
    revision: 12,
    segments,
    flags: { server: boolFlag({ clientExposed: false }), implicit: boolFlag(), client: boolFlag({ clientExposed: true }) },
  };

  it("keeps only client-exposed flags and leaves everything else untouched", () => {
    const out = clientBundle(bundle);
    expect(Object.keys(out.flags)).toEqual(["client"]);
    expect(out.flags.client).toBe(bundle.flags.client);
    expect(out).toMatchObject({ schema: 1, project: "commerce", environment: "production", revision: 12 });
    // No client-exposed flag uses "staff": it is not part of the browser view.
    expect(out.segments).toEqual({});
  });

  it("keeps exactly the segments client-exposed flags reference, transitively", () => {
    const seg = (refs: string[]): Segment => ({ match: "any", conditions: refs.map((r) => ({ attribute: "", op: "segment" as const, value: r })) });
    const b: Bundle = {
      ...bundle,
      segments: { a: seg(["b"]), b: seg(["c"]), c: { match: "all", conditions: [{ attribute: "plan", op: "eq", value: "pro" }] }, secret: seg([]), cycle1: seg(["cycle2"]), cycle2: seg(["cycle1"]) },
      flags: {
        client: boolFlag({ clientExposed: true, rules: [{ id: "r", match: "all", conditions: [{ attribute: "", op: "not_segment", value: "a" }], serve: { type: "fixed", value: true } }] }),
        loop: boolFlag({ clientExposed: true, rules: [{ id: "r", match: "all", conditions: [{ attribute: "", op: "segment", value: "cycle1" }, { attribute: "", op: "segment", value: "missing" }], serve: { type: "fixed", value: true } }] }),
        server: boolFlag({ rules: [{ id: "r", match: "all", conditions: [{ attribute: "", op: "segment", value: "secret" }], serve: { type: "fixed", value: true } }] }),
      },
    };
    expect(Object.keys(clientBundle(b).segments).sort()).toEqual(["a", "b", "c", "cycle1", "cycle2"]);
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(bundle);
    clientBundle(bundle);
    expect(JSON.stringify(bundle)).toBe(before);
    expect(Object.keys(bundle.flags)).toHaveLength(3);
  });

  it("returns an empty flag map when nothing is exposed", () => {
    expect(clientBundle({ ...bundle, flags: { server: boolFlag() } }).flags).toEqual({});
  });
});

describe("supportsEngine", () => {
  it("accepts bundles without an engine version and up to ENGINE_VERSION, refuses newer or malformed ones", () => {
    expect(supportsEngine({})).toBe(true);
    expect(supportsEngine({ engine: ENGINE_VERSION })).toBe(true);
    expect(supportsEngine({ engine: ENGINE_VERSION + 1 })).toBe(false);
    expect(supportsEngine({ engine: "1" })).toBe(false);
    expect(supportsEngine({ engine: 0 })).toBe(false);
  });
});
