/**
 * NanoFlags evaluation engine.
 *
 * Pure, deterministic and dependency-free. The same bundle + flag key + context always
 * produces the same result in the dashboard, the Worker, the SDKs and CI.
 * Rules are data (JSON); no user code is ever executed during evaluation.
 */

export const ENGINE_VERSION = 1;

export type FlagType = "boolean" | "string" | "number" | "json";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type Operator =
  | "eq" | "neq" | "in" | "not_in"
  | "contains" | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "exists" | "not_exists"
  | "segment" | "not_segment";

export interface Condition {
  /** Context attribute name, e.g. "region". Ignored for segment operators. */
  attribute: string;
  op: Operator;
  /** Comparison value. Array for in/not_in; segment key for segment operators. */
  value?: JsonValue;
}

export type Serve =
  | { type: "fixed"; value: JsonValue }
  | {
      type: "rollout";
      /** 0–100, up to two decimals. */
      percentage: number;
      /** Value for contexts inside the allocation. */
      value: JsonValue;
      /** Value for matching contexts outside the allocation. */
      otherwise: JsonValue;
      /** Context attribute used for bucketing. Defaults to "key". */
      bucketBy?: string;
      /** Documented seed. Defaults to the flag key, so allocations are independent per flag. */
      seed?: string;
    };

export interface Rule {
  id: string;
  description?: string;
  match: "all" | "any";
  conditions: Condition[];
  serve: Serve;
}

export interface FlagConfig {
  type: FlagType;
  /** When false the flag short-circuits to `off`. */
  enabled: boolean;
  rules: Rule[];
  /** Served when the flag is enabled and no rule matches. */
  default: JsonValue;
  /** Served when the flag is disabled. */
  off: JsonValue;
  /** Only client-exposed flags are included in bundles served to browser keys. */
  clientExposed?: boolean;
}

export interface Segment {
  match: "all" | "any";
  conditions: Condition[];
}

export interface Bundle {
  schema: 1;
  /**
   * Engine version the bundle was produced for (`ENGINE_VERSION` of the publisher). Absent in bundles from before it
   * existed (treated as 1). SDKs refuse a bundle whose `engine` is newer than the engine they ship.
   */
  engine?: number;
  project: string;
  environment: string;
  /** Published revision number. 0 means "draft / never published". */
  revision: number;
  flags: Record<string, FlagConfig>;
  segments: Record<string, Segment>;
}

/** Attributes supplied by the application. `key` is the stable identity used for bucketing. */
export type Context = { key?: string } & Record<string, JsonValue | undefined>;

export type Reason = "rule_match" | "default" | "off" | "flag_not_found" | "error";

export interface TraceStep {
  kind: "config" | "rule" | "allocation" | "result";
  title: string;
  detail: string;
  matched?: boolean;
}

export interface Evaluation<T = JsonValue> {
  flagKey: string;
  value: T;
  reason: Reason;
  /** Zero-based index of the matching rule. */
  ruleIndex?: number;
  ruleId?: string;
  /** For rollout rules: whether the context fell inside the allocation, and its bucket (0–99.99). */
  inRollout?: boolean;
  bucket?: number;
  revision: number;
  trace: TraceStep[];
  error?: string;
}

/* ---------------- hashing ---------------- */

const encoder = new TextEncoder();

/** MurmurHash3 x86 32-bit over UTF-8 bytes. Used for distribution only — never for security. */
export function murmur3(input: string, seed = 0): number {
  const data = encoder.encode(input.normalize("NFC"));
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = data.length >> 2;
  for (let i = 0; i < blocks; i++) {
    const o = i * 4;
    let k = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = blocks * 4;
  switch (data.length & 3) {
    case 3:
      k ^= data[tail + 2]! << 16;
    // falls through
    case 2:
      k ^= data[tail + 1]! << 8;
    // falls through
    case 1:
      k ^= data[tail]!;
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Bucket in [0, 100) with two decimals of resolution. Stable for a given seed + identity. */
export function bucketOf(seed: string, identity: string): number {
  return (murmur3(`${seed}:${identity}`) % 10000) / 100;
}

/* ---------------- conditions ---------------- */

/** Own-property lookup, so keys such as "constructor" or "__proto__" never resolve to Object.prototype members. */
function own<T>(obj: Record<string, T> | null | undefined, key: string): T | undefined {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function looseEq(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function num(v: JsonValue | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function matchCondition(c: Condition, ctx: Context, segments: Record<string, Segment>, depth = 0): boolean {
  if (c.op === "segment" || c.op === "not_segment") {
    const seg = typeof c.value === "string" ? own(segments, c.value) : undefined;
    // An unknown segment never matches; depth guard prevents accidental cycles.
    const inSeg = seg !== undefined && depth < 4 && matchAll(seg.match, seg.conditions, ctx, segments, depth + 1);
    return c.op === "segment" ? inSeg : seg !== undefined && !inSeg;
  }
  const actual = own(ctx, c.attribute);
  switch (c.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "eq":
      return looseEq(actual, c.value);
    case "neq":
      return actual !== undefined && !looseEq(actual, c.value);
    case "in":
      return Array.isArray(c.value) && c.value.some((v) => looseEq(actual, v));
    case "not_in":
      return actual !== undefined && Array.isArray(c.value) && !c.value.some((v) => looseEq(actual, v));
    case "contains":
      return typeof actual === "string" && typeof c.value === "string" && actual.includes(c.value);
    case "starts_with":
      return typeof actual === "string" && typeof c.value === "string" && actual.startsWith(c.value);
    case "ends_with":
      return typeof actual === "string" && typeof c.value === "string" && actual.endsWith(c.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = num(actual);
      const b = num(c.value);
      if (a === null || b === null) return false;
      return c.op === "gt" ? a > b : c.op === "gte" ? a >= b : c.op === "lt" ? a < b : a <= b;
    }
    default:
      return false;
  }
}

function matchAll(mode: "all" | "any", conditions: Condition[], ctx: Context, segments: Record<string, Segment>, depth = 0): boolean {
  if (conditions.length === 0) return true;
  return mode === "any"
    ? conditions.some((c) => matchCondition(c, ctx, segments, depth))
    : conditions.every((c) => matchCondition(c, ctx, segments, depth));
}

export function matchSegment(segment: Segment, ctx: Context, segments: Record<string, Segment> = {}): boolean {
  return matchAll(segment.match, segment.conditions, ctx, segments, 1);
}

export function describeCondition(c: Condition): string {
  const v = Array.isArray(c.value) ? c.value.join(", ") : c.value === undefined ? "" : String(c.value);
  const words: Record<Operator, string> = {
    eq: "=", neq: "≠", in: "in", not_in: "not in", contains: "contains", starts_with: "starts with", ends_with: "ends with",
    gt: ">", gte: "≥", lt: "<", lte: "≤", exists: "exists", not_exists: "does not exist", segment: "in segment", not_segment: "not in segment",
  };
  if (c.op === "segment" || c.op === "not_segment") return `${words[c.op]} ${v}`;
  if (c.op === "exists" || c.op === "not_exists") return `${c.attribute} ${words[c.op]}`;
  return `${c.attribute} ${words[c.op]} ${v}`;
}

/* ---------------- evaluation ---------------- */

/**
 * Evaluate one flag. Never throws: on any problem it returns `fallback` with reason
 * "flag_not_found" or "error", so callers always have an explicit default.
 */
export function evaluate<T extends JsonValue = JsonValue>(bundle: Bundle | null | undefined, flagKey: string, ctx: Context, fallback: T): Evaluation<T> {
  const revision = bundle?.revision ?? 0;
  const trace: TraceStep[] = [];
  try {
    const flag = own(bundle?.flags, flagKey);
    if (!bundle || !flag) {
      trace.push({ kind: "result", title: `Returned ${fmt(fallback)}`, detail: bundle ? "Flag is not in this configuration. The application fallback applies." : "No configuration is loaded. The application fallback applies." });
      return { flagKey, value: fallback, reason: "flag_not_found", revision, trace };
    }
    trace.push({ kind: "config", title: "Configuration loaded", detail: revision > 0 ? `r${revision}` : "draft" });
    if (!flag.enabled) {
      trace.push({ kind: "result", title: `Returned ${fmt(flag.off)}`, detail: "Flag is disabled in this environment." });
      return { flagKey, value: flag.off as T, reason: "off", revision, trace };
    }
    for (let i = 0; i < flag.rules.length; i++) {
      const rule = flag.rules[i]!;
      const matched = matchAll(rule.match, rule.conditions, ctx, bundle.segments);
      const label = `Rule ${String(i + 1).padStart(2, "0")}`;
      const summary = rule.conditions.length ? rule.conditions.map(describeCondition).join(rule.match === "any" ? " OR " : " AND ") : "all contexts";
      trace.push({ kind: "rule", title: matched ? `${label} matched` : `${label} did not match`, detail: summary, matched });
      if (!matched) continue;
      if (rule.serve.type === "fixed") {
        trace.push({ kind: "result", title: `Returned ${fmt(rule.serve.value)}`, detail: `${label} serves a fixed value.` });
        return { flagKey, value: rule.serve.value as T, reason: "rule_match", ruleIndex: i, ruleId: rule.id, revision, trace };
      }
      const attr = rule.serve.bucketBy ?? "key";
      const identity = own(ctx, attr);
      if (identity === undefined || identity === null || identity === "") {
        trace.push({ kind: "allocation", title: "Allocation skipped", detail: `Context has no "${attr}" to bucket by; treated as outside the allocation.`, matched: false });
        trace.push({ kind: "result", title: `Returned ${fmt(rule.serve.otherwise)}`, detail: "Remaining eligible users." });
        return { flagKey, value: rule.serve.otherwise as T, reason: "rule_match", ruleIndex: i, ruleId: rule.id, inRollout: false, revision, trace };
      }
      const bucket = bucketOf(rule.serve.seed ?? flagKey, String(identity));
      const inRollout = bucket < rule.serve.percentage;
      trace.push({ kind: "allocation", title: "Allocation evaluated", detail: `${rule.serve.percentage}% rollout · ${attr} ${inRollout ? "inside" : "outside"} allocation (bucket ${bucket.toFixed(2)})`, matched: inRollout });
      const value = inRollout ? rule.serve.value : rule.serve.otherwise;
      trace.push({ kind: "result", title: `Returned ${fmt(value)}`, detail: inRollout ? `Inside the ${rule.serve.percentage}% allocation.` : "Remaining eligible users." });
      return { flagKey, value: value as T, reason: "rule_match", ruleIndex: i, ruleId: rule.id, inRollout, bucket, revision, trace };
    }
    trace.push({ kind: "result", title: `Returned ${fmt(flag.default)}`, detail: "No rule matched. The flag default applies." });
    return { flagKey, value: flag.default as T, reason: "default", revision, trace };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    trace.push({ kind: "result", title: `Returned ${fmt(fallback)}`, detail: `Evaluation error: ${error}. The application fallback applies.` });
    return { flagKey, value: fallback, reason: "error", revision, trace, error };
  }
}

export function fmt(v: JsonValue | undefined): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/* ---------------- validation ---------------- */

export function valueMatchesType(type: FlagType, v: unknown): boolean {
  if (type === "boolean") return typeof v === "boolean";
  if (type === "string") return typeof v === "string";
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return v !== undefined; // json: any JSON value
}

const OPS: Operator[] = ["eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "exists", "not_exists", "segment", "not_segment"];

/** Structural validation run before saving and before publishing. Returns human-readable problems. */
export function validateFlagConfig(flagKey: string, flag: FlagConfig, segments: Record<string, Segment> = {}): string[] {
  const problems: string[] = [];
  const check = (label: string, v: unknown) => {
    if (!valueMatchesType(flag.type, v)) problems.push(`${flagKey}: ${label} must be a ${flag.type} value.`);
  };
  check("default value", flag.default);
  check("off value", flag.off);
  flag.rules.forEach((r, i) => {
    const label = `rule ${String(i + 1).padStart(2, "0")}`;
    if (r.match !== "all" && r.match !== "any") problems.push(`${flagKey}: ${label} has an invalid match mode.`);
    r.conditions.forEach((c) => {
      if (!OPS.includes(c.op)) problems.push(`${flagKey}: ${label} uses unsupported operator "${c.op}".`);
      if ((c.op === "in" || c.op === "not_in") && !Array.isArray(c.value)) problems.push(`${flagKey}: ${label} needs a list for "${c.op}".`);
      if ((c.op === "segment" || c.op === "not_segment") && (typeof c.value !== "string" || !own(segments, c.value))) problems.push(`${flagKey}: ${label} references an unknown segment.`);
      if (c.op !== "segment" && c.op !== "not_segment" && !c.attribute) problems.push(`${flagKey}: ${label} has a condition without an attribute.`);
    });
    if (r.serve.type === "fixed") check(`${label} value`, r.serve.value);
    else {
      check(`${label} rollout value`, r.serve.value);
      check(`${label} remaining value`, r.serve.otherwise);
      if (!(r.serve.percentage >= 0 && r.serve.percentage <= 100)) problems.push(`${flagKey}: ${label} percentage must be between 0 and 100.`);
    }
  });
  return problems;
}

export function validateBundle(bundle: Bundle): string[] {
  return Object.entries(bundle.flags).flatMap(([k, f]) => validateFlagConfig(k, f, bundle.segments));
}

/* ---------------- diff ---------------- */

export interface DiffRow {
  flagKey: string;
  field: string;
  before: string;
  after: string;
}

function summarizeRule(r: Rule | undefined): string {
  if (!r) return "—";
  const when = r.conditions.length ? r.conditions.map(describeCondition).join(r.match === "any" ? " OR " : " AND ") : "all contexts";
  const then = r.serve.type === "fixed" ? fmt(r.serve.value) : `${r.serve.percentage}% → ${fmt(r.serve.value)}, else ${fmt(r.serve.otherwise)}`;
  return `${when} ⇒ ${then}`;
}

/** Field-level differences between two configurations, for review screens. */
export function diffBundles(before: Pick<Bundle, "flags" | "segments"> | null, after: Pick<Bundle, "flags" | "segments">): DiffRow[] {
  const rows: DiffRow[] = [];
  const keys = new Set([...Object.keys(before?.flags ?? {}), ...Object.keys(after.flags)]);
  for (const flagKey of [...keys].sort()) {
    const a = own(before?.flags, flagKey);
    const b = own(after.flags, flagKey);
    if (!a && b) { rows.push({ flagKey, field: "flag", before: "—", after: "added" }); continue; }
    if (a && !b) { rows.push({ flagKey, field: "flag", before: "present", after: "removed" }); continue; }
    if (!a || !b) continue;
    if (a.type !== b.type) rows.push({ flagKey, field: "type", before: a.type, after: b.type });
    if (Boolean(a.clientExposed) !== Boolean(b.clientExposed)) rows.push({ flagKey, field: "client exposed", before: String(Boolean(a.clientExposed)), after: String(Boolean(b.clientExposed)) });
    if (a.enabled !== b.enabled) rows.push({ flagKey, field: "enabled", before: String(a.enabled), after: String(b.enabled) });
    if (!looseEq(a.default, b.default)) rows.push({ flagKey, field: "default", before: fmt(a.default), after: fmt(b.default) });
    if (!looseEq(a.off, b.off)) rows.push({ flagKey, field: "off value", before: fmt(a.off), after: fmt(b.off) });
    const n = Math.max(a.rules.length, b.rules.length);
    for (let i = 0; i < n; i++) {
      const ra = a.rules[i];
      const rb = b.rules[i];
      if (JSON.stringify(ra) === JSON.stringify(rb)) continue;
      const label = `rule ${String(i + 1).padStart(2, "0")}`;
      if (ra && rb && ra.serve.type === "rollout" && rb.serve.type === "rollout" && JSON.stringify({ ...ra, serve: { ...ra.serve, percentage: 0 } }) === JSON.stringify({ ...rb, serve: { ...rb.serve, percentage: 0 } }) && ra.serve.percentage !== rb.serve.percentage) {
        rows.push({ flagKey, field: `${label} rollout`, before: `${ra.serve.percentage}%`, after: `${rb.serve.percentage}%` });
      } else {
        rows.push({ flagKey, field: label, before: summarizeRule(ra), after: summarizeRule(rb) });
      }
    }
  }
  const segKeys = new Set([...Object.keys(before?.segments ?? {}), ...Object.keys(after.segments)]);
  for (const k of [...segKeys].sort()) {
    const a = own(before?.segments, k);
    const b = own(after.segments, k);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      rows.push({ flagKey: `segment:${k}`, field: "conditions", before: a ? a.conditions.map(describeCondition).join(a.match === "any" ? " OR " : " AND ") : "—", after: b ? b.conditions.map(describeCondition).join(b.match === "any" ? " OR " : " AND ") : "removed" });
    }
  }
  return rows;
}

/**
 * Remove what must not reach browser keys: flags that are not client-exposed, and every segment that no client-exposed
 * flag references (directly or through other segments).
 */
export function clientBundle(bundle: Bundle): Bundle {
  const flags = Object.fromEntries(Object.entries(bundle.flags).filter(([, f]) => f.clientExposed === true));
  const pending: string[] = [];
  const refs = (conditions: Condition[] | undefined) => {
    for (const c of conditions ?? []) if ((c.op === "segment" || c.op === "not_segment") && typeof c.value === "string") pending.push(c.value);
  };
  for (const f of Object.values(flags)) for (const r of f.rules ?? []) refs(r.conditions);
  const needed = new Set<string>();
  while (pending.length > 0) {
    const k = pending.pop()!;
    const seg = own(bundle.segments, k);
    if (needed.has(k) || !seg) continue;
    needed.add(k);
    refs(seg.conditions);
  }
  const segments = Object.fromEntries(Object.entries(bundle.segments ?? {}).filter(([k]) => needed.has(k)));
  return { ...bundle, flags, segments };
}

/** True when this engine can evaluate `bundle` (its `engine` is absent or not newer than `ENGINE_VERSION`). */
export function supportsEngine(bundle: { engine?: unknown }): boolean {
  const e = bundle.engine;
  return e === undefined || (typeof e === "number" && Number.isInteger(e) && e >= 1 && e <= ENGINE_VERSION);
}
