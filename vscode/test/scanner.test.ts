import { describe, expect, it } from "vitest";
import { completionContextAt, maskComments, refAt, scanText } from "../src/scanner";

const keys = (text: string, lang: string) => scanText(text, lang).map((r) => `${r.key}${r.strong ? "" : "?"}`);

describe("scanText", () => {
  it("finds JS/TS getters, like the CLI's code references", () => {
    const src = `
      const a = flags.boolean("new-checkout", false, ctx);
      const b = client?.string('accent', "blue");
      const c = useFlag(\`banner\`, false);
      const d = nf.number<number>("limit", 10);
      const e = flags.json("cfg", {}).value;
      const f = z.string("not-a-flag-maybe");
      const g = flags.boolean(key, false);              // variable: not a reference
      const h = flags.boolean("a" + "b", false);         // concatenation: not a reference
      // flags.boolean("commented-out")
      /* useFlag("also-commented") */
      const i = flags.boolean(\`tpl-\${x}\`, false);       // substitution: not a reference
      const j = api.getBooleanValue("of-flag", false);
    `;
    expect(keys(src, "typescript")).toEqual(["new-checkout", "accent?", "banner", "limit", "cfg", "not-a-flag-maybe?", "of-flag"]);
  });

  it("reports the exact key range", () => {
    const src = `x = flags.boolean("new-checkout", false)`;
    const [r] = scanText(src, "javascript");
    expect(src.slice(r!.start, r!.end)).toBe("new-checkout");
    expect(refAt(scanText(src, "javascript"), r!.start + 3)?.key).toBe("new-checkout");
    expect(refAt(scanText(src, "javascript"), 0)).toBeUndefined();
  });

  it("finds Python and Ruby getters and skips # comments", () => {
    const py = `on = flags.bool_variation("checkout-v2", False, {"key": u})\n# flags.bool_variation("old")\nv = client.get_boolean_value('of-py', False)\ns = flags.string_variation_detail("accent", "blue")`;
    expect(keys(py, "python")).toEqual(["checkout-v2", "of-py", "accent"]);
    const rb = `on = FLAGS.bool_variation("checkout-v2", false, { key: id }) # FLAGS.bool_variation("x")\nFLAGS.json_variation('limits', {})`;
    expect(keys(rb, "ruby")).toEqual(["checkout-v2", "limits"]);
  });

  it("finds Go getters, including OpenFeature with a context first", () => {
    const go = 'on := client.BoolVariation("checkout-v2", ctx, false)\nn := client.Float64Variation(`ratio`, ctx, 0)\nb, _ := openfeature.NewDefaultClient().BooleanValue(ctx, "of-go", false, ec)\nx := client.BoolVariation(key, ctx, false)';
    expect(keys(go, "go")).toEqual(["checkout-v2", "ratio", "of-go"]);
  });

  it("finds Java, C#, Kotlin getters", () => {
    expect(keys(`boolean on = flags.boolVariation("checkout-v2", ctx, false); long l = flags.longVariationDetail("limit", ctx, 1L);`, "java")).toEqual(["checkout-v2", "limit"]);
    expect(keys(`var on = flags.BoolVariation("checkout-v2", ctx, false); var s = await client.GetStringValueAsync("of-cs", "x");`, "csharp")).toEqual(["checkout-v2", "of-cs"]);
    expect(keys(`if (flags.boolVariation("new-checkout", false)) go()\nval accent by rememberFlag("accent", "blue")`, "kotlin")).toEqual(["new-checkout", "accent"]);
  });

  it("finds PHP getters with both comment styles", () => {
    const php = `$on = $flags->boolVariation('checkout-v2', false, []); # $flags->boolVariation('x')\n// $flags->stringVariation('y')\n$s = $flags->stringVariation("accent", "blue");`;
    expect(keys(php, "php")).toEqual(["checkout-v2", "accent"]);
  });

  it("finds Swift labelled keys and Dart FlagBuilder keys", () => {
    expect(keys(`if flags.boolVariation(key: "new-checkout", default: false) { }`, "swift")).toEqual(["new-checkout"]);
    const dart = `final on = flags.boolVariation('new-checkout', false);\nFlagBuilder<bool>(\n  flagKey: 'banner',\n  fallback: false,\n)`;
    expect(keys(dart, "dart")).toEqual(["new-checkout", "banner"]);
  });

  it("keeps strings that contain comment markers", () => {
    expect(maskComments(`a("http://x") // c`, "typescript")).toBe(`a("http://x")     `);
    expect(keys(`flags.boolean("a#b")`, "python")).toEqual(["a#b"]);
  });
});

describe("completionContextAt", () => {
  it("detects the key position inside getter calls", () => {
    expect(completionContextAt(`const on = flags.boolean("new-ch`, 32)).toMatchObject({ prefix: "new-ch", start: 26, quote: '"' });
    expect(completionContextAt(`on = flags.bool_variation('`, 27)).toMatchObject({ prefix: "", quote: "'" });
    expect(completionContextAt(`client.BooleanValue(ctx, "che`, 29)).toMatchObject({ prefix: "che" });
    expect(completionContextAt(`flags.boolVariation(key: "x`, 27)).toMatchObject({ prefix: "x" });
    expect(completionContextAt(`  flagKey: 'ban`, 15)).toMatchObject({ prefix: "ban", callee: "flagKey" });
  });

  it("ignores unrelated calls", () => {
    expect(completionContextAt(`z.string("`, 10)).toBeUndefined();
    expect(completionContextAt(`console.log("`, 13)).toBeUndefined();
    expect(completionContextAt(`client.BoolVariation(ctx, "x`, 28)).toBeUndefined();
    expect(completionContextAt(`flags.boolean("done", `, 22)).toBeUndefined();
  });
});
