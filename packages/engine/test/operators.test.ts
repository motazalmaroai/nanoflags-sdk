import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  compareSemver,
  conditionValueProblem,
  describeCondition,
  evaluate,
  flagWarnings,
  matchCondition,
  numericVersionWarning,
  OPERATORS,
  parseInstant,
  parseSemver,
  validateFlagConfig,
  type Bundle,
  type Condition,
  type JsonValue,
  type Operator,
} from "../src/index";
import operatorsJson from "../fixtures/operators.json";

interface Vector { op: Operator; actual: JsonValue; value: JsonValue; expected: boolean; note?: string }
const vectors = (operatorsJson as unknown as { cases: Vector[] }).cases;

describe("operators.json conformance vectors", () => {
  it("has cases for every new operator", () => {
    const ops = new Set(vectors.map((v) => v.op));
    for (const op of ["semver_eq", "semver_neq", "semver_gt", "semver_gte", "semver_lt", "semver_lte", "before", "after"]) expect(ops.has(op as Operator)).toBe(true);
    expect(vectors.length).toBeGreaterThan(1000);
  });
  it("matchCondition reproduces every hand-written expectation", () => {
    const failures: string[] = [];
    for (const v of vectors) {
      const ctx = v.actual === "__absent__" ? {} : { attr: v.actual };
      const got = matchCondition({ attribute: "attr", op: v.op, value: v.value }, ctx, {});
      if (got !== v.expected) failures.push(`${v.op} ${JSON.stringify(v.actual)} vs ${JSON.stringify(v.value)}: expected ${v.expected} (${v.note ?? ""})`);
    }
    expect(failures).toEqual([]);
  });
});

describe("parseSemver / compareSemver", () => {
  const cmp = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
  it("orders the SemVer 2.0 precedence example", () => {
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < chain.length; i++) expect(cmp(chain[i]!, chain[i + 1]!)).toBe(-1);
  });
  it("is lenient about missing numbers, v prefixes and leading zeros", () => {
    expect(parseSemver("4.10")).toEqual({ major: "4", minor: "10", patch: "0", prerelease: [] });
    expect(parseSemver("v4")).toEqual({ major: "4", minor: "0", patch: "0", prerelease: [] });
    expect(parseSemver("2026.01.05")).toEqual({ major: "2026", minor: "1", patch: "5", prerelease: [] });
    expect(cmp("4.10", "4.9")).toBe(1);
  });
  it("ignores build metadata and rejects junk", () => {
    expect(parseSemver("1.2.3-rc.1+build.7")).toEqual({ major: "1", minor: "2", patch: "3", prerelease: ["rc", "1"] });
    for (const bad of ["", "1.2.3.4", "1.2.3-", "1.2.3+", "1..2", " 1.2.3", "v", "1.2.3-a..b", "1.2.x"]) expect(parseSemver(bad)).toBeNull();
    for (const bad of [null, undefined, 1, true, [], {}]) expect(parseSemver(bad)).toBeNull();
  });
  it("is a total order consistent with antisymmetry (property)", () => {
    const ident = fc.oneof(fc.nat({ max: 30 }).map(String), fc.constantFrom("alpha", "beta", "rc", "a", "A", "x-1"));
    const version = fc.tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.array(ident, { maxLength: 3 }), fc.boolean())
      .map(([a, b, c, pre, build]) => `${a}.${b}.${c}${pre.length ? `-${pre.join(".")}` : ""}${build ? "+b.1" : ""}`);
    fc.assert(fc.property(version, version, (a, b) => {
      const x = parseSemver(a);
      const y = parseSemver(b);
      expect(x).not.toBeNull();
      expect(y).not.toBeNull();
      expect(compareSemver(x!, y!)).toBe(-compareSemver(y!, x!) || 0);
    }));
  });
  it("never throws on arbitrary input", () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (s) => { parseSemver(s); parseInstant(s); }));
  });
});

describe("parseInstant", () => {
  it("reads dates, timestamps and epoch numbers", () => {
    expect(parseInstant("2026-01-01")).toBe(Date.UTC(2026, 0, 1));
    expect(parseInstant("2024-02-29T12:30:00+03:00")).toBe(Date.parse("2024-02-29T12:30:00+03:00"));
    expect(parseInstant("2026-01-01T00:00:00.123456Z")).toBe(Date.UTC(2026, 0, 1) + 123);
    expect(parseInstant(1767225600)).toBe(1767225600000);
    expect(parseInstant(1767225600000)).toBe(1767225600000);
    expect(parseInstant(-1)).toBe(-1000);
  });
  it("agrees with Date.UTC for every day of a leap cycle (property)", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), (y, m, d) => {
      const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const date = new Date(0);
      date.setUTCFullYear(y, m - 1, d);
      expect(parseInstant(s)).toBe(date.getTime());
    }));
  });
  it("rejects invalid calendar dates and timestamps without an offset", () => {
    for (const bad of ["2023-02-29", "2026-04-31", "2026-01-01T10:00:00", "2026-01-01T24:00:00Z", "1767225600", "", "2026-01-01\n"]) expect(parseInstant(bad)).toBeNull();
    for (const bad of [null, undefined, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) expect(parseInstant(bad)).toBeNull();
  });
});

describe("evaluation with the new operators", () => {
  const bundle = (conditions: Condition[], match: "all" | "any" = "all"): Bundle => ({
    schema: 1, project: "p", environment: "e", revision: 1, segments: {},
    flags: { f: { type: "boolean", enabled: true, default: false, off: false, rules: [{ id: "r", match, conditions, serve: { type: "fixed", value: true } }] } },
  });
  it("targets app versions correctly where gt cannot", () => {
    const b = bundle([{ attribute: "appVersion", op: "semver_gte", value: "4.10.0" }]);
    expect(evaluate(b, "f", { appVersion: "4.10.0" }, false).value).toBe(true);
    expect(evaluate(b, "f", { appVersion: "4.9.3" }, false).value).toBe(false);
    expect(evaluate(b, "f", { appVersion: "4.10.0-beta.1" }, false).value).toBe(false);
    expect(evaluate(b, "f", { appVersion: "garbage" }, false)).toMatchObject({ value: false, reason: "default" });
    const numeric = bundle([{ attribute: "appVersion", op: "gt", value: "4.9" }]);
    expect(evaluate(numeric, "f", { appVersion: "4.10" }, false).value).toBe(false); // numeric semantics are unchanged
  });
  it("describes the conditions in traces", () => {
    expect(describeCondition({ attribute: "appVersion", op: "semver_gte", value: "4.10.0" })).toBe("appVersion version ≥ 4.10.0");
    expect(describeCondition({ attribute: "signupAt", op: "before", value: "2026-01-01" })).toBe("signupAt before 2026-01-01");
    expect(evaluate(bundle([{ attribute: "t", op: "after", value: 0 }]), "f", { t: 1 }, false).trace[1]!.detail).toBe("t after 0");
  });
  it("lists the operators and validates them structurally", () => {
    expect(OPERATORS).toHaveLength(23);
    const flag = bundle([{ attribute: "v", op: "semver_lt", value: "2.0" }, { attribute: "d", op: "after", value: "2026-01-01" }]).flags.f!;
    expect(validateFlagConfig("f", flag)).toEqual([]);
  });
});

describe("advice", () => {
  it("flags numeric operators used on versions", () => {
    expect(numericVersionWarning({ attribute: "v", op: "gt", value: "4.10.0" })).toBe(true);
    expect(numericVersionWarning({ attribute: "v", op: "gte", value: "v4" })).toBe(true);
    expect(numericVersionWarning({ attribute: "appVersion", op: "lt", value: 4.1 })).toBe(true);
    expect(numericVersionWarning({ attribute: "os_ver", op: "lte", value: "17" })).toBe(true);
    expect(numericVersionWarning({ attribute: "age", op: "gt", value: "18" })).toBe(false);
    expect(numericVersionWarning({ attribute: "server", op: "gt", value: 3 })).toBe(false);
    expect(numericVersionWarning({ attribute: "appVersion", op: "semver_gt", value: "4.10.0" })).toBe(false);
    expect(flagWarnings("f", { rules: [{ id: "r", match: "all", conditions: [{ attribute: "build", op: "gt", value: "4.10.0" }], serve: { type: "fixed", value: true } }] }))
      .toEqual(['f: rule 01 compares "build" as a number (gt); use a version operator (semver_gt) to compare versions such as 4.10.0.']);
  });
  it("reports comparison values the version and date operators cannot read", () => {
    expect(conditionValueProblem({ op: "semver_eq", value: "4.x" })).toBe("version");
    expect(conditionValueProblem({ op: "semver_eq", value: "4.10" })).toBeNull();
    expect(conditionValueProblem({ op: "before", value: "next week" })).toBe("date");
    expect(conditionValueProblem({ op: "after", value: 1767225600 })).toBeNull();
    expect(conditionValueProblem({ op: "eq", value: "anything" })).toBeNull();
  });
});
