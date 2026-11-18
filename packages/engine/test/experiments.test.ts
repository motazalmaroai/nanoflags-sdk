import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bucketOf, diffBundles, evaluate, exposureOf, type Bundle, type FlagConfig } from "../src/index";

const EXP_ID = "3f1c2b8e-7d52-4c1a-9a43-1f0e6d5b2c11";

const flag = (over: Partial<FlagConfig> = {}): FlagConfig => ({
  type: "boolean",
  enabled: true,
  default: false,
  off: false,
  rules: [
    { id: "staff", match: "all", conditions: [{ attribute: "staff", op: "eq", value: true }], serve: { type: "fixed", value: true } },
    { id: "r1", match: "all", conditions: [{ attribute: "country", op: "in", value: ["SA", "AE"] }], serve: { type: "rollout", percentage: 50, value: true, otherwise: false } },
  ],
  experiment: { id: EXP_ID, key: "new-checkout", ruleId: "r1", seed: `exp:${EXP_ID}`, traffic: 100, variants: [{ key: "control", value: false }, { key: "treatment", value: true }] },
  ...over,
});

const bundle = (f: FlagConfig): Bundle => ({ schema: 1, project: "shop", environment: "production", revision: 3, flags: { checkout: f }, segments: {} });

describe("exposureOf", () => {
  it("both sides of the experiment's rollout rule are exposures, with the variant of the served value", () => {
    const f = flag();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const ctx = { key: `user-${i}`, country: "SA" };
      const e = evaluate(bundle(f), "checkout", ctx, false);
      const x = exposureOf(f, e, ctx);
      expect(x).not.toBeNull();
      expect(x!.experiment).toBe(EXP_ID);
      expect(x!.unit).toBe(`user-${i}`);
      expect(x!.variant).toBe(e.value ? "treatment" : "control");
      seen.add(x!.variant);
    }
    expect(seen).toEqual(new Set(["control", "treatment"]));
  });

  it("other rules, the default, a disabled flag and flags without an experiment are not exposures", () => {
    const f = flag();
    const staff = { key: "u1", staff: true, country: "SA" };
    expect(exposureOf(f, evaluate(bundle(f), "checkout", staff, false), staff)).toBeNull();
    const elsewhere = { key: "u1", country: "DE" };
    expect(exposureOf(f, evaluate(bundle(f), "checkout", elsewhere, false), elsewhere)).toBeNull();
    const off = flag({ enabled: false });
    expect(exposureOf(off, evaluate(bundle(off), "checkout", { key: "u1", country: "SA" }, false), { key: "u1", country: "SA" })).toBeNull();
    const plain = flag({ experiment: undefined });
    expect(exposureOf(plain, evaluate(bundle(plain), "checkout", { key: "u1", country: "SA" }, false), { key: "u1", country: "SA" })).toBeNull();
    expect(exposureOf(undefined, { reason: "rule_match", ruleId: "r1", value: true }, { key: "u1" })).toBeNull();
  });

  it("needs the unit attribute, and uses the configured one", () => {
    const f = flag();
    expect(exposureOf(f, { reason: "rule_match", ruleId: "r1", value: true }, { country: "SA" })).toBeNull();
    expect(exposureOf(f, { reason: "rule_match", ruleId: "r1", value: true }, { key: "", country: "SA" })).toBeNull();
    const byAccount = flag({ experiment: { ...flag().experiment!, unit: "accountId" } });
    expect(exposureOf(byAccount, { reason: "rule_match", ruleId: "r1", value: true }, { key: "u1", accountId: "acct-9" })?.unit).toBe("acct-9");
    expect(exposureOf(byAccount, { reason: "rule_match", ruleId: "r1", value: true }, { key: "u1", accountId: 42 })?.unit).toBe("42");
  });

  it("values that are not a variant are not exposures", () => {
    expect(exposureOf(flag(), { reason: "rule_match", ruleId: "r1", value: "maybe" }, { key: "u1" })).toBeNull();
  });

  it("traffic enrolls the units whose experiment bucket is below it, independently of the rollout bucket", () => {
    const f = flag({ experiment: { ...flag().experiment!, traffic: 20 } });
    let enrolled = 0;
    for (let i = 0; i < 2000; i++) {
      const unit = `u${i}`;
      const x = exposureOf(f, { reason: "rule_match", ruleId: "r1", value: true }, { key: unit });
      expect(x !== null).toBe(bucketOf(`exp:${EXP_ID}`, unit) < 20);
      if (x) enrolled++;
    }
    expect(enrolled / 2000).toBeGreaterThan(0.17);
    expect(enrolled / 2000).toBeLessThan(0.23);
  });

  it("is deterministic and never throws on malformed metadata", () => {
    fc.assert(
      fc.property(fc.string(), fc.anything(), (unit, junk) => {
        const f = { ...flag(), experiment: junk as FlagConfig["experiment"] };
        const ev = { reason: "rule_match" as const, ruleId: "r1", value: true };
        const a = exposureOf(f, ev, { key: unit });
        expect(exposureOf(f, ev, { key: unit })).toEqual(a);
      }),
    );
  });
});

describe("diffBundles: experiments", () => {
  it("reports starting and stopping an experiment", () => {
    const withExp = bundle(flag());
    const without = bundle(flag({ experiment: undefined }));
    expect(diffBundles(without, withExp)).toEqual([{ flagKey: "checkout", field: "experiment", before: "—", after: "new-checkout (100% of rule r1)" }]);
    expect(diffBundles(withExp, without)).toEqual([{ flagKey: "checkout", field: "experiment", before: "new-checkout (100% of rule r1)", after: "stopped" }]);
    expect(diffBundles(withExp, withExp)).toEqual([]);
  });
});
