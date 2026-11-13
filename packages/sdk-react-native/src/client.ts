/**
 * The React Native client: `@nanoflags/sdk`'s core (same engine, same verification, same transports) configured for
 * a mobile app, plus a current evaluation context that `identify()` replaces without any network round trip.
 */
import { AppState } from "react-native";
import { murmur3 } from "@nanoflags/engine";
import {
  NanoFlagsError,
  OFFICIAL_EDGE_URL,
  createClient as createCoreClient,
  type Bundle,
  type ClientOptions,
  type ClientStatus,
  type Context,
  type EventsOptions,
  type Evaluation,
  type JsonValue,
  type NanoFlagsClient,
  type SessionEvaluator,
  type SessionOptions,
  type SignatureCrypto,
  type Transport,
  type UpdateEvent,
  type VerifyOptions,
} from "@nanoflags/sdk";
import { nobleCrypto } from "./crypto.js";
import { attachLifecycle, type AppStateLike, type LifecycleState, type NetInfoLike } from "./lifecycle.js";
import { memoryStorage, storageKey, toStore, type StorageAdapter } from "./storage.js";
import { fetchWithHeaders, webSocketWithHeaders, xhrStreamOpener, type ReactNativeWebSocketConstructor, type XhrConstructor } from "./transport.js";

export const SDK_VERSION = "0.1.0";
/** Sent as `User-Agent` on every request and socket (Cloudflare refuses default library agents with 403 / 1010). */
export const DEFAULT_USER_AGENT = `nanoflags-react-native/${SDK_VERSION}`;

export interface ReactNativeClientOptions {
  /** Browser / client key (`nf_pub_…`): only client-exposed flags are delivered. Server keys are refused. */
  sdkKey: string;
  /** Default `https://edge.nanoflags.io` (bundles verified against the embedded signing keys, unsigned refused). */
  baseUrl?: string;
  /** Initial evaluation context (user). Change it later with `identify()`. */
  context?: Context;
  /** Name shown in "which revision is this app running" (service reports). Default `react-native`. */
  service?: string;
  /** A bundle shipped with the app (e.g. exported at build time); used until a newer one is loaded. */
  bootstrap?: Bundle;
  /**
   * Where the last verified bundle is kept between launches. Default: in memory only (nothing persists). Pass
   * `asyncStorage(AsyncStorage)` or any `StorageAdapter`; `false` disables persistence.
   */
  storage?: StorageAdapter | false;
  /** `@react-native-community/netinfo`'s default export (optional): pause while offline, data saver on metered networks. */
  netInfo?: NetInfoLike;
  /** Default: React Native's `AppState`. `null` disables lifecycle handling. */
  appState?: AppStateLike | null;
  /** Default true. Close the live socket and stop polling while the app is in the background; revalidate on foreground. */
  pauseInBackground?: boolean;
  /** Default true. On a metered connection (NetInfo `isConnectionExpensive`), no live socket: conditional polling only. */
  dataSaver?: boolean;
  /** Default 30000. Poll interval while the live socket is not in use. `0` disables polling. */
  pollIntervalMs?: number;
  /** Default 300000. Safety-poll interval while the live socket is healthy. */
  livePollIntervalMs?: number;
  /** Default true. `false`: no live socket and no SSE (polling only). */
  streaming?: boolean;
  /** Default true. `false` skips the live socket (SSE + polling). */
  live?: boolean;
  /** Telemetry (service reports + sampled evaluations with attribute names/types only). `false` opts out. */
  events?: EventsOptions | false;
  /** Signature verification; see `@nanoflags/sdk`. Default: on, against the embedded keys, for the official edge. */
  verify?: VerifyOptions | false;
  /** SHA-256 / Ed25519 implementation. Default: pure JS (`@noble/ed25519`, `@noble/hashes`, bundled). */
  crypto?: SignatureCrypto;
  /** Default `nanoflags-react-native/<version>`. */
  userAgent?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Default: the global `WebSocket` (React Native's, which accepts headers). */
  webSocket?: ReactNativeWebSocketConstructor;
  /** Default: the global `XMLHttpRequest` (SSE fallback). */
  xmlHttpRequest?: XhrConstructor;
}

/** A flag's value together with how it was decided (reason, matched rule, revision). */
export type FlagDetail<T extends JsonValue = JsonValue> = Evaluation<T>;

type Widen<T> = T extends boolean ? boolean : T extends string ? string : T extends number ? number : T;

export interface ReactNativeClient extends NanoFlagsClient {
  /** The current evaluation context (user). Evaluations without an explicit context use it. */
  readonly context: Context;
  /**
   * Replace the evaluation context (log-in, log-out, attribute change). Synchronous and local: no request is made;
   * subscribers (hooks) re-render with the new values.
   */
  identify(context: Context): void;
  /** True once the first load attempt (storage + network) has finished, whether or not it produced a bundle. */
  readonly settled: boolean;
  /** Lifecycle / connectivity state (background, offline, metered, paused). */
  readonly lifecycle: LifecycleState;
  /** Value plus reason, typed by `fallback` like `useFlag` (a value of another type returns `fallback` with reason `error`). */
  detail<T extends JsonValue>(key: string, fallback: T, ctx?: Context): FlagDetail<Widen<T>>;
}

function typeOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function accepts(fallback: unknown): (v: unknown) => boolean {
  if (typeof fallback === "boolean") return (v) => typeof v === "boolean";
  if (typeof fallback === "string") return (v) => typeof v === "string";
  if (typeof fallback === "number") return (v) => typeof v === "number" && Number.isFinite(v);
  return (v) => v !== undefined;
}

function isContext(v: unknown): v is Context {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createClient(options: ReactNativeClientOptions): ReactNativeClient {
  const sdkKey = options.sdkKey;
  if (typeof sdkKey !== "string" || !sdkKey.startsWith("nf_pub_")) {
    // A server key in an app binary is readable by anyone who installs the app: refuse it before any request.
    throw new NanoFlagsError(
      typeof sdkKey === "string" && sdkKey.startsWith("nf_srv_")
        ? "Server keys (nf_srv_…) must never ship in a mobile app. Create a browser/client key (nf_pub_…) for this environment."
        : "`sdkKey` must be a browser/client key (nf_pub_…).",
      "config",
    );
  }
  const baseUrl = String(options.baseUrl ?? OFFICIAL_EDGE_URL).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const headers = { "User-Agent": userAgent };
  const g = globalThis as { fetch?: typeof fetch; WebSocket?: unknown; XMLHttpRequest?: unknown };
  const baseFetch = options.fetch ?? (typeof g.fetch === "function" ? (input: RequestInfo | URL, init?: RequestInit) => g.fetch!(input, init) : undefined);
  const BaseWS = options.webSocket ?? (typeof g.WebSocket === "function" ? (g.WebSocket as ReactNativeWebSocketConstructor) : undefined);
  const Xhr = options.xmlHttpRequest ?? (typeof g.XMLHttpRequest === "function" ? (g.XMLHttpRequest as XhrConstructor) : undefined);
  // Same non-secret fingerprint the core uses to bind a persisted bundle to this key + edge.
  const fingerprint = murmur3(`${baseUrl}|${sdkKey}`).toString(16).padStart(8, "0");
  const storage = options.storage === false ? null : (options.storage ?? memoryStorage());

  let context: Context = isContext(options.context) ? { ...options.context } : {};
  let version = 0;
  let settled = false;
  let lifecycle: LifecycleState = { background: false, offline: false, metered: false, paused: false, realtime: true };
  const subscribers = new Set<() => void>();
  const notify = () => {
    version++;
    for (const s of [...subscribers]) {
      try {
        s();
      } catch {
        /* a listener must never break the client */
      }
    }
  };

  const coreOptions: ClientOptions = {
    sdkKey,
    baseUrl,
    service: options.service ?? "react-native",
    sdkLabel: `react-native/${SDK_VERSION}`,
    store: storage ? toStore(storage, storageKey(fingerprint)) : false,
    crypto: options.crypto ?? nobleCrypto,
    ...(baseFetch ? { fetch: fetchWithHeaders(baseFetch, headers) } : {}),
    ...(BaseWS ? { webSocket: webSocketWithHeaders(BaseWS, headers) } : {}),
    ...(Xhr ? { openStream: xhrStreamOpener(Xhr, headers) } : {}),
    ...(options.bootstrap !== undefined ? { bootstrap: options.bootstrap } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.livePollIntervalMs !== undefined ? { livePollIntervalMs: options.livePollIntervalMs } : {}),
    ...(options.streaming !== undefined ? { streaming: options.streaming } : {}),
    ...(options.live !== undefined ? { live: options.live } : {}),
    ...(options.events !== undefined ? { events: options.events } : {}),
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
    lifecycle: (control) => {
      const appState = options.appState === undefined ? (AppState as unknown as AppStateLike | undefined) : options.appState;
      return attachLifecycle(control, {
        appState: appState ?? null,
        netInfo: options.netInfo ?? null,
        pauseInBackground: options.pauseInBackground ?? true,
        dataSaver: options.dataSaver ?? true,
        onChange: (s) => {
          const changed = s.background !== lifecycle.background || s.offline !== lifecycle.offline || s.metered !== lifecycle.metered || s.paused !== lifecycle.paused || s.realtime !== lifecycle.realtime;
          lifecycle = s;
          if (changed) notify();
        },
      });
    },
  };
  const core = createCoreClient(coreOptions);
  core.subscribe(notify);
  void core.ready().then(() => {
    settled = true;
    notify();
  });

  const merged = (ctx: Context | undefined): Context => (ctx ? { ...context, ...ctx } : context);

  const client: ReactNativeClient = {
    get context() {
      return context;
    },
    identify(next) {
      context = isContext(next) ? { ...next } : {};
      notify();
    },
    get settled() {
      return settled;
    },
    get lifecycle() {
      return { ...lifecycle };
    },
    get status(): ClientStatus {
      return core.status;
    },
    get revision() {
      return core.revision;
    },
    get transport(): Transport {
      return core.transport;
    },
    get version() {
      return version;
    },
    ready: () => core.ready(),
    boolean: (key, fallback, ctx) => core.boolean(key, fallback, merged(ctx)),
    string: (key, fallback, ctx) => core.string(key, fallback, merged(ctx)),
    number: (key, fallback, ctx) => core.number(key, fallback, merged(ctx)),
    json: (key, fallback, ctx) => core.json(key, fallback, merged(ctx)),
    evaluate: (key, fallback, ctx) => core.evaluate(key, fallback, merged(ctx)),
    detail<T extends JsonValue>(key: string, fallback: T, ctx?: Context): FlagDetail<Widen<T>> {
      const e = core.evaluate<JsonValue>(key, fallback, merged(ctx));
      if (e.reason !== "flag_not_found" && e.reason !== "error" && !accepts(fallback)(e.value)) {
        const error = `Flag "${key}" has a ${typeOf(e.value)} value, which does not match the requested type.`;
        return { flagKey: key, value: fallback as Widen<T>, reason: "error", revision: e.revision, trace: [...e.trace, { kind: "result", title: "Returned the fallback", detail: error }], error };
      }
      return e as FlagDetail<Widen<T>>;
    },
    allFlags: (ctx) => core.allFlags(merged(ctx)),
    session: (token: string | null | undefined, opts?: SessionOptions): Promise<SessionEvaluator> => core.session(token, opts),
    useSession: (token) => core.useSession(token),
    sessionHeaders: () => core.sessionHeaders(),
    on: ((event: "update" | "error", cb: ((e: UpdateEvent) => void) | ((e: Error) => void)) => core.on(event as "update", cb as (e: UpdateEvent) => void)) as NanoFlagsClient["on"],
    subscribe(listener) {
      subscribers.add(listener);
      return () => void subscribers.delete(listener);
    },
    refresh: () => core.refresh(),
    flush: () => core.flush(),
    close: () => core.close(),
  };
  return client;
}
