/**
 * Read-only review tools (wave 1, B6): look before proposing. Every one reads only (annotations readOnlyHint true,
 * destructiveHint false, openWorldHint false), publishes an outputSchema, and bounds its lists.
 *   preview_change         what publishing an environment's draft would change: diff vs published, rules touched,
 *                          scenario checks on the current draft, strict validation. No estimate of who is affected.
 *   find_stale_flags       the dashboard's cleanup list (GET …/stale-flags).
 *   get_removal_readiness  safe / caution / blocked for removing one flag, with the evidence.
 *   get_effective_policy   the environment's publishing policy and what this token may do (GET …/agent-policy).
 *   get_flag_usage         sampled usage of one flag in one environment (GET …/insights).
 */
import { strictFlagConfig, type ConfigIssue } from "@nanoflags/engine";
import { ApiError, isObject, seg } from "./api.js";
import { capList, cursorArg, limitArg, pageOf, readOffsetCursor } from "./limits.js";
import type { JsonSchema, Tool, ToolContext } from "./tools.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const KEY = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" };
const project = { type: "string", description: "Project key. Default: the project the connection or token is limited to (or NANOFLAGS_PROJECT for the local server)." };
const environment = { type: "string", description: "Environment key, e.g. development, staging, production." };
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const out = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: "object", properties: { ...properties, truncated: { type: "boolean", description: "Set when the answer was shortened to the output limit." } }, required });
const P = (p: string) => `/projects/${seg(p)}`;
const S = { type: "string" };
const N = { type: "integer" };
const B = { type: "boolean" };
const arr = (items: JsonSchema = {}): JsonSchema => ({ type: "array", items });
const nullable = (t: string): JsonSchema => ({ type: [t, "null"] });

/** Helpers from tools.ts (passed in, so the two modules do not import each other at load time). */
export interface ReviewHelpers {
  projectOf: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  inputError: (message: string) => Error;
  boundInsights: (insights: Record<string, unknown>, limit: number) => { insights: Record<string, unknown>; cut: Record<string, number> };
}

interface DiffRow { flagKey: string; field: string; before: string; after: string }
interface Run { scenarioId: string; configChecksum: string; passed: boolean; createdAt: string }

/** Strict validation of every flag in a draft bundle (engine), bounded. */
function validateBundle(bundle: Record<string, unknown>, only: Set<string> | null): ConfigIssue[] {
  const flags = isObject(bundle.flags) ? bundle.flags : {};
  const segments = isObject(bundle.segments) ? bundle.segments : {};
  const issues: ConfigIssue[] = [];
  for (const [key, f] of Object.entries(flags)) if (!only || only.has(key)) issues.push(...strictFlagConfig(f, { segments, path: `flags.${key}` }));
  return issues;
}

export function reviewTools({ projectOf, inputError, boundInsights }: ReviewHelpers): Tool[] {
  return [
    {
      name: "preview_change",
      title: "Preview a change",
      description:
        "Preview what publishing an environment's draft would change, without changing anything: the field-level diff against the published revision, the flags and targeting rules it touches, the scenario-check results recorded for exactly this draft, and strict validation of the draft. Optionally limited to some flags or to the flags of one change request. It reports configuration differences only, not how many users or requests they would affect.",
      inputSchema: obj({
        project, environment,
        flags: { type: "array", maxItems: 200, items: KEY, description: "Only these flag keys (default: every flag that differs)." },
        change: { type: "string", pattern: "^[0-9a-fA-F-]{36}$", description: "A change id: preview its environment and its flags." },
        limit: limitArg(200, 100, "diff rows"),
      }),
      outputSchema: out({
        environment: S, publishedRevision: N, draftChecksum: S, hasChanges: B,
        changes: arr({ type: "object", properties: { flagKey: S, field: S, before: S, after: S }, required: ["flagKey", "field", "before", "after"] }),
        changesTotal: N, flagsTouched: arr(S), rulesTouched: arr({ type: "object", properties: { flag: S, rule: S }, required: ["flag", "rule"] }), segmentsTouched: arr(S),
        scenarios: { type: "object", properties: { total: N, passed: N, failed: N, notRun: N, failing: arr(S) }, required: ["total", "passed", "failed", "notRun", "failing"] },
        validation: { type: "object", properties: { ok: B, issues: arr({ type: "object", properties: { path: S, code: S, message: S }, required: ["path", "code", "message"] }) }, required: ["ok", "issues"] },
        note: S,
      }, ["environment", "publishedRevision", "draftChecksum", "hasChanges", "changes", "changesTotal", "flagsTouched", "rulesTouched", "segmentsTouched", "scenarios", "validation", "note"]),
      annotations: RO,
      async run(args, ctx) {
        const p = await projectOf(args, ctx);
        let envKey = typeof args.environment === "string" ? args.environment : "";
        let only: Set<string> | null = Array.isArray(args.flags) ? new Set(args.flags as string[]) : null;
        if (typeof args.change === "string") {
          const c = await ctx.api.get<{ environment: string; flags: string[] }>(`${P(p)}/changes/${seg(args.change)}`);
          envKey = c.environment;
          only = new Set([...(only ?? []), ...c.flags]);
        }
        if (!envKey) throw inputError("Name the environment (or a change).");
        const e = seg(envKey);
        const env = await ctx.api.get<{ key: string; publishedRevision: number }>(`${P(p)}/environments/${e}`);
        const draft = await ctx.api.get<{ checksum: string; dirty: boolean; bundle: Record<string, unknown> }>(`${P(p)}/environments/${e}/draft`);
        let rows: DiffRow[];
        if (env.publishedRevision >= 1) {
          rows = (await ctx.api.get<{ changes: DiffRow[] }>(`${P(p)}/environments/${e}/revisions/${env.publishedRevision}/diff`, { to: "draft" })).changes;
        } else {
          rows = Object.keys(isObject(draft.bundle.flags) ? draft.bundle.flags : {}).map((k) => ({ flagKey: k, field: "flag", before: "—", after: "added" }));
        }
        if (only) rows = rows.filter((r) => only!.has(r.flagKey) || r.flagKey.startsWith("segment:"));
        const flagsTouched = [...new Set(rows.filter((r) => !r.flagKey.startsWith("segment:")).map((r) => r.flagKey))];
        const segmentsTouched = [...new Set(rows.filter((r) => r.flagKey.startsWith("segment:")).map((r) => r.flagKey.slice(8)))];
        const rulesTouched = rows.filter((r) => /^rule \d+/.test(r.field)).map((r) => ({ flag: r.flagKey, rule: r.field }));
        // Scenario checks count only for runs on exactly this draft (configChecksum = draft checksum).
        const [scenarios, runs] = await Promise.all([
          ctx.api.get<{ data: { id: string; name: string; flag: string }[] }>(`${P(p)}/scenarios`, { limit: 100 }),
          ctx.api.get<{ data: Run[] }>(`${P(p)}/scenario-runs`, { environment: envKey, limit: 100 }),
        ]);
        const inScope = scenarios.data.filter((s) => !only || only.has(s.flag));
        const latest = new Map<string, boolean>();
        for (const r of runs.data) if (r.configChecksum === draft.checksum && !latest.has(r.scenarioId)) latest.set(r.scenarioId, r.passed);
        const passed = inScope.filter((s) => latest.get(s.id) === true).length;
        const failing = inScope.filter((s) => latest.get(s.id) === false).map((s) => s.name);
        const issues = validateBundle(draft.bundle, only);
        const limited = capList(rows, typeof args.limit === "number" ? args.limit : 100);
        const data = {
          environment: env.key, publishedRevision: env.publishedRevision, draftChecksum: draft.checksum, hasChanges: rows.length > 0,
          changes: limited.items, changesTotal: rows.length, flagsTouched, rulesTouched, segmentsTouched,
          scenarios: { total: inScope.length, passed, failed: failing.length, notRun: inScope.length - passed - failing.length, failing: failing.slice(0, 50) },
          validation: { ok: issues.length === 0, issues: issues.slice(0, 50) },
          note: "Configuration differences only; this preview does not estimate how many users or requests a change affects.",
        };
        const lines = [
          rows.length ? `Publishing the ${env.key} draft would change ${rows.length} field(s) against r${env.publishedRevision}:` : `The ${env.key} draft matches r${env.publishedRevision}${only ? " for these flags" : ""}: nothing to publish.`,
          ...limited.items.map((r) => `- ${r.flagKey} ${r.field}: ${r.before} → ${r.after}`),
          ...(limited.truncated ? [`(${rows.length - limited.items.length} more rows; raise limit)`] : []),
          `Scenario checks on this draft: ${passed} passed, ${failing.length} failed, ${data.scenarios.notRun} not run (of ${inScope.length}).`,
          issues.length ? `Validation: ${issues.length} problem(s): ${issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join("; ")}` : "Validation: no problems found.",
          data.note,
        ];
        return { text: lines.join("\n"), data };
      },
    },
    {
      name: "find_stale_flags",
      title: "Find stale flags",
      description: "List the flags NanoFlags suggests cleaning up, with the reasons: review date passed, one value everywhere for 14+ days, not referenced in linked repositories, or fully on for 30+ days. Permanent and archived flags are not listed.",
      inputSchema: obj({ project, limit: limitArg(100, 50, "flags"), cursor: cursorArg }),
      outputSchema: out({
        data: arr({ type: "object", properties: { key: S, name: S, reasons: arr(S), reviewDate: nullable("string"), ownerName: nullable("string") }, required: ["key", "reasons"] }),
        nextCursor: nullable("string"), total: N,
      }, ["data", "nextCursor", "total"]),
      annotations: RO,
      async run(args, ctx) {
        const p = await projectOf(args, ctx);
        const offset = readOffsetCursor(`stale:${p}`, args.cursor);
        if (offset === null) throw inputError("`cursor` is not a cursor of this list.");
        const r = await ctx.api.get<{ data: { key: string; name: string; reasons: string[]; reviewDate: string | null; ownerName: string | null }[] }>(`${P(p)}/stale-flags`);
        const page = pageOf(`stale:${p}`, r.data, offset, typeof args.limit === "number" ? args.limit : 50);
        const lines = page.items.map((f) => `- ${f.key}: ${f.reasons.join(", ")}${f.ownerName ? ` (owner ${f.ownerName})` : ""}`);
        return {
          text: `${page.total} cleanup candidate(s) in ${p}${page.items.length < page.total ? `, showing ${page.items.length}` : ""}:\n${lines.join("\n") || "(none)"}${page.nextCursor ? `\nMore: cursor=${page.nextCursor}` : ""}`,
          data: { data: page.items, nextCursor: page.nextCursor, total: page.total },
        };
      },
    },
    {
      name: "get_removal_readiness",
      title: "Check if a flag can be removed",
      description: "Assess whether a flag can be removed from code and archived: safe, caution or blocked, with the evidence (purpose and permanence, recent sampled evaluations per environment, code references, published values, cleanup reasons). Permanent flags are blocked; operational and permission flags are long-lived by purpose and get caution. It reads only; archiving is done by a person.",
      inputSchema: obj({ project, flag: { ...KEY, description: "Flag key." } }, ["flag"]),
      outputSchema: out({
        flag: S, verdict: { type: "string", enum: ["safe", "caution", "blocked"] },
        reasons: arr({ type: "object", properties: { level: { type: "string", enum: ["blocked", "caution", "info"] }, code: S, message: S }, required: ["level", "code", "message"] }),
        evidence: { type: "object" },
      }, ["flag", "verdict", "reasons", "evidence"]),
      annotations: RO,
      async run(args, ctx) {
        const p = await projectOf(args, ctx);
        const flag = String(args.flag);
        const def = await ctx.api.get<{ key: string; type: string; purpose: string; permanent: boolean; archivedAt: string | null }>(`${P(p)}/flags/${seg(flag)}`);
        const envs = (await ctx.api.get<{ data: { key: string }[] }>(`${P(p)}/environments`)).data.slice(0, 20);
        const now = Date.now();
        const perEnv = await Promise.all(envs.map(async (e) => {
          const c = await ctx.api.get<{ published: Record<string, unknown> | null; draft: { rules: unknown[] } }>(`${P(p)}/flags/${seg(flag)}/environments/${seg(e.key)}`);
          let usage: { events: number; lastSeenAt: string | null } | null = null;
          try {
            const i = await ctx.api.get<{ totals?: { events?: number }; seen?: { lastSeenAt?: string | null } }>(`${P(p)}/flags/${seg(flag)}/insights`, { environment: e.key, window: "30d" });
            usage = { events: i.totals?.events ?? 0, lastSeenAt: i.seen?.lastSeenAt ?? null };
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
          }
          const pub = c.published;
          return {
            environment: e.key, published: pub !== null,
            servesWhenPublished: pub ? (pub.enabled ? (Array.isArray(pub.rules) && pub.rules.length ? "targeted" : JSON.stringify(pub.default)) : JSON.stringify(pub.off)) : null,
            events30d: usage ? usage.events : null, lastSeenAt: usage ? usage.lastSeenAt : null,
          };
        }));
        let refs: { total: number; repositories: string[]; lastScannedAt: string | null } | null = null;
        try {
          refs = await ctx.api.get(`${P(p)}/flags/${seg(flag)}/code-refs`, { limit: 1 });
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
        }
        let stale: string[] = [];
        try {
          stale = (await ctx.api.get<{ data: { key: string; reasons: string[] }[] }>(`${P(p)}/stale-flags`)).data.find((s) => s.key === flag)?.reasons ?? [];
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
        }
        const reasons: { level: "blocked" | "caution" | "info"; code: string; message: string }[] = [];
        if (def.permanent) reasons.push({ level: "blocked", code: "permanent", message: "Marked permanent: it is meant to stay." });
        if (def.purpose === "operational" || def.purpose === "permission") reasons.push({ level: "caution", code: `purpose_${def.purpose}`, message: `Purpose ${def.purpose}: such switches are usually long-lived; confirm with the owner that it is no longer needed.` });
        const day = perEnv.filter((x) => x.lastSeenAt && now - Date.parse(x.lastSeenAt) < 86_400_000).map((x) => x.environment);
        const month = perEnv.filter((x) => (x.events30d ?? 0) > 0).map((x) => x.environment);
        if (day.length) reasons.push({ level: "blocked", code: "evaluated_recently", message: `Evaluated in the last 24 hours in ${day.join(", ")}: code still reads it.` });
        else if (month.length) reasons.push({ level: "caution", code: "evaluated_30d", message: `Sampled evaluations in the last 30 days in ${month.join(", ")}.` });
        if (perEnv.some((x) => x.events30d === null)) reasons.push({ level: "caution", code: "usage_unknown", message: `Usage insights unavailable for ${perEnv.filter((x) => x.events30d === null).map((x) => x.environment).join(", ")}.` });
        if (refs && refs.total > 0) reasons.push({ level: "blocked", code: "code_references", message: `${refs.total} code reference(s) in ${refs.repositories.join(", ")}: remove them from code first.` });
        else if (!refs || !refs.lastScannedAt) reasons.push({ level: "caution", code: "no_code_scan", message: "No code-reference scan found: references in code are not known." });
        const values = new Set(perEnv.filter((x) => x.published).map((x) => x.servesWhenPublished));
        if (values.size > 1 || values.has("targeted")) reasons.push({ level: "caution", code: "values_differ", message: "Environments serve different values or targeted rules: decide which value the code keeps." });
        if (stale.length) reasons.push({ level: "info", code: "stale", message: `Cleanup candidate: ${stale.join(", ")}.` });
        if (def.archivedAt) reasons.push({ level: "info", code: "archived", message: "Already archived." });
        const verdict = reasons.some((r) => r.level === "blocked") ? "blocked" : reasons.some((r) => r.level === "caution") ? "caution" : "safe";
        const evidence = { purpose: def.purpose, permanent: def.permanent, archived: def.archivedAt !== null, environments: perEnv, codeRefs: refs, staleReasons: stale };
        const text = [`${flag}: ${verdict}.`, ...reasons.map((r) => `- [${r.level}] ${r.message}`), ...(reasons.length ? [] : ["- No evaluations in 30 days, no code references, one value everywhere."])].join("\n");
        return { text, data: { flag, verdict, reasons, evidence } };
      },
    },
    {
      name: "get_effective_policy",
      title: "Get the effective policy",
      description: "What this connection may do: the environment's publishing policy (approvals, approvers, scenario checks, protection), whether work proposed by an agent needs an independent approval on this plan, the token's grants and the operations left to it, and what only a person can do.",
      inputSchema: obj({ project, environment }),
      outputSchema: out({
        token: { type: "object" }, role: S, environment: { type: ["object", "null"] }, approvalsOnPlan: B, agentWorkNeedsApproval: B,
        grants: { type: ["array", "null"] }, hasGrants: B, allowedOperations: { type: ["array", "null"], items: S }, personOnly: { type: ["array", "null"], items: S },
      }, ["token", "role", "environment", "approvalsOnPlan", "agentWorkNeedsApproval", "hasGrants"]),
      annotations: RO,
      async run(args, ctx) {
        const p = await projectOf(args, ctx);
        const r = await ctx.api.get<Record<string, any>>(`${P(p)}/agent-policy`, { environment: args.environment as string | undefined });
        const e = r.environment as Record<string, unknown> | null;
        const lines = [
          `Token: ${r.token?.kind === "agent" ? `AI agent "${r.token.agentLabel}"` : "standard"}, acting as a ${r.role}${r.token?.projectKey ? `, limited to ${r.token.projectKey}` : ""}.`,
          e ? `${e.key}: ${e.requireApproval ? `approval required (${e.requiredApprovers})` : "no approval required"}${e.requireScenarios ? ", scenario checks required" : ""}${e.isProtected ? ", protected" : ""}; published r${e.publishedRevision}.` : "No environment given: pass `environment` for its publishing policy.",
          r.agentWorkNeedsApproval ? "Work proposed by this agent needs an independent approval by a person other than the token's owner before it is published." : r.token?.kind === "agent" ? "This plan has no approvals: a person reviews and publishes the draft in the dashboard." : "",
          r.hasGrants ? `Grants narrow this token: ${(r.grants as { environment: string | null; actions: string[] | null }[]).map((g) => `${g.environment ?? "any environment"}: ${g.actions ? g.actions.join(", ") : "all agent operations"}`).join("; ")}.` : "",
          Array.isArray(r.allowedOperations) ? `Allowed here: ${r.allowedOperations.join(", ")}.` : "",
          Array.isArray(r.personOnly) ? `Only a person can: ${r.personOnly.join(", ")}.` : "",
        ].filter(Boolean);
        return { text: lines.join("\n"), data: r };
      },
    },
    {
      name: "get_flag_usage",
      title: "Get flag usage",
      description: "Sampled usage of one flag in one environment: sampled evaluation events over a window, served values, deciding rules, the services and SDK versions that evaluate it, and when it was first and last seen. Counts are sampled events, not evaluations.",
      inputSchema: obj({
        project, flag: { ...KEY, description: "Flag key." },
        environment: { type: "string", description: "Environment key (default: the project's default environment)." },
        window: { type: "string", enum: ["1h", "24h", "7d", "30d"], description: "Window (default 24h)." },
        limit: limitArg(50, 10, "services, served values, rules and publishes (each)"),
      }, ["flag"]),
      outputSchema: out({
        environment: S, flag: S, window: S, totals: { type: "object" }, series: arr(), variations: arr(), rules: arr(), services: arr(), publishes: arr(),
        seen: { type: "object" }, listsTruncated: { type: "object" },
      }, ["environment", "flag", "window", "totals"]),
      annotations: RO,
      async run(args, ctx) {
        const p = await projectOf(args, ctx);
        const i = await ctx.api.get<Record<string, unknown>>(`${P(p)}/flags/${seg(String(args.flag))}/insights`, { environment: args.environment as string | undefined, window: (args.window as string | undefined) ?? "24h" });
        const n = typeof args.limit === "number" ? args.limit : 10;
        const b = boundInsights(i, n);
        const totals = isObject(i.totals) ? i.totals : {};
        const seen = isObject(i.seen) ? i.seen : {};
        const services = (b.insights.services as { service: string; sdk: string; events: number }[] | undefined) ?? [];
        const lines = [
          `${args.flag} in ${String(i.environment)} (${String(i.window)}): ${String(totals.events ?? 0)} sampled event(s)${typeof totals.weighted === "number" && totals.weighted > 0 ? `, about ${Math.round(totals.weighted)} evaluations where the sample rate is known` : ""}.`,
          `Last seen: ${seen.lastSeenAt ?? "never"}.`,
          services.length ? `Evaluated by: ${services.map((s) => `${s.service} (${s.sdk}, ${s.events})`).join(", ")}.` : "No service evaluated it in this window.",
          ...(Object.keys(b.cut).length ? [`Lists shortened to ${n}: ${Object.entries(b.cut).map(([k, t]) => `${k} (${t} in total)`).join(", ")}.`] : []),
        ];
        return { text: lines.join("\n"), data: b.insights };
      },
    },
  ];
}
