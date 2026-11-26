import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA_VERSION,
  configSchemaVersionProblem,
  evaluate,
  formatIssues,
  isJsonValue,
  strictCondition,
  strictDraftConfig,
  strictExperiment,
  strictFlagConfig,
  strictRule,
  strictRules,
  strictSegment,
  strictServe,
  type Bundle,
  type ConfigIssue,
  type FlagConfig,
} from "../src/index";

const segments = { staff: { match: "all", conditions: [] } };
const paths = (issues: ConfigIssue[]) => issues.map((i) => i.path);
const flag = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "boolean",
  enabled: true,
  default: false,
  off: false,
  rules: [
    { id: "staff", match: "all", conditions: [{ attribute: "", op: "segment", value: "staff" }], serve: { type: "fixed", value: true } },
    { id: "r1", match: "any", conditions: [{ attribute: "region", op: "in", value: ["US"] }], serve: { type: "rollout", percentage: 12.5, value: true, otherwise: false, bucketBy: "accountId", seed: "s" } },
  ],
  ...over,
});

describe("strictFlagConfig: valid configurations", () => {
  it("accepts a complete configuration, with and without optional members", () => {
    expect(strictFlagConfig(flag(), { segments })).toEqual([]);
    expect(strictFlagConfig(flag({ clientExposed: true, schemaVersion: 1 }), { segments })).toEqual([]);
    expect(strictFlagConfig({ type: "json", enabled: false, default: { a: [1, null] }, off: null, rules: [] })).toEqual([]);
  });

  it("accepts rules without `match` (evaluation reads it as all)", () => {
    const f = flag({ rules: [{ id: "a", conditions: [], serve: { type: "fixed", value: true } }] });
    expect(strictFlagConfig(f)).toEqual([]);
  });

  it("accepts what the database puts into bundles, including running experiments", () => {
    const f = flag({
      clientExposed: false,
      experiment: { id: "4f0c", key: "checkout", ruleId: "r1", unit: null, traffic: 50, seed: "exp:4f0c", variants: [{ key: "control", value: false }, { key: "treatment", value: true }] },
    });
    expect(strictFlagConfig(f, { segments })).toEqual([]);
  });
});

describe("strictFlagConfig: unknown keys are refused with their path", () => {
  it("an extra `variants` key on a serve object is refused, not ignored", () => {
    const f = flag({ rules: [{ id: "r1", conditions: [], serve: { type: "fixed", value: true, variants: [{ key: "a", value: true }] } }] });
    const issues = strictFlagConfig(f);
    expect(issues).toEqual([{ path: "rules[0].serve.variants", code: "unknown_key", message: "unknown key (a fixed serve allows: type, value)" }]);
    expect(formatIssues(issues)).toEqual(["rules[0].serve.variants: unknown key (a fixed serve allows: type, value)"]);
  });

  it("an extra `variants` key on a rollout serve is refused too", () => {
    const f = flag({ rules: [{ id: "r1", conditions: [], serve: { type: "rollout", percentage: 50, value: true, otherwise: false, variants: [] } }] });
    expect(strictFlagConfig(f)).toEqual([{ path: "rules[0].serve.variants", code: "unknown_key", message: "unknown key (a rollout serve allows: type, percentage, value, otherwise, bucketBy, seed)" }]);
  });

  it("rollout-only keys on a fixed serve are unknown keys", () => {
    const f = flag({ rules: [{ id: "r1", conditions: [], serve: { type: "fixed", value: true, percentage: 50, otherwise: false } }] });
    expect(paths(strictFlagConfig(f))).toEqual(["rules[0].serve.percentage", "rules[0].serve.otherwise"]);
  });

  it("reports unknown keys at every level", () => {
    const f = flag({
      variations: [true, false],
      rules: [{ id: "r1", name: "x", conditions: [{ attribute: "a", op: "eq", value: 1, negate: true }], serve: { type: "fixed", value: true } }],
    });
    expect(strictFlagConfig(f).filter((i) => i.code === "unknown_key").map((i) => i.path)).toEqual(["variations", "rules[0].name", "rules[0].conditions[0].negate"]);
  });

  it("prefixes paths with the `path` option", () => {
    const f = flag({ extra: 1 });
    expect(paths(strictFlagConfig(f, { path: "flags.checkout-v2", segments }))).toEqual(["flags.checkout-v2.extra"]);
  });

  it("unknown keys in experiment metadata and its variants", () => {
    const x = { id: "e", key: "k", ruleId: "r1", seed: "s", variants: [{ key: "a", value: 1, weight: 50 }], status: "running" };
    expect(paths(strictExperiment(x))).toEqual(["status", "variants[0].weight"]);
  });
});

describe("strictFlagConfig: shape and values", () => {
  it("requires the members of a flag configuration", () => {
    const issues = strictFlagConfig({});
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["type", "required"],
      ["enabled", "required"],
      ["rules", "required"],
    ]);
    expect(paths(strictFlagConfig({ type: "string", enabled: true, rules: [] }))).toEqual(["default", "off"]);
  });

  it("checks values against the flag type", () => {
    const issues = strictFlagConfig(flag({ default: "yes", off: 0, rules: [{ id: "r", conditions: [], serve: { type: "rollout", percentage: 5, value: "on", otherwise: null } }] }));
    expect(formatIssues(issues)).toEqual([
      "rules[0].serve.value: value must be a boolean value (got string)",
      "rules[0].serve.otherwise: otherwise must be a boolean value (got null)",
      "default: default value must be a boolean value (got string)",
      "off: off value must be a boolean value (got number)",
    ]);
  });

  it("refuses non-JSON values even for json flags", () => {
    const f = { type: "json", enabled: true, default: { a: Number.NaN }, off: () => 1, rules: [] };
    expect(strictFlagConfig(f).map((i) => [i.path, i.code])).toEqual([
      ["default", "invalid_value"],
      ["off", "invalid_value"],
    ]);
  });

  it("checks rollouts: percentage range and decimals, bucketBy, seed, missing members", () => {
    const serve = (s: Record<string, unknown>) => strictServe({ type: "rollout", value: true, otherwise: false, ...s }, { type: "boolean" });
    expect(serve({ percentage: 0 })).toEqual([]);
    expect(serve({ percentage: 100 })).toEqual([]);
    expect(serve({ percentage: 33.33 })).toEqual([]);
    expect(serve({ percentage: 33.333 })[0]!.message).toBe("percentage allows at most two decimals");
    expect(serve({ percentage: 101 })[0]!.message).toBe("percentage must be between 0 and 100");
    expect(serve({ percentage: -1 })[0]!.code).toBe("invalid_value");
    expect(serve({ percentage: "50" })[0]!.code).toBe("invalid_type");
    expect(serve({})[0]).toEqual({ path: "percentage", code: "required", message: "percentage is required" });
    expect(serve({ percentage: 5, bucketBy: " " })[0]!.path).toBe("bucketBy");
    expect(serve({ percentage: 5, seed: 7 })[0]!.path).toBe("seed");
    expect(paths(strictServe({ type: "rollout", percentage: 5 }, { type: "boolean" }))).toEqual(["value", "otherwise"]);
  });

  it("checks serve types", () => {
    expect(strictServe({ type: "split", value: true }, { type: "boolean" })).toEqual([{ path: "type", code: "invalid_value", message: 'unknown serve type "split" (expected "fixed" or "rollout")' }]);
    expect(strictServe({ value: true }, { type: "boolean" })[0]!.code).toBe("required");
    expect(strictServe([], { type: "boolean" })[0]!.code).toBe("invalid_type");
    expect(strictServe({ type: "fixed" }, { type: "boolean" })).toEqual([{ path: "value", code: "required", message: "value is required" }]);
  });

  it("checks rules: id, match, conditions, serve", () => {
    const issues = strictRule({ id: "", match: "some", conditions: {}, serve: null }, { type: "boolean", path: "rules[3]" });
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["rules[3].id", "invalid_value"],
      ["rules[3].match", "invalid_value"],
      ["rules[3].conditions", "invalid_type"],
      ["rules[3].serve", "invalid_type"],
    ]);
    expect(paths(strictRule({}, { type: "boolean" }))).toEqual(["id", "conditions", "serve"]);
    expect(strictRule({ id: "a", description: 1, conditions: [], serve: { type: "fixed", value: true } }, { type: "boolean" })[0]!.path).toBe("description");
  });

  it("refuses duplicate rule ids", () => {
    const r = { id: "same", conditions: [], serve: { type: "fixed", value: true } };
    expect(strictRules([r, { ...r }], { type: "boolean" })).toEqual([{ path: "rules[1].id", code: "duplicate", message: 'duplicate rule id "same" (also rules[0].id)' }]);
    expect(strictRules({}, { type: "boolean" })[0]).toEqual({ path: "rules", code: "invalid_type", message: "rules must be a list (got object)" });
  });
});

describe("strictCondition", () => {
  const c = (x: Record<string, unknown>, o = {}) => strictCondition(x, o);
  it("accepts every well-formed operator", () => {
    expect(c({ attribute: "a", op: "eq", value: "x" })).toEqual([]);
    expect(c({ attribute: "a", op: "in", value: ["x", 1] })).toEqual([]);
    expect(c({ attribute: "a", op: "gt", value: 4 })).toEqual([]);
    expect(c({ attribute: "a", op: "lte", value: "4.5" })).toEqual([]);
    expect(c({ attribute: "a", op: "semver_gte", value: "4.10.0" })).toEqual([]);
    expect(c({ attribute: "a", op: "before", value: "2026-12-31" })).toEqual([]);
    expect(c({ attribute: "a", op: "exists" })).toEqual([]);
    expect(c({ attribute: "", op: "segment", value: "staff" }, { segments })).toEqual([]);
    expect(c({ op: "not_segment", value: "staff" }, { segments: ["staff"] })).toEqual([]);
  });

  it("reports precise problems", () => {
    expect(c({ attribute: "a", op: "matches", value: "x" })[0]!.message).toMatch(/^unsupported operator "matches"/);
    expect(c({ attribute: "a" })).toEqual([{ path: "op", code: "required", message: "op is required" }]);
    expect(c({ op: "eq", value: "x" })[0]).toEqual({ path: "attribute", code: "required", message: "attribute is required" });
    expect(c({ attribute: " ", op: "eq", value: "x" })[0]!.code).toBe("invalid_value");
    expect(c({ attribute: 3, op: "eq", value: "x" })[0]!.code).toBe("invalid_type");
    expect(c({ attribute: "a", op: "in", value: "US" })[0]!.message).toBe("in needs a non-empty list of values");
    expect(c({ attribute: "a", op: "not_in", value: [] })[0]!.path).toBe("value");
    expect(c({ attribute: "a", op: "eq" })[0]!.message).toBe("eq needs a value");
    expect(c({ attribute: "a", op: "gt", value: "four" })[0]!.message).toBe("gt compares numbers: the value must be a number");
    expect(c({ attribute: "a", op: "gt", value: [1] })[0]!.code).toBe("invalid_value");
    expect(c({ attribute: "a", op: "semver_gt", value: "four" })[0]!.message).toMatch(/needs a version/);
    expect(c({ attribute: "a", op: "after", value: "tomorrow" })[0]!.message).toMatch(/needs a date/);
    expect(c({ attribute: "", op: "segment", value: "ghost" }, { segments })[0]).toEqual({ path: "value", code: "unknown_segment", message: 'unknown segment "ghost"' });
    expect(c({ attribute: "", op: "segment", value: "constructor" }, { segments })[0]!.code).toBe("unknown_segment");
    expect(c({ attribute: "", op: "segment", value: "" })[0]!.code).toBe("invalid_type");
    expect(c({ attribute: 1, op: "segment", value: "staff" })[0]!.path).toBe("attribute");
    expect(c({ attribute: "a", op: "eq", value: undefined })[0]!.code).toBe("invalid_value");
  });

  it("segment references are not checked when no segments are given", () => {
    expect(c({ attribute: "", op: "segment", value: "anything" })).toEqual([]);
  });
});

describe("strictSegment", () => {
  it("checks keys, match, conditions and self-reference", () => {
    expect(strictSegment({ match: "any", conditions: [{ attribute: "email", op: "ends_with", value: "@x.dev" }] })).toEqual([]);
    expect(paths(strictSegment({ match: "all", conditions: [], name: "Staff" }))).toEqual(["name"]);
    expect(strictSegment({ conditions: [{ attribute: "", op: "segment", value: "staff" }] }, { self: "staff", segments })[0]!.message).toBe("a segment cannot reference itself");
    expect(paths(strictSegment({ match: "x" }))).toEqual(["match", "conditions"]);
  });
});

describe("strictDraftConfig (Management API configs.update, MCP update_draft, stored drafts)", () => {
  it("full drafts need every member", () => {
    expect(strictDraftConfig({ enabled: true, rules: [], default: "a", off: "b" }, { type: "string" })).toEqual([]);
    expect(paths(strictDraftConfig({}, { type: "string" }))).toEqual(["enabled", "rules", "default", "off"]);
  });

  it("partial updates check only what is sent, and need something", () => {
    expect(strictDraftConfig({ enabled: false }, { type: "number", partial: true })).toEqual([]);
    expect(strictDraftConfig({ default: 3 }, { type: "number", partial: true })).toEqual([]);
    expect(strictDraftConfig({}, { type: "number", partial: true })).toEqual([{ path: "", code: "required", message: "send at least one of enabled, rules, default, off" }]);
    expect(strictDraftConfig({ schemaVersion: 1 }, { type: "number", partial: true })[0]!.code).toBe("required");
    expect(strictDraftConfig({ enabled: "yes" }, { type: "number", partial: true })[0]).toEqual({ path: "enabled", code: "invalid_type", message: "enabled must be a boolean (got string)" });
  });

  it("refuses unknown keys, including members that only bundles carry", () => {
    const issues = strictDraftConfig({ enabled: true, type: "boolean", clientExposed: true }, { type: "boolean", partial: true });
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["type", "unknown_key"],
      ["clientExposed", "unknown_key"],
    ]);
  });

  it("an extra `variants` key inside a rule's serve is refused", () => {
    const body = { rules: [{ id: "r1", conditions: [], serve: { type: "fixed", value: "a", variants: ["a", "b"] } }] };
    expect(formatIssues(strictDraftConfig(body, { type: "string", partial: true }))).toEqual(["rules[0].serve.variants: unknown key (a fixed serve allows: type, value)"]);
  });

  it("checks values against the flag's type and segment references", () => {
    const body = { rules: [{ id: "r1", conditions: [{ attribute: "", op: "segment", value: "ghost" }], serve: { type: "fixed", value: 1 } }], off: "0" };
    expect(strictDraftConfig(body, { type: "number", partial: true, segments }).map((i) => i.path)).toEqual(["rules[0].conditions[0].value", "off"]);
  });

  it("refuses something that is not an object", () => {
    expect(strictDraftConfig([], { type: "number" })[0]!.code).toBe("invalid_type");
    expect(strictFlagConfig("x")[0]!.code).toBe("invalid_type");
  });
});

describe("schemaVersion", () => {
  it("is 1 for this engine", () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(1);
  });

  it("absent means version 1 (every existing configuration stays valid)", () => {
    expect(configSchemaVersionProblem(undefined)).toBeNull();
    expect(configSchemaVersionProblem(1)).toBeNull();
    expect(strictFlagConfig(flag(), { segments })).toEqual([]);
    expect(strictDraftConfig({ enabled: true }, { type: "boolean", partial: true })).toEqual([]);
  });

  it("an unknown future version is refused with a clear error, and nothing else is reported", () => {
    const f = flag({ schemaVersion: 2, rules: [{ id: "r1", conditions: [], serve: { type: "weighted", variants: [] } }], newThing: true });
    const issues = strictFlagConfig(f);
    expect(issues).toEqual([
      {
        path: "schemaVersion",
        code: "unsupported_version",
        message: "version 2 is not supported: this engine reads configuration schema version 1. Upgrade the engine that validates or evaluates this configuration",
      },
    ]);
    expect(strictDraftConfig({ schemaVersion: 7, rules: "?" }, { type: "boolean", partial: true }).map((i) => i.code)).toEqual(["unsupported_version"]);
  });

  it("malformed versions are invalid values", () => {
    for (const v of [0, -1, 1.5, "1", null, true]) {
      const issues = strictFlagConfig(flag({ schemaVersion: v }), { segments });
      expect(issues.map((i) => [i.path, i.code])).toEqual([["schemaVersion", "invalid_value"]]);
    }
  });

  it("evaluation is unaffected by the field", () => {
    const bundle: Bundle = { schema: 1, project: "p", environment: "e", revision: 1, segments: {}, flags: { f: { ...(flag({ rules: [] }) as unknown as FlagConfig), schemaVersion: 1 } } };
    expect(evaluate(bundle, "f", {}, true).reason).toBe("default");
  });
});

describe("isJsonValue", () => {
  it("accepts JSON and refuses everything else", () => {
    expect(isJsonValue({ a: [1, "x", null, true, { b: {} }] })).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(1n)).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(isJsonValue(deep)).toBe(false);
  });
});

describe("evaluation error codes", () => {
  const bundle: Bundle = { schema: 1, project: "p", environment: "e", revision: 3, segments: {}, flags: { f: { type: "boolean", enabled: true, default: true, off: false, rules: [] } } };
  it("distinguishes no configuration from a missing flag, keeping the reason", () => {
    expect(evaluate(null, "f", {}, false)).toMatchObject({ reason: "flag_not_found", errorCode: "CONFIG_NOT_LOADED", value: false, revision: 0 });
    expect(evaluate(bundle, "nope", {}, false)).toMatchObject({ reason: "flag_not_found", errorCode: "FLAG_NOT_FOUND", revision: 3 });
    expect(evaluate(bundle, "f", {}, false).errorCode).toBeUndefined();
  });
  it("marks evaluation errors GENERAL", () => {
    const broken = { ...bundle, flags: { f: { type: "boolean", enabled: true, default: true, off: false, rules: null } } } as unknown as Bundle;
    expect(evaluate(broken, "f", {}, false)).toMatchObject({ reason: "error", errorCode: "GENERAL" });
  });
});
