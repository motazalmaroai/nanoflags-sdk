/**
 * The NanoFlags MCP tools: eight wrappers over the Management API, all on the PROPOSE side. There is deliberately no
 * tool to publish, approve, schedule, kill or change settings; an agent token could not do it anyway (the database
 * answers AGENT_FORBIDDEN), and offering the tool would only invite the attempt.
 */
import { ApiClient, ApiError, isObject, seg } from "./api.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolContext {
  api: ApiClient;
  /** NANOFLAGS_PROJECT, or the project of a project-scoped token. */
  defaultProject?: string;
  /** Lazily resolved project of the token (token.get), cached. */
  tokenProject?: () => Promise<string | null>;
  /** What to say when no project is known (the transport's own words). */
  projectHint?: string;
}

export interface ToolResult {
  text: string;
  data?: unknown;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolInputError extends Error {}

const KEY = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" };
const project = { type: "string", description: "Project key. Default: the project the connection or token is limited to (or NANOFLAGS_PROJECT for the local server)." };
const environment = { type: "string", description: "Environment key, e.g. development, staging, production." };
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

const GOVERNANCE =
  "Publishing, approving, scheduling and the kill switch are not available through this server; they are done by a person in the NanoFlags dashboard.";
/** A flag value: boolean, number, string or JSON, matching the flag's type. */
const VALUE: JsonSchema = { type: ["boolean", "number", "string", "object", "array"] };

/** Validates the subset of JSON Schema the tools use: object, required, additionalProperties false, type, enum, pattern, items, bounds. */
export function validate(schema: JsonSchema, value: unknown, path = "arguments"): string | null {
  const type = schema.type as string | string[] | undefined;
  const types = Array.isArray(type) ? type : type ? [type] : [];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.some((t) => t === kind || (t === "number" && kind === "integer"))) return `${path} must be ${types.join(" or ")}.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}.`;
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} must be at most ${schema.maxLength} characters.`;
    if (typeof schema.minLength === "number" && value.trim().length < schema.minLength) return `${path} must not be empty.`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} must have at most ${schema.maxItems} items.`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} must have at least ${schema.minItems} item(s).`;
    if (isObject(schema.items)) for (let i = 0; i < value.length; i++) { const e = validate(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
  }
  if (isObject(value) && isObject(schema.properties)) {
    const props = schema.properties as Record<string, JsonSchema>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (value[r] === undefined) return `${path}.${r} is required.`;
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((k) => !(k in props));
      if (extra.length) return `Unknown argument(s): ${extra.join(", ")}.`;
    }
    for (const [k, v] of Object.entries(value)) if (props[k] && v !== undefined) { const e = validate(props[k]!, v, `${path}.${k}`); if (e) return e; }
  }
  return null;
}

async function projectOf(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (typeof args.project === "string" && args.project) return args.project;
  if (ctx.defaultProject) return ctx.defaultProject;
  const p = ctx.tokenProject ? await ctx.tokenProject() : null;
  if (p) return p;
  throw new ToolInputError(ctx.projectHint ?? "Name the project: pass `project` (a project key) or set NANOFLAGS_PROJECT in the MCP server configuration.");
}

const P = (p: string) => `/projects/${seg(p)}`;
const j = (v: unknown) => JSON.stringify(v);

interface Env { key: string; name: string; requireApproval: boolean; requiredApprovers: number; isProtected: boolean; publishedRevision: number }
interface Config { flag: string; environment: string; draft: { enabled: boolean; rules: unknown[]; default: unknown; off: unknown; updatedAt?: string }; publishedRevision: number; published: Record<string, unknown> | null }
interface Change { id: string; environment: string; title: string; status: string; flags: string[]; approvals: { approverId: string | null; decision: string; createdAt: string }[]; openedByAgent?: { label: string } | null; publishedRevision: number | null; lifecycle?: { stage?: string } }

async function environments(ctx: ToolContext, p: string): Promise<Env[]> {
  const r = await ctx.api.get<{ data: Env[] }>(`${P(p)}/environments`);
  return r.data;
}

/** Whether the draft of one flag in one environment differs from what is published. */
function draftDiffers(c: Config): boolean {
  if (!c.published) return true;
  const pub = c.published;
  return j(pub.enabled) !== j(c.draft.enabled) || j(pub.rules ?? []) !== j(c.draft.rules) || j(pub.default) !== j(c.draft.default) || j(pub.off) !== j(c.draft.off);
}

function changeSummary(c: Change, base?: string): string {
  const approved = c.approvals.filter((a) => a.decision === "approved").length;
  const rejected = c.approvals.filter((a) => a.decision === "rejected").length;
  const lines = [
    `Change ${c.id} "${c.title}" in ${c.environment}: status ${c.status}${c.lifecycle?.stage && c.lifecycle.stage !== "open" ? ` (${c.lifecycle.stage})` : ""}.`,
    `Flags: ${c.flags.length ? c.flags.join(", ") : "none yet"}. Approvals: ${approved} approved, ${rejected} rejected.`,
  ];
  if (c.openedByAgent) lines.push(`Opened by AI agent "${c.openedByAgent.label}": it needs an independent approval by a person before it can be published (Team plan and above).`);
  if (c.status === "published" || c.publishedRevision) lines.push(`Published as revision ${c.publishedRevision}.`);
  else if (c.status === "approved") lines.push("Approved. A person can now publish it from the dashboard.");
  else if (c.status === "awaiting_approval") lines.push("Waiting for a person to review and approve it.");
  else if (c.status === "closed") lines.push("Closed without publishing.");
  else lines.push("Still a draft. Submit it (open_change_request does) so reviewers are notified.");
  if (base) lines.push(`Review: ${base}/app/changes/${c.id}`);
  return lines.join("\n");
}

const DASHBOARD = "https://nanoflags.io";

export const TOOLS: Tool[] = [
  {
    name: "list_environments",
    title: "List environments",
    description: "List the environments of a project with their publishing policy (approval required, approvers, protected) and published revision.",
    inputSchema: obj({ project }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const envs = await environments(ctx, p);
      const text = envs.map((e) => `- ${e.key} (${e.name}): r${e.publishedRevision}${e.requireApproval ? `, approval required (${e.requiredApprovers})` : ""}${e.isProtected ? ", protected" : ""}`).join("\n");
      return { text: `Environments of ${p}:\n${text || "(none)"}`, data: envs };
    },
  },
  {
    name: "list_flags",
    title: "List flags",
    description: "List the flags of a project (key, name, type, purpose). Use `cursor` from the previous answer for the next page.",
    inputSchema: obj({
      project,
      archived: { type: "string", enum: ["false", "true", "all"], description: "Archived flags: false (default), true or all." },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", maxLength: 500 },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const r = await ctx.api.get<{ data: { key: string; name: string; type: string; purpose: string; archivedAt: string | null }[]; nextCursor: string | null }>(`${P(p)}/flags`, {
        archived: args.archived as string | undefined, limit: args.limit as number | undefined, cursor: args.cursor as string | undefined,
      });
      const lines = r.data.map((f) => `- ${f.key} (${f.type}, ${f.purpose})${f.name && f.name !== f.key ? `: ${f.name}` : ""}${f.archivedAt ? " [archived]" : ""}`);
      return { text: `${r.data.length} flag(s) in ${p}:\n${lines.join("\n") || "(none)"}${r.nextCursor ? `\nMore: cursor=${r.nextCursor}` : ""}`, data: r };
    },
  },
  {
    name: "get_flag",
    title: "Get a flag",
    description: "A flag's definition and its draft configuration (enabled, targeting rules, default and off values) in one environment, or in every environment when `environment` is omitted.",
    inputSchema: obj({ project, flag: { ...KEY, description: "Flag key." }, environment }, ["flag"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const flag = String(args.flag);
      const def = await ctx.api.get<Record<string, unknown>>(`${P(p)}/flags/${seg(flag)}`);
      const envKeys = typeof args.environment === "string" ? [args.environment] : (await environments(ctx, p)).map((e) => e.key);
      const configs = await Promise.all(envKeys.map((e) => ctx.api.get<Config>(`${P(p)}/flags/${seg(flag)}/environments/${seg(e)}`)));
      const lines = configs.map((c) => `- ${c.environment}: ${c.draft.enabled ? "on" : "off"}, ${c.draft.rules.length} rule(s), default ${j(c.draft.default)}, off ${j(c.draft.off)}${draftDiffers(c) ? " (draft differs from published)" : ""}`);
      return { text: `${def.key} (${def.type}): ${def.name}\n${lines.join("\n")}`, data: { flag: def, configs } };
    },
  },
  {
    name: "create_flag",
    title: "Create a flag",
    description: `Create a flag. It starts off in every environment's draft; nothing is served until a person publishes. ${GOVERNANCE}`,
    inputSchema: obj(
      {
        project,
        key: { ...KEY, description: "Flag key: lowercase letters, digits, hyphens, underscores (max 63)." },
        name: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 2000 },
        type: { type: "string", enum: ["boolean", "string", "number", "json"], description: "Default boolean." },
        initialValue: { ...VALUE, description: "Value served before any rule (required for non-boolean flags)." },
        purpose: { type: "string", enum: ["release", "experiment", "operational", "permission"] },
      },
      ["key"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      if ((args.type ?? "boolean") !== "boolean" && args.initialValue === undefined) throw new ToolInputError("`initialValue` is required for non-boolean flags.");
      const body: Record<string, unknown> = { key: args.key };
      for (const k of ["name", "description", "type", "initialValue", "purpose"]) if (args[k] !== undefined) body[k] = args[k];
      const f = await ctx.api.post<Record<string, unknown>>(`${P(p)}/flags`, body);
      return { text: `Created flag ${f.key} (${f.type}) in ${p}. It is off in every draft. Next: update_draft to target it, then open_change_request so a person can approve and publish.`, data: f };
    },
  },
  {
    name: "update_draft",
    title: "Edit a flag's draft",
    description: `Edit a flag's draft configuration in one environment: on/off, targeting rules, default value (the variation served when no rule matches) and off value. Only the fields you send change. The draft is not live until a person publishes it. ${GOVERNANCE}`,
    inputSchema: obj(
      {
        project,
        flag: { ...KEY, description: "Flag key." },
        environment,
        enabled: { type: "boolean" },
        rules: { type: "array", maxItems: 200, items: { type: "object" }, description: 'Targeting rules, replacing the current list: [{ id, conditions: [{ attribute, op, value }], serve: { type: "fixed", value } | { type: "rollout", percentage, value, otherwise } }]. op is one of eq, neq, in, not_in (value: list), contains, starts_with, ends_with, gt, gte, lt, lte (numbers only: "4.10" is 4.1), semver_eq, semver_neq, semver_gt, semver_gte, semver_lt, semver_lte (versions such as "4.10.0"; use these for app versions), before, after (dates "2026-12-31", timestamps "2026-12-31T09:00:00Z", or Unix seconds/milliseconds), exists, not_exists, segment, not_segment (value: segment key, attribute "").' },
        default: { ...VALUE, description: "Value served when the flag is on and no rule matches." },
        off: { ...VALUE, description: "Value served when the flag is off." },
      },
      ["flag", "environment"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const body: Record<string, unknown> = {};
      for (const k of ["enabled", "rules", "default", "off"]) if (args[k] !== undefined) body[k] = args[k];
      if (!Object.keys(body).length) throw new ToolInputError("Send at least one of enabled, rules, default, off.");
      const c = await ctx.api.patch<Config>(`${P(p)}/flags/${seg(String(args.flag))}/environments/${seg(String(args.environment))}`, body);
      return {
        text: `Saved the ${c.environment} draft of ${c.flag}: ${c.draft.enabled ? "on" : "off"}, ${c.draft.rules.length} rule(s), default ${j(c.draft.default)}. Not live yet: open_change_request so a person can approve and publish it.`,
        data: c,
      };
    },
  },
  {
    name: "open_change_request",
    title: "Open a change request",
    description: `Open a change request for flags edited in one environment's draft and submit it for review. A person approves it and publishes it in the dashboard; changes opened by an agent always need an independent human approval. ${GOVERNANCE}`,
    inputSchema: obj(
      {
        project,
        environment,
        title: { type: "string", minLength: 1, maxLength: 140 },
        reason: { type: "string", maxLength: 2000, description: "Why: what it does and how to verify it. Reviewers read this." },
        codeRef: { type: "string", maxLength: 200, description: "Pull request, commit or branch this change belongs to." },
        flags: { type: "array", minItems: 1, maxItems: 200, items: KEY, description: "Flag keys included in the change." },
        submit: { type: "boolean", description: "Request approval right away (default true)." },
      },
      ["environment", "title", "flags"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const body: Record<string, unknown> = { environment: args.environment, title: String(args.title).trim(), flags: args.flags };
      if (args.reason !== undefined) body.reason = args.reason;
      if (args.codeRef !== undefined) body.codeRef = args.codeRef;
      let c = await ctx.api.post<Change>(`${P(p)}/changes`, body);
      if (args.submit !== false) {
        await ctx.api.post(`${P(p)}/changes/${seg(c.id)}/submit`, {});
        c = await ctx.api.get<Change>(`${P(p)}/changes/${seg(c.id)}`);
      }
      return { text: `${changeSummary(c, DASHBOARD)}\nUse get_change_status to follow it.`, data: c };
    },
  },
  {
    name: "get_change_status",
    title: "Get a change's status",
    description: "Status of a change request: draft, awaiting approval, approved, published or closed, with its approvals and whether an agent opened it.",
    inputSchema: obj({ project, change: { type: "string", pattern: "^[0-9a-fA-F-]{36}$", description: "Change id." } }, ["change"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const c = await ctx.api.get<Change>(`${P(p)}/changes/${seg(String(args.change))}`);
      return { text: changeSummary(c, DASHBOARD), data: c };
    },
  },
  {
    name: "explain_flag",
    title: "Explain a flag",
    description: "Explain a flag before changing it: what it is, its draft and published state in every environment, and where it is evaluated (services, SDKs, served values and deciding rules from usage insights).",
    inputSchema: obj({
      project,
      flag: { ...KEY, description: "Flag key." },
      environment: { type: "string", description: "Environment for usage insights (default: the project's default environment)." },
      window: { type: "string", enum: ["1h", "24h", "7d", "30d"], description: "Usage window (default 24h)." },
    }, ["flag"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, ctx) {
      const p = await projectOf(args, ctx);
      const flag = String(args.flag);
      const [def, envs] = await Promise.all([ctx.api.get<Record<string, unknown>>(`${P(p)}/flags/${seg(flag)}`), environments(ctx, p)]);
      const configs = await Promise.all(envs.map((e) => ctx.api.get<Config>(`${P(p)}/flags/${seg(flag)}/environments/${seg(e.key)}`)));
      let insights: Record<string, unknown> | null = null;
      let insightsNote = "";
      try {
        insights = await ctx.api.get<Record<string, unknown>>(`${P(p)}/flags/${seg(flag)}/insights`, { environment: args.environment as string | undefined, window: (args.window as string | undefined) ?? "24h" });
      } catch (e) {
        insightsNote = e instanceof ApiError ? `Usage insights unavailable (${e.code}: ${e.message})` : "Usage insights unavailable.";
      }
      const lines = [`${def.key} (${def.type}, ${def.purpose}${def.permanent ? ", permanent" : ""}): ${def.name}${def.description ? ` — ${def.description}` : ""}${def.archivedAt ? " [archived]" : ""}`];
      for (const c of configs) {
        const pub = c.published;
        const live = pub ? `${pub.enabled ? "on" : "off"}, ${Array.isArray(pub.rules) ? pub.rules.length : 0} rule(s), default ${j(pub.default)}` : "not published yet";
        lines.push(`- ${c.environment} (r${c.publishedRevision}): live ${live}${draftDiffers(c) ? `; draft: ${c.draft.enabled ? "on" : "off"}, ${c.draft.rules.length} rule(s), default ${j(c.draft.default)} (unpublished)` : ""}`);
      }
      if (insights) {
        const totals = isObject(insights.totals) ? insights.totals : {};
        const services = Array.isArray(insights.services) ? (insights.services as { service: string; sdk: string; events: number }[]) : [];
        const variations = Array.isArray(insights.variations) ? (insights.variations as { value: unknown; events: number }[]) : [];
        lines.push(`Usage in ${insights.environment} (${insights.window}): ${totals.events ?? 0} sampled evaluation event(s).`);
        lines.push(services.length ? `Evaluated by: ${services.map((s) => `${s.service} (${s.sdk}, ${s.events})`).join(", ")}.` : "No service evaluated it in this window.");
        if (variations.length) lines.push(`Served: ${variations.map((v) => `${j(v.value)} ×${v.events}`).join(", ")}.`);
      } else if (insightsNote) lines.push(insightsNote);
      return { text: lines.join("\n"), data: { flag: def, configs, insights } };
    },
  },
];

if (TOOLS.length > 8) throw new Error("The NanoFlags MCP server offers at most 8 tools.");
