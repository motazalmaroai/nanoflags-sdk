/**
 * Shared mapping between NanoFlags evaluations and OpenFeature resolution details.
 * The providers live in `@nanoflags/openfeature-provider/server` and `/web`.
 */
import { ErrorCode, StandardResolutionReasons, type EvaluationContext, type JsonValue as OFJsonValue, type ResolutionDetails, type TrackingEventDetails } from "@openfeature/core";
import type { Context, Evaluation, JsonValue, NanoFlagsClient, UpdateEvent } from "@nanoflags/sdk";

/** The part of a NanoFlags client the providers use. `track` is optional: without it, OpenFeature `track()` calls are ignored. */
export type NanoFlagsLike = Pick<NanoFlagsClient, "evaluate" | "ready" | "status" | "revision" | "on" | "subscribe" | "close"> & Partial<Pick<NanoFlagsClient, "track">>;

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
    // The caller's default is the SDK fallback, so the SDK's sampled telemetry and its evaluation trace show the value the
    // application actually got when the flag is missing (the same as `client.boolean(key, fallback)`).
    const e = target.evaluate<JsonValue>(flagKey, (defaultValue ?? null) as JsonValue, toNanoFlagsContext(context));
    return toResolution(e, defaultValue, kind, options.client.revision !== null || e.reason !== "flag_not_found");
  } catch (err) {
    return { value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.GENERAL, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * OpenFeature `track()` → NanoFlags `client.track(eventName, value, ctx)` (experiment metric events). `value` is taken
 * from `trackingEventDetails.value` when it is a finite number; other details are not sent (NanoFlags only sends a
 * hash of the unit, never the context or custom attributes). Goes to the client, not to `evaluator`. Never throws.
 */
export function track(options: NanoFlagsProviderOptions, trackingEventName: string, context: EvaluationContext | undefined, details: TrackingEventDetails | undefined): void {
  const client = options.client;
  if (typeof client.track !== "function") return;
  try {
    const value = details && typeof details.value === "number" && Number.isFinite(details.value) ? details.value : undefined;
    client.track(trackingEventName, value, toNanoFlagsContext(context));
  } catch {
    /* tracking never affects the application */
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
 * Client errors are only listened to while no bundle is loaded. With a bundle in use, an error (failed revalidation,
 * rejected signature, transparency-log or co-signature failure, invalid track() call, ...) is not a provider state
 * change, and leaving the client without a provider listener keeps the SDK's own reporting of it (`console.warn` once
 * per error code when the application attached no `error` listener, since @nanoflags/sdk 0.5.1).
 * Returns a function that stops the translation.
 */
export function bridge(client: NanoFlagsLike, emit: (e: BridgeEvent) => void): () => void {
  let last = client.status;
  let offError: (() => void) | null = null;
  const listenForErrors = () => {
    if (client.status === "not-ready") {
      offError ??= client.on("error", (err: Error) => {
        if (client.status === "not-ready") emit({ type: "error", message: err.message });
      });
    } else if (offError) {
      offError();
      offError = null;
    }
  };
  listenForErrors();
  const offStatus = client.subscribe(() => {
    listenForErrors();
    const now = client.status;
    if (now === last) return;
    last = now;
    if (now === "ready") emit({ type: "ready" });
    else if (now === "stale") emit({ type: "stale", message: "The configuration in use is not known to be current." });
  });
  const offUpdate = client.on("update", (u: UpdateEvent) => emit({ type: "changed", message: `Revision ${u.revision} is now in use.`, revision: u.revision }));
  return () => {
    offStatus();
    offUpdate();
    offError?.();
    offError = null;
  };
}

export type { OFJsonValue };
