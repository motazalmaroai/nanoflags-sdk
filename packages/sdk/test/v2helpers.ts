import { vi } from "vitest";
import type { Bundle, Context } from "../src/index";
import { canonicalString, sha256Hex } from "../src/verify";
import type { Call } from "./helpers";

export const ENV_ID = "6f0c7c1e-0000-4000-8000-000000000001";

export interface Signer {
  kid: string;
  publicJwk: JsonWebKey & { kid: string };
  privateJwk: JsonWebKey;
  sign(text: string): Promise<string>;
}

export async function makeSigner(kid = "k1"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    kid,
    publicJwk,
    privateJwk,
    async sign(text) {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(text)));
      return Buffer.from(sig).toString("base64url");
    },
  };
}

export interface SignedOpts {
  checksum?: string;
  environmentId?: string;
  /** Bundle text to embed and sign. Default `JSON.stringify(bundle)`. */
  bundleText?: string;
  /** Replace the body after signing (tampering). */
  tamper?: (body: string) => string;
  signed?: boolean;
  kid?: string | null;
}

/** A `/v1/bundle` response signed like the publisher signs it. */
export async function signedResponse(signer: Signer, bundle: Bundle, opts: SignedOpts = {}): Promise<Response> {
  const checksum = opts.checksum ?? `c${bundle.revision}`;
  const environmentId = opts.environmentId ?? ENV_ID;
  const bundleText = opts.bundleText ?? JSON.stringify(bundle);
  const signature = await signer.sign(canonicalString(environmentId, bundle.revision, checksum, await sha256Hex(bundleText)));
  const body = `{"revision":${bundle.revision},"checksum":${JSON.stringify(checksum)},"bundle":${bundleText}}`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ETag: `"${checksum}-server"`, "X-NanoFlags-Environment-Id": environmentId };
  if (opts.signed === false) headers["X-NanoFlags-Signed"] = "false";
  else {
    headers["X-NanoFlags-Signed"] = "true";
    headers["X-NanoFlags-Signature"] = signature;
    if (opts.kid !== null) headers["X-NanoFlags-Key-Id"] = opts.kid ?? signer.kid;
  }
  return new Response(opts.tamper ? opts.tamper(body) : body, { status: 200, headers });
}

type Reply = Response | Error | ((call: Call) => Response | Error | Promise<Response | Error>);

/** fetch mock with one reply per path. Unknown paths answer 404. */
export function mockRoutes(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url).pathname;
    const call: Call = { url, path, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const reply = routes[path] ?? new Response("{}", { status: 404 });
    const r = typeof reply === "function" ? await reply(call) : reply;
    if (r instanceof Error) throw r;
    return r.clone();
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    routes,
    count: (path: string) => calls.filter((c) => c.path === path).length,
    last: (path: string) => calls.filter((c) => c.path === path).at(-1),
  };
}

export function sessionBody(id: string, bundle: Bundle, context: Context = {}, expiresInMs = 60_000) {
  return { id, checksum: `s-${id}`, source: "draft", revision: null, context, expires_at: new Date(Date.now() + expiresInMs).toISOString(), bundle };
}

/** `/v1/session` route: token → body. Unknown tokens answer 404, like the edge. */
export function sessionRoute(sessions: Record<string, () => unknown>): (call: Call) => Response {
  return (call) => {
    const make = sessions[call.headers.get("X-NanoFlags-Session") ?? ""];
    return make ? new Response(JSON.stringify(make()), { status: 200, headers: { "Cache-Control": "no-store" } }) : new Response('{"error":"not_found"}', { status: 404 });
  };
}
