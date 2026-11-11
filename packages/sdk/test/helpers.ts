import { vi } from "vitest";
import type { Bundle } from "../src/index";

export const BASE = "https://edge.test";
export const SERVER_KEY = "nf_srv_test_00000000000000000000000000000000000000000000";
export const CLIENT_KEY = "nf_pub_test_00000000000000000000000000000000000000000000";

export function makeBundle(revision: number, over: Partial<Bundle["flags"]> = {}): Bundle {
  return {
    schema: 1,
    project: "commerce",
    environment: "production",
    revision,
    segments: { staff: { match: "all", conditions: [{ attribute: "email", op: "ends_with", value: "@nanoflags.dev" }] } },
    flags: {
      "checkout-v2": {
        type: "boolean",
        enabled: true,
        default: false,
        off: false,
        rules: [
          { id: "staff", match: "all", conditions: [{ attribute: "", op: "segment", value: "staff" }], serve: { type: "fixed", value: true } },
          { id: "r1", match: "all", conditions: [{ attribute: "signedIn", op: "eq", value: true }, { attribute: "region", op: "in", value: ["US"] }], serve: { type: "rollout", percentage: 100, value: true, otherwise: false } },
        ],
      },
      "search-ranking": { type: "string", enabled: true, default: `relevance-v${revision}`, off: "off", rules: [], clientExposed: true },
      "max-items": { type: "number", enabled: true, default: 20, off: 0, rules: [] },
      layout: { type: "json", enabled: true, default: { columns: 3 }, off: null, rules: [] },
      ...over,
    } as Bundle["flags"],
  };
}

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Reply = Response | Error | (() => Response | Error | Promise<Response>);

/** fetch mock: `bundle` and `events` hold the reply for the next (and all following) requests. */
export function mockEdge(initial: { bundle?: Reply; events?: Reply; stream?: Reply } = {}) {
  const calls: Call[] = [];
  const replies: { bundle: Reply; events: Reply; stream: Reply } = {
    bundle: initial.bundle ?? new Error("offline"),
    events: initial.events ?? (() => new Response('{"accepted":0}', { status: 202 })),
    stream: initial.stream ?? new Error("no stream"),
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({ url, path, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const reply = path === "/v1/bundle" ? replies.bundle : path === "/v1/events" ? replies.events : replies.stream;
    const r = typeof reply === "function" ? await reply() : reply;
    if (r instanceof Error) throw r;
    return r.clone();
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    replies,
    count: (path: string) => calls.filter((c) => c.path === path).length,
    last: (path: string) => calls.filter((c) => c.path === path).at(-1),
  };
}

export function bundleResponse(bundle: Bundle, opts: { checksum?: string; kind?: string; stale?: boolean } = {}): Response {
  const checksum = opts.checksum ?? `c${bundle.revision}`;
  return new Response(JSON.stringify({ revision: bundle.revision, checksum, bundle }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: `"${checksum}-${opts.kind ?? "server"}"`, ...(opts.stale ? { "X-NanoFlags-Stale": "true", "X-NanoFlags-Stored-At": "2026-11-10T00:00:00.000Z" } : {}) },
  });
}

/** 200 or 304 depending on If-None-Match, like the real edge. */
export function conditional(get: () => Bundle, calls: Call[]): () => Response {
  return () => {
    const b = get();
    const etag = `"c${b.revision}-server"`;
    return calls.at(-1)?.headers.get("If-None-Match") === etag ? new Response(null, { status: 304, headers: { ETag: etag } }) : bundleResponse(b);
  };
}

export function memoryStore(initial: string | null = null) {
  let value = initial;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (v: string) => {
      value = v;
    }),
    peek: () => value,
  };
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
