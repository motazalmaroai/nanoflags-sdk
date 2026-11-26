/**
 * @nanoflags/sdk — isomorphic core.
 *
 * Flags are evaluated locally and synchronously against an in-memory bundle. The network is only
 * used in the background: to load the bundle, to learn about new revisions, to send sampled
 * telemetry, and — for flags with a running experiment — exposures and `track()` events (hashed units only).
 * A flag accessor never performs I/O and never throws.
 *
 * New revisions arrive over one of three transports, best first: the live WebSocket (`/v1/live`,
 * the edge pushes the signed bundle itself — no request follows), the SSE stream (`/v1/stream`,
 * a notification followed by a conditional fetch), and polling (`/v1/bundle`).
 */
import { ENGINE_VERSION, evaluate as engineEvaluate, exposureOf, murmur3, supportsEngine, type Bundle, type Condition, type Context, type Evaluation, type JsonValue } from "@nanoflags/engine";
import { unitHash } from "./sha256.js";
import { OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS } from "./keys.js";
import { defaultStore, type Store } from "./store.js";
import { readSse } from "./sse.js";
import { importPublicKeys, isPublicEd25519Jwk, rawMember, verifyBundleText, verifyShadowText, type ImportedKey, type SignatureCrypto, type SignatureInfo, type VerifyOptions } from "./verify.js";
import { changedFlags, isShadowMarker, parseShadowHeader, ShadowCounters, SHADOW_FLUSH_MS, SHADOW_PIN_WAIT_MS, SHADOW_RETRY_MS, type ShadowBundle, type ShadowOptions } from "./shadow.js";
import { checkEvidence, decodeEvidence, isLogEvidence, isTreeHead, onlyTurnsFlagsOff, verifyConsistency, verifyHead, type LogEvidence, type TreeHead } from "./log.js";

export type { Bundle, Context, Evaluation, EvaluationErrorCode, ExperimentMeta, JsonValue, Reason } from "@nanoflags/engine";
export { sha256Hex, unitHash } from "./sha256.js";
export type { Store } from "./store.js";
export type { SignatureCrypto, VerifyOptions } from "./verify.js";
export type { ShadowOptions, ShadowReport } from "./shadow.js";
export { headText, leafHash, onlyTurnsFlagsOff, parseLeaf, verifyConsistency, verifyInclusion, type LogEvidence, type LogLeaf, type TreeHead } from "./log.js";
export { OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS } from "./keys.js";

export const SDK_VERSION = "0.8.2";

/** Newest bundle format (`bundle.engine`) this SDK can evaluate. Newer bundles are refused; the previous one stays in use. */
export const SUPPORTED_ENGINE_VERSION = ENGINE_VERSION;

/** WebSocket close code of the edge for an environment that was deleted: the SDK stops reconnecting. */
export const CLOSE_ENVIRONMENT_DELETED = 4004;

/** Header that carries a test-session token between services. */
export const SESSION_HEADER = "x-nanoflags-session";

export type ClientStatus = "not-ready" | "ready" | "stale";

/**
 * Whether the client has a configuration, from the application's point of view (`client.state`):
 * - `starting`: no configuration yet, the first load attempt is still running;
 * - `ready`: a configuration is loaded and the edge confirmed it is current;
 * - `stale`: a configuration is loaded (restored from the store, or the edge cannot be reached right now) but is not
 *   known to be current;
 * - `failed`: the first load attempt finished without any configuration (see `client.lastError`). Evaluations return
 *   the application's fallbacks with `errorCode: "CONFIG_NOT_LOADED"`; the client keeps retrying and moves to `ready`
 *   when a configuration arrives.
 * `status` is unchanged: `not-ready` covers both `starting` and `failed`.
 */
export type ClientState = "starting" | "ready" | "stale" | "failed";

/**
 * Why loading the configuration failed (`client.lastError.code`, `NanoFlagsError.errorCode`):
 * - `INVALID_KEY`: the edge refused the SDK key (HTTP 401 / 403: unknown, revoked, or the wrong kind of key);
 * - `EDGE_UNREACHABLE`: no answer from the edge (DNS, connection refused, offline, TLS);
 * - `TIMEOUT`: the edge did not answer within 10 seconds;
 * - `HTTP_ERROR`: the edge answered with another HTTP error (`httpStatus`), e.g. 5xx;
 * - `INVALID_BUNDLE`: the edge's answer is not a configuration;
 * - `BUNDLE_REJECTED`: a configuration arrived but was refused (signature, transparency log, co-signature, or a
 *   rollback: an older revision than one this client already verified); `lastError.reason` says which;
 * - `UNSUPPORTED_ENGINE`: the configuration needs a newer SDK;
 * - `ENVIRONMENT_DELETED`: the key's environment was deleted;
 * - `CONFIG`: the client is misconfigured (e.g. no `sdkKey` or `baseUrl`);
 * - `NO_BUNDLE`: the first load attempt finished without a configuration and without one of the errors above.
 */
export type LoadErrorCode = "INVALID_KEY" | "EDGE_UNREACHABLE" | "TIMEOUT" | "HTTP_ERROR" | "INVALID_BUNDLE" | "BUNDLE_REJECTED" | "UNSUPPORTED_ENGINE" | "ENVIRONMENT_DELETED" | "CONFIG" | "NO_BUNDLE";

/** The most recent failure to load or update the configuration (`client.lastError`). */
export interface LoadError {
  code: LoadErrorCode;
  message: string;
  /** HTTP status of the edge's answer, when there was one. */
  httpStatus?: number;
  /**
   * The detailed `NanoFlagsError.code`, e.g. `"signature"`, `"log"`, `"cosign"` or `"rollback"` for `BUNDLE_REJECTED`.
   * Absent for failures without one (`NO_BUNDLE`).
   */
  reason?: NanoFlagsErrorCode;
  /** ISO timestamp of the failure. */
  at: string;
}

/** Payload of the `state` event: emitted whenever `client.state` changes. */
export interface StateEvent {
  state: ClientState;
  previous: ClientState;
  /** `client.lastError` at the time of the change (null once a configuration is confirmed current). */
  error: LoadError | null;
}

/** How updates currently reach the client: pushed over the live WebSocket, announced over SSE, or polled. */
export type Transport = "live" | "stream" | "poll";

/** WebSocket subprotocol of `/v1/live`. The key travels as a second protocol entry, never in the URL. */
export const LIVE_PROTOCOL = "nanoflags.v1";

/** The part of the WHATWG WebSocket the SDK uses (browsers, Node ≥ 22, Deno, Bun, the `ws` package). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  onopen: ((event: any) => any) | null;
  onmessage: ((event: any) => any) | null;
  onclose: ((event: any) => any) | null;
  onerror: ((event: any) => any) | null;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/**
 * Opens one server-sent-events request and reports its events until the response ends. Resolves with the HTTP status
 * (after the body has ended); rejects on network errors. Aborting `signal` must end it promptly.
 * Default: `fetch` with a streamed body. Runtimes whose `fetch` cannot stream (React Native) pass their own.
 */
export type StreamOpener = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }, onEvent: (event: string, data: string) => void) => Promise<number>;

/**
 * Handed to `ClientOptions.lifecycle` once, when the client starts. Platform integrations (mobile app lifecycle,
 * connectivity) use it to stop background network activity and to resume it.
 */
export interface LifecycleControl {
  /**
   * Stop all background network activity: the live socket (no reconnect), SSE, polling and the telemetry timer.
   * Queued telemetry is flushed once. Evaluations keep working on the bundle in use. Idempotent.
   */
  pause(): void;
  /** Undo `pause()`: revalidate the bundle now (conditional request), then restart polling, telemetry and the live connection. Idempotent. */
  resume(): void;
  /** `false`: no live socket and no SSE, polling only (data saver). `true` (the default): best transport. */
  setRealtime(enabled: boolean): void;
  /** True between `pause()` and `resume()`. */
  readonly paused: boolean;
}

export interface EventsOptions {
  /** Default true. */
  enabled?: boolean;
  /** Fraction of evaluations reported, 0–1. Default 0.1. */
  sampleRate?: number;
  /** Default 10000. How often queued events are sent. */
  flushIntervalMs?: number;
  /**
   * Default 60000. While no events are queued, the service report ("this service runs revision N")
   * goes out at this interval instead of on every flush interval.
   */
  reportIntervalMs?: number;
  /**
   * Decides what part of the evaluation context leaves the process with a sampled event.
   * Default: no attribute VALUES are sent — only the names of the attributes that the flag's
   * rules reference and that were present, mapped to the value's type (e.g. `{ region: "string" }`).
   */
  redact?: (ctx: Context) => Record<string, JsonValue | undefined>;
  /** Random source for sampling; injectable for tests. */
  random?: () => number;
}

export interface ExperimentsOptions {
  /**
   * Default true, or false when telemetry is turned off (`events: false`). Log an exposure the first time a unit
   * evaluates a flag that carries a running experiment (published bundles include its metadata), and send `track()`
   * events. Exposures are never sampled. `false` turns both off; `true` keeps them on even with `events: false`.
   */
  enabled?: boolean;
  /** Default 5000. How often queued exposures and track events are sent (sooner when 100 are queued). */
  flushIntervalMs?: number;
}

export interface ClientOptions {
  /** `nf_srv_…` on servers, `nf_pub_…` in browsers. Never ship a server key to a browser. */
  sdkKey: string;
  /** Base URL of the NanoFlags edge, e.g. `https://flags.example.com`. */
  baseUrl: string;
  /** Name shown in "which revision is this service running". */
  service?: string;
  /** Default 30000. `0` disables polling. */
  pollIntervalMs?: number;
  /**
   * Default true. Receive updates without polling: over the live WebSocket when the runtime has
   * one, otherwise (or when the socket cannot be established) over SSE. `false` disables both.
   */
  streaming?: boolean;
  /** Default true. `false` skips the live WebSocket and uses SSE + polling as SDK 0.2 did. */
  live?: boolean;
  /** Default 300000. Safety-poll interval while the live socket is healthy (`pollIntervalMs` applies otherwise; `pollIntervalMs: 0` disables both). */
  livePollIntervalMs?: number;
  /** WebSocket implementation. Default: the global `WebSocket` (browsers, Node ≥ 22). Without one the SDK uses SSE + polling. */
  webSocket?: WebSocketConstructor;
  /** A bundle obtained elsewhere (e.g. embedded at build time or passed from the server). */
  bootstrap?: Bundle;
  /** Persistence. Default: IndexedDB in browsers, none elsewhere. `false` disables it. */
  store?: Store | false;
  events?: EventsOptions | false;
  /** Experiments: exposure logging and `track()`. See `ExperimentsOptions`. */
  experiments?: ExperimentsOptions | false;
  /**
   * Verify bundle signatures before a new bundle replaces the current one. A bundle whose signature
   * does not verify is rejected: the previous bundle stays in use and an `error` (`code: "signature"`)
   * is emitted. Without `require`, bundles the edge marks as unsigned are still accepted.
   *
   * Default: with `baseUrl` = `https://edge.nanoflags.io` the SDK verifies against the embedded production keys
   * (`OFFICIAL_SIGNING_KEYS`, plus `GET /v1/keys` once when a bundle names an unknown key id) with `require: true`;
   * with any other `baseUrl` nothing is verified unless configured. `false` turns verification off explicitly.
   */
  verify?: VerifyOptions | false;
  /**
   * Verify every new configuration against the environment's transparency log (verifiable publish history): the
   * revision must be recorded in the log, exactly with the bytes received, under a tree head signed by NanoFlags, and
   * every new tree head must extend the previous one (consistency proof). A configuration that cannot be verified is
   * not applied: the configuration in use stays, an `error` with code `log` is emitted and the SDK tries again.
   * Implies signature verification with `require: true` (`verify: false` makes every update fail). Default false.
   */
  verifyLog?: boolean;
  /**
   * Customer co-signing keys (public Ed25519 JWKs with `kid`) registered for this environment in the dashboard. With
   * keys set, a configuration must also carry a valid signature by one of them (made in your CI with
   * `nanoflags sign`); otherwise it is rejected (`error` code `cosign`) and the configuration in use stays. Implies
   * signature verification with `require: true`.
   */
  coSignerKeys?: readonly JsonWebKey[];
  /**
   * With `coSignerKeys`: accept a configuration without the customer signature when it is an emergency (kill-switch)
   * revision — it differs from the configuration in use only by flags turned off. Default true, so the kill switch keeps
   * working when your CI key is unavailable. With `verifyLog` the log must also record it as an emergency. Without a
   * configuration in use to compare with (first start), such a revision is not accepted.
   */
  allowEmergencyWithoutCosign?: boolean;
  fetch?: typeof fetch;
  /** Platform integration: SHA-256 + Ed25519 for signature verification where WebCrypto lacks them (React Native). Default: WebCrypto. */
  crypto?: SignatureCrypto;
  /** Platform integration: how the SSE fallback is opened. Default: `fetch` with a streamed body. */
  openStream?: StreamOpener;
  /** Platform integration: called once at start with a `LifecycleControl`; may return a cleanup function that `close()` calls. */
  lifecycle?: (control: LifecycleControl) => (() => void) | void;
  /** Platform integration: the `sdk` label of telemetry reports. Default `js/<version>`. At most 40 characters. */
  sdkLabel?: string;
  /**
   * Your service's own version (e.g. `"3.1.0"`), at most 40 characters. Shown next to `service` on the change page's
   * "Production impact (shadow)" panel, so a difference that only one release has stands out.
   */
  serviceVersion?: string;
  /**
   * Shadow evaluation of drafts. When an admin turned it on for the environment and a change waits for approval, the
   * edge offers the change's draft as a signed shadow bundle. For a sample of the evaluations of the flags the draft
   * changes, the SDK also evaluates the draft and reports only aggregate counters (how often the value would change,
   * per flag, value pair and draft rule) with the telemetry report — never a context, attribute or identifier. The app
   * always gets the live value; a shadow bundle is never applied, and one whose signature does not verify is ignored.
   * Default on (sample rate 0.1) when `events` are enabled; `false` turns it off.
   */
  shadow?: ShadowOptions | false;
}

/** The flag accessors shared by the client and by session-scoped evaluators. */
export interface FlagEvaluator {
  boolean(key: string, fallback: boolean, ctx?: Context): boolean;
  string(key: string, fallback: string, ctx?: Context): string;
  number(key: string, fallback: number, ctx?: Context): number;
  json<T extends JsonValue = JsonValue>(key: string, fallback: T, ctx?: Context): T;
  /** Full engine result (value, reason, matched rule, trace). No type check is applied. */
  evaluate<T extends JsonValue = JsonValue>(key: string, fallback: T, ctx?: Context): Evaluation<T>;
}

/**
 * Evaluator bound to one test session. While `active`, flags are evaluated against the session's
 * pinned bundle with the context `{ ...session.context, ...ctx }` and sampled events carry the
 * session id. When the session is unknown, not permitted for this service, or expired, it evaluates
 * exactly like the client (`active` is false). It never throws.
 */
export interface SessionEvaluator extends FlagEvaluator {
  /** True while the session is known and has not expired. Re-evaluated on every read. */
  readonly active: boolean;
  /** Session id, or null when the session could not be resolved. */
  readonly id: string | null;
  /** ISO timestamp, or null when the session could not be resolved. */
  readonly expiresAt: string | null;
  /** Revision evaluations currently run against (the pinned one while active, otherwise the client's). */
  readonly revision: number | null;
}

export interface SessionOptions {
  /** Service name sent as `X-NanoFlags-Service`. Defaults to the client's `service`. */
  service?: string;
}

export interface UpdateEvent {
  revision: number;
  previousRevision: number | null;
  checksum: string | null;
  source: "network" | "store" | "bootstrap";
  /**
   * Milliseconds from the commit of the revision in the database to this event — only for revisions
   * pushed over the live socket (`transport: "live"`) that carry the commit time; otherwise null.
   * It compares the database's clock with this machine's, so it is as accurate as their clocks agree.
   */
  latencyMs: number | null;
  /** How this bundle arrived: pushed (`live`), fetched after an SSE notification (`stream`), or anything else (`poll`). */
  transport: Transport;
}

export interface NanoFlagsClient {
  /** Resolves once a usable bundle is loaded, or once the first load attempt has finished without one. Never rejects. */
  ready(): Promise<void>;
  readonly status: ClientStatus;
  /**
   * `starting`, `ready`, `stale` or `failed`: like `status`, but tells a client that is still loading from one that could
   * not load anything. Always set on clients from `createClient`; optional in this interface only so that existing
   * implementations of it (wrappers, test doubles) keep compiling.
   */
  readonly state?: ClientState;
  /**
   * The most recent failure to load or update the configuration (invalid key, edge unreachable, timeout, …), or null.
   * Cleared when the edge confirms a configuration as current. Errors of telemetry, test sessions and shadow
   * evaluation do not count. Always set on clients from `createClient` (optional for the same reason as `state`).
   */
  readonly lastError?: LoadError | null;
  /** Revision of the bundle in use, or null when none is loaded. */
  readonly revision: number | null;
  /** How updates reach this client right now: `live` while the WebSocket is open, `stream` while SSE is in use, else `poll`. */
  readonly transport: Transport;
  boolean(key: string, fallback: boolean, ctx?: Context): boolean;
  string(key: string, fallback: string, ctx?: Context): string;
  number(key: string, fallback: number, ctx?: Context): number;
  json<T extends JsonValue = JsonValue>(key: string, fallback: T, ctx?: Context): T;
  /** Full engine result (value, reason, matched rule, trace). No type check is applied. */
  evaluate<T extends JsonValue = JsonValue>(key: string, fallback: T, ctx?: Context): Evaluation<T>;
  /**
   * Values of every flag in the bundle in use for `ctx` (a flag whose evaluation fails is left out). `{}` while no
   * bundle is loaded. Not sampled into telemetry.
   */
  allFlags(ctx?: Context): Record<string, JsonValue>;
  /**
   * Resolve a test session (`GET /v1/session`, once per token until it expires) and return an
   * evaluator scoped to it. Never rejects: an unknown or expired session yields an evaluator
   * whose `active` is false and that behaves like the client.
   */
  session(token: string | null | undefined, options?: SessionOptions): Promise<SessionEvaluator>;
  /**
   * Browser only. Remember `token` for this page session (sessionStorage) and route this client's
   * own accessors through the session while it is active. `null` leaves the session.
   * On servers use `session()` or `@nanoflags/sdk/node` instead: one client serves many requests.
   */
  useSession(token: string | null): Promise<SessionEvaluator>;
  /** Browser only. `{ "x-nanoflags-session": token }` while a page session is set, otherwise `{}`. */
  sessionHeaders(): Record<string, string>;
  on(event: "update", cb: (e: UpdateEvent) => void): () => void;
  /** Errors are `NanoFlagsError`s; those about loading the configuration carry `errorCode` (see `LoadErrorCode`). */
  on(event: "error", cb: (e: Error) => void): () => void;
  /** `client.state` changed (e.g. `starting` → `failed`, `failed` → `ready`). */
  on(event: "state", cb: (e: StateEvent) => void): () => void;
  /** Force a revalidation now. Resolves when it finished (successfully or not). */
  refresh(): Promise<void>;
  /**
   * Record a metric event for experiments, e.g. `track("checkout_completed", 42.5, { key: user.id })`. The unit is taken
   * from the context (`key`, and the unit attribute of every experiment in the bundle); only its SHA-256 hash, scoped to
   * the project and environment, is sent — never the context. Events whose name no metric uses are dropped by NanoFlags.
   * `value` is optional (needed for value metrics). Synchronous, never throws, never performs I/O itself.
   */
  track(eventName: string, ctx?: Context): void;
  track(eventName: string, value: number | null | undefined, ctx?: Context): void;
  /** Send queued telemetry, exposures and track events now. */
  flush(): Promise<void>;
  /** Stops timers, the stream and telemetry. Evaluations keep working on the last bundle. */
  close(): void;
  /** For external-store bindings (React): called on every bundle or status change. */
  subscribe(listener: () => void): () => void;
  /** Monotonic counter that changes whenever `subscribe` listeners fire. */
  readonly version: number;
}

/**
 * Lower-case classification of an `error` event. `rollback`: a validly signed configuration was refused because its
 * revision is older than one this client already verified for the environment (a replayed or stale response); the
 * configuration in use stays. Revisions only grow per environment (restoring an old revision publishes a new one).
 */
export type NanoFlagsErrorCode = "network" | "unauthorized" | "http" | "invalid_bundle" | "store" | "config" | "signature" | "session" | "engine" | "environment_deleted" | "log" | "cosign" | "shadow" | "rollback";

/** The `LoadErrorCode` an error code stands for, when it is about loading the configuration. */
function loadCodeOf(code: NanoFlagsErrorCode): LoadErrorCode | undefined {
  switch (code) {
    case "unauthorized":
      return "INVALID_KEY";
    case "network":
      return "EDGE_UNREACHABLE";
    case "http":
      return "HTTP_ERROR";
    case "invalid_bundle":
      return "INVALID_BUNDLE";
    case "signature":
    case "log":
    case "cosign":
    case "rollback":
      return "BUNDLE_REJECTED";
    case "engine":
      return "UNSUPPORTED_ENGINE";
    case "environment_deleted":
      return "ENVIRONMENT_DELETED";
    case "config":
      return "CONFIG";
    default:
      return undefined;
  }
}

export class NanoFlagsError extends Error {
  /** Upper-case classification of errors that can keep a configuration from loading (`LoadErrorCode`); undefined for others (`store`, `session`, `shadow`). */
  readonly errorCode: LoadErrorCode | undefined;
  constructor(
    message: string,
    readonly code: NanoFlagsErrorCode,
    readonly httpStatus?: number,
    errorCode?: LoadErrorCode,
  ) {
    super(message);
    this.name = "NanoFlagsError";
    this.errorCode = errorCode ?? loadCodeOf(code);
  }
}

interface QueuedEvent {
  flagKey: string;
  value: JsonValue;
  reason: string;
  ruleIndex?: number;
  revision: number;
  context: Record<string, JsonValue | undefined>;
  at: string;
  sessionId?: string;
  /** The sampling probability this event was recorded with, so the dashboard can estimate evaluations from samples. */
  sampleRate: number;
}

interface QueuedExposure {
  experiment: string;
  variant: string;
  /** Scope of the unit hash, computed when the batch is sent. */
  project: string;
  environment: string;
  attribute: string;
  identity: string;
}

interface QueuedTrack {
  event: string;
  value?: number;
  /** [attribute, identity] pairs; hashed with the bundle in use when the batch is sent. */
  units: [string, string][];
}

interface SessionState {
  id: string;
  bundle: Bundle;
  context: Context;
  expiresAt: string;
  expiresAtMs: number;
}

interface Persisted {
  v: 1;
  id: string;
  etag: string | null;
  checksum: string | null;
  savedAt: string;
  bundle: Bundle;
  /** Signature the bundle was accepted with, so a restored copy can be verified again. */
  sig?: SignatureInfo;
  /** Signed bundle text, kept only when it differs from `JSON.stringify(bundle)`. */
  raw?: string;
  /** The customer co-signature the bundle was accepted with (`coSignerKeys`). */
  cosign?: { kid: string; signature: string } | null;
  /** The newest transparency-log head this client has verified (`verifyLog`): the next one must extend it. */
  logHead?: TreeHead | null;
}

const MAX_QUEUE = 500;
/** Experiments: queued exposures / track events (each), items per request, units remembered for de-duplication. */
const MAX_EXPERIMENT_QUEUE = 5000;
const EXPERIMENT_BATCH = 100;
const MAX_EXPERIMENT_BATCHES_PER_FLUSH = 20;
const MAX_SEEN_EXPOSURES = 20_000;
/** Same rule as the edge and `metrics.event_name`. */
const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;
const MAX_BATCH = 50;
const MAX_EVENT_VALUE_CHARS = 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SESSIONS = 1000;
const SESSION_MISS_TTL_MS = 15_000;
const SESSION_ERROR_TTL_MS = 3_000;
const KEYS_REFETCH_MS = 60_000;
const STORAGE_KEY = "nanoflags:session";
const LIVE_CONNECT_TIMEOUT_MS = 10_000;
const LIVE_PING_MS = 30_000;
const LIVE_PONG_TIMEOUT_MS = 10_000;
const LIVE_MAX_BACKOFF_MS = 5 * 60_000;
/** A healthy socket is replaced after about this long, so the edge validates the key again (the edge drops sockets older than 2 h). */
const LIVE_ROTATE_MS = 50 * 60_000;
/**
 * Rollback check: right after a revision arrived over the live socket, the HTTP path (KV) may still answer the previous
 * one for a moment, and vice versa. Within this window an older answer from the other transport is refused silently;
 * outside it (or on the same transport) it is refused and reported (`rollback`).
 */
const ROLLBACK_GRACE_MS = 120_000;
/** How long a network answer waits for the stored bundle to be read (and verified) before the rollback check. */
const RESTORE_WAIT_MS = 2_000;

/** A session token is opaque; it only has to be safe to put in a header. */
export function isSessionToken(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]{1,512}$/.test(v);
}

type Timer = ReturnType<typeof setTimeout>;
function unref(t: Timer): Timer {
  // Never keep a Node process (or a serverless invocation) alive just for background work.
  (t as { unref?: () => void }).unref?.();
  return t;
}

function isBundle(v: unknown): v is Bundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  // A shadow bundle (migration 0179) is never configuration, whatever path it arrives on.
  return b.schema === 1 && typeof b.revision === "number" && typeof b.flags === "object" && b.flags !== null && !Array.isArray(b.flags) && typeof b.segments === "object" && b.segments !== null && b.shadow === undefined;
}

/** A shadow bundle: the bundle shape plus its `shadow` marker (inside the signed bytes). */
function isShadowBundle(v: unknown): v is ShadowBundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return b.schema === 1 && typeof b.revision === "number" && typeof b.flags === "object" && b.flags !== null && !Array.isArray(b.flags) && typeof b.segments === "object" && b.segments !== null && !Array.isArray(b.segments) && isShadowMarker(b.shadow);
}

function engineError(b: { revision?: unknown; engine?: unknown }): NanoFlagsError {
  return new NanoFlagsError(
    `Bundle r${String(b.revision)} needs evaluation engine ${JSON.stringify(b.engine)}; this SDK supports up to ${ENGINE_VERSION}. Upgrade @nanoflags/sdk. The configuration in use is unchanged.`,
    "engine",
  );
}

function typeOf(v: JsonValue | undefined): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/** Process-wide: the "server key in a browser" warning is logged at most once, however many clients are created. */
let warnedServerKeyInBrowser = false;

function warn(message: string): void {
  try {
    if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(`[nanoflags] ${message}`);
  } catch {
    /* logging must never break the client */
  }
}

/**
 * Spellings of the official edge address (case, `:443`, trailing dot, trailing slashes) are normalised to
 * `OFFICIAL_EDGE_URL`; any other address is left as given.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    if (u.protocol === "https:" && u.username === "" && u.password === "" && u.search === "" && u.hash === "" && (u.pathname === "/" || u.pathname === "") && (u.port === "" || u.port === "443") && u.hostname.replace(/\.$/, "") === new URL(OFFICIAL_EDGE_URL).hostname) return OFFICIAL_EDGE_URL;
  } catch {
    /* not a URL: left as given */
  }
  return trimmed;
}

export function createClient(options: ClientOptions): NanoFlagsClient {
  const sdkKey = options.sdkKey;
  const baseUrl = normalizeBaseUrl(String(options.baseUrl ?? ""));
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const doFetch: typeof fetch | undefined = options.fetch ?? (typeof fetch === "function" ? (input, init) => fetch(input, init) : undefined);
  const ev = options.events === false ? { enabled: false } : (options.events ?? {});
  const eventsEnabled = ev.enabled ?? true;
  const sampleRate = Math.min(1, Math.max(0, ev.sampleRate ?? 0.1));
  const flushIntervalMs = ev.flushIntervalMs ?? 10_000;
  const reportIntervalMs = ev.reportIntervalMs ?? 60_000;
  const livePollIntervalMs = options.livePollIntervalMs ?? 300_000;
  const random = ev.random ?? Math.random;
  const cryptoImpl = options.crypto;
  const sdkLabel = typeof options.sdkLabel === "string" && options.sdkLabel !== "" ? options.sdkLabel.slice(0, 40) : `js/${SDK_VERSION}`;
  const service = options.service ?? "unknown";
  /** Non-secret fingerprint binding persisted bundles to this key + edge. */
  const id = murmur3(`${baseUrl}|${sdkKey}`).toString(16).padStart(8, "0");
  const store: Store | null = options.store === false ? null : (options.store ?? defaultStore(id));
  const isBrowserKey = typeof sdkKey === "string" && sdkKey.startsWith("nf_pub_");
  const doc: Document | undefined = typeof document !== "undefined" ? document : undefined;

  // ---- state. `bundle` is only ever replaced as a whole, so every evaluation sees one consistent revision.
  let bundle: Bundle | null = null;
  let etag: string | null = null;
  let checksum: string | null = null;
  let status: ClientStatus = "not-ready";
  /** The first load attempt (store + network) has finished: without a bundle, `state` is then `failed`, not `starting`. */
  let attempted = false;
  let restoreDone = false;
  let lastError: LoadError | null = null;
  let reportedState: ClientState = "starting";
  let version = 0;
  let closed = false;
  let failures = 0;
  let lastSyncAt = 0;
  let pollTimer: Timer | null = null;
  let flushTimer: Timer | null = null;
  let inFlight: Promise<void> | null = null;
  let streamAbort: AbortController | null = null;
  let eventSource: EventSource | null = null;
  /** Bumped to stop the running SSE loop; `streamActive` is true while SSE (either flavour) is in use. */
  let streamGen = 0;
  let streamActive = false;
  let streamTriggered = false;
  const WS: WebSocketConstructor | undefined = options.webSocket ?? (typeof WebSocket === "function" ? (WebSocket as unknown as WebSocketConstructor) : undefined);
  const liveUrl = /^https?:\/\//i.test(baseUrl) ? `${baseUrl.replace(/^http/i, "ws")}/v1/live` : null;
  let socket: WebSocketLike | null = null;
  let liveOpen = false;
  let liveAttempt = 0;
  let liveTimer: Timer | null = null;
  /** The edge closed the socket with 4004: the environment was deleted. No more reconnects. */
  let environmentDeleted = false;
  /** Highest revision adopted from a push: a slower HTTP answer must never replace it with something older. */
  let liveRevision = 0;
  /**
   * Rollback protection (with `verify`): the newest revision this client adopted after verifying its signature — from
   * the network, a push or the store. Any later bundle with a lower revision is refused, signed or not. Only verified
   * revisions count, so an unverified source (bootstrap, an unsigned answer) can never block updates. One client serves
   * one SDK key, i.e. one environment, and verified bundles of another environment are already refused (`pin`).
   */
  let newestVerified: { revision: number; environmentId: string; seq: number; at: number; source: "live" | "http" | "store" } | null = null;
  /** Counts adoptions of verified revisions: an answer requested at sequence n is "older news" if a later one was adopted. */
  let verifiedSeq = 0;
  const noteVerified = (info: SignatureInfo, source: "live" | "http" | "store") => {
    verifiedSeq++;
    if (!newestVerified || info.revision >= newestVerified.revision) newestVerified = { revision: info.revision, environmentId: info.environmentId, seq: verifiedSeq, at: Date.now(), source };
  };
  /**
   * `revision` is older than the newest verified one: returns the `rollback` error to report, or null when the older
   * answer is explained by ordering (the newer one was accepted after this answer was requested, or arrived a moment
   * ago over the other transport). Either way the caller does not adopt it.
   */
  const rollbackError = (revision: number, requestedAtSeq: number, source: "live" | "http"): NanoFlagsError | null => {
    const n = newestVerified;
    if (!n || revision >= n.revision) return null;
    if (n.source !== "store" && (n.seq > requestedAtSeq || (n.source !== source && Date.now() - n.at < ROLLBACK_GRACE_MS))) return null;
    return new NanoFlagsError(
      `Bundle r${revision} was rejected: it is older than r${n.revision}, which this client already verified for this environment (a replayed or stale response; restoring an old revision in NanoFlags publishes a new, higher one). The configuration in use is unchanged.`,
      "rollback",
    );
  };
  let restoring: Promise<void> | null = null;
  let pushChain: Promise<void> = Promise.resolve();
  let lastReportAt = 0;
  /** `lifecycle` control state: paused = no background network activity; realtime = live socket / SSE allowed. */
  let paused = false;
  let realtimeAllowed = true;
  let lifecycleCleanup: (() => void) | null = null;
  const usedAttrs = new WeakMap<Bundle, Map<string, string[]>>();
  /**
   * Effective verification: `keys` to verify with (`"fetch"` = only `/v1/keys`), `require` = refuse unsigned bundles,
   * `refetch` = an unknown key id loads `/v1/keys` once (official edge with the embedded keys, or `"fetch"`).
   */
  const official = baseUrl === OFFICIAL_EDGE_URL;
  const verifyLog = options.verifyLog === true;
  const coSignerJwks = Array.isArray(options.coSignerKeys) ? options.coSignerKeys : [];
  const cosignWanted = Array.isArray(options.coSignerKeys);
  const allowEmergency = options.allowEmergencyWithoutCosign !== false;
  /** `verifyLog` / `coSignerKeys` need verified signatures: they imply `require: true`, and cannot work with `verify: false`. */
  const strict = verifyLog || cosignWanted;
  const strictBroken = strict && options.verify === false;
  const verifyOpt: { keys: readonly unknown[] | "fetch"; require: boolean; refetch: boolean } | null = (() => {
    const v = options.verify;
    if (v === false) return null;
    if (v === undefined || v === null) return official ? { keys: OFFICIAL_SIGNING_KEYS, require: true, refetch: true } : strict ? { keys: "fetch", require: true, refetch: true } : null;
    const keys = v.publicKeys === "fetch" ? "fetch" : Array.isArray(v.publicKeys) ? v.publicKeys : official ? OFFICIAL_SIGNING_KEYS : "fetch";
    return { keys, require: strict || (v.require ?? official), refetch: keys === "fetch" || (official && v.publicKeys === undefined) };
  })();
  let coSignerKeys: Promise<ImportedKey[]> | null = null;
  /** Newest verified transparency-log head (`verifyLog`). */
  let logHead: TreeHead | null = null;
  /** Co-signature of the bundle in use (persisted with it). */
  let cosignInUse: { kid: string; signature: string } | null = null;
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  if (isBrowser && typeof sdkKey === "string" && sdkKey.startsWith("nf_srv_") && !warnedServerKeyInBrowser) {
    warnedServerKeyInBrowser = true;
    warn("A server key (nf_srv_…) is being used in a browser. Server keys are secrets and must never be shipped to browsers: anyone can read them from the page. Create a client key (nf_pub_…) for browser code; it receives only client-exposed flags.");
  }
  let pinnedKeys: Promise<ImportedKey[]> | null = null;
  let fetchedKeys: ImportedKey[] = [];
  let keysFetchedAt = 0;
  let keysFetching: Promise<void> | null = null;
  let pinnedEnvironment: string | null = null;
  /** Shadow fetches waiting for the first verification to pin the environment (`awaitPinnedEnvironment`). */
  let pinWaiters: Array<() => void> = [];
  function pin(environmentId: string) {
    pinnedEnvironment = environmentId;
    const waiting = pinWaiters;
    pinWaiters = [];
    for (const w of waiting) w();
  }
  /** The environment the live configuration was verified for, waiting up to `ms` for the first verification. */
  function awaitPinnedEnvironment(ms = SHADOW_PIN_WAIT_MS): Promise<string | null> {
    if (pinnedEnvironment !== null || closed) return Promise.resolve(pinnedEnvironment);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(pinnedEnvironment);
      };
      const timer = unref(
        setTimeout(() => {
          pinWaiters = pinWaiters.filter((w) => w !== done);
          resolve(null);
        }, ms),
      );
      pinWaiters.push(done);
    });
  }
  let sig: SignatureInfo | null = null;
  let rawText: string | null = null;
  const sessions = new Map<string, { promise: Promise<SessionState | null>; until: number }>();
  let pageToken: string | null = null;
  let pageSession: SessionState | null = null;
  let pageResolved = false;
  let pageTimer: Timer | null = null;
  const queue: QueuedEvent[] = [];
  const xo = options.experiments === false ? { enabled: false } : (options.experiments ?? {});
  // Turning telemetry off (`events: false` or `events: { enabled: false }`) also turns experiments off, unless the
  // application opts back in explicitly with `experiments: { enabled: true }`.
  const telemetryOff = options.events === false || (typeof options.events === "object" && options.events?.enabled === false);
  const experimentsEnabled = xo.enabled ?? !telemetryOff;
  const experimentFlushMs = xo.flushIntervalMs ?? 5_000;
  const exposureQueue: QueuedExposure[] = [];
  const trackQueue: QueuedTrack[] = [];
  /** Exposures already queued in this process (experiment, unit, variant), oldest first: repeats are not sent again. */
  const seenExposures = new Set<string>();
  const unitAttrs = new WeakMap<Bundle, string[]>();
  let experimentTimer: Timer | null = null;
  let experimentDue = 0;
  let experimentFlushing: Promise<void> | null = null;
  const listeners = { update: new Set<(e: UpdateEvent) => void>(), error: new Set<(e: Error) => void>(), state: new Set<(e: StateEvent) => void>() };
  const subscribers = new Set<() => void>();

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((r) => (resolveReady = r));

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* a listener must never break the client */
    }
  };
  const currentState = (): ClientState => (status === "ready" ? "ready" : status === "stale" ? "stale" : attempted ? "failed" : "starting");
  const changed = () => {
    version++;
    for (const s of [...subscribers]) safely(s);
    const next = currentState();
    if (next !== reportedState) {
      const e: StateEvent = { state: next, previous: reportedState, error: lastError };
      reportedState = next;
      for (const cb of [...listeners.state]) safely(() => cb(e));
    }
  };
  /** Records a failure to load or update the configuration (`lastError`). Other errors (telemetry, sessions, shadow) never get here. */
  const noteLoadError = (e: NanoFlagsError) => {
    // Subscribers are not notified for this alone (they are on bundle and status changes, as before); `state` events carry it.
    lastError = { code: e.errorCode ?? "NO_BUNDLE", message: e.message, ...(e.httpStatus === undefined ? {} : { httpStatus: e.httpStatus }), reason: e.code, at: new Date().toISOString() };
  };
  /**
   * An update was refused (verification, rollback, unsupported engine, invalid): the configuration in use stays, but the
   * client now knows it is not on the current revision, so a loaded client turns `stale` until the edge confirms one.
   */
  /** Rejections of an answer the edge marked as unsigned (`verify.require`): transient publisher lag, status unchanged. */
  const unsignedRejections = new WeakSet<Error>();
  const updateRejected = (e: NanoFlagsError) => {
    noteLoadError(e);
    if (bundle) setStatus("stale");
    emitError(e);
  };
  /** The first load attempt has finished. Without a bundle the client is now `failed`. */
  const markAttempted = () => {
    if (attempted || closed) return;
    attempted = true;
    if (!bundle && lastError === null) lastError = { code: "NO_BUNDLE", message: "No configuration could be loaded: none was bootstrapped or stored, and the edge did not provide one.", at: new Date().toISOString() };
    if (currentState() !== reportedState) changed();
  };
  /** `transport` is derived from the socket and stream state: subscribers (React hooks) re-render when it changes. */
  let reportedTransport: Transport = "poll";
  const transportMaybeChanged = () => {
    const t: Transport = liveOpen ? "live" : streamActive ? "stream" : "poll";
    if (t === reportedTransport) return;
    reportedTransport = t;
    changed();
  };
  const setStatus = (next: ClientStatus) => {
    // The edge confirmed the configuration in use: the last failure is over.
    if (next === "ready") lastError = null;
    if (status === next) return;
    status = next;
    changed();
  };
  /** Error codes already logged because no `error` listener was attached (each is logged once per client). */
  const warnedCodes = new Set<string>();
  const emitError = (e: Error) => {
    if (listeners.error.size === 0) {
      const code = e instanceof NanoFlagsError ? e.code : e.name || "error";
      if (!warnedCodes.has(code)) {
        warnedCodes.add(code);
        warn(`${code}: ${e.message} (No "error" listener is attached: add client.on("error", …) before await ready() to handle this. Logged once per error code.)`);
      }
      return;
    }
    for (const cb of [...listeners.error]) safely(() => cb(e));
  };

  function adopt(next: Bundle, meta: { etag: string | null; checksum: string | null; status: ClientStatus; source: UpdateEvent["source"]; transport?: Transport; latencyMs?: number | null }) {
    const previousRevision = bundle ? bundle.revision : null;
    const isNew = !bundle || previousRevision !== next.revision || checksum !== meta.checksum;
    bundle = next; // single assignment: the swap is atomic for synchronous evaluations
    etag = meta.etag;
    checksum = meta.checksum;
    status = meta.status;
    if (meta.status === "ready") lastError = null;
    changed();
    resolveReady();
    if (isNew) {
      const e: UpdateEvent = { revision: next.revision, previousRevision, checksum: meta.checksum, source: meta.source, latencyMs: meta.latencyMs ?? null, transport: meta.transport ?? "poll" };
      for (const cb of [...listeners.update]) safely(() => cb(e));
    }
  }

  function persist() {
    if (!store || !bundle) return;
    const payload: Persisted = { v: 1, id, etag, checksum, savedAt: new Date().toISOString(), bundle, ...(sig ? { sig } : {}), ...(sig && rawText !== null ? { raw: rawText } : {}), ...(cosignInUse ? { cosign: cosignInUse } : {}), ...(logHead ? { logHead } : {}) };
    void Promise.resolve()
      .then(() => store.set(JSON.stringify(payload)))
      .catch(() => emitError(new NanoFlagsError("Could not persist the bundle.", "store")));
  }

  async function restore(): Promise<void> {
    if (!store) return;
    try {
      const raw = await store.get();
      if (!raw || closed) return;
      const p = JSON.parse(raw) as Partial<Persisted>;
      if (p.v !== 1 || p.id !== id || !isBundle(p.bundle)) return;
      if (!supportsEngine(p.bundle)) {
        const err = engineError(p.bundle);
        noteLoadError(err);
        return void emitError(err);
      }
      // Never replace something newer (network result or a newer bootstrap) with the stored copy.
      if (bundle && bundle.revision >= p.bundle.revision) return;
      let restored: Bundle = p.bundle;
      let restoredSig: SignatureInfo | null = null;
      let restoredRaw: string | null = null;
      if (verifyOpt) {
        // The store is outside the trust boundary: a signed copy must verify again, and with
        // `require` an unsigned copy is not used at all.
        const s = p.sig;
        if (s && typeof s.signature === "string" && typeof s.environmentId === "string" && typeof s.checksum === "string" && s.revision === p.bundle.revision) {
          const text = typeof p.raw === "string" ? p.raw : JSON.stringify(p.bundle);
          let ok = false;
          try {
            ok = await verifyBundleText(await loadKeys(s.kid ?? null), { signature: s.signature, kid: s.kid ?? null, environmentId: s.environmentId, revision: s.revision, checksum: s.checksum }, text, cryptoImpl);
            if (ok && typeof p.raw === "string") {
              const parsed: unknown = JSON.parse(p.raw);
              if (isBundle(parsed)) restored = parsed;
              else ok = false;
            }
          } catch {
            ok = false;
          }
          if (!ok) return void emitError(new NanoFlagsError("The persisted bundle failed signature verification and was ignored.", "signature"));
          restoredSig = { signature: s.signature, kid: s.kid ?? null, environmentId: s.environmentId, revision: s.revision, checksum: s.checksum };
          restoredRaw = typeof p.raw === "string" ? p.raw : null;
          // With co-signer keys a persisted copy must carry a valid customer signature too (emergency copies are not kept).
          if (cosignWanted) {
            const c = p.cosign;
            const text = typeof p.raw === "string" ? p.raw : JSON.stringify(p.bundle);
            if (!c || typeof c.kid !== "string" || typeof c.signature !== "string" || !(await verifyCosign(restoredSig, text, c))) return;
            cosignInUse = { kid: c.kid, signature: c.signature };
          }
          if (verifyLog && isTreeHead(p.logHead) && logHead === null) {
            try {
              if (await verifyHead(await loadKeys(p.logHead.kid), s.environmentId, p.logHead)) logHead = p.logHead;
            } catch {
              /* no baseline: the next head starts one */
            }
          }
        } else if (verifyOpt.require) return;
        if (closed || (bundle && bundle.revision >= restored.revision)) return;
      }
      sig = restoredSig;
      rawText = restoredRaw;
      if (restoredSig && pinnedEnvironment === null) pin(restoredSig.environmentId);
      // The stored copy is the newest this client verified before the restart: an older answer must not replace it.
      if (restoredSig) noteVerified(restoredSig, "store");
      // A restored bundle is usable but not known to be current: stale until the edge confirms it.
      adopt(restored, { etag: p.etag ?? null, checksum: p.checksum ?? null, status: "stale", source: "store" });
    } catch {
      emitError(new NanoFlagsError("Could not read the persisted bundle.", "store"));
    }
  }

  async function request(path: string, init: RequestInit): Promise<Response> {
    if (!doFetch) throw new NanoFlagsError("No fetch implementation available.", "config");
    const ac = new AbortController();
    let timedOut = false;
    const t = unref(
      setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, REQUEST_TIMEOUT_MS),
    );
    try {
      return await doFetch(`${baseUrl}${path}`, { ...init, signal: ac.signal, headers: { Authorization: `Bearer ${sdkKey}`, ...(init.headers as Record<string, string> | undefined) } });
    } catch (e) {
      if (timedOut) throw new NanoFlagsError(`Could not reach the NanoFlags edge: no answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, "network", undefined, "TIMEOUT");
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // ---- signature verification
  async function fetchKeys(): Promise<ImportedKey[]> {
    if (!doFetch) throw new NanoFlagsError("No fetch implementation available.", "config");
    const ac = new AbortController();
    const t = unref(setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS));
    try {
      // Public endpoint: the SDK key is deliberately not sent.
      const res = await doFetch(`${baseUrl}/v1/keys`, { method: "GET", signal: ac.signal });
      if (!res.ok) throw new NanoFlagsError(`Signing keys request failed with HTTP ${res.status}.`, "signature", res.status);
      const body = (await res.json()) as { keys?: unknown } | null;
      const keys = await importPublicKeys(Array.isArray(body?.keys) ? body.keys : [], cryptoImpl);
      if (keys.length === 0) throw new NanoFlagsError("The edge returned no usable signing keys.", "signature");
      return keys;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Keys to verify a signature by `kid` with: the pinned / embedded keys, plus those fetched from `/v1/keys`. With
   * `refetch`, a key id none of them has (rotation) loads `/v1/keys` once — again at most once a minute.
   */
  async function loadKeys(kid: string | null): Promise<ImportedKey[]> {
    if (!verifyOpt) return [];
    let base: ImportedKey[] = [];
    if (verifyOpt.keys !== "fetch") {
      const p = (pinnedKeys ??= importPublicKeys(verifyOpt.keys, cryptoImpl));
      // A failed import (no Ed25519 in this runtime) is not remembered.
      p.catch(() => {
        if (pinnedKeys === p) pinnedKeys = null;
      });
      base = await p;
    }
    const all = () => [...base, ...fetchedKeys];
    if (!verifyOpt.refetch) return base;
    const known = all();
    if (known.length > 0 && (kid === null || known.some((k) => k.kid === kid))) return known;
    if (keysFetchedAt !== 0 && Date.now() - keysFetchedAt < KEYS_REFETCH_MS) return known;
    keysFetching ??= fetchKeys()
      .then((keys) => {
        fetchedKeys = keys;
        keysFetchedAt = Date.now();
      })
      .finally(() => {
        keysFetching = null;
      });
    try {
      await keysFetching;
    } catch (e) {
      // Without any key at all the bundle cannot be checked (the next bundle tries again). With the embedded keys the
      // failed reload counts as the one reload of this minute, so a bad key id cannot make every poll ask for keys.
      if (base.length === 0) throw e;
      keysFetchedAt = Date.now();
    }
    return all();
  }

  /** Returns the bundle to adopt, or throws a NanoFlagsError with code "signature". */
  async function checkSignature(res: Response, text: string, body: { revision?: unknown; checksum?: unknown; bundle: Bundle }): Promise<{ bundle: Bundle; sig: SignatureInfo | null; raw: string | null }> {
    if (!verifyOpt) return { bundle: body.bundle, sig: null, raw: null };
    const reject = (why: string) => new NanoFlagsError(`Bundle r${body.bundle.revision} was rejected: ${why} The configuration in use is unchanged.`, "signature");
    if (res.headers.get("X-NanoFlags-Signed") !== "true") {
      if (verifyOpt.require) {
        const e = reject("it is not signed (the edge is still distributing it) and unsigned bundles are refused (`verify.require`); fetching again shortly.");
        unsignedRejections.add(e);
        throw e;
      }
      return { bundle: body.bundle, sig: null, raw: null };
    }
    const signature = res.headers.get("X-NanoFlags-Signature");
    const environmentId = res.headers.get("X-NanoFlags-Environment-Id");
    const kid = res.headers.get("X-NanoFlags-Key-Id");
    if (!signature || !environmentId || typeof body.checksum !== "string") throw reject("the signature headers are incomplete.");
    const revision = typeof body.revision === "number" ? body.revision : body.bundle.revision;
    if (revision !== body.bundle.revision) throw reject("the signed revision does not match the bundle.");
    if (pinnedEnvironment !== null && pinnedEnvironment !== environmentId) throw reject("it was signed for a different environment.");
    const info: SignatureInfo = { signature, kid, environmentId, revision, checksum: body.checksum };
    let keys: ImportedKey[];
    try {
      keys = await loadKeys(kid);
    } catch (e) {
      throw reject(`the signing keys could not be loaded (${e instanceof Error ? e.message : String(e)}).`);
    }
    try {
      // The edge embeds the stored bundle text byte-for-byte; fall back to re-serialisation.
      const raw = rawMember(text, "bundle");
      const again = JSON.stringify(body.bundle);
      if (raw !== null && raw !== again && (await verifyBundleText(keys, info, raw, cryptoImpl))) {
        const parsed: unknown = JSON.parse(raw);
        if (isBundle(parsed) && parsed.revision === revision) {
          pin(environmentId);
          return { bundle: parsed, sig: info, raw };
        }
      } else if (await verifyBundleText(keys, info, again, cryptoImpl)) {
        pin(environmentId);
        return { bundle: body.bundle, sig: info, raw: null };
      }
    } catch (e) {
      throw reject(`the signature could not be checked (${e instanceof Error ? e.message : String(e)}).`);
    }
    throw reject("its signature does not verify.");
  }

  // ---- co-signatures and the transparency log (migration 0174)
  async function verifyCosign(info: SignatureInfo, text: string, c: { kid: string; signature: string }): Promise<boolean> {
    coSignerKeys ??= importPublicKeys(coSignerJwks, cryptoImpl);
    const keys = await coSignerKeys;
    // A co-signature names its key: only that key is tried (`kid` must match).
    const named = keys.filter((k) => k.kid === c.kid);
    if (named.length === 0) return false;
    return verifyBundleText(named, { ...info, signature: c.signature, kid: c.kid }, text, cryptoImpl);
  }

  /** `/v1/log/proof` for a revision, retried briefly: the entry is written right after a revision is distributed. */
  async function fetchEvidence(revision: number): Promise<LogEvidence | null> {
    for (const wait of [0, 300, 700, 1500]) {
      if (wait) await new Promise<void>((r) => unref(setTimeout(r, wait)));
      if (closed) return null;
      try {
        const res = await request(`/v1/log/proof?revision=${revision}`, { method: "GET" });
        if (res.status === 404) {
          void res.body?.cancel().catch(() => undefined);
          continue;
        }
        if (!res.ok) return null;
        const v: unknown = await res.json();
        return isLogEvidence(v) ? v : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * The checks `coSignerKeys` and `verifyLog` add on top of the NanoFlags signature (already verified for `text`).
   * Throws a NanoFlagsError (`cosign` / `log`) when the configuration must not be applied. Commits the new log head only
   * when everything passed; returns the co-signature to keep with the bundle.
   */
  async function checkTrust(t: { info: SignatureInfo; text: string; next: Bundle; cosign: { kid: string; signature: string } | null; evidence: LogEvidence | null }): Promise<{ cosign: { kid: string; signature: string } | null; commit: () => void }> {
    const rev = t.info.revision;
    if (strictBroken) throw new NanoFlagsError(`Bundle r${rev} was rejected: \`verifyLog\` / \`coSignerKeys\` need signature verification, but \`verify\` is false. The configuration in use is unchanged.`, "config");
    let emergency = false;
    let cosign: { kid: string; signature: string } | null = null;
    if (cosignWanted) {
      if (t.cosign) {
        if (!(await verifyCosign(t.info, t.text, t.cosign))) throw new NanoFlagsError(`Bundle r${rev} was rejected: its co-signature does not verify with your co-signer keys. The configuration in use is unchanged.`, "cosign");
        cosign = t.cosign;
      } else if (allowEmergency && bundle && onlyTurnsFlagsOff(bundle as unknown as Record<string, unknown>, t.next as unknown as Record<string, unknown>)) {
        emergency = true;
      } else {
        throw new NanoFlagsError(`Bundle r${rev} was rejected: it carries no co-signature${allowEmergency ? " and is not an emergency revision that only turns flags off" : ""}. The configuration in use is unchanged.`, "cosign");
      }
    }
    if (!verifyLog) return { cosign, commit: () => undefined };
    const reject = (why: string) => new NanoFlagsError(`Bundle r${rev} was rejected: ${why} The configuration in use is unchanged; checking again shortly.`, "log");
    const evidence = t.evidence ?? (await fetchEvidence(rev));
    if (!evidence) throw reject("it is not in the transparency log (yet).");
    const checked = await checkEvidence(evidence, { environmentId: t.info.environmentId, revision: rev, checksum: t.info.checksum, text: t.text, browser: isBrowserKey }, cryptoImpl);
    if ("problem" in checked) throw reject(checked.problem);
    if (cosign && (checked.leaf.mode !== "cosigned" || checked.leaf.cosignerKid !== cosign.kid)) throw reject("the log does not record its co-signature.");
    if (emergency && checked.leaf.mode !== "emergency") throw reject("it has no co-signature and the log does not record it as an emergency revision.");
    const head = evidence.head;
    let keys: ImportedKey[];
    try {
      keys = await loadKeys(head.kid);
    } catch (e) {
      throw reject(`the signing keys could not be loaded (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (!(await verifyHead(keys, t.info.environmentId, head))) throw reject("its tree head is not signed by NanoFlags.");
    let next: TreeHead = head;
    const prev = logHead;
    if (prev) {
      if (prev.size === head.size) {
        if (prev.root !== head.root) throw reject("the log forked: two different trees of the same size.");
      } else {
        const [a, b] = prev.size < head.size ? [prev, head] : [head, prev];
        let proof: unknown = null;
        try {
          const res = await request(`/v1/log/consistency?first=${a.size}&second=${b.size}`, { method: "GET" });
          if (res.ok) proof = ((await res.json()) as { proof?: unknown }).proof;
          else void res.body?.cancel().catch(() => undefined);
        } catch {
          proof = null;
        }
        if (!Array.isArray(proof) || !proof.every((x) => typeof x === "string")) throw reject("the log's consistency proof could not be loaded.");
        if (!(await verifyConsistency(a.size, b.size, a.root, b.root, proof as string[], cryptoImpl))) throw reject("the log is not consistent with the history this client has seen (fork or rewrite).");
        next = b;
      }
    }
    return { cosign, commit: () => (logHead = next) };
  }

  async function syncOnce(): Promise<void> {
    try {
      await syncAttempt();
    } finally {
      // The first attempt counts once the store was read too (a stored bundle may still arrive from it).
      if (restoreDone) markAttempted();
    }
  }

  async function syncAttempt(): Promise<void> {
    lastSyncAt = Date.now();
    const requestedAt = verifiedSeq;
    const transport: Transport = streamTriggered ? "stream" : "poll";
    streamTriggered = false;
    try {
      const res = await request("/v1/bundle", { method: "GET", headers: etag ? { "If-None-Match": etag } : {} });
      if (closed) return;
      const servedStale = res.headers.get("X-NanoFlags-Stale") === "true";
      // Migration 0179: a change is being shadow-evaluated (fresh answers only; a stale answer says nothing about it).
      if ((res.status === 304 || res.ok) && !servedStale) noteShadow(res.headers.get("X-NanoFlags-Shadow"));
      if (res.status === 304) {
        failures = 0;
        if (bundle) setStatus(servedStale ? "stale" : "ready");
        return;
      }
      if (res.status === 401 || res.status === 403) throw new NanoFlagsError("The SDK key was rejected (unknown or revoked).", "unauthorized", res.status);
      if (!res.ok) throw new NanoFlagsError(`Bundle request failed with HTTP ${res.status}.`, "http", res.status);
      const text = await res.text();
      if (closed) return;
      const body = ((): { revision?: unknown; checksum?: string | null; bundle?: unknown } | null => {
        try {
          return JSON.parse(text) as { revision?: unknown; checksum?: string | null; bundle?: unknown } | null;
        } catch {
          return null;
        }
      })();
      if (!body || !isBundle(body.bundle)) throw new NanoFlagsError("The edge returned an invalid bundle.", "invalid_bundle");
      const verified = await checkSignature(res, text, body as { revision?: unknown; checksum?: unknown; bundle: Bundle });
      if (closed) return;
      const next = verified.bundle;
      if (verifyOpt && !servedStale) {
        // Rollback / replay: never adopt a revision older than one already verified (signed or not, fetched or polled).
        // The stored copy is read first, so a restart cannot be rolled back by an answer that beats the store.
        if (!restoreDone && restoring) await Promise.race([restoring, new Promise<void>((r) => unref(setTimeout(r, RESTORE_WAIT_MS)))]);
        if (closed) return;
        if (newestVerified && next.revision < newestVerified.revision) {
          const err = rollbackError(next.revision, requestedAt, "http");
          if (err) throw err;
          failures = 0;
          return;
        }
      }
      if (!supportsEngine(next)) throw engineError(next);
      let trusted: Awaited<ReturnType<typeof checkTrust>> | null = null;
      if (strict && verified.sig) {
        // The same signed message as the one in use (a signature binds environment, revision, checksum and the bundle's
        // bytes): nothing new to check.
        if (!(bundle && sig && bundle.revision === next.revision && sig.signature === verified.sig.signature)) {
          const cs = res.headers.get("X-NanoFlags-Cosignature");
          const ck = res.headers.get("X-NanoFlags-Cosigner-Key-Id");
          trusted = await checkTrust({ info: verified.sig, text: verified.raw ?? JSON.stringify(next), next, cosign: cs && ck ? { kid: ck, signature: cs } : null, evidence: decodeEvidence(res.headers.get("X-NanoFlags-Log")) });
          if (closed) return;
        }
      } else if (strict) throw new NanoFlagsError(`Bundle r${next.revision} was rejected: it is not signed. The configuration in use is unchanged.`, "signature");
      failures = 0;
      // The edge is serving its last-known-good copy: never go backwards because of it.
      if (servedStale && bundle && bundle.revision >= next.revision) {
        setStatus("stale");
        return;
      }
      // A revision that was pushed while this request was under way (or that KV does not point at yet) wins.
      if (bundle && next.revision < liveRevision && bundle.revision >= liveRevision) return;
      sig = verified.sig;
      rawText = verified.raw;
      if (trusted) {
        trusted.commit();
        cosignInUse = trusted.cosign;
      }
      if (verified.sig) noteVerified(verified.sig, "http");
      adopt(next, { etag: res.headers.get("ETag"), checksum: body.checksum ?? null, status: servedStale ? "stale" : "ready", source: "network", transport });
      persist();
    } catch (e) {
      if (closed) return;
      const err = e instanceof NanoFlagsError ? e : new NanoFlagsError(`Could not reach the NanoFlags edge: ${e instanceof Error ? e.message : String(e)}`, "network");
      // A bundle for a newer engine: nothing to retry quickly, the edge will answer the same until this SDK is upgraded.
      if (err.code === "engine" || unsignedRejections.has(err)) {
        // Not a reason for `stale` (status unchanged, `lastError` and `error` say it): an engine refusal lasts until the
        // SDK is upgraded, and an unsigned answer is the edge's own signal that the publisher is still signing the new
        // revision (typically well under a minute after every publish). Neither means the configuration was tampered with.
        if (err.code !== "engine") failures++;
        noteLoadError(err);
        return void emitError(err);
      }
      failures++;
      // A rejected update keeps the bundle in use, which is now known not to be current: `stale` (with `lastError`)
      // until the edge confirms a configuration again. Polling retries with backoff.
      if (err.code === "signature" || err.code === "log" || err.code === "cosign" || err.code === "config" || err.code === "rollback") return void updateRejected(err);
      noteLoadError(err);
      // A rejected key must not keep a socket: drop it (reconnects are refused by the edge and back off).
      if (err.code === "unauthorized") dropLive();
      // Keep evaluating with what we have; it is just no longer known to be current.
      if (bundle) setStatus("stale");
      emitError(err);
    }
  }

  /** Single-flight: concurrent triggers (poll, stream, visibility) share one request. */
  function sync(): Promise<void> {
    if (closed) return Promise.resolve();
    if (!inFlight) {
      inFlight = syncOnce().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function nextDelay(): number {
    const jitter = 0.8 + 0.4 * Math.random();
    // After failures, catch up quickly (1s, 2s, 4s … capped at the poll interval).
    // While the live socket is healthy, polling is only a safety net.
    const interval = liveOpen ? Math.max(pollIntervalMs, livePollIntervalMs) : pollIntervalMs;
    const base = failures > 0 ? Math.min(pollIntervalMs, 1000 * 2 ** Math.min(failures - 1, 10)) : interval;
    return Math.max(250, Math.round(base * jitter));
  }

  function schedulePoll() {
    if (closed || paused || pollIntervalMs <= 0) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = unref(
      setTimeout(() => {
        pollTimer = null;
        if (paused) return;
        // Hidden tabs do not poll; they catch up when they become visible again.
        if (doc && doc.visibilityState === "hidden") return schedulePoll();
        void sync().then(schedulePoll);
      }, nextDelay()),
    );
  }

  const onVisible = () => {
    if (closed || !doc || doc.visibilityState !== "visible") return void flush();
    if (Date.now() - lastSyncAt >= Math.min(pollIntervalMs > 0 ? pollIntervalMs : 30_000, 30_000) || failures > 0) void sync().then(schedulePoll);
  };
  const onOnline = () => {
    if (!closed) void sync().then(schedulePoll);
  };

  // ---- streaming: the stream only says "revision N exists"; the bundle is always fetched conditionally.
  function onRevision(data: string) {
    try {
      const m = JSON.parse(data) as { revision?: number; checksum?: string | null };
      if (!bundle || m.revision !== bundle.revision || (m.checksum ?? null) !== checksum || status !== "ready") {
        streamTriggered = true;
        void sync();
      }
    } catch {
      /* ignore malformed notifications */
    }
  }

  function startStream() {
    if (closed || paused || !realtimeAllowed || options.streaming === false || (!doFetch && !options.openStream) || streamActive || environmentDeleted) return;
    streamActive = true;
    transportMaybeChanged();
    const ES: typeof EventSource | undefined = typeof EventSource === "function" ? EventSource : undefined;
    if (ES && isBrowserKey && !options.openStream) {
      // EventSource cannot send headers; only browser keys may travel in the URL.
      const es = new ES(`${baseUrl}/v1/stream?key=${encodeURIComponent(sdkKey)}`);
      eventSource = es;
      es.addEventListener("revision", (e) => onRevision(String((e as MessageEvent).data)));
      es.addEventListener("revoked", () => {
        es.close();
        void sync();
      });
      return; // EventSource reconnects on its own.
    }
    void streamLoop(++streamGen);
  }

  function stopStream() {
    streamGen++;
    streamActive = false;
    streamAbort?.abort();
    streamAbort = null;
    eventSource?.close();
    eventSource = null;
    transportMaybeChanged();
  }

  const openStream: StreamOpener =
    options.openStream ??
    (async (url, init, onEvent) => {
      const res = await doFetch!(url, init);
      if (res.ok && res.body) await readSse(res.body, onEvent);
      return res.status;
    });

  async function streamLoop(gen: number) {
    let attempt = 0;
    const current = () => !closed && gen === streamGen;
    while (current()) {
      const ac = new AbortController();
      streamAbort = ac;
      const startedAt = Date.now();
      let stop = false;
      try {
        const status = await openStream(`${baseUrl}/v1/stream`, { headers: { Authorization: `Bearer ${sdkKey}`, Accept: "text/event-stream" }, signal: ac.signal }, (event, data) => {
          if (!current()) return;
          if (event === "revision") onRevision(data);
          else if (event === "revoked") {
            stop = true;
            ac.abort();
            void sync();
          }
        });
        if (status === 401 || status === 403) stop = true; // polling keeps reporting the error
      } catch {
        /* reconnect below */
      }
      if (!current()) return;
      if (stop) {
        streamActive = false;
        transportMaybeChanged();
        return;
      }
      attempt = Date.now() - startedAt > 30_000 ? 0 : attempt + 1;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random());
      await new Promise<void>((r) => unref(setTimeout(r, wait)));
    }
  }

  // ---- live socket: the edge pushes the signed bundle itself; nothing is fetched.
  const liveWanted = options.streaming !== false && options.live !== false && WS !== undefined && liveUrl !== null;

  function pushFailed(e: NanoFlagsError) {
    // Same as the request path: an unsupported engine leaves `status` unchanged (it lasts until the SDK is upgraded).
    if (e.code === "engine") {
      noteLoadError(e);
      return void emitError(e);
    }
    updateRejected(e);
  }

  /** Applies one `rev` / `hello` message. Never throws; a message that cannot be trusted changes nothing. */
  async function applyPush(m: Record<string, unknown>): Promise<void> {
    if (closed || (m.t !== "rev" && m.t !== "hello")) return;
    const revision = m.revision;
    // Revision 0 / no bundle: the environment has nothing published yet.
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || typeof m.bundle !== "string") return;
    const receivedAt = verifiedSeq;
    // Never backwards. An older push than a verified revision is checked first, so that a genuine (signed) replay is
    // reported as a rollback; anything else older is dropped silently, as before.
    const older = bundle !== null && revision < bundle.revision;
    if (older && !(verifyOpt && newestVerified && revision < newestVerified.revision)) return;
    const text = m.bundle;
    const pushedChecksum = typeof m.checksum === "string" ? m.checksum : null;

    let info: SignatureInfo | null = null;
    if (verifyOpt) {
      const reject = (why: string) => {
        updateRejected(new NanoFlagsError(`Pushed bundle r${revision} was rejected: ${why} The configuration in use is unchanged.`, "signature"));
        // Whatever sent this, the regular (verified) request path says what is really current.
        void sync();
      };
      if (typeof m.signature !== "string" || typeof m.environmentId !== "string" || pushedChecksum === null) return reject("it carries no complete signature.");
      if (pinnedEnvironment !== null && pinnedEnvironment !== m.environmentId) return reject("it was signed for a different environment.");
      info = { signature: m.signature, kid: typeof m.kid === "string" ? m.kid : null, environmentId: m.environmentId, revision, checksum: pushedChecksum };
      let ok = false;
      try {
        ok = await verifyBundleText(await loadKeys(info.kid), info, text, cryptoImpl);
      } catch {
        ok = false;
      }
      if (closed) return;
      if (!ok) return reject("its signature does not verify.");
    }
    if (older) {
      const err = rollbackError(revision, receivedAt, "live");
      if (err) {
        pushFailed(err);
        void sync(); // the regular request path says what is really current (and confirms `ready` again)
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isBundle(parsed) || parsed.revision !== revision) return void pushFailed(new NanoFlagsError("The edge pushed an invalid bundle; it was ignored.", "invalid_bundle"));
    if (!supportsEngine(parsed)) return void pushFailed(engineError(parsed));
    if (bundle && revision < bundle.revision) return;
    if (bundle && revision === bundle.revision) {
      failures = 0;
      // Already in use: the push only confirms that it is current.
      if (checksum === null || checksum === pushedChecksum) setStatus("ready");
      return;
    }
    let trusted: Awaited<ReturnType<typeof checkTrust>> | null = null;
    if (strict) {
      try {
        if (!info) throw new NanoFlagsError(`Pushed bundle r${revision} was rejected: it is not signed. The configuration in use is unchanged.`, "signature");
        const cs = typeof m.cosignature === "string" && typeof m.cosignerKid === "string" ? { kid: m.cosignerKid, signature: m.cosignature } : null;
        trusted = await checkTrust({ info, text, next: parsed, cosign: cs, evidence: isLogEvidence(m.log) ? m.log : null });
      } catch (e) {
        if (closed) return;
        pushFailed(e instanceof NanoFlagsError ? e : new NanoFlagsError(`Pushed bundle r${revision} could not be checked.`, "log"));
        // The regular request path tries again (with backoff) and may find the log entry by then.
        failures++;
        unref(setTimeout(() => void sync(), 3000));
        return;
      }
      if (closed || (bundle && revision <= bundle.revision)) return;
      trusted.commit();
      cosignInUse = trusted.cosign;
    }
    failures = 0;
    if (info) {
      pin(info.environmentId);
      noteVerified(info, "live");
    }
    sig = info;
    rawText = info && JSON.stringify(parsed) !== text ? text : null;
    liveRevision = revision;
    const committedAt = m.committedAt;
    adopt(parsed, {
      // What `/v1/bundle` would send as ETag for this revision, so the safety poll gets a 304.
      etag: pushedChecksum !== null ? `"${pushedChecksum}-${isBrowserKey ? "client" : "server"}"` : null,
      checksum: pushedChecksum,
      status: "ready",
      source: "network",
      transport: "live",
      latencyMs: typeof committedAt === "number" && Number.isFinite(committedAt) ? Date.now() - committedAt : null,
    });
    persist();
  }

  /** Closes the current socket; its close handler schedules the reconnect. */
  /** Ends the current socket now (handlers detached, `transport` updated at once); its end handler decides about reconnecting. */
  let endSocket: (() => void) | null = null;
  function dropLive() {
    if (endSocket) return endSocket();
    try {
      socket?.close(1000, "bye");
    } catch {
      /* not open */
    }
  }

  function connectLive(): void {
    if (closed || paused || !realtimeAllowed || !liveWanted || socket || environmentDeleted) return;
    let ws: WebSocketLike;
    try {
      // The key travels in the subprotocol list (browsers cannot set headers on a WebSocket) — never in the URL.
      ws = new WS!(liveUrl!, [LIVE_PROTOCOL, `key.${sdkKey}`]);
    } catch {
      return liveEnded(false, 0, false);
    }
    socket = ws;
    let opened = false;
    let done = false;
    let rotating = false;
    let openedAt = 0;
    let pingTimer: Timer | null = null;
    let pongTimer: Timer | null = null;
    let rotateTimer: Timer | null = null;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      if (pingTimer) clearTimeout(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      if (rotateTimer) clearTimeout(rotateTimer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (endSocket === end) endSocket = null;
      try {
        ws.close(1000, "bye");
      } catch {
        /* already closed */
      }
      if (socket === ws) socket = null;
      liveOpen = false;
      transportMaybeChanged();
      liveEnded(opened, opened ? Date.now() - openedAt : 0, rotating);
    };
    endSocket = end;
    const connectTimer = unref(setTimeout(end, LIVE_CONNECT_TIMEOUT_MS));
    const ping = () => {
      pingTimer = unref(
        setTimeout(() => {
          try {
            ws.send("ping");
          } catch {
            return end();
          }
          // The edge answers `pong` without waking anything up; silence means the connection is dead.
          pongTimer ??= unref(setTimeout(end, LIVE_PONG_TIMEOUT_MS));
          ping();
        }, LIVE_PING_MS * (0.9 + 0.2 * Math.random())),
      );
    };
    ws.onopen = () => {
      if (done) return;
      opened = true;
      openedAt = Date.now();
      liveOpen = true;
      clearTimeout(connectTimer);
      stopStream(); // SSE is not used while the socket is healthy (also reports the transport change)
      transportMaybeChanged();
      schedulePoll(); // the poll becomes a safety net
      ping();
      rotateTimer = unref(
        setTimeout(() => {
          rotating = true;
          end();
        }, LIVE_ROTATE_MS * (0.9 + 0.2 * Math.random())),
      );
    };
    ws.onmessage = (event: { data?: unknown }) => {
      if (done || typeof event?.data !== "string") return;
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = null;
      if (event.data === "pong") return;
      let m: unknown;
      try {
        m = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof m !== "object" || m === null || Array.isArray(m)) return;
      // One at a time, in arrival order: verification is asynchronous.
      pushChain = pushChain.then(() => applyPush(m as Record<string, unknown>)).catch(() => undefined);
    };
    ws.onclose = (event: { code?: unknown } | undefined) => {
      if (event?.code === CLOSE_ENVIRONMENT_DELETED) environmentDeleted = true;
      end();
    };
    ws.onerror = end;
  }

  function liveEnded(opened: boolean, openMs: number, rotating: boolean): void {
    if (closed) return;
    if (environmentDeleted) {
      // Keep evaluating the last bundle; it can no longer be updated. No socket, no stream; the regular poll stays
      // (it reports the key as rejected, and recovers if the environment turns out to exist after all).
      stopStream();
      if (bundle) setStatus("stale");
      pushFailed(new NanoFlagsError("The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated.", "environment_deleted"));
      schedulePoll();
      return;
    }
    // Paused (app in the background, offline) or realtime switched off: no reconnect, no SSE fallback.
    if (paused) return;
    if (!realtimeAllowed) return schedulePoll();
    if (rotating) return connectLive(); // planned replacement: no fallback, no backoff
    liveAttempt = opened && openMs > 30_000 ? 1 : liveAttempt + 1;
    // Never got through (no WebSocket path, socket cap reached, edge without /v1/live), or lost it and the
    // reconnect failed as well: SSE + polling take over until a socket opens again.
    if (!opened) startStream();
    // Back to the normal poll interval — only when a socket was actually lost: failed attempts must not keep pushing the poll out.
    else schedulePoll();
    const wait = Math.min(LIVE_MAX_BACKOFF_MS, 1000 * 2 ** Math.min(liveAttempt - 1, 10)) * (0.5 + Math.random());
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = unref(
      setTimeout(() => {
        liveTimer = null;
        connectLive();
      }, wait),
    );
  }

  function startRealtime() {
    if (closed || paused || !realtimeAllowed || options.streaming === false) return;
    if (liveWanted) connectLive();
    else startStream();
  }

  // ---- lifecycle control (platform integrations: app background/foreground, connectivity, data saver)
  function stopRealtime() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
    dropLive();
    stopStream();
  }

  const control: LifecycleControl = {
    get paused() {
      return paused;
    },
    pause() {
      if (closed || paused) return;
      paused = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (experimentTimer) clearTimeout(experimentTimer);
      experimentTimer = null;
      stopRealtime();
      void flush(true); // the app may be suspended next: send what is queued now
      void flushExperiments();
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      liveAttempt = 0;
      void sync().then(schedulePoll);
      scheduleFlush();
      scheduleExperiments();
      startRealtime();
    },
    setRealtime(enabled) {
      if (closed || realtimeAllowed === enabled) return;
      realtimeAllowed = enabled;
      if (!enabled) {
        stopRealtime();
        schedulePoll();
      } else {
        liveAttempt = 0;
        startRealtime();
      }
    },
  };

  // ---- telemetry (off the hot path: evaluation only pushes into a bounded array)
  function attrsUsedBy(b: Bundle | null, flagKey: string): string[] {
    let cache = b ? usedAttrs.get(b) : undefined;
    if (b && !cache) usedAttrs.set(b, (cache = new Map()));
    const hit = cache?.get(flagKey);
    if (hit) return hit;
    const names = new Set<string>();
    const flag = b && Object.prototype.hasOwnProperty.call(b.flags, flagKey) ? b.flags[flagKey] : undefined;
    const visit = (conditions: Condition[], depth: number) => {
      for (const c of conditions) {
        if (c.op === "segment" || c.op === "not_segment") {
          const seg = b && typeof c.value === "string" && Object.prototype.hasOwnProperty.call(b.segments, c.value) ? b.segments[c.value] : undefined;
          if (seg && depth < 4) visit(seg.conditions, depth + 1);
        } else if (c.attribute) names.add(c.attribute);
      }
    };
    try {
      for (const r of flag?.rules ?? []) {
        visit(r.conditions, 0);
        if (r.serve.type === "rollout") names.add(r.serve.bucketBy ?? "key");
      }
    } catch {
      /* malformed flag: report nothing */
    }
    const list = [...names];
    cache?.set(flagKey, list);
    return list;
  }

  function defaultRedact(b: Bundle | null, flagKey: string, ctx: Context): Record<string, JsonValue | undefined> {
    const out: Record<string, JsonValue> = {};
    for (const name of attrsUsedBy(b, flagKey)) {
      if (Object.prototype.hasOwnProperty.call(ctx, name) && ctx[name] !== undefined) out[name] = typeOf(ctx[name]);
    }
    return out;
  }

  function record(e: Evaluation, ctx: Context, b: Bundle | null, sessionId: string | undefined) {
    if (!eventsEnabled || closed || sampleRate <= 0 || random() >= sampleRate) return;
    if (queue.length >= MAX_QUEUE) return; // bounded: drop instead of growing
    try {
      queue.push({
        flagKey: e.flagKey,
        value: e.value,
        reason: e.reason,
        ...(e.ruleIndex === undefined ? {} : { ruleIndex: e.ruleIndex }),
        revision: e.revision,
        context: ev.redact ? ev.redact({ ...ctx }) : defaultRedact(b, e.flagKey, ctx),
        at: new Date().toISOString(),
        ...(sessionId === undefined ? {} : { sessionId }),
        sampleRate,
      });
    } catch {
      /* telemetry must never affect evaluation */
    }
  }

  async function flush(force = false): Promise<void> {
    if (!eventsEnabled || !doFetch) return;
    // Shadow counters ride along at most once a minute (or now: flush(), pause, close, a new shadow session).
    let shadowReport: ReturnType<ShadowCounters["report"]> | null = null;
    if (shadowCounters && shadowCounters.size > 0 && (force || Date.now() - shadowFlushedAt >= SHADOW_FLUSH_MS)) {
      shadowReport = shadowCounters.report(serviceVersion);
      shadowCounters = new ShadowCounters(shadowCounters.sessionId, shadowCounters.checksum);
      shadowFlushedAt = Date.now();
    }
    // One request per interval: the service report plus up to one batch. Anything beyond that waits.
    const batch = queue.splice(0, MAX_BATCH).map((e) => {
      let value: JsonValue = e.value;
      try {
        if (typeof value === "object" && value !== null && JSON.stringify(value).length > MAX_EVENT_VALUE_CHARS) value = null;
        else if (typeof value === "string" && value.length > MAX_EVENT_VALUE_CHARS) value = value.slice(0, MAX_EVENT_VALUE_CHARS);
      } catch {
        value = null;
      }
      return { ...e, flagKey: e.flagKey.slice(0, 63), value };
    });
    lastReportAt = Date.now();
    try {
      await request("/v1/events", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, sdk: sdkLabel, revision: bundle?.revision ?? 0, events: batch, ...(shadowReport ? { shadow: shadowReport } : {}) }),
      });
    } catch {
      /* dropped on failure, by design: telemetry is never retried */
    }
  }

  function scheduleFlush() {
    if (closed || paused || !eventsEnabled || flushIntervalMs <= 0) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = unref(
      setTimeout(() => {
        flushTimer = null;
        // Nothing queued: the service report alone goes out once per report interval.
        if (queue.length === 0 && Date.now() - lastReportAt < reportIntervalMs) return scheduleFlush();
        void flush().then(scheduleFlush);
      }, flushIntervalMs),
    );
  }

  // ---- experiments: exposures and track() (never on the evaluation path beyond a Set lookup)
  function recordExposure(e: Evaluation, ctx: Context, b: Bundle | null) {
    if (!experimentsEnabled || closed || !b) return;
    try {
      const flag = Object.prototype.hasOwnProperty.call(b.flags, e.flagKey) ? b.flags[e.flagKey] : undefined;
      if (!flag || !flag.experiment) return;
      const x = exposureOf(flag, e, ctx);
      if (!x) return;
      const attribute = flag.experiment.unit ?? "key";
      const seen = `${x.experiment}\n${attribute}\n${x.variant}\n${x.unit}`;
      if (seenExposures.has(seen)) return;
      if (exposureQueue.length >= MAX_EXPERIMENT_QUEUE) return; // bounded: drop instead of growing
      seenExposures.add(seen);
      if (seenExposures.size > MAX_SEEN_EXPOSURES) seenExposures.delete(seenExposures.values().next().value as string);
      exposureQueue.push({ experiment: x.experiment, variant: x.variant, project: b.project, environment: b.environment, attribute, identity: x.unit });
      if (exposureQueue.length >= EXPERIMENT_BATCH) kickExperiments();
    } catch {
      /* experiments must never affect evaluation */
    }
  }

  /** Unit attributes a track event is reported under: `key` plus the unit attribute of every experiment in the bundle. */
  function trackAttributes(b: Bundle | null): string[] {
    if (!b) return ["key"];
    const hit = unitAttrs.get(b);
    if (hit) return hit;
    const names = new Set<string>(["key"]);
    try {
      for (const f of Object.values(b.flags)) if (f && f.experiment && typeof f.experiment.unit === "string") names.add(f.experiment.unit);
    } catch {
      /* malformed bundle: key only */
    }
    const list = [...names];
    unitAttrs.set(b, list);
    return list;
  }

  function track(eventName: string, value?: number | Context | null, ctx?: Context): void {
    if (!experimentsEnabled || closed) return;
    try {
      let v: number | undefined;
      let c: Context | undefined;
      if (typeof value === "number") {
        v = value;
        c = ctx;
      } else if (value === null || value === undefined) c = ctx;
      else c = value;
      if (typeof eventName !== "string" || !EVENT_NAME.test(eventName)) {
        emitError(new NanoFlagsError(`track(): ${JSON.stringify(eventName)} is not a valid event name (1–64 letters, digits, _ . : / -, starting with a letter or digit). The event was dropped.`, "config"));
        return;
      }
      if (v !== undefined && !(Number.isFinite(v) && Math.abs(v) < 1e15)) {
        emitError(new NanoFlagsError(`track("${eventName}"): the value must be a finite number. The event was dropped.`, "config"));
        return;
      }
      // A browser page inside a test session is QA traffic.
      if (live(pageSession)) return;
      const context: Context = c ?? {};
      const units: [string, string][] = [];
      for (const attribute of trackAttributes(bundle)) {
        const id = Object.prototype.hasOwnProperty.call(context, attribute) ? context[attribute] : undefined;
        if ((typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id))) units.push([attribute, String(id)]);
      }
      if (units.length === 0 || trackQueue.length >= MAX_EXPERIMENT_QUEUE) return;
      trackQueue.push(v === undefined ? { event: eventName, units } : { event: eventName, value: v, units });
      if (trackQueue.length >= EXPERIMENT_BATCH) kickExperiments();
    } catch {
      /* track() never throws */
    }
  }

  /**
   * Sends queued exposures first (so a conversion rarely arrives before its exposure; the database also waits up to
   * 10 minutes for it), then track events. Exposures are re-queued after a network error, 429 or 5xx (the database
   * de-duplicates them); track events are sent at most once.
   */
  async function sendExperiments(): Promise<void> {
    if (!doFetch || baseUrl === "") return;
    for (let i = 0; i < MAX_EXPERIMENT_BATCHES_PER_FLUSH && exposureQueue.length > 0; i++) {
      const batch = exposureQueue.splice(0, EXPERIMENT_BATCH);
      let retry = false;
      try {
        const exposures = batch.map((e) => ({ experiment: e.experiment, variant: e.variant, unit: unitHash(e.project, e.environment, e.attribute, e.identity) }));
        const res = await request("/v1/exposures", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdk: sdkLabel, exposures }) });
        retry = res.status === 429 || res.status >= 500;
      } catch {
        retry = true;
      }
      if (retry) {
        exposureQueue.unshift(...batch.slice(0, Math.max(0, MAX_EXPERIMENT_QUEUE - exposureQueue.length)));
        break;
      }
    }
    for (let i = 0; i < MAX_EXPERIMENT_BATCHES_PER_FLUSH && trackQueue.length > 0; i++) {
      const b = bundle;
      if (!b) break; // the unit hash needs the project and environment: wait for a bundle
      const items: { event: string; unit: string; value?: number }[] = [];
      while (trackQueue.length > 0 && items.length < EXPERIMENT_BATCH) {
        const t = trackQueue.shift()!;
        for (const [attribute, identity] of t.units) {
          const unit = unitHash(b.project, b.environment, attribute, identity);
          items.push(t.value === undefined ? { event: t.event, unit } : { event: t.event, unit, value: t.value });
        }
      }
      try {
        await request("/v1/track", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdk: sdkLabel, events: items }) });
      } catch {
        /* at most once, by design */
      }
    }
  }

  function flushExperiments(): Promise<void> {
    if (!experimentsEnabled) return Promise.resolve();
    if (experimentFlushing) return experimentFlushing.then(() => (exposureQueue.length || trackQueue.length ? flushExperiments() : undefined));
    experimentFlushing = sendExperiments().finally(() => {
      experimentFlushing = null;
    });
    return experimentFlushing;
  }

  function scheduleExperiments(delay = experimentFlushMs) {
    if (closed || paused || !experimentsEnabled || experimentFlushMs <= 0) return;
    // Never postpone a flush that is already due sooner (a full batch kicked one).
    const due = Date.now() + delay;
    if (experimentTimer && experimentDue <= due) return;
    if (experimentTimer) clearTimeout(experimentTimer);
    experimentDue = due;
    experimentTimer = unref(
      setTimeout(() => {
        experimentTimer = null;
        if (exposureQueue.length === 0 && trackQueue.length === 0) return scheduleExperiments();
        void flushExperiments().then(() => scheduleExperiments());
      }, delay),
    );
  }

  /** A full batch is waiting: send soon instead of at the end of the interval. */
  function kickExperiments() {
    if (closed || paused || experimentFlushing) return;
    scheduleExperiments(0);
  }

  // ---- shadow evaluation of drafts (migration 0179; src/shadow.ts). Never changes what the app gets.
  const shadowOpt: ShadowOptions = options.shadow === false ? { enabled: false } : (options.shadow ?? {});
  const shadowEnabled = (shadowOpt.enabled ?? true) && eventsEnabled;
  const shadowRate = Math.min(1, Math.max(0, typeof shadowOpt.sampleRate === "number" && Number.isFinite(shadowOpt.sampleRate) ? shadowOpt.sampleRate : 0.1));
  const shadowRandom = shadowOpt.random ?? Math.random;
  const serviceVersion = typeof options.serviceVersion === "string" && options.serviceVersion.trim() !== "" ? options.serviceVersion.trim().slice(0, 40) : undefined;
  /** The verified shadow bundle in use, and the flags it changes compared with the live bundle (recomputed per live bundle). */
  let shadowState: { bundle: ShadowBundle; live: Bundle | null; changed: Set<string> } | null = null;
  let shadowCounters: ShadowCounters | null = null;
  let shadowFlushedAt = Date.now();
  let shadowFetch: { id: string; at: number; running: boolean } | null = null;
  let shadowKeys: Promise<ImportedKey[]> | null = null;

  function dropShadow() {
    if (shadowCounters && shadowCounters.size > 0) void flush(true);
    shadowState = null;
    shadowCounters = null;
  }

  /** `X-NanoFlags-Shadow` of a fresh `/v1/bundle` answer: fetch the announced shadow bundle, or drop the one in use. */
  function noteShadow(header: string | null) {
    if (!shadowEnabled || closed) return;
    const want = parseShadowHeader(header);
    if (!want) return dropShadow();
    const m = shadowState?.bundle.shadow;
    if (m && m.sessionId === want.sessionId && m.checksum === want.checksum) return;
    const id = `${want.sessionId}.${want.checksum}`;
    if (shadowFetch && shadowFetch.id === id && (shadowFetch.running || Date.now() - shadowFetch.at < SHADOW_RETRY_MS)) return;
    const entry = { id, at: Date.now(), running: true };
    shadowFetch = entry;
    void fetchShadow(want)
      .then((skipped) => {
        // Skipped (no verified live configuration yet): not an attempt, so the next announcement retries at once.
        if (skipped === true && shadowFetch === entry) shadowFetch = null;
      })
      .finally(() => {
        entry.running = false;
        entry.at = Date.now();
      });
  }

  /** Keys a shadow bundle is checked with: the configured ones, or (verification off for this edge) `/v1/keys`. */
  async function shadowVerifyKeys(kid: string | null): Promise<ImportedKey[]> {
    if (verifyOpt) return loadKeys(kid);
    const p = (shadowKeys ??= fetchKeys());
    p.catch(() => {
      if (shadowKeys === p) shadowKeys = null;
    });
    return p;
  }

  /** Loads and verifies a shadow bundle. Only a bundle signed for this session, with a matching marker inside, is used. */
  /** Loads and checks an announced shadow bundle. Resolves `true` when it was skipped (no verified live configuration). */
  async function fetchShadow(want: { sessionId: string; checksum: string }): Promise<boolean | void> {
    const reject = (why: string) =>
      emitError(new NanoFlagsError(`The shadow bundle of session ${want.sessionId} was ignored: ${why} Nothing changes for the app (shadow bundles are never applied).`, "shadow"));
    try {
      const res = await request("/v1/shadow", { method: "GET", cache: "no-store" });
      if (closed) return;
      if (res.status === 404) return dropShadow();
      if (!res.ok) return;
      const text = await res.text();
      const body = JSON.parse(text) as { sessionId?: unknown; checksum?: unknown } | null;
      // Already replaced by a newer session: the next bundle answer announces that one.
      if (!body || body.sessionId !== want.sessionId || body.checksum !== want.checksum) return;
      const raw = rawMember(text, "bundle");
      const signature = res.headers.get("X-NanoFlags-Signature");
      const kid = res.headers.get("X-NanoFlags-Key-Id");
      const environmentId = res.headers.get("X-NanoFlags-Environment-Id");
      if (!signature || !environmentId || raw === null) return reject("it is not signed.");
      // Bound to the environment of the verified live configuration. The announcement comes with a /v1/bundle answer
      // whose own verification (which pins the environment) may still be running: wait for it rather than skip the
      // check. Without verification nothing is ever pinned.
      const pinned = verifyOpt ? await awaitPinnedEnvironment() : pinnedEnvironment;
      if (closed) return;
      if (verifyOpt && pinned === null) return true; // no verified live configuration yet: the next announcement retries
      if (pinned !== null && pinned !== environmentId) return reject("it was signed for a different environment.");
      let ok = false;
      try {
        ok = await verifyShadowText(await shadowVerifyKeys(kid), { signature, kid, environmentId, sessionId: want.sessionId, checksum: want.checksum }, raw, cryptoImpl);
      } catch {
        ok = false;
      }
      if (closed) return;
      if (!ok) return reject("its signature does not verify.");
      const parsed: unknown = JSON.parse(raw);
      if (!isShadowBundle(parsed)) return reject("it is not a shadow bundle.");
      const m = parsed.shadow;
      if (m.sessionId !== want.sessionId || m.checksum !== want.checksum || m.environmentId !== environmentId) return reject("its shadow marker does not match.");
      if (!supportsEngine(parsed)) return;
      if (shadowCounters && shadowCounters.size > 0) void flush(true);
      shadowState = { bundle: parsed, live: null, changed: new Set() };
      shadowCounters = new ShadowCounters(want.sessionId, want.checksum);
    } catch {
      /* shadow evaluation never affects the app */
    }
  }

  /** After a live evaluation: for a sample of the flags the draft changes, evaluate the draft too and count. */
  function shadowEvaluate<T extends JsonValue>(key: string, fallback: T, context: Context, accepts: ((v: unknown) => boolean) | null, live: Evaluation<T>, b: Bundle) {
    const st = shadowState;
    const counters = shadowCounters;
    if (!st || !counters || shadowRate <= 0) return;
    try {
      if (st.live !== b) {
        st.live = b;
        st.changed = changedFlags(b, st.bundle);
      }
      if (!st.changed.has(key) || shadowRandom() >= shadowRate) return;
      const r = engineEvaluate<T>(st.bundle, key, context, fallback);
      // A side that used the app's own fallback is reported as "<fallback>": that value is the app's, not a bundle's (flag
      // missing on that side, evaluation error, or a value of the wrong type, which run() already turned into "error").
      const liveFallback = live.reason === "flag_not_found" || live.reason === "error";
      const shadowFallback = r.reason === "flag_not_found" || r.reason === "error" || (accepts !== null && !accepts(r.value));
      counters.add(key, live.value, shadowFallback ? fallback : r.value, r.reason === "rule_match" ? r.ruleIndex : undefined, liveFallback, shadowFallback);
    } catch {
      /* shadow evaluation never affects the app */
    }
  }

  // ---- evaluation
  const live = (s: SessionState | null): SessionState | null => (s !== null && Date.now() < s.expiresAtMs ? s : null);

  /** `scope` undefined: the client's own accessors (which follow the browser page session, if any). */
  function run<T extends JsonValue>(key: string, fallback: T, ctx: Context | undefined, accepts: ((v: unknown) => boolean) | null, scope?: SessionState | null): Evaluation<T> {
    const s = live(scope === undefined ? pageSession : scope);
    const b = s ? s.bundle : bundle;
    const context: Context = s ? { ...s.context, ...ctx } : (ctx ?? {});
    let result = engineEvaluate<T>(b, key, context, fallback);
    if (accepts && result.reason !== "flag_not_found" && result.reason !== "error" && !accepts(result.value)) {
      const error = `Flag "${key}" has a ${typeOf(result.value as JsonValue)} value, which does not match the requested type.`;
      result = { flagKey: key, value: fallback, reason: "error", revision: result.revision, trace: [...result.trace, { kind: "result", title: "Returned the fallback", detail: error }], error, errorCode: "TYPE_MISMATCH" };
    }
    record(result as Evaluation, context, b, s?.id);
    // Test sessions evaluate a pinned bundle for QA: synthetic traffic is never an exposure.
    if (!s) recordExposure(result as Evaluation, context, b);
    // Test sessions evaluate their own snapshot: never shadowed.
    if (shadowState && !s && b) shadowEvaluate(key, fallback, context, accepts, result, b);
    return result;
  }

  // ---- test sessions
  function evaluatorFor(state: SessionState | null): SessionEvaluator {
    return {
      get active() {
        return live(state) !== null;
      },
      id: state ? state.id : null,
      expiresAt: state ? state.expiresAt : null,
      get revision() {
        const s = live(state);
        return s ? s.bundle.revision : bundle ? bundle.revision : null;
      },
      boolean: (key, fallback, ctx) => run(key, fallback, ctx, (v) => typeof v === "boolean", state).value,
      string: (key, fallback, ctx) => run(key, fallback, ctx, (v) => typeof v === "string", state).value,
      number: (key, fallback, ctx) => run(key, fallback, ctx, (v) => typeof v === "number" && Number.isFinite(v), state).value,
      json: (key, fallback, ctx) => run(key, fallback, ctx, (v) => v !== undefined, state).value,
      evaluate: (key, fallback, ctx) => run(key, fallback, ctx, null, state),
    };
  }

  /** Resolves to null for "no such session" (unknown, expired, revoked, service not permitted) and on any failure. */
  async function fetchSession(token: string, serviceName: string | undefined): Promise<{ state: SessionState | null; failed: boolean }> {
    try {
      const res = await request("/v1/session", { method: "GET", cache: "no-store", headers: { "X-NanoFlags-Session": token, ...(serviceName ? { "X-NanoFlags-Service": serviceName } : {}) } });
      if (res.status === 404) return { state: null, failed: false };
      if (!res.ok) throw new NanoFlagsError(`Session request failed with HTTP ${res.status}.`, res.status === 401 || res.status === 403 ? "unauthorized" : "session", res.status);
      const body = (await res.json()) as { id?: unknown; context?: unknown; expires_at?: unknown; bundle?: unknown } | null;
      const expiresAtMs = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
      if (!body || typeof body.id !== "string" || !isBundle(body.bundle) || !Number.isFinite(expiresAtMs)) throw new NanoFlagsError("The edge returned an invalid session.", "session");
      if (expiresAtMs <= Date.now()) return { state: null, failed: false };
      const context = typeof body.context === "object" && body.context !== null && !Array.isArray(body.context) ? (body.context as Context) : {};
      return { state: { id: body.id, bundle: body.bundle, context, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs }, failed: false };
    } catch (e) {
      // A timeout of the session request stays a `session` error, as before (`request` reports it as `network`).
      if (!closed) emitError(e instanceof NanoFlagsError && e.code !== "network" ? e : new NanoFlagsError(`Could not load the test session: ${e instanceof Error ? e.message : String(e)}`, "session"));
      return { state: null, failed: true };
    }
  }

  function resolveSession(token: string | null | undefined, opts: SessionOptions | undefined): Promise<SessionState | null> {
    if (!isSessionToken(token) || closed || baseUrl === "") return Promise.resolve(null);
    const serviceName = opts?.service ?? options.service;
    const cacheKey = `${serviceName ?? ""}\n${token}`;
    const now = Date.now();
    const hit = sessions.get(cacheKey);
    if (hit && now < hit.until) return hit.promise;
    sessions.delete(cacheKey);
    if (sessions.size >= MAX_SESSIONS) {
      for (const [k, v] of sessions) if (now >= v.until) sessions.delete(k);
      // Still full: drop the oldest entries (insertion order).
      for (const k of sessions.keys()) {
        if (sessions.size < MAX_SESSIONS) break;
        sessions.delete(k);
      }
    }
    const entry = { promise: Promise.resolve<SessionState | null>(null), until: Number.POSITIVE_INFINITY };
    entry.promise = fetchSession(token, serviceName).then(({ state, failed }) => {
      entry.until = state ? state.expiresAtMs : Date.now() + (failed ? SESSION_ERROR_TTL_MS : SESSION_MISS_TTL_MS);
      return state;
    });
    sessions.set(cacheKey, entry);
    return entry.promise;
  }

  function pageStorage(): Storage | null {
    try {
      return isBrowser && typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch {
      return null; // storage access can throw (blocked cookies, sandboxed frames)
    }
  }

  function setPageSession(state: SessionState | null, resolved: boolean) {
    if (pageTimer) clearTimeout(pageTimer);
    pageTimer = null;
    pageSession = state;
    pageResolved = resolved;
    if (state) {
      // Re-render subscribers when the session ends, so the page returns to the normal configuration.
      const wait = Math.min(Math.max(0, state.expiresAtMs - Date.now()) + 50, 2_147_000_000);
      pageTimer = unref(setTimeout(() => {
        pageTimer = null;
        if (pageSession === state) changed();
      }, wait));
    }
    changed();
  }

  async function usePageSession(token: string | null): Promise<SessionEvaluator> {
    if (!isBrowser) {
      // One server client serves many requests: a client-wide session would leak between them.
      if (token !== null) emitError(new NanoFlagsError("useSession() is for browsers. On servers use client.session(token) or @nanoflags/sdk/node.", "config"));
      return evaluatorFor(null);
    }
    const storage = pageStorage();
    if (!isSessionToken(token)) {
      pageToken = null;
      try {
        storage?.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setPageSession(null, false);
      return evaluatorFor(null);
    }
    pageToken = token;
    try {
      storage?.setItem(STORAGE_KEY, token);
    } catch {
      /* the token still applies to this page load */
    }
    const state = await resolveSession(token, undefined);
    if (pageToken === token) setPageSession(state, true);
    return evaluatorFor(state);
  }

  const client: NanoFlagsClient = {
    ready: () => readyPromise,
    get status() {
      return status;
    },
    get state() {
      return currentState();
    },
    get lastError() {
      return lastError;
    },
    get revision() {
      return bundle ? bundle.revision : null;
    },
    get version() {
      return version;
    },
    get transport(): Transport {
      return liveOpen ? "live" : streamActive ? "stream" : "poll";
    },
    boolean: (key, fallback, ctx) => run(key, fallback, ctx, (v) => typeof v === "boolean").value,
    string: (key, fallback, ctx) => run(key, fallback, ctx, (v) => typeof v === "string").value,
    number: (key, fallback, ctx) => run(key, fallback, ctx, (v) => typeof v === "number" && Number.isFinite(v)).value,
    json: (key, fallback, ctx) => run(key, fallback, ctx, (v) => v !== undefined).value,
    evaluate: (key, fallback, ctx) => run(key, fallback, ctx, null),
    allFlags(ctx) {
      const s = live(pageSession);
      const b = s ? s.bundle : bundle;
      const out: Record<string, JsonValue> = {};
      if (!b) return out;
      const context: Context = s ? { ...s.context, ...ctx } : (ctx ?? {});
      for (const key of Object.keys(b.flags)) {
        const e = engineEvaluate<JsonValue>(b, key, context, null);
        if (e.reason !== "error" && e.reason !== "flag_not_found" && e.value !== undefined) out[key] = e.value;
      }
      return out;
    },
    session: (token, opts) => resolveSession(token, opts).then(evaluatorFor, () => evaluatorFor(null)),
    useSession: (token) => usePageSession(token).catch(() => evaluatorFor(null)),
    sessionHeaders() {
      const headers: Record<string, string> = {};
      if (pageToken !== null && !(pageResolved && live(pageSession) === null)) headers[SESSION_HEADER] = pageToken;
      return headers;
    },
    on(event: "update" | "error" | "state", cb: ((e: UpdateEvent) => void) | ((e: Error) => void) | ((e: StateEvent) => void)) {
      const set = listeners[event] as Set<typeof cb>;
      set.add(cb);
      return () => void set.delete(cb);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => void subscribers.delete(listener);
    },
    async refresh() {
      // A request that is already in flight may predate the caller's reason to refresh: wait, then revalidate.
      if (inFlight) await inFlight;
      return sync();
    },
    track: track as NanoFlagsClient["track"],
    async flush() {
      await Promise.all([flush(true), flushExperiments()]);
    },
    close() {
      if (closed) return;
      void flush(true); // best effort
      void flushExperiments();
      closed = true;
      for (const w of pinWaiters.splice(0)) w();
      if (pollTimer) clearTimeout(pollTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (experimentTimer) clearTimeout(experimentTimer);
      if (pageTimer) clearTimeout(pageTimer);
      sessions.clear();
      if (liveTimer) clearTimeout(liveTimer);
      dropLive();
      stopStream();
      doc?.removeEventListener("visibilitychange", onVisible);
      if (lifecycleCleanup) safely(lifecycleCleanup);
      lifecycleCleanup = null;
      if (typeof removeEventListener === "function") removeEventListener("online", onOnline);
      resolveReady();
    },
  };

  // ---- start
  if (options.bootstrap !== undefined) {
    if (isBundle(options.bootstrap) && !supportsEngine(options.bootstrap)) {
      const err = engineError(options.bootstrap);
      queueMicrotask(() => emitError(err));
    } else if (isBundle(options.bootstrap)) adopt(options.bootstrap, { etag: null, checksum: null, status: "ready", source: "bootstrap" });
    else queueMicrotask(() => emitError(new NanoFlagsError("The bootstrap bundle is invalid and was ignored.", "invalid_bundle")));
  }
  if (verifyOpt && Array.isArray(verifyOpt.keys) && verifyOpt.keys.some((k) => !isPublicEd25519Jwk(k))) {
    queueMicrotask(() => emitError(new NanoFlagsError("`verify.publicKeys` must contain public Ed25519 JWKs only. Other entries (including private keys) were ignored.", "config")));
  }
  if (strictBroken) {
    queueMicrotask(() => emitError(new NanoFlagsError("`verifyLog` and `coSignerKeys` need signature verification, but `verify` is false: no update will be applied.", "config")));
  }
  if (cosignWanted && (coSignerJwks.length === 0 || coSignerJwks.some((k) => !isPublicEd25519Jwk(k) || typeof (k as { kid?: unknown }).kid !== "string"))) {
    queueMicrotask(() => emitError(new NanoFlagsError("`coSignerKeys` must contain public Ed25519 JWKs with a `kid`. Other entries were ignored; without a usable key every update is rejected.", "config")));
  }
  if (typeof sdkKey !== "string" || sdkKey === "" || baseUrl === "") {
    const err = new NanoFlagsError("`sdkKey` and `baseUrl` are required.", "config");
    lastError = { code: "CONFIG", message: err.message, at: new Date().toISOString() };
    restoreDone = true;
    markAttempted();
    queueMicrotask(() => emitError(err));
    resolveReady();
    return client;
  }
  if (options.lifecycle) {
    try {
      const cleanup = options.lifecycle(control);
      if (typeof cleanup === "function") lifecycleCleanup = cleanup;
    } catch {
      /* a broken integration must not break the client */
    }
  }
  // Started in the background (paused before the first load): the store still loads; the network waits for resume().
  const started = !paused;
  restoring = restore().finally(() => {
    restoreDone = true;
  });
  void Promise.all([restoring, started ? sync() : Promise.resolve()]).then(() => {
    // Started in the background: the first attempt is the first network request after resume().
    if (started) markAttempted();
    resolveReady(); // even without a bundle: callers must not hang; they check `status` / `state`
    if (closed || paused) return;
    // Paused and resumed while the first load ran: resume() already started everything.
    if (!started) return;
    schedulePoll();
    scheduleFlush();
    scheduleExperiments();
    startRealtime();
  });
  // A page reload stays in the test session it was opened with.
  try {
    const remembered = pageStorage()?.getItem(STORAGE_KEY);
    if (isSessionToken(remembered)) void usePageSession(remembered).catch(() => undefined);
  } catch {
    /* ignore */
  }
  doc?.addEventListener("visibilitychange", onVisible);
  if (doc && typeof addEventListener === "function") addEventListener("online", onOnline);

  return client;
}
