import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupText, type Json } from "../src/cleanup";
import { FIXTURES } from "./helpers";

const DIR = join(FIXTURES, "cleanup");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

/** Fixture → the (flag, value) pairs applied in order. `<name>.true.*` / `<name>.false.*` hold the expected result. */
const CASES: Record<string, { ext: string; true: Array<[string, Json]>; false?: Array<[string, Json]> }> = {
  "if-statement": { ext: "ts", true: [["checkout-v2", true]], false: [["checkout-v2", false]] },
  ternary: { ext: "ts", true: [["checkout-v2", true]], false: [["checkout-v2", false]] },
  logical: { ext: "ts", true: [["checkout-v2", true]], false: [["checkout-v2", false]] },
  "const-binding": { ext: "ts", true: [["checkout-v2", true]], false: [["checkout-v2", false]] },
  "use-flag": { ext: "tsx", true: [["checkout-v2", true]], false: [["checkout-v2", false]] },
  openfeature: { ext: "ts", true: [["checkout-v2", true]], false: [["checkout-v2", false]] },
  "string-flag": { ext: "ts", true: [["search-ranking", "relevance-v2"], ["max-items", 20], ["layout", { columns: 3 }]] },
};

function apply(file: string, text: string, steps: Array<[string, Json]>) {
  let output = text;
  let transformed = 0;
  for (const [flag, value] of steps) {
    const r = cleanupText(file, output, flag, value);
    output = r.output;
    transformed += r.transformed.length;
    expect(r.skipped).toEqual([]);
  }
  return { output, transformed };
}

describe("cleanup fixtures", () => {
  it("every fixture has a case", () => {
    const inputs = readdirSync(DIR).filter((f) => f.includes(".input.")).map((f) => f.split(".")[0]!);
    expect(inputs.sort()).toEqual([...Object.keys(CASES), "unsupported"].sort());
  });

  for (const [name, c] of Object.entries(CASES)) {
    for (const variant of ["true", "false"] as const) {
      const steps = c[variant];
      if (!steps) continue;
      it(`${name} (${steps.map(([f, v]) => `${f}=${JSON.stringify(v)}`).join(", ")})`, () => {
        const file = `${name}.input.${c.ext}`;
        const { output, transformed } = apply(file, read(file), steps);
        const expectedFile = join(DIR, `${name}.${variant}.${c.ext}`);
        if (process.env.UPDATE_FIXTURES === "1" || !existsSync(expectedFile)) writeFileSync(expectedFile, output);
        expect(output).toBe(readFileSync(expectedFile, "utf8"));
        expect(transformed).toBeGreaterThan(0);
        // No read of the flag is left, and running it again changes nothing.
        for (const [flag, value] of steps) {
          expect(output).not.toContain(`"${flag}"`);
          expect(cleanupText(file, output, flag, value).output).toBe(output);
        }
      });
    }
  }
});

const run = (code: string, value: Json = true, file = "a.ts") => cleanupText(file, code, "checkout-v2", value);

describe("supported patterns", () => {
  it("direct call as an if condition", () => {
    expect(run('if (flags.boolean("checkout-v2", false, ctx)) {\n  a();\n} else {\n  b();\n}\n').output).toBe("a();\n");
    expect(run('if (flags.boolean("checkout-v2", false, ctx)) {\n  a();\n} else {\n  b();\n}\n', false).output).toBe("b();\n");
    expect(run('before();\nif (flags.boolean("checkout-v2", false)) {\n  a();\n}\nafter();\n', false).output).toBe("before();\nafter();\n");
  });

  it("useFlag as an if condition", () => {
    expect(run('function C() {\n  if (useFlag("checkout-v2", false)) {\n    return 1;\n  }\n  return 2;\n}\n', false, "a.tsx").output).toBe("function C() {\n  return 2;\n}\n");
  });

  it("ternary condition", () => {
    expect(run('const x = flags.boolean("checkout-v2", false) ? a : b;\n').output).toBe("const x = a;\n");
    expect(run('const x = flags.boolean("checkout-v2", false) ? a : b;\n', false).output).toBe("const x = b;\n");
    expect(run('f(useFlag("checkout-v2", false) ? 1 : 2);\n').output).toBe("f(1);\n");
  });

  it("&& and || operands", () => {
    expect(run('const x = flags.boolean("checkout-v2", false) && y;\n').output).toBe("const x = y;\n");
    expect(run('const x = flags.boolean("checkout-v2", false) || y;\n', false).output).toBe("const x = y;\n");
    expect(run('if (y && flags.boolean("checkout-v2", false)) z();\n').output).toBe("if (y) z();\n");
    expect(run('if (y || flags.boolean("checkout-v2", false)) z();\n', false).output).toBe("if (y) z();\n");
    // As a value, `y && true` is not `y`: only the call is replaced.
    expect(run('const x = y && flags.boolean("checkout-v2", false);\n').output).toBe("const x = y && true;\n");
  });

  it("const binding followed by uses in the same scope", () => {
    const code = 'function f() {\n  const on = flags.boolean("checkout-v2", false);\n  if (on) {\n    a();\n  }\n  return on ? 1 : 2;\n}\n';
    expect(run(code).output).toBe("function f() {\n  a();\n  return 1;\n}\n");
    expect(run(code, false).output).toBe("function f() {\n  return 2;\n}\n");
  });

  it("a shadowing binding with the same name is not touched", () => {
    const code = 'const on = flags.boolean("checkout-v2", false);\nfunction g(on: boolean) {\n  return on ? 1 : 2;\n}\nexport const v = on ? g(true) : g(false);\n';
    expect(run(code).output).toBe("function g(on: boolean) {\n  return on ? 1 : 2;\n}\nexport const v = g(true);\n");
  });

  it("anything else gets the literal", () => {
    expect(run('send({ v2: flags.boolean("checkout-v2", false) });\n').output).toBe("send({ v2: true });\n");
    expect(run('let on = flags.boolean("checkout-v2", false);\n', false).output).toBe("let on = false;\n");
    expect(run('for (; flags.boolean("checkout-v2", false); ) step();\n', false).output).toBe("for (; false; ) step();\n");
    expect(run('export default () => flags.json("checkout-v2", {});\n', { a: 1 }).output).toBe('export default () => ({"a":1});\n');
    expect(run('const n = flags.number("checkout-v2", 0) ** 2;\n', -3).output).toBe("const n = (-3) ** 2;\n");
  });

  it("keeps formatting outside the rewritten range, including CRLF-free comments and JS files", () => {
    const code = '// header\nconst   a = 1;   // odd spacing stays\nmodule.exports = flags.boolean("checkout-v2", false) ? "x" : "y";\n';
    expect(run(code, true, "a.cjs").output).toBe('// header\nconst   a = 1;   // odd spacing stays\nmodule.exports = "x";\n');
  });

  it("reports code that became unreachable", () => {
    const r = run('function f() {\n  if (flags.boolean("checkout-v2", false)) {\n    return 1;\n  }\n  return 2;\n}\n');
    expect(r.output).toBe("function f() {\n  return 1;\n  return 2;\n}\n");
    expect(r.unreachable).toEqual([{ line: 3, snippet: "return 2;" }]);
  });
});

describe("refusals: references that are reported, not rewritten", () => {
  it("the unsupported fixture is left byte-for-byte unchanged and every reference is listed with a reason", () => {
    const text = read("unsupported.input.ts");
    const r = cleanupText("unsupported.input.ts", text, "checkout-v2", true);
    expect(r.output).toBe(text);
    expect(r.transformed).toEqual([]);
    expect(r.skipped.map((s) => [s.line, s.reason])).toEqual([
      [5, "evaluate() returns an evaluation object, not the value"],
      [6, "getBooleanDetails() returns an evaluation object, not the value"],
      [8, "getBooleanValue() may return a promise (OpenFeature server SDK); only awaited calls are rewritten"],
      [10, "the call or its arguments may have side effects"],
      [14, "this is a string read but the value is a boolean: today it returns its fallback, not the value"],
      [16, "optional call (?.) may also yield undefined"],
      [18, "the accessor type depends on a fallback that is not a literal"],
    ]);
    expect(r.skipped[0]!.snippet).toBe('const details = flags.evaluate("checkout-v2", false, ctx);');
  });

  it("a callee with side effects is not dropped", () => {
    const r = run('const x = getFlags().boolean("checkout-v2", false);\n');
    expect(r.output).toContain("getFlags()");
    expect(r.skipped).toHaveLength(1);
  });

  it("mixed file: supported reads are rewritten, the others are reported", () => {
    const r = run('const d = flags.evaluate("checkout-v2", false);\nif (flags.boolean("checkout-v2", false)) {\n  a();\n}\n');
    expect(r.output).toBe('const d = flags.evaluate("checkout-v2", false);\na();\n');
    expect(r.transformed.map((s) => s.line)).toEqual([2]);
    expect(r.skipped.map((s) => s.line)).toEqual([1]);
    expect(r.skipped[0]!.removed).toBeUndefined();
  });

  it("an unsupported read inside a removed branch is reported as removed", () => {
    const r = run('if (flags.boolean("checkout-v2", false)) {\n  a();\n} else {\n  log(flags.evaluate("checkout-v2", false));\n}\n');
    expect(r.output).toBe("a();\n");
    expect(r.skipped).toMatchObject([{ line: 4, removed: true }]);
  });

  it("other flags, other functions and non-literal keys are not references", () => {
    const code = 'flags.boolean("other-flag", false);\ntrack("checkout-v2");\nflags.boolean(KEY, false);\nconst s = "checkout-v2";\n';
    const r = run(code);
    expect(r).toEqual({ output: code, transformed: [], skipped: [], unreachable: [] });
  });

  it("a file with syntax errors is never made worse", () => {
    const code = 'if (flags.boolean("checkout-v2", false)) {\n  a(;\n';
    const r = run(code);
    expect(r.output === code || r.skipped.length === 0).toBe(true);
  });
});
