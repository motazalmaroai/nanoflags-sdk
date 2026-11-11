/**
 * Shared mapping between NanoFlags evaluations and OpenFeature resolution details.
 * The providers live in `@nanoflags/openfeature-provider/server` and `/web`.
 */
import { ErrorCode, StandardResolutionReasons, type EvaluationContext, type JsonValue as OFJsonValue, type ResolutionDetails } from "@openfeature/core";
import type { Context, Evaluation, JsonValue, NanoFlagsClient, UpdateEvent } from "@nanoflags/sdk";

/** The part of a NanoFlags client the providers use. */
export type NanoFlagsLike = Pick<NanoFlagsClient, "evaluate" | "ready" | "status" | "revision" | "on" | "subscribe" | "close">;

export interface NanoFlagsProviderOptions {
  client: NanoFlagsLike;
  /** Close the NanoFlags client when the provider is shut down. Default false: the client is yours. */
  closeClient?: boolean;
  /**
   * Where evaluations go. Default: the client. Return a session-scoped evaluator here (for example
   * `() => flagsFor(client)` from `@nanoflags/sdk/node`) to make OpenFeature evaluations follow the
   * current request's test session.
   */
  evaluator?: () => Pick<NanoFlagsClient, "evaluate">;
}

export type FlagKind = "boolean" | "string" | "number" | "object";

function toJson(v: unknown, depth: number): JsonValue | undefined {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (depth >= 8 || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return v.map((x) => toJson(x, depth + 1) ?? null);
  const out: Record<string, JsonValue> = {};
  for (const [k, x] of Object.entries(v)) {
    const j = toJson(x, depth + 1);
    if (j !== undefined) out[k] = j;
  }
  return out;
}

/**
 * OpenFeature context → NanoFlags context. `targetingKey` becomes `key` (the bucketing identity)
 * and wins over an attribute that happens to be called `key`. Dates become ISO strings.
 */
export function toNanoFlagsContext(context: EvaluationContext | undefined): Context {
  const out: Context = {};
  if (!context) return out;
  for (const [name, value] of Object.entries(context)) {
    if (name === "targetingKey") continue;
    const j = toJson(value, 0);
    if (j !== undefined) out[name] = j;
  }
  if (typeof context.targetingKey === "string" && context.targetingKey !== "") out.key = context.targetingKey;
  return out;
}

const accepts: Record<FlagKind, (v: unknown) => boolean> = {
  boolean: (v) => typeof v === "boolean",
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  object: (v) => v !== undefined,
};

function describe(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/** NanoFlags evaluation → OpenFeature resolution details. Never throws. */
export function toResolution<T>(e: Evaluation<JsonValue>, defaultValue: T, kind: FlagKind, loaded: boolean): ResolutionDetails<T> {
  const flagMetadata = { revision: e.revision };
  const failure = (errorCode: ErrorCode, errorMessage: string): ResolutionDetails<T> => ({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode, errorMessage, flagMetadata });
  if (e.reason === "flag_not_found") {
    return loaded
      ? failure(ErrorCode.FLAG_NOT_FOUND, `Flag "${e.flagKey}" is not in the loaded configuration (r${e.revision}).`)
      : failure(ErrorCode.PROVIDER_NOT_READY, "NanoFlags has no configuration loaded yet.");
  }
  if (e.reason === "error") return failure(ErrorCode.GENERAL, e.error ?? "Evaluation failed.");
  if (!accepts[kind](e.value)) return failure(ErrorCode.TYPE_MISMATCH, `Flag "${e.flagKey}" has a ${describe(e.value)} value; a ${kind} was requested.`);
  const reason =
    e.reason === "off"
      ? StandardResolutionReasons.DISABLED
      : e.reason === "default"
        ? StandardResolutionReasons.DEFAULT
        : // A rule matched. Rollout rules decide by pseudo-random bucket: SPLIT. Fixed rules: TARGETING_MATCH.
          e.inRollout === undefined
          ? StandardResolutionReasons.TARGETING_MATCH
          : StandardResolutionReasons.SPLIT;
  return { value: e.value as T, reason, ...(e.ruleId === undefined ? {} : { variant: e.ruleId }), flagMetadata };
}

export function resolve<T>(options: NanoFlagsProviderOptions, flagKey: string, defaultValue: T, context: EvaluationContext | undefined, kind: FlagKind): ResolutionDetails<T> {
  try {
    const target = options.evaluator?.() ?? options.client;
    const e = target.evaluate<JsonValue>(flagKey, null, toNanoFlagsContext(context));
    return toResolution(e, defaultValue, kind, options.client.revision !== null || e.reason !== "flag_not_found");
  } catch (err) {
    return { value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.GENERAL, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

export type BridgeEvent =
  | { type: "ready" }
  | { type: "stale"; message: string }
  | { type: "error"; message: string }
  | { type: "changed"; message: string; revision: number };

/**
 * Translates client status changes and updates into provider events:
 *   status → ready                     READY
 *   status → stale                     STALE
 *   new bundle adopted                 CONFIGURATION_CHANGED
 *   client error while no bundle       ERROR
 * Returns a function that stops the translation.
 */
export function bridge(client: NanoFlagsLike, emit: (e: BridgeEvent) => void): () => void {
  let last = client.status;
  const offStatus = client.subscribe(() => {
    const now = client.status;
    if (now === last) return;
    last = now;
    if (now === "ready") emit({ type: "ready" });
    else if (now === "stale") emit({ type: "stale", message: "The configuration in use is not known to be current." });
  });
  const offUpdate = client.on("update", (u: UpdateEvent) => emit({ type: "changed", message: `Revision ${u.revision} is now in use.`, revision: u.revision }));
  const offError = client.on("error", (err: Error) => {
    if (client.status === "not-ready") emit({ type: "error", message: err.message });
  });
  return () => {
    offStatus();
    offUpdate();
    offError();
  };
}

export type { OFJsonValue };
