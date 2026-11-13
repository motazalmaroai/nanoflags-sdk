/**
 * A fake NanoFlags edge that signs like the publisher (Ed25519 over the canonical string, WebCrypto in Node), a
 * scriptable React Native WebSocket, a fake XMLHttpRequest and a fake NetInfo.
 */
import type { Bundle } from "@nanoflags/sdk";
import { canonicalString, sha256Hex } from "../../sdk/src/verify";

export const BASE = "https://edge.test";
export const CLIENT_KEY = "nf_pub_test_rn_000000000000000000000000000000000000000";
export const SERVER_KEY = "nf_srv_test_rn_000000000000000000000000000000000000000";
export const ENV_ID = "6f0c7c1e-0000-4000-8000-0000000000aa";

export function makeBundle(revision: number, over: Partial<Bundle["flags"]> = {}): Bundle {
  return {
    schema: 1,
    engine: 1,
    project: "mobile",
    environment: "production",
    revision,
    segments: { staff: { match: "all", conditions: [{ attribute: "email", op: "ends_with", value: "@nanoflags.dev" }] } },
    flags: {
      "new-checkout": {
        type: "boolean",
        enabled: true,
        clientExposed: true,
        default: false,
        off: false,
        rules: [
          { id: "staff", match: "all", conditions: [{ attribute: "", op: "segment", value: "staff" }], serve: { type: "fixed", value: true } },
          { id: "vip", match: "all", conditions: [{ attribute: "plan", op: "eq", value: "vip" }], serve: { type: "fixed", value: true } },
        ],
      },
      accent: { type: "string", enabled: true, clientExposed: true, default: `blue-r${revision}`, off: "gray", rules: [] },
      "max-items": { type: "number", enabled: true, clientExposed: true, default: 20, off: 0, rules: [] },
      layout: { type: "json", enabled: true, clientExposed: true, default: { columns: 2 }, off: null, rules: [] },
      ...over,
    } as Bundle["flags"],
  } as Bundle;
}

export interface Signer {
  kid: string;
  publicJwk: JsonWebKey & { kid: string };
  sign(text: string): Promise<string>;
}

export async function makeSigner(kid = "k-test"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x!, kid },
    async sign(text) {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(text)));
      return Buffer.from(sig).toString("base64url");
    },
  };
}

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Signed `/v1/bundle`, `/v1/keys`, `/v1/events` (and nothing else) — the way the edge serves client keys. */
export class FakeEdge {
  calls: Call[] = [];
  bundle: Bundle;
  /** false: the edge's unsigned fallback (`X-NanoFlags-Signed: false`). */
  signed = true;
  /** Rewrites the response body after signing (tampering on the wire). */
  tamper: ((body: string) => string) | null = null;
  /** Network down: every request rejects. */
  offline = false;
  kid: string;
  keys: Array<JsonWebKey & { kid: string }>;

  constructor(
    readonly signer: Signer,
    bundle: Bundle,
  ) {
    this.bundle = bundle;
    this.kid = signer.kid;
    this.keys = [signer.publicJwk];
  }

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  last(path: string): Call | undefined {
    return this.calls.filter((c) => c.path === path).at(-1);
  }

  async signedText(bundle: Bundle, checksum = `c${bundle.revision}`): Promise<{ text: string; signature: string }> {
    const text = JSON.stringify(bundle);
    return { text, signature: await this.signer.sign(canonicalString(ENV_ID, bundle.revision, checksum, await sha256Hex(text))) };
  }

  /** A `rev` / `hello` message as the sequencer pushes it over `/v1/live`. */
  async push(bundle: Bundle, t: "rev" | "hello" = "rev", committedAt: number | null = Date.now() - 50): Promise<Record<string, unknown>> {
    const checksum = `c${bundle.revision}`;
    const { text, signature } = await this.signedText(bundle, checksum);
    return { t, revision: bundle.revision, checksum, signature, kid: this.kid, environmentId: ENV_ID, bundle: text, committedAt, sentAt: Date.now() };
  }

  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    this.calls.push({ url, path, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (this.offline) throw new TypeError("Network request failed");
    if (path === "/v1/keys") return Response.json({ keys: this.keys.map((k) => ({ ...k, alg: "EdDSA", use: "sig", status: "active" })) });
    if (path === "/v1/events") return new Response('{"accepted":1,"capped":false}', { status: 202 });
    if (path !== "/v1/bundle") return new Response('{"error":{"code":"not_found"}}', { status: 404 });
    const b = this.bundle;
    const checksum = `c${b.revision}`;
    const etag = `"${checksum}-client"`;
    const signedHeaders: Record<string, string> = this.signed ? { "X-NanoFlags-Signed": "true", "X-NanoFlags-Key-Id": this.kid } : { "X-NanoFlags-Signed": "false" };
    if (headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "X-NanoFlags-Environment-Id": ENV_ID, ...signedHeaders } });
    const { text, signature } = await this.signedText(b, checksum);
    let body = `{"revision":${b.revision},"checksum":${JSON.stringify(checksum)},"bundle":${text}}`;
    if (this.tamper) body = this.tamper(body);
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json", ETag: etag, "X-NanoFlags-Environment-Id": ENV_ID, ...signedHeaders, ...(this.signed ? { "X-NanoFlags-Signature": signature } : {}) } });
  }) as typeof fetch;
}

/** React Native's WebSocket: `(url, protocols, { headers })`. Records what the SDK does; the test plays the edge. */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  static autoOpen = true;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeSocket.instances.push(this);
    if (FakeSocket.autoOpen) queueMicrotask(() => !this.closed && this.onopen?.({}));
  }
  send(data: string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
    if (data === "ping") queueMicrotask(() => this.onmessage?.({ data: "pong" }));
  }
  close(code?: number) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.onclose?.({ code: code ?? 1000 });
  }
  message(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  drop(code = 1006) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.onclose?.({ code });
  }
  static get last(): FakeSocket | undefined {
    return FakeSocket.instances.at(-1);
  }
  static get open(): FakeSocket[] {
    return FakeSocket.instances.filter((s) => !s.closed);
  }
  static reset() {
    FakeSocket.instances = [];
    FakeSocket.autoOpen = true;
  }
}

/** NetInfo double: `emit(state)` notifies the SDK. */
export function fakeNetInfo() {
  const listeners = new Set<(s: { isConnected: boolean | null; isInternetReachable?: boolean | null; details?: { isConnectionExpensive?: boolean } | null }) => void>();
  return {
    addEventListener(l: (s: { isConnected: boolean | null; isInternetReachable?: boolean | null; details?: { isConnectionExpensive?: boolean } | null }) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    emit(s: { isConnected: boolean | null; isInternetReachable?: boolean | null; details?: { isConnectionExpensive?: boolean } | null }) {
      for (const l of [...listeners]) l(s);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

/** Polls `check` until it is truthy (real timers; signature work is plain promises with the pure-JS crypto). */
export async function waitFor(check: () => unknown, timeoutMs = 3000, what = "condition"): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
