import { describe, expect, it } from "vitest";
import { table, unifiedDiff } from "../src/util";

/** Minimal `patch`: applies a unified diff produced by unifiedDiff. */
function applyPatch(before: string, diff: string): string {
  const src = before.split("\n");
  if (src.at(-1) === "") src.pop();
  const out: string[] = [];
  let cursor = 0;
  const lines = diff.split("\n").slice(2);
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]!);
    if (!m) continue;
    const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
    while (cursor < start) out.push(src[cursor++]!);
    for (i++; i < lines.length && !lines[i]!.startsWith("@@"); i++) {
      const l = lines[i]!;
      if (l === "" && i === lines.length - 1) break;
      if (l[0] === " ") {
        expect(src[cursor]).toBe(l.slice(1));
        out.push(src[cursor++]!);
      } else if (l[0] === "-") {
        expect(src[cursor]).toBe(l.slice(1));
        cursor++;
      } else out.push(l.slice(1));
    }
    i--;
  }
  while (cursor < src.length) out.push(src[cursor++]!);
  return out.length ? `${out.join("\n")}\n` : "";
}

describe("unifiedDiff", () => {
  it("is empty for equal texts", () => {
    expect(unifiedDiff("a.ts", "x\n", "x\n")).toBe("");
  });

  it("produces hunks with three lines of context", () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 6\n", "line six\n");
    expect(unifiedDiff("a.ts", before, after)).toBe(
      ["--- a/a.ts", "+++ b/a.ts", "@@ -3,7 +3,7 @@", " line 3", " line 4", " line 5", "-line 6", "+line six", " line 7", " line 8", " line 9", ""].join("\n"),
    );
  });

  it("round-trips: applying the diff to the old text gives the new text", () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rnd(40) }, () => `l${rnd(12)}`);
      const b = [...a];
      for (let e = rnd(6); e > 0; e--) {
        const at = rnd(b.length + 1);
        const kind = rnd(3);
        if (kind === 0) b.splice(at, 0, `new${rnd(100)}`);
        else if (kind === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1 + rnd(2));
        else if (b.length) b[Math.min(at, b.length - 1)] = `chg${rnd(100)}`;
      }
      const before = a.length ? `${a.join("\n")}\n` : "";
      const after = b.length ? `${b.join("\n")}\n` : "";
      const diff = unifiedDiff("f", before, after);
      if (before === after) expect(diff).toBe("");
      else expect(applyPatch(before, diff)).toBe(after);
    }
  });
});

describe("table", () => {
  it("aligns columns and does not pad the last one", () => {
    expect(table(["A", "LONGER"], [["xxxx", "1"], ["y", "22"]])).toBe("A     LONGER\n----  ------\nxxxx  1\ny     22");
  });
});
