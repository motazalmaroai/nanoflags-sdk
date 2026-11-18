/**
 * Read-only client for the NanoFlags Management API (`/api/v1`, `nf_api_…` tokens, `Authorization: Bearer`).
 * The extension only needs the `flags:read` scope (projects and environments are readable by any valid token).
 */

export const DEFAULT_BASE_URL = "https://edge.nanoflags.io";
export const API_TOKEN_RE = /^nf_api_[0-9a-f]{48}$/;

export type FlagType = "boolean" | "string" | "number" | "json";

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  orgId: string;
  projectId: string | null;
  projectKey: string | null;
  scopes: string[];
  expiresAt: string;
  status: "active" | "expired" | "revoked";
}

export interface Project {
  id: string;
  key: string;
  name: string;
  defaultEnvironment: string;
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  sort: number;
  isProtected: boolean;
  requireApproval: boolean;
  publishedRevision: number;
}

export interface Flag {
  id: string;
  key: string;
  name: string;
  description: string;
  type: FlagType;
  purpose: string;
  permanent: boolean;
  clientExposed: boolean;
  archivedAt: string | null;
  createdAt: string;
}

/** A flag's configuration inside an engine bundle (draft or published revision). */
export interface BundleFlag {
  type?: FlagType;
  enabled: boolean;
  rules: unknown[];
  default: unknown;
  off: unknown;
  clientExposed?: boolean;
}

export interface Bundle {
  flags?: Record<string, BundleFlag>;
  segments?: Record<string, unknown>;
}

export interface Draft {
  environment: string;
  checksum: string;
  publishedRevision: number;
  publishedChecksum: string | null;
  dirty: boolean;
  bundle: Bundle;
}

export interface Revision {
  number: number;
  bundle: Bundle;
}

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

export interface ClientOptions {
  baseUrl?: string;
  token: string;
  fetch?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
}

/** Normalises a base URL to the Management API root (`…/api/v1`). */
export function apiRoot(baseUrl: string | undefined): string {
  let b = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (b === "") b = DEFAULT_BASE_URL;
  return b.endsWith("/api/v1") ? b : `${b}/api/v1`;
}

export class ManagementClient {
  private readonly root: string;
  private readonly f: typeof fetch;

  constructor(private readonly o: ClientOptions) {
    this.root = apiRoot(o.baseUrl);
    this.f = o.fetch ?? fetch;
  }

  async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const qs = Object.entries(query)
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${this.root}${path}${qs ? `?${qs}` : ""}`;
    let res: Response;
    try {
      res = await this.f(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.o.token}`, Accept: "application/json", ...(this.o.userAgent ? { "User-Agent": this.o.userAgent } : {}) },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new ApiError(`Could not reach ${this.root}: ${e instanceof Error ? e.message : String(e)}`, 0, "NETWORK");
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? `HTTP_${res.status}`);
    }
    return json as T;
  }

  private async all<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await this.get<{ data: T[]; nextCursor: string | null }>(path, { ...query, cursor });
      out.push(...page.data);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  token(): Promise<TokenInfo> {
    return this.get("/token");
  }
  projects(): Promise<Project[]> {
    return this.all("/projects", { limit: "100" });
  }
  environments(project: string): Promise<Environment[]> {
    return this.all(`/projects/${encodeURIComponent(project)}/environments`);
  }
  /** Every flag of the project, archived ones included (`archived=all`). */
  flags(project: string): Promise<Flag[]> {
    return this.all(`/projects/${encodeURIComponent(project)}/flags`, { archived: "all", limit: "100" });
  }
  draft(project: string, env: string): Promise<Draft> {
    return this.get(`/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}/draft`);
  }
  revision(project: string, env: string, n: number): Promise<Revision> {
    return this.get(`/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}/revisions/${n}`);
  }
}

/** A person-readable explanation of an API failure. */
export function explainError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "NanoFlags rejected the API token (unknown, revoked or expired). Run “NanoFlags: Sign In” again.";
    if (e.status === 403) return `The API token may not read this (${e.message}). It needs the flags:read scope.`;
    if (e.status === 404) return `Not found: ${e.message}. Check the project setting (nanoflags.project).`;
    if (e.status === 429) return "NanoFlags rate-limited the request; try again shortly.";
    if (e.code === "NETWORK") return e.message;
    return `NanoFlags API error ${e.status} ${e.code}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
