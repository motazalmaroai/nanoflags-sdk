import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanText } from "../src/refs.js";
import { isSourcePath, scanSource } from "../src/refs-lite.js";

// The compiler-free scanner (used by the GitHub App in the notify Worker) must find exactly what the CLI's
// TypeScript-AST scanner finds.
const KEYS = new Set(["checkout-v2", "max-items", "search-ranking", "old-banner", "layout", "kill-switch", "new-nav", "a"]);

function files(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? files(full, root) : [relative(root, full).replace(/\\/g, "/")];
  });
}

const CASES: [string, string][] = [
  ["basic.ts", `flags.boolean("checkout-v2", false);\nconst x = client.getStringValue('layout', "a");`],
  ["optional.ts", `a?.boolean("checkout-v2"); a!.boolean("layout"); a.boolean!("kill-switch"); a.boolean?.("max-items");`],
  ["generic.ts", `useFlag<{ a: number; b: Array<string> }>("layout", { a: 1 });\nconst v = flags.json<Record<string, number>>("max-items", {});`],
  ["chain.ts", `const v = this.sdk\n  .client()\n  .boolean("checkout-v2", false);\nsuper.evaluate("layout", 1);`],
  ["calls-in-calls.ts", `track(flags.boolean("checkout-v2"), flags.string("layout", flags.number("max-items")));`],
  ["same-start.ts", `a.boolean("checkout-v2").boolean("layout");`],
  ["new.ts", `new flags.boolean("checkout-v2"); new Client().boolean("layout"); new a.b("x").string("max-items");`],
  ["not-refs.ts", `flags.boolean(key); flags.boolean("checkout-" + "v2"); flags.boolean(\`\${"checkout-v2"}\`); other("checkout-v2"); flags["boolean"]("layout"); const s = "flags.boolean('layout')";`],
  ["comments.ts", `// flags.boolean("checkout-v2")\n/* flags.boolean("layout") */\nflags.boolean("max-items") // trailing\n`],
  ["template.ts", "const t = `x ${flags.boolean(\"checkout-v2\")} y ${ { a: flags.string(`layout`) }.a } z`;\nflags.number(`max-items`);"],
  ["regex.ts", `const r = /flags.boolean("checkout-v2")/g; const d = a / b; flags.boolean("layout") / 2;`],
  ["escapes.ts", `flags.boolean("checkout\\x2dv2"); flags.boolean('lay\\u006fut');`],
  ["view.tsx", `export const V = () => <div title="flags.boolean('layout')" data-x={flags.boolean("checkout-v2")}>\n  Don't use flags.boolean("max-items") here\n  {flags.string("kill-switch") ? <b>{useFlag("old-banner")}</b> : null}\n  <Foo.Bar {...p} on={() => evaluate("search-ranking")} />\n</div>;`],
  ["frag.jsx", `const F = () => <>\n  It's {useFlag("new-nav")}\n</>;\nconst G = useFlagDetails("a");`],
  ["arrow.ts", `const f = async () => (await flags.boolean("checkout-v2")) ? 1 : 2;\nif (x) flags.boolean("layout");\nreturn flags.boolean("max-items");`],
  ["crlf.ts", `a();\r\nflags.boolean("checkout-v2");\r\n  x.getBooleanDetails("layout");`],
  ["long.ts", `flags.boolean("checkout-v2", ${JSON.stringify("x".repeat(300))});`],
  ["classes.ts", `class A { boolean(k: string) { return k; } m() { return this.boolean("layout"); } }\nfunction evaluate(k: string) {}\nevaluate("checkout-v2");`],
];

describe("refs-lite parity with the TypeScript scanner", () => {
  it("matches on the CLI fixture repository", () => {
    const root = join(import.meta.dirname, "fixtures", "repo");
    let compared = 0;
    for (const f of files(root).filter(isSourcePath)) {
      const text = readFileSync(join(root, f), "utf8");
      expect(scanSource(f, text, KEYS), f).toEqual(scanText(f, text, KEYS));
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(5);
  });

  it.each(CASES)("matches on %s", (path, text) => {
    const lite = scanSource(path, text, KEYS);
    expect(lite).toEqual(scanText(path, text, KEYS));
  });

  it("finds the references in the tricky cases at all (not just agreeing on nothing)", () => {
    const found = CASES.reduce((n, [p, t]) => n + scanSource(p, t, KEYS).length, 0);
    expect(found).toBeGreaterThan(30);
  });

  it("filters paths like the CLI walker", () => {
    expect(isSourcePath("src/a.ts")).toBe(true);
    expect(isSourcePath("src/a.d.ts")).toBe(false);
    expect(isSourcePath("node_modules/x/a.js")).toBe(false);
    expect(isSourcePath("packages/web/.next/a.js")).toBe(false);
    expect(isSourcePath("README.md")).toBe(false);
    expect(isSourcePath("a.mjs")).toBe(true);
  });
});
