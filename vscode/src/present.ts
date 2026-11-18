/** Pure presentation helpers (hover text, diagnostics, dashboard links), kept free of the vscode API for tests. */
import type { BundleFlag, Flag } from "./api";
import type { FlagRef } from "./scanner";
import type { EnvironmentStatus } from "./store";

export const DEFAULT_DASHBOARD_URL = "https://app.nanoflags.io";

/** Dashboard page of a flag. The dashboard opens it in the project currently selected there. */
export function dashboardFlagUrl(dashboardUrl: string | undefined, key: string): string {
  const base = (dashboardUrl?.trim() || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");
  return `${base}/app/flags/${encodeURIComponent(key)}`;
}

export function formatValue(v: unknown, max = 40): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? "undefined";
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function describe(c: BundleFlag | null): string {
  if (!c) return "—";
  const rules = c.rules?.length ?? 0;
  return c.enabled ? `On · default ${formatValue(c.default)}${rules ? ` · ${rules} rule${rules === 1 ? "" : "s"}` : ""}` : `Off · serves ${formatValue(c.off)}`;
}

function same(a: BundleFlag | null, b: BundleFlag | null): boolean {
  return JSON.stringify(a ? { e: a.enabled, r: a.rules, d: a.default, o: a.off } : null) === JSON.stringify(b ? { e: b.enabled, r: b.rules, d: b.default, o: b.off } : null);
}

/** Escapes text for Markdown (VS Code MarkdownString with supportHtml off). */
export function md(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

/** Hover text for a flag: name, type, per-environment status (published, and the draft when it differs), link. */
export function hoverMarkdown(flag: Flag, statuses: EnvironmentStatus[], dashboardUrl: string | undefined, projectName?: string): string {
  const lines: string[] = [];
  lines.push(`**${md(flag.name)}** \`${flag.key}\``);
  const facts = [flag.type, flag.purpose, flag.clientExposed ? "client-exposed" : "server-only", flag.permanent ? "permanent" : undefined].filter(Boolean);
  lines.push(`_${facts.join(" · ")}${projectName ? ` · ${md(projectName)}` : ""}_`);
  if (flag.archivedAt) lines.push(`\n⚠️ **Archived** on ${flag.archivedAt.slice(0, 10)}: evaluations get the code default.`);
  if (flag.description) lines.push(`\n${md(flag.description)}`);
  if (statuses.length) {
    lines.push("\n| Environment | Published | Draft |", "| --- | --- | --- |");
    for (const s of statuses) {
      const draft = same(s.draft, s.published) ? "same" : describe(s.draft);
      lines.push(`| ${md(s.environment.name)} | ${s.environment.publishedRevision === 0 ? "not published" : describe(s.published)} | ${draft} |`);
    }
  }
  lines.push(`\n[Open in NanoFlags](${dashboardFlagUrl(dashboardUrl, flag.key)})`);
  return lines.join("\n");
}

export interface FlagProblem {
  start: number;
  end: number;
  kind: "unknown" | "archived";
  key: string;
  message: string;
}

/** Problems of the references in a document: unknown keys (strong references only) and archived flags. */
export function problems(refs: FlagRef[], lookup: (key: string) => Flag | undefined, projectName: string): FlagProblem[] {
  const out: FlagProblem[] = [];
  for (const r of refs) {
    const f = lookup(r.key);
    if (!f) {
      if (r.strong) out.push({ start: r.start, end: r.end, kind: "unknown", key: r.key, message: `Unknown NanoFlags flag "${r.key}" in project ${projectName}. Evaluations will return the code default.` });
    } else if (f.archivedAt) {
      out.push({ start: r.start, end: r.end, kind: "archived", key: r.key, message: `NanoFlags flag "${r.key}" is archived: evaluations return the code default. Remove the flag from the code.` });
    }
  }
  return out;
}

/** Edit distance, for "did you mean" suggestions on unknown keys. */
export function closest(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Math.max(2, Math.floor(key.length / 4)) + 1;
  for (const c of candidates) {
    const d = distance(key, c, bestD);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
