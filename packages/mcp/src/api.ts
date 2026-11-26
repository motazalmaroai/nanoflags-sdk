/**
 * Minimal client for the NanoFlags Management API (https://edge.nanoflags.io/api/v1, OpenAPI at /api/v1/openapi.json).
 * Errors are `{ "error": { "code", "message" } }`; `code` is stable (AGENT_FORBIDDEN, INSUFFICIENT_SCOPE, NOT_FOUND, …).
 */

export const DEFAULT_BASE_URL = "https://edge.nanoflags.io";
export const TOKEN_PATTERN = /^nf_api_[0-9a-f]{48}$/;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Other fields of the API's error object, e.g. `currentVersion` with DRAFT_CONFLICT. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Origin of the edge API, e.g. https://edge.nanoflags.io (the `/api/v1` prefix is added). */
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  userAgent: string;
  timeoutMs?: number;
  /** Sent with every request (e.g. the agent provenance headers). */
  headers?: Record<string, string>;
}

export type Query = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  private readonly root: string;

  constructor(private readonly o: ApiClientOptions) {
    this.root = `${o.baseUrl.replace(/\/+$/, "")}/api/v1`;
  }

  /** The same client, with these headers added to every request. */
  withHeaders(headers: Record<string, string>): ApiClient {
    return Object.keys(headers).length ? new ApiClient({ ...this.o, headers: { ...this.o.headers, ...headers } }) : this;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  patch<T = unknown>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    return this.request<T>("PATCH", path, body, undefined, extraHeaders);
  }

  async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, query?: Query, extraHeaders?: Record<string, string>): Promise<T> {
    const url = new URL(this.root + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...this.o.headers, ...extraHeaders, Authorization: `Bearer ${this.o.token}`, Accept: "application/json", "User-Agent": this.o.userAgent };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // A retried POST (same key) is answered from the server's idempotency store instead of running twice.
    if (method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
    let res: Response;
    try {
      res = await this.o.fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new ApiError(`NanoFlags could not be reached (${e instanceof Error ? e.name : "network error"}).`, 0, "UNREACHABLE");
    }
    let payload: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        /* not JSON */
      }
    }
    if (!res.ok) {
      const err = isObject(payload) && isObject(payload.error) ? payload.error : null;
      const code = err && typeof err.code === "string" ? err.code : `HTTP_${res.status}`;
      const message = err && typeof err.message === "string" ? err.message : `NanoFlags answered ${res.status}.`;
      const details: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(err ?? {})) if (k !== "code" && k !== "message" && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) details[k] = v;
      throw new ApiError(message, res.status, code, details);
    }
    return payload as T;
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A path segment from a key or id (keys are [a-z0-9_-]; ids are UUIDs). */
export const seg = (v: string) => encodeURIComponent(v);
