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
  | "semver_eq" | "semver_neq" | "semver_gt" | "semver_gte" | "semver_lt" | "semver_lte"
  | "before" | "after"
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
  /** The experiment running on this flag in this environment, if any (see `exposureOf`). */
  experiment?: ExperimentMeta;
}

/**
 * Experiment metadata carried by a flag while an experiment runs on it. SDKs use it to log exposures; evaluation itself
 * never reads it, so a bundle evaluates identically with or without it.
 */
export interface ExperimentMeta {
  /** Experiment id (UUID). Exposures name it. */
  id: string;
  /** Human-readable experiment key (for logs only). */
  key: string;
  /** Only evaluations decided by this rule count as exposures (both sides of its rollout). */
  ruleId: string;
  /** Context attribute identifying the unit of randomisation. Default "key" (the rule's `bucketBy`). */
  unit?: string;
  /** Share of the rule's units enrolled in the experiment, 0–100. Default 100. */
  traffic?: number;
  /** Seed of the enrollment hash; independent of the rollout seed so enrollment does not correlate with the variant. */
  seed: string;
  /** Variant keys and the flag values that identify them. The first variant is the control. */
  variants: { key: string; value: JsonValue }[];
}

/** One unit's exposure to an experiment. `unit` is the raw identity: SDKs must hash it before it leaves the process. */
export interface Exposure {
  experiment: string;
  variant: string;
  unit: string;
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

/* ---------------- experiments ---------------- */

/**
 * The exposure an evaluation represents, or null. An evaluation is an exposure when the flag carries experiment
 * metadata, the experiment's rule decided it, the unit attribute is present, the unit falls inside the experiment's
 * traffic (`bucketOf(seed, unit) < traffic`) and the served value is one of the variants. Deterministic: the same flag,
 * context and value always give the same answer, so SDKs only have to de-duplicate repeated exposures.
 */
export function exposureOf(flag: FlagConfig | undefined, evaluation: Pick<Evaluation, "reason" | "ruleId" | "value">, ctx: Context): Exposure | null {
  const x = flag?.experiment;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !Array.isArray(x.variants)) return null;
  if (evaluation.reason !== "rule_match" || evaluation.ruleId !== x.ruleId) return null;
  const identity = own(ctx, x.unit ?? "key");
  if (identity === undefined || identity === null || identity === "" || typeof identity === "object" || typeof identity === "boolean") return null;
  const unit = String(identity);
  const traffic = typeof x.traffic === "number" ? x.traffic : 100;
  if (traffic < 100 && !(bucketOf(x.seed, unit) < traffic)) return null;
  for (const v of x.variants) {
    if (v && typeof v.key === "string" && looseEq(v.value, evaluation.value as JsonValue)) return { experiment: x.id, variant: v.key, unit };
  }
  return null;
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

/* ---------------- versions and dates ---------------- */

/** Longest version or date string the engine parses. Longer values are invalid (the condition is false). */
export const MAX_VERSION_LENGTH = 256;

/** A parsed semantic version: core numbers as digit strings without leading zeros, and prerelease identifiers. */
export interface SemVer {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdentChar = (c: number) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
const stripZeros = (d: string) => d.replace(/^0+(?=.)/, "");
const allDigits = (s: string) => /^[0-9]+$/.test(s);

/**
 * Parses a semantic version, leniently: an optional leading `v` or `V`; missing minor / patch read as 0 (`4.10` is
 * 4.10.0, `4` is 4.0.0); leading zeros are accepted and ignored (`2026.01.05` is 2026.1.5). Then SemVer 2.0: an
 * optional prerelease (`-` and dot-separated identifiers of `[0-9A-Za-z-]`) and optional build metadata (`+…`, ignored).
 * Anything else (whitespace, empty identifiers, a fourth number, non-ASCII, longer than 256) is null. Never throws.
 */
export function parseSemver(input: unknown): SemVer | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_VERSION_LENGTH) return null;
  const s = input;
  let i = s.charCodeAt(0) === 118 || s.charCodeAt(0) === 86 ? 1 : 0;
  const core: string[] = [];
  for (;;) {
    const start = i;
    while (i < s.length && isDigit(s.charCodeAt(i))) i++;
    if (i === start) return null;
    core.push(stripZeros(s.slice(start, i)));
    if (core.length < 3 && s.charCodeAt(i) === 46) { i++; continue; }
    break;
  }
  while (core.length < 3) core.push("0");
  const idents = (from: number, stopAtPlus: boolean): [string[], number] | null => {
    const out: string[] = [];
    let j = from;
    let start = j;
    for (;;) {
      const c = j < s.length ? s.charCodeAt(j) : -1;
      if (c !== -1 && isIdentChar(c)) { j++; continue; }
      if (j === start) return null;
      out.push(s.slice(start, j));
      if (c === 46) { j++; start = j; continue; }
      if (c === -1 || (stopAtPlus && c === 43)) return [out, j];
      return null;
    }
  };
  let prerelease: string[] = [];
  if (s.charCodeAt(i) === 45) {
    const r = idents(i + 1, true);
    if (!r) return null;
    [prerelease, i] = r;
  }
  if (s.charCodeAt(i) === 43) {
    const r = idents(i + 1, false);
    if (!r) return null;
    i = r[1];
  }
  if (i !== s.length) return null;
  return { major: core[0]!, minor: core[1]!, patch: core[2]!, prerelease };
}

/** Compares two digit strings without leading zeros, of any length. */
function compareDigits(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0 precedence: -1, 0 or 1. Build metadata never matters; numeric prerelease identifiers sort before others. */
export function compareSemver(a: SemVer, b: SemVer): number {
  const core = compareDigits(a.major, b.major) || compareDigits(a.minor, b.minor) || compareDigits(a.patch, b.patch);
  if (core !== 0) return core;
  const pa = a.prerelease;
  const pb = b.prerelease;
  if (pa.length === 0 || pb.length === 0) return pa.length === pb.length ? 0 : pa.length === 0 ? 1 : -1;
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    const xn = allDigits(x);
    const yn = allDigits(y);
    const c = xn && yn ? compareDigits(stripZeros(x), stripZeros(y)) : xn ? -1 : yn ? 1 : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?([Zz]|[+-][0-9]{2}:[0-9]{2}))?$/;

/** Epoch seconds below this magnitude, epoch milliseconds from it (1e12 ms is 2001-09-09; 1e12 s is year 33658). */
export const EPOCH_MS_THRESHOLD = 1e12;

/**
 * A point in time as Unix epoch milliseconds, or null. Accepts a JSON number (Unix epoch: seconds when its magnitude is
 * below 1e12, milliseconds otherwise), a date `YYYY-MM-DD` (00:00 UTC) or an RFC 3339 / ISO 8601 timestamp
 * `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by `Z` or `±HH:MM` (required). Calendar-checked (leap years; seconds
 * 00–59). Fractions beyond milliseconds are truncated. Numeric strings are not timestamps. Never throws.
 */
export function parseInstant(input: unknown): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return Math.abs(input) >= EPOCH_MS_THRESHOLD ? input : input * 1000;
  }
  if (typeof input !== "string" || input.length > MAX_VERSION_LENGTH) return null;
  const m = DATE_RE.exec(input);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = mo === 2 ? (leap ? 29 : 28) : mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
  if (d > dim) return null;
  let ms = daysFromCivil(y, mo, d) * 86_400_000;
  if (m[4] === undefined) return ms;
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (h > 23 || mi > 59 || sec > 59) return null;
  const frac = m[7] === undefined ? 0 : Number((m[7] + "00").slice(0, 3));
  ms += h * 3_600_000 + mi * 60_000 + sec * 1000 + frac;
  const z = m[8]!;
  if (z !== "Z" && z !== "z") {
    const oh = Number(z.slice(1, 3));
    const om = Number(z.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    ms -= (z[0] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return ms;
}

const SEMVER_OPS = new Set<string>(["semver_eq", "semver_neq", "semver_gt", "semver_gte", "semver_lt", "semver_lte"]);

function matchSemver(op: string, actual: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  const a = parseSemver(actual);
  const b = parseSemver(expected);
  if (a === null || b === null) return false;
  const c = compareSemver(a, b);
  switch (op) {
    case "semver_eq": return c === 0;
    case "semver_neq": return c !== 0;
    case "semver_gt": return c > 0;
    case "semver_gte": return c >= 0;
    case "semver_lt": return c < 0;
    default: return c <= 0;
  }
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
    case "semver_eq":
    case "semver_neq":
    case "semver_gt":
    case "semver_gte":
    case "semver_lt":
    case "semver_lte":
      return matchSemver(c.op, actual, c.value);
    case "before":
    case "after": {
      const a = parseInstant(actual);
      const b = parseInstant(c.value);
      if (a === null || b === null) return false;
      return c.op === "before" ? a < b : a > b;
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
    semver_eq: "version =", semver_neq: "version ≠", semver_gt: "version >", semver_gte: "version ≥", semver_lt: "version <", semver_lte: "version ≤",
    before: "before", after: "after",
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

/** Every operator this engine evaluates, in the order editors list them. Conditions with any other operator never match. */
export const OPERATORS: readonly Operator[] = [
  "eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte",
  "semver_eq", "semver_neq", "semver_gt", "semver_gte", "semver_lt", "semver_lte", "before", "after",
  "exists", "not_exists", "segment", "not_segment",
];
const OPS: readonly Operator[] = OPERATORS;

/** Operators that compare semantic versions. */
export const isSemverOp = (op: string): boolean => SEMVER_OPS.has(op);
/** Operators that compare points in time. */
export const isDateOp = (op: string): boolean => op === "before" || op === "after";
/** The numeric comparison operators (`gt`, `gte`, `lt`, `lte`). */
export const isNumericOp = (op: string): boolean => op === "gt" || op === "gte" || op === "lt" || op === "lte";

/**
 * Words of an attribute name: split at camelCase humps, `_`, `-`, `.`, spaces and other separators, lower-cased
 * (`appVersion` → app, version; `OSVersion` → os, version; `os_ver` → os, ver).
 */
export function attributeWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * An attribute named like a version: a word `version` or `ver` (`appVersion`, `os_ver`, `build.version`), but not a
 * version code (`versionCode`, `version_code`: Android's integer, compared numerically on purpose). Words containing
 * "ver" (`conversions`, `totalConversions`, `server`) do not count.
 */
export function versionLikeAttribute(name: string): boolean {
  const w = attributeWords(name);
  return w.some((x) => x === "version" || x === "ver") && !w.includes("code");
}

/**
 * True when a numeric operator (`gt`/`gte`/`lt`/`lte`) is probably meant as a version comparison: its value is a version
 * that is not a number (`"4.10.0"`, `"v4.2"`), or the attribute is named like a version (`appVersion`, `os_version`).
 * Numeric operators compare numbers (`"4.10"` is 4.1, below 4.9); the version operators compare `4.10` above `4.9`.
 * A warning only: such a condition is valid and keeps its numeric meaning.
 */
export function numericVersionWarning(c: Pick<Condition, "attribute" | "op" | "value">): boolean {
  if (!isNumericOp(c.op)) return false;
  const v = c.value;
  if (typeof v === "string" && num(v) === null && parseSemver(v) !== null) return true;
  return (typeof v === "string" || typeof v === "number") && typeof c.attribute === "string" && versionLikeAttribute(c.attribute);
}

/** Non-blocking advice about a flag configuration (saving and publishing are allowed). Human-readable, English. */
export function flagWarnings(flagKey: string, flag: Pick<FlagConfig, "rules">): string[] {
  const out: string[] = [];
  (flag.rules ?? []).forEach((r, i) => {
    for (const c of r.conditions ?? []) {
      if (numericVersionWarning(c)) out.push(`${flagKey}: rule ${String(i + 1).padStart(2, "0")} compares "${c.attribute}" as a number (${c.op}); use a version operator (semver_${c.op}) to compare versions such as 4.10.0.`);
    }
  });
  return out;
}

/** Problem with a condition's comparison value for the version and date operators, or null. */
export function conditionValueProblem(c: Pick<Condition, "op" | "value">): "version" | "date" | null {
  if (isSemverOp(c.op)) return parseSemver(c.value) === null ? "version" : null;
  if (isDateOp(c.op)) return parseInstant(c.value) === null ? "date" : null;
  return null;
}

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
    if (JSON.stringify(a.experiment ?? null) !== JSON.stringify(b.experiment ?? null)) {
      const label = (x: ExperimentMeta | undefined) => (x ? `${x.key} (${x.traffic ?? 100}% of rule ${x.ruleId})` : "—");
      rows.push({ flagKey, field: "experiment", before: label(a.experiment), after: b.experiment ? label(b.experiment) : "stopped" });
    }
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
