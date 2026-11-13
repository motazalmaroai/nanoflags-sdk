import { CliError, EXIT } from "./util.js";

export const DEFAULT_BASE_URL = "https://edge.nanoflags.io";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ExportedFlag {
  key: string;
  name?: string;
  type: "boolean" | "string" | "number" | "json";
  purpose?: string | null;
  permanent?: boolean;
  client_exposed?: boolean;
  description?: string | null;
  review_date?: string | null;
  archived?: boolean;
}

export interface ExportData {
  project: { key: string; name?: string };
  key_environment: string;
  environments: Array<{ key: string; name?: string; published_revision: number; require_approval?: boolean; require_scenarios?: boolean }>;
  flags: ExportedFlag[];
  segments: Array<{ key: string; name?: string; match: "all" | "any"; conditions: unknown[] }>;
  drafts: Record<string, { flags: Record<string, unknown>; segments: Record<string, unknown> }>;
}

export interface ScenarioResult {
  id: string;
  name: string;
  flag: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  reason?: string;
}

export interface ScenarioRun {
  source: string;
  checksum: string | null;
  publishedRevision: number | null;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}

export interface CreatedFlag {
  id: string;
  key: string;
  name?: string;
  type: string;
  default?: unknown;
  environments?: string[];
}

export function isExport(v: unknown): v is ExportData {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.project === "object" && e.project !== null && Array.isArray(e.flags) && e.flags.every((f) => typeof f === "object" && f !== null && typeof (f as { key?: unknown }).key === "string");
}

export type KeyKind = "admin" | "ci" | "server" | "client" | "unknown";
export function keyKind(key: string): KeyKind {
  return key.startsWith("nf_adm_") ? "admin" : key.startsWith("nf_ci_") ? "ci" : key.startsWith("nf_srv_") ? "server" : key.startsWith("nf_pub_") ? "client" : "unknown";
}

export interface ApiOptions {
  baseUrl: string;
  key: string;
  fetch: typeof fetch;
  userAgent: string;
}

export class Api {
  constructor(private readonly o: ApiOptions) {}

  /** One JSON request to `baseUrl + path`; API errors become `ApiError`. */
  async call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.o.key}`, Accept: "application/json", "User-Agent": this.o.userAgent, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new CliError(`Could not reach ${this.o.baseUrl}: ${e instanceof Error ? e.message : String(e)}`, EXIT.unavailable);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.ok) {
      if (json === null) throw new CliError(`${method} ${path} returned an empty or non-JSON response (HTTP ${res.status}).`, EXIT.unavailable);
      return json as T;
    }
    const err = (json as { error?: { code?: unknown; message?: unknown } | string } | null)?.error;
    const code = typeof err === "object" && err !== null && typeof err.code === "string" ? err.code : typeof err === "string" ? err : `http_${res.status}`;
    const message = typeof err === "object" && err !== null && typeof err.message === "string" ? err.message : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, code);
  }

  export(): Promise<ExportData> {
    return this.call<ExportData>("GET", "/v1/admin/export");
  }
  bundle(): Promise<{ revision: number; checksum: string | null; bundle: unknown }> {
    return this.call("GET", "/v1/bundle");
  }
  /** The published revision of the key's environment (CI or admin key). */
  published(): Promise<{ revision: number; checksum: string | null; bundle: unknown }> {
    return this.call("GET", "/v1/ci/published");
  }
  runScenarios(body: { source: "draft" | "revision"; commit?: string; runUrl?: string }): Promise<ScenarioRun> {
    return this.call<ScenarioRun>("POST", "/v1/ci/scenarios/run", body);
  }
  publish(body: { expectedRevision: number; note?: string }): Promise<{ revision: number; checksum: string }> {
    return this.call("POST", "/v1/admin/publish", body);
  }
  /** Creates a flag in the key's project (admin key). Every environment's draft starts with `default`. */
  createFlag(body: { key: string; type: "boolean" | "string" | "number" | "json"; default: unknown; description?: string; name?: string }): Promise<CreatedFlag> {
    return this.call<CreatedFlag>("POST", "/v1/admin/flags", body);
  }
  putCodeRefs(body: { repo: string; commit: string | null; refs: Array<{ flag: string; path: string; line: number; snippet: string }> }): Promise<{ stored: number }> {
    return this.call("PUT", "/v1/ci/code-refs", body);
  }
}

export interface KillResult {
  killId: string;
  flag: string;
  reason: string;
  killed: number;
  environments: Array<{ environment: string; environmentId: string; status: string; revision: number; previousRevision?: number; checksum?: string; committedAt?: number; offValue?: unknown }>;
}

export interface KillRestoreResult {
  flag: string;
  environment: string;
  killId: string;
  change: { id: string; title: string; status: string };
  requirements: { changeRequired: boolean; approvalMet: boolean; approvalsNeeded: number; scenariosMet: boolean };
}

/** Management API (`/api/v1`, `nf_api_…` tokens): only the kill-switch calls the CLI needs. */
export class ManagementApi {
  private readonly http: Api;
  constructor(o: ApiOptions) {
    this.http = new Api({ ...o, baseUrl: `${o.baseUrl}/api/v1` });
  }
  private call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.http.call<T>(method, path, body, headers);
  }
  projects(): Promise<{ data: Array<{ id: string; key: string; name: string }>; nextCursor: string | null }> {
    return this.call("GET", "/projects");
  }
  kill(project: string, flag: string, body: { environment?: string; allEnvironments?: true; reason: string }, idempotencyKey: string): Promise<KillResult> {
    return this.call("POST", `/projects/${encodeURIComponent(project)}/flags/${encodeURIComponent(flag)}/kill`, body, { "Idempotency-Key": idempotencyKey });
  }
  restore(project: string, flag: string, body: { environment: string; title?: string; reason?: string }): Promise<KillRestoreResult> {
    return this.call("POST", `/projects/${encodeURIComponent(project)}/flags/${encodeURIComponent(flag)}/restore`, body);
  }
}

/** Turns transport-level failures into messages a person can act on. */
export function explain(e: unknown, key: string, what: string): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof ApiError) {
    const kind = keyKind(key);
    if (e.status === 401) return new CliError(`The key was rejected (unknown or revoked). Check NANOFLAGS_KEY.`, EXIT.usage);
    if (e.status === 403) return new CliError(`This key may not ${what}${kind === "unknown" ? "" : ` (it is a ${kind} key)`}. ${e.message}`, EXIT.usage);
    if (e.status === 404 && e.code === "not_found") return new CliError(`The edge at this base URL does not offer this endpoint (${e.message}). Check --base-url, or the edge is older than this CLI.`, EXIT.unavailable);
    if (e.status >= 500) return new CliError(`NanoFlags could not ${what} right now (HTTP ${e.status}: ${e.message}).`, EXIT.unavailable);
    return new CliError(`Could not ${what}: ${e.message} [${e.code}]`, EXIT.failed);
  }
  return new CliError(e instanceof Error ? e.message : String(e), EXIT.failed);
}
