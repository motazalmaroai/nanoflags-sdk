/**
 * Shadow evaluation of drafts (migration 0179, RUNTIME.md "Shadow evaluation of drafts").
 *
 * While a change waits for approval in an environment whose admin turned shadow evaluation on, the edge announces a
 * signed shadow bundle (`X-NanoFlags-Shadow` on `/v1/bundle`, the bundle itself on `/v1/shadow`). For a sample of the
 * evaluations of the flags the draft changes, the SDK evaluates the draft as well and counts, per flag, how often the
 * value would change. Only those counters leave the process (with the next `/v1/events` report):
 *
 *   { sessionId, checksum, version?, flags: [{ flag, samples, flips, pairs: [{ live, shadow, count }], rules: { "<i>" | "default": n } }] }
 *
 * No context, attribute, key or identifier is ever part of it. Values are the flag's own configured values, as JSON text
 * with object keys sorted, at most 100 characters (longer ones are replaced by a hash); a side that used the app's own
 * fallback (flag missing there, evaluation error, wrong type) is reported as "<fallback>", never as the value. The shadow bundle is NEVER applied: the app always
 * gets the live value, and the client refuses any bundle that carries a `shadow` member as configuration.
 *
 * Wire format and rules are the contract other SDKs follow (see RUNTIME.md).
 */
import { murmur3, type Bundle, type Condition, type FlagConfig, type JsonValue } from "@nanoflags/engine";

/** `"shadow"` member of a signed shadow bundle (inside the signed bytes). */
export interface ShadowMarker {
  sessionId: string;
  checksum: string;
  environmentId: string;
  baseRevision: number;
}

export type ShadowBundle = Bundle & { shadow: ShadowMarker };

export interface ShadowOptions {
  /** Default true. `false` (or `shadow: false`) never fetches nor evaluates shadow bundles. Needs `events` enabled. */
  enabled?: boolean;
  /** Fraction of evaluations of changed flags that are also evaluated with the draft, 0–1. Default 0.1. */
  sampleRate?: number;
  /** Random source for sampling; injectable for tests. */
  random?: () => number;
}

export interface ShadowReport {
  sessionId: string;
  checksum: string;
  version?: string;
  flags: { flag: string; samples: number; flips: number; pairs: { live: string; shadow: string; count: number }[]; rules: Record<string, number> }[];
}

export const MAX_SHADOW_FLAGS = 100;
export const MAX_SHADOW_PAIRS = 10;
export const MAX_SHADOW_RULES = 50;
export const MAX_SHADOW_VALUE_CHARS = 100;
/** The edge accepts counts up to 10^7; a flag's counter stops there (the next report starts from zero again). */
export const MAX_SHADOW_COUNT = 10_000_000;
/** The edge accepts flag keys of 1–63 characters (UTF-16 code units) in a report. */
export const MAX_SHADOW_FLAG_KEY = 63;
/** Shadow counters go out with the events report at most this often (and on flush(), pause and close). */
export const SHADOW_FLUSH_MS = 60_000;
/** A failed shadow fetch is not retried for the same announcement before this. */
export const SHADOW_RETRY_MS = 60_000;
/** How long a shadow bundle waits for the live configuration's first verification to pin the environment. */
export const SHADOW_PIN_WAIT_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM = /^[0-9a-f]{32}$/;

/** `X-NanoFlags-Shadow: <sessionId>.<checksum>` → its parts, or null. */
export function parseShadowHeader(v: string | null): { sessionId: string; checksum: string } | null {
  if (!v) return null;
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{32})$/i.exec(v.trim());
  return m && UUID.test(m[1]!) ? { sessionId: m[1]!.toLowerCase(), checksum: m[2]!.toLowerCase() } : null;
}

export function isShadowMarker(v: unknown): v is ShadowMarker {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.sessionId === "string" && UUID.test(m.sessionId) && typeof m.checksum === "string" && CHECKSUM.test(m.checksum)
    && typeof m.environmentId === "string" && typeof m.baseRevision === "number";
}

/** JSON text with object keys sorted, so two configurations compare equal whatever their key order. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

const own = (o: object | null | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** Segment keys a list of conditions references directly (segment / not_segment). */
function conditionRefs(conditions: unknown): string[] {
  const out: string[] = [];
  for (const c of Array.isArray(conditions) ? (conditions as Condition[]) : []) {
    if (c && (c.op === "segment" || c.op === "not_segment") && typeof c.value === "string") out.push(c.value);
  }
  return out;
}

/** Segment keys a flag's rules reference directly (segment / not_segment). */
function segmentRefs(f: FlagConfig | undefined): string[] {
  return (Array.isArray(f?.rules) ? f!.rules : []).flatMap((r) => conditionRefs(r?.conditions));
}

/**
 * Segments whose evaluation can differ between the live and the shadow bundle: the definition differs (new, edited or
 * removed in the draft), or one of its conditions references such a segment, transitively (the engine evaluates
 * segments inside segments). Iterated to a fixpoint. Same rule as the database (`app.shadow_changed_segments`).
 */
export function changedSegments(live: Bundle, shadow: Bundle): Set<string> {
  const ls = live.segments ?? {};
  const ss = shadow.segments ?? {};
  const changed = new Set<string>();
  for (const k of Object.keys(ss)) if (!own(ls, k) || stableStringify(ls[k]) !== stableStringify(ss[k])) changed.add(k);
  for (const k of Object.keys(ls)) if (!own(ss, k)) changed.add(k);
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of Object.keys(ss)) {
      if (!changed.has(k) && conditionRefs(ss[k]?.conditions).some((x) => changed.has(x))) {
        changed.add(k);
        grew = true;
      }
    }
  }
  return changed;
}

/**
 * Keys of the shadow bundle's flags that the draft changes compared with the live bundle: a different configuration,
 * or a segment they reference (directly or through other segments) that differs. Same rule as the database
 * (`app.shadow_flags`).
 */
export function changedFlags(live: Bundle, shadow: Bundle): Set<string> {
  const changedSegs = changedSegments(live, shadow);
  const out = new Set<string>();
  for (const k of Object.keys(shadow.flags ?? {})) {
    const s = shadow.flags[k];
    if (!own(live.flags, k) || stableStringify(live.flags[k]) !== stableStringify(s) || segmentRefs(s).some((x) => changedSegs.has(x))) out.add(k);
  }
  return out;
}

/**
 * Reported instead of a value that did not come from a bundle: the application's own fallback (flag missing on that
 * side, evaluation error, or a value of the wrong type). The fallback is the app's data and never leaves the SDK.
 */
export const FALLBACK_TOKEN = "<fallback>";

/** A value as it is reported: JSON text with object keys sorted, at most 100 characters (longer values become `#<hash>`). */
export function reprValue(v: JsonValue | undefined): string {
  let text: string;
  try {
    text = stableStringify(v);
  } catch {
    text = "null";
  }
  return text.length <= MAX_SHADOW_VALUE_CHARS ? text : `#${murmur3(text).toString(16).padStart(8, "0")}`;
}

interface FlagCounter {
  samples: number;
  flips: number;
  pairs: Map<string, { live: string; shadow: string; count: number }>;
  rules: Map<string, number>;
}

/** In-memory counters of one shadow session. Bounded: 100 flags × (10 value pairs + 50 rule counters). */
export class ShadowCounters {
  private flags = new Map<string, FlagCounter>();
  constructor(readonly sessionId: string, readonly checksum: string) {}

  get size(): number {
    return this.flags.size;
  }

  /**
   * One sampled evaluation: the value the app got, what the draft would give, and which draft rule matched. A side whose
   * value is the app's fallback (`liveFallback` / `shadowFallback`) is reported as `"<fallback>"`, never as the value.
   * Whether the value changes is decided on the values themselves, whatever the order of object keys.
   */
  add(flag: string, live: JsonValue | undefined, shadow: JsonValue | undefined, ruleIndex: number | undefined, liveFallback = false, shadowFallback = false): void {
    // The edge refuses the whole report (400) over one flag key outside 1–63 characters.
    if (typeof flag !== "string" || flag === "" || flag.length > MAX_SHADOW_FLAG_KEY) return;
    let c = this.flags.get(flag);
    if (!c) {
      if (this.flags.size >= MAX_SHADOW_FLAGS) return;
      c = { samples: 0, flips: 0, pairs: new Map(), rules: new Map() };
      this.flags.set(flag, c);
    }
    // Every count of a flag (flips, pair and rule counters) is ≤ samples, so stopping samples keeps them all ≤ 10^7.
    if (c.samples >= MAX_SHADOW_COUNT) return;
    c.samples++;
    const rk = typeof ruleIndex === "number" && Number.isInteger(ruleIndex) && ruleIndex >= 0 && ruleIndex < 10_000 ? String(ruleIndex) : "default";
    if (c.rules.has(rk) || c.rules.size < MAX_SHADOW_RULES) c.rules.set(rk, (c.rules.get(rk) ?? 0) + 1);
    let same: boolean;
    try {
      same = stableStringify(live) === stableStringify(shadow);
    } catch {
      same = false;
    }
    if (same) return;
    const a = liveFallback ? FALLBACK_TOKEN : reprValue(live);
    const b = shadowFallback ? FALLBACK_TOKEN : reprValue(shadow);
    c.flips++;
    let key = `${a}\u0000${b}`;
    if (!c.pairs.has(key) && c.pairs.size >= MAX_SHADOW_PAIRS - 1) key = "*\u0000*";
    const p = c.pairs.get(key) ?? { live: key === "*\u0000*" ? "*" : a, shadow: key === "*\u0000*" ? "*" : b, count: 0 };
    p.count++;
    c.pairs.set(key, p);
  }

  report(version: string | undefined): ShadowReport {
    return {
      sessionId: this.sessionId,
      checksum: this.checksum,
      ...(version ? { version } : {}),
      flags: [...this.flags].map(([flag, c]) => ({ flag, samples: c.samples, flips: c.flips, pairs: [...c.pairs.values()], rules: Object.fromEntries(c.rules) })),
    };
  }
}
