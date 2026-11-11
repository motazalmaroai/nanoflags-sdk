/**
 * @nanoflags/sdk — isomorphic core.
 *
 * Flags are evaluated locally and synchronously against an in-memory bundle. The network is only
 * used in the background: to load the bundle, to learn about new revisions, and to send sampled
 * telemetry. A flag accessor never performs I/O and never throws.
 *
 * New revisions arrive over one of three transports, best first: the live WebSocket (`/v1/live`,
 * the edge pushes the signed bundle itself — no request follows), the SSE stream (`/v1/stream`,
 * a notification followed by a conditional fetch), and polling (`/v1/bundle`).
 */
import { ENGINE_VERSION, evaluate as engineEvaluate, murmur3, supportsEngine, type Bundle, type Condition, type Context, type Evaluation, type JsonValue } from "@nanoflags/engine";
import { OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS } from "./keys.js";
import { defaultStore, type Store } from "./store.js";
import { readSse } from "./sse.js";
import { importPublicKeys, isPublicEd25519Jwk, rawMember, verifyBundleText, type ImportedKey, type SignatureInfo, type VerifyOptions } from "./verify.js";

export type { Bundle, Context, Evaluation, JsonValue, Reason } from "@nanoflags/engine";
export type { Store } from "./store.js";
export type { VerifyOptions } from "./verify.js";
export { OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS } from "./keys.js";

export const SDK_VERSION = "0.4.0";

/** Newest bundle format (`bundle.engine`) this SDK can evaluate. Newer bundles are refused; the previous one stays in use. */
export const SUPPORTED_ENGINE_VERSION = ENGINE_VERSION;

/** WebSocket close code of the edge for an environment that was deleted: the SDK stops reconnecting. */
export const CLOSE_ENVIRONMENT_DELETED = 4004;

/** Header that carries a test-session token between services. */
export const SESSION_HEADER = "x-nanoflags-session";

export type ClientStatus = "not-ready" | "ready" | "stale";

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
  fetch?: typeof fetch;
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
  on(event: "error", cb: (e: Error) => void): () => void;
  /** Force a revalidation now. Resolves when it finished (successfully or not). */
  refresh(): Promise<void>;
  /** Send queued telemetry now. */
  flush(): Promise<void>;
  /** Stops timers, the stream and telemetry. Evaluations keep working on the last bundle. */
  close(): void;
  /** For external-store bindings (React): called on every bundle or status change. */
  subscribe(listener: () => void): () => void;
  /** Monotonic counter that changes whenever `subscribe` listeners fire. */
  readonly version: number;
}

export class NanoFlagsError extends Error {
  constructor(
    message: string,
    readonly code: "network" | "unauthorized" | "http" | "invalid_bundle" | "store" | "config" | "signature" | "session" | "engine" | "environment_deleted",
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "NanoFlagsError";
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
}

const MAX_QUEUE = 500;
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
  return b.schema === 1 && typeof b.revision === "number" && typeof b.flags === "object" && b.flags !== null && !Array.isArray(b.flags) && typeof b.segments === "object" && b.segments !== null;
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

export function createClient(options: ClientOptions): NanoFlagsClient {
  const sdkKey = options.sdkKey;
  const baseUrl = String(options.baseUrl ?? "").replace(/\/+$/, "");
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const doFetch: typeof fetch | undefined = options.fetch ?? (typeof fetch === "function" ? (input, init) => fetch(input, init) : undefined);
  const ev = options.events === false ? { enabled: false } : (options.events ?? {});
  const eventsEnabled = ev.enabled ?? true;
  const sampleRate = Math.min(1, Math.max(0, ev.sampleRate ?? 0.1));
  const flushIntervalMs = ev.flushIntervalMs ?? 10_000;
  const reportIntervalMs = ev.reportIntervalMs ?? 60_000;
  const livePollIntervalMs = options.livePollIntervalMs ?? 300_000;
  const random = ev.random ?? Math.random;
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
  let pushChain: Promise<void> = Promise.resolve();
  let lastReportAt = 0;
  const usedAttrs = new WeakMap<Bundle, Map<string, string[]>>();
  /**
   * Effective verification: `keys` to verify with (`"fetch"` = only `/v1/keys`), `require` = refuse unsigned bundles,
   * `refetch` = an unknown key id loads `/v1/keys` once (official edge with the embedded keys, or `"fetch"`).
   */
  const official = baseUrl === OFFICIAL_EDGE_URL;
  const verifyOpt: { keys: readonly unknown[] | "fetch"; require: boolean; refetch: boolean } | null = (() => {
    const v = options.verify;
    if (v === false) return null;
    if (v === undefined || v === null) return official ? { keys: OFFICIAL_SIGNING_KEYS, require: true, refetch: true } : null;
    const keys = v.publicKeys === "fetch" ? "fetch" : Array.isArray(v.publicKeys) ? v.publicKeys : official ? OFFICIAL_SIGNING_KEYS : "fetch";
    return { keys, require: v.require ?? official, refetch: keys === "fetch" || (official && v.publicKeys === undefined) };
  })();
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  let pinnedKeys: Promise<ImportedKey[]> | null = null;
  let fetchedKeys: ImportedKey[] = [];
  let keysFetchedAt = 0;
  let keysFetching: Promise<void> | null = null;
  let pinnedEnvironment: string | null = null;
  let sig: SignatureInfo | null = null;
  let rawText: string | null = null;
  const sessions = new Map<string, { promise: Promise<SessionState | null>; until: number }>();
  let pageToken: string | null = null;
  let pageSession: SessionState | null = null;
  let pageResolved = false;
  let pageTimer: Timer | null = null;
  const queue: QueuedEvent[] = [];
  const listeners = { update: new Set<(e: UpdateEvent) => void>(), error: new Set<(e: Error) => void>() };
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
  const changed = () => {
    version++;
    for (const s of [...subscribers]) safely(s);
  };
  const setStatus = (next: ClientStatus) => {
    if (status === next) return;
    status = next;
    changed();
  };
  const emitError = (e: Error) => {
    for (const cb of [...listeners.error]) safely(() => cb(e));
  };

  function adopt(next: Bundle, meta: { etag: string | null; checksum: string | null; status: ClientStatus; source: UpdateEvent["source"]; transport?: Transport; latencyMs?: number | null }) {
    const previousRevision = bundle ? bundle.revision : null;
    const isNew = !bundle || previousRevision !== next.revision || checksum !== meta.checksum;
    bundle = next; // single assignment: the swap is atomic for synchronous evaluations
    etag = meta.etag;
    checksum = meta.checksum;
    status = meta.status;
    changed();
    resolveReady();
    if (isNew) {
      const e: UpdateEvent = { revision: next.revision, previousRevision, checksum: meta.checksum, source: meta.source, latencyMs: meta.latencyMs ?? null, transport: meta.transport ?? "poll" };
      for (const cb of [...listeners.update]) safely(() => cb(e));
    }
  }

  function persist() {
    if (!store || !bundle) return;
    const payload: Persisted = { v: 1, id, etag, checksum, savedAt: new Date().toISOString(), bundle, ...(sig ? { sig } : {}), ...(sig && rawText !== null ? { raw: rawText } : {}) };
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
      if (!supportsEngine(p.bundle)) return void emitError(engineError(p.bundle));
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
            ok = await verifyBundleText(await loadKeys(s.kid ?? null), { signature: s.signature, kid: s.kid ?? null, environmentId: s.environmentId, revision: s.revision, checksum: s.checksum }, text);
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
        } else if (verifyOpt.require) return;
        if (closed || (bundle && bundle.revision >= restored.revision)) return;
      }
      sig = restoredSig;
      rawText = restoredRaw;
      if (restoredSig) pinnedEnvironment ??= restoredSig.environmentId;
      // A restored bundle is usable but not known to be current: stale until the edge confirms it.
      adopt(restored, { etag: p.etag ?? null, checksum: p.checksum ?? null, status: "stale", source: "store" });
    } catch {
      emitError(new NanoFlagsError("Could not read the persisted bundle.", "store"));
    }
  }

  async function request(path: string, init: RequestInit): Promise<Response> {
    if (!doFetch) throw new NanoFlagsError("No fetch implementation available.", "config");
    const ac = new AbortController();
    const t = unref(setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS));
    try {
      return await doFetch(`${baseUrl}${path}`, { ...init, signal: ac.signal, headers: { Authorization: `Bearer ${sdkKey}`, ...(init.headers as Record<string, string> | undefined) } });
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
      const keys = await importPublicKeys(Array.isArray(body?.keys) ? body.keys : []);
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
      const p = (pinnedKeys ??= importPublicKeys(verifyOpt.keys));
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
      if (verifyOpt.require) throw reject("it is not signed (the edge is still distributing it) and unsigned bundles are refused (`verify.require`); fetching again shortly.");
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
      if (raw !== null && raw !== again && (await verifyBundleText(keys, info, raw))) {
        const parsed: unknown = JSON.parse(raw);
        if (isBundle(parsed) && parsed.revision === revision) {
          pinnedEnvironment = environmentId;
          return { bundle: parsed, sig: info, raw };
        }
      } else if (await verifyBundleText(keys, info, again)) {
        pinnedEnvironment = environmentId;
        return { bundle: body.bundle, sig: info, raw: null };
      }
    } catch (e) {
      throw reject(`the signature could not be checked (${e instanceof Error ? e.message : String(e)}).`);
    }
    throw reject("its signature does not verify.");
  }

  async function syncOnce(): Promise<void> {
    lastSyncAt = Date.now();
    const transport: Transport = streamTriggered ? "stream" : "poll";
    streamTriggered = false;
    try {
      const res = await request("/v1/bundle", { method: "GET", headers: etag ? { "If-None-Match": etag } : {} });
      if (closed) return;
      const servedStale = res.headers.get("X-NanoFlags-Stale") === "true";
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
      if (!supportsEngine(next)) throw engineError(next);
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
      adopt(next, { etag: res.headers.get("ETag"), checksum: body.checksum ?? null, status: servedStale ? "stale" : "ready", source: "network", transport });
      persist();
    } catch (e) {
      if (closed) return;
      // A bundle for a newer engine: nothing to retry quickly, the edge will answer the same until this SDK is upgraded.
      if (e instanceof NanoFlagsError && e.code === "engine") return void emitError(e);
      failures++;
      // A rejected update changes nothing: same bundle, same status. Polling retries with backoff.
      if (e instanceof NanoFlagsError && e.code === "signature") return void emitError(e);
      // A rejected key must not keep a socket: drop it (reconnects are refused by the edge and back off).
      if (e instanceof NanoFlagsError && e.code === "unauthorized") dropLive();
      // Keep evaluating with what we have; it is just no longer known to be current.
      if (bundle) setStatus("stale");
      emitError(e instanceof NanoFlagsError ? e : new NanoFlagsError(`Could not reach the NanoFlags edge: ${e instanceof Error ? e.message : String(e)}`, "network"));
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
    if (closed || pollIntervalMs <= 0) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = unref(
      setTimeout(() => {
        pollTimer = null;
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
    if (closed || options.streaming === false || !doFetch || streamActive || environmentDeleted) return;
    streamActive = true;
    const ES: typeof EventSource | undefined = typeof EventSource === "function" ? EventSource : undefined;
    if (ES && isBrowserKey) {
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
  }

  async function streamLoop(gen: number) {
    let attempt = 0;
    const current = () => !closed && gen === streamGen;
    while (current()) {
      const ac = new AbortController();
      streamAbort = ac;
      const startedAt = Date.now();
      let stop = false;
      try {
        const res = await doFetch!(`${baseUrl}/v1/stream`, { headers: { Authorization: `Bearer ${sdkKey}`, Accept: "text/event-stream" }, signal: ac.signal });
        if (res.status === 401 || res.status === 403) stop = true; // polling keeps reporting the error
        else if (res.ok && res.body) {
          await readSse(res.body, (event, data) => {
            if (event === "revision") onRevision(data);
            else if (event === "revoked") {
              stop = true;
              ac.abort();
              void sync();
            }
          });
        }
      } catch {
        /* reconnect below */
      }
      if (!current()) return;
      if (stop) {
        streamActive = false;
        return;
      }
      attempt = Date.now() - startedAt > 30_000 ? 0 : attempt + 1;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random());
      await new Promise<void>((r) => unref(setTimeout(r, wait)));
    }
  }

  // ---- live socket: the edge pushes the signed bundle itself; nothing is fetched.
  const liveWanted = options.streaming !== false && options.live !== false && WS !== undefined && liveUrl !== null;

  /** Applies one `rev` / `hello` message. Never throws; a message that cannot be trusted changes nothing. */
  async function applyPush(m: Record<string, unknown>): Promise<void> {
    if (closed || (m.t !== "rev" && m.t !== "hello")) return;
    const revision = m.revision;
    // Revision 0 / no bundle: the environment has nothing published yet.
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || typeof m.bundle !== "string") return;
    if (bundle && revision < bundle.revision) return; // never backwards
    const text = m.bundle;
    const pushedChecksum = typeof m.checksum === "string" ? m.checksum : null;

    let info: SignatureInfo | null = null;
    if (verifyOpt) {
      const reject = (why: string) => {
        emitError(new NanoFlagsError(`Pushed bundle r${revision} was rejected: ${why} The configuration in use is unchanged.`, "signature"));
        // Whatever sent this, the regular (verified) request path says what is really current.
        void sync();
      };
      if (typeof m.signature !== "string" || typeof m.environmentId !== "string" || pushedChecksum === null) return reject("it carries no complete signature.");
      if (pinnedEnvironment !== null && pinnedEnvironment !== m.environmentId) return reject("it was signed for a different environment.");
      info = { signature: m.signature, kid: typeof m.kid === "string" ? m.kid : null, environmentId: m.environmentId, revision, checksum: pushedChecksum };
      let ok = false;
      try {
        ok = await verifyBundleText(await loadKeys(info.kid), info, text);
      } catch {
        ok = false;
      }
      if (closed) return;
      if (!ok) return reject("its signature does not verify.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isBundle(parsed) || parsed.revision !== revision) return void emitError(new NanoFlagsError("The edge pushed an invalid bundle; it was ignored.", "invalid_bundle"));
    if (!supportsEngine(parsed)) return void emitError(engineError(parsed));
    if (bundle && revision < bundle.revision) return;
    failures = 0;
    if (bundle && revision === bundle.revision) {
      // Already in use: the push only confirms that it is current.
      if (checksum === null || checksum === pushedChecksum) setStatus("ready");
      return;
    }
    if (info) pinnedEnvironment = info.environmentId;
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
  function dropLive() {
    try {
      socket?.close(1000, "bye");
    } catch {
      /* not open */
    }
  }

  function connectLive(): void {
    if (closed || !liveWanted || socket || environmentDeleted) return;
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
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (socket === ws) socket = null;
      liveOpen = false;
      liveEnded(opened, opened ? Date.now() - openedAt : 0, rotating);
    };
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
      stopStream(); // SSE is not used while the socket is healthy
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
      emitError(new NanoFlagsError("The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated.", "environment_deleted"));
      schedulePoll();
      return;
    }
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
    if (closed || options.streaming === false) return;
    if (liveWanted) connectLive();
    else startStream();
  }

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
      });
    } catch {
      /* telemetry must never affect evaluation */
    }
  }

  async function flush(): Promise<void> {
    if (!eventsEnabled || !doFetch) return;
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
        body: JSON.stringify({ service, sdk: `js/${SDK_VERSION}`, revision: bundle?.revision ?? 0, events: batch }),
      });
    } catch {
      /* dropped on failure, by design: telemetry is never retried */
    }
  }

  function scheduleFlush() {
    if (closed || !eventsEnabled || flushIntervalMs <= 0) return;
    flushTimer = unref(
      setTimeout(() => {
        flushTimer = null;
        // Nothing queued: the service report alone goes out once per report interval.
        if (queue.length === 0 && Date.now() - lastReportAt < reportIntervalMs) return scheduleFlush();
        void flush().then(scheduleFlush);
      }, flushIntervalMs),
    );
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
      result = { flagKey: key, value: fallback, reason: "error", revision: result.revision, trace: [...result.trace, { kind: "result", title: "Returned the fallback", detail: error }], error };
    }
    record(result as Evaluation, context, b, s?.id);
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
      if (!closed) emitError(e instanceof NanoFlagsError ? e : new NanoFlagsError(`Could not load the test session: ${e instanceof Error ? e.message : String(e)}`, "session"));
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
    session: (token, opts) => resolveSession(token, opts).then(evaluatorFor, () => evaluatorFor(null)),
    useSession: (token) => usePageSession(token).catch(() => evaluatorFor(null)),
    sessionHeaders() {
      const headers: Record<string, string> = {};
      if (pageToken !== null && !(pageResolved && live(pageSession) === null)) headers[SESSION_HEADER] = pageToken;
      return headers;
    },
    on(event: "update" | "error", cb: ((e: UpdateEvent) => void) | ((e: Error) => void)) {
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
    flush,
    close() {
      if (closed) return;
      void flush(); // best effort
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (pageTimer) clearTimeout(pageTimer);
      sessions.clear();
      if (liveTimer) clearTimeout(liveTimer);
      dropLive();
      stopStream();
      doc?.removeEventListener("visibilitychange", onVisible);
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
  if (typeof sdkKey !== "string" || sdkKey === "" || baseUrl === "") {
    queueMicrotask(() => emitError(new NanoFlagsError("`sdkKey` and `baseUrl` are required.", "config")));
    resolveReady();
    return client;
  }
  void Promise.all([restore(), sync()]).then(() => {
    resolveReady(); // even without a bundle: callers must not hang; they check `status`
    if (closed) return;
    schedulePoll();
    scheduleFlush();
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
