import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Exit codes. 1 = a check failed (scenarios, publish refused); 2 = usage, configuration or authentication. */
export const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.usage,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function show(v: unknown): string {
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
export const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".next", ".git"]);
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export interface Walked {
  /** Paths relative to the root, with forward slashes. */
  files: string[];
  /** Files skipped because they exceed the size cap. */
  tooLarge: string[];
}

/** Source files under `root`, in a stable order. Symbolic links are not followed. */
export function walk(root: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Walked {
  const out: Walked = { files: [], tooLarge: [] };
  const visit = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) visit(full, relPath);
      } else if (st.isFile() && SOURCE_EXTENSIONS.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts")) {
        if (st.size > maxBytes) out.tooLarge.push(relPath);
        else out.files.push(relPath);
      }
    }
  };
  visit(root, "");
  return out;
}

/* ---------------- unified diff (Myers) ---------------- */

type Op = { kind: " " | "-" | "+"; line: string };

function diffLines(a: string[], b: string[]): Op[] {
  // Common prefix and suffix are cheap to strip and make the search area small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  const max = n + m;
  const trace: Map<number, number>[] = [];
  let v = new Map<number, number>([[1, 0]]);
  let found = max === 0;
  for (let d = 0; d <= max && !found; d++) {
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      next.set(k, i);
      if (i >= n && j >= m) {
        found = true;
        break;
      }
    }
    trace.push(next);
    v = next;
  }
  // Backtrack.
  const middle: Op[] = [];
  let i = n;
  let j = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = i - j;
    const down = k === -d || (k !== d && (prev.get(k - 1) ?? -1) < (prev.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevI = prev.get(prevK) ?? 0;
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) {
      middle.push({ kind: " ", line: x[--i]! });
      j--;
    }
    if (down) middle.push({ kind: "+", line: y[--j]! });
    else middle.push({ kind: "-", line: x[--i]! });
  }
  while (i > 0 && j > 0) {
    middle.push({ kind: " ", line: x[--i]! });
    j--;
  }
  middle.reverse();
  return [...a.slice(0, start).map((line): Op => ({ kind: " ", line })), ...middle, ...a.slice(endA).map((line): Op => ({ kind: " ", line }))];
}

/** Unified diff with `context` lines around each change. Empty string when the texts are equal. */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const split = (s: string) => {
    const lines = s.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const ops = diffLines(split(before), split(after));
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let lineA = 1;
  let lineB = 1;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      i++;
      lineA++;
      lineB++;
      continue;
    }
    // Start of a hunk: back up `context` lines, extend until `2 * context` unchanged lines follow.
    const from = Math.max(0, i - context);
    const startA = lineA - (i - from);
    const startB = lineB - (i - from);
    let end = i;
    let quiet = 0;
    let k = i;
    while (k < ops.length && quiet <= context * 2) {
      if (ops[k]!.kind === " ") quiet++;
      else {
        quiet = 0;
        end = k;
      }
      k++;
    }
    const to = Math.min(ops.length, end + 1 + context);
    const hunk = ops.slice(from, to);
    const countA = hunk.filter((o) => o.kind !== "+").length;
    const countB = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${countA === 0 ? startA - 1 : startA},${countA} +${countB === 0 ? startB - 1 : startB},${countB} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
    for (let q = i; q < to; q++) {
      if (ops[q]!.kind !== "+") lineA++;
      if (ops[q]!.kind !== "-") lineB++;
    }
    i = to;
  }
  return `${out.join("\n")}\n`;
}
