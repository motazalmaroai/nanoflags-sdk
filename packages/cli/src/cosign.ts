/**
 * Customer co-signing (`nanoflags sign`, `nanoflags keygen`, `nanoflags publish --cosign`).
 *
 * The customer signs, with their own Ed25519 key, the same canonical strings NanoFlags signs:
 *   nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<SHA-256 hex of the bundle text>
 * for the server view and for the browser view of the revision the next publish would create. The bundle texts are
 * computed HERE, from the preview the edge returns, exactly as the publisher computes them (the `engine` field, the
 * browser view's filtering) — the signer never signs a hash it was handed. `clientView` below must stay identical to
 * `workers/shared/src/bundle.ts` (the monorepo's edge tests compare both).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { ENGINE_VERSION } from "@nanoflags/engine";

export interface CosignPreview {
  environmentId: string;
  expectedRevision: number;
  revision: number;
  checksum: string;
  bundle: Record<string, unknown>;
  required: boolean;
  keys: { kid: string; publicKey: string }[];
}

export function isCosignPreview(v: unknown): v is CosignPreview {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.environmentId === "string" && typeof p.revision === "number" && typeof p.expectedRevision === "number" && typeof p.checksum === "string" && typeof p.bundle === "object" && p.bundle !== null && !Array.isArray(p.bundle) && Array.isArray(p.keys);
}

/** What `nanoflags sign` writes and `nanoflags publish --cosign` sends. */
export interface Cosignature {
  environmentId: string;
  kid: string;
  revision: number;
  checksum: string;
  server: string;
  client: string;
}

export function isCosignature(v: unknown): v is Cosignature {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const sig = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9_-]{86}$/.test(x);
  return typeof c.environmentId === "string" && typeof c.kid === "string" && typeof c.revision === "number" && typeof c.checksum === "string" && sig(c.server) && sig(c.client);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function segmentRefs(conditions: unknown, out: string[]): void {
  if (!Array.isArray(conditions)) return;
  for (const c of conditions) if (isObject(c) && (c.op === "segment" || c.op === "not_segment") && typeof c.value === "string") out.push(c.value);
}

/** The browser-key view (identical to the publisher's `clientView`). */
export function clientView(bundle: Record<string, unknown>): Record<string, unknown> {
  const flags = isObject(bundle.flags) ? bundle.flags : {};
  const exposed: Record<string, unknown> = {};
  const pending: string[] = [];
  for (const [k, v] of Object.entries(flags)) {
    if (!isObject(v) || v.clientExposed !== true) continue;
    exposed[k] = v;
    if (Array.isArray(v.rules)) for (const r of v.rules) if (isObject(r)) segmentRefs(r.conditions, pending);
  }
  const out: Record<string, unknown> = { ...bundle, flags: exposed };
  if (!own(bundle, "segments")) return out;
  const segments = isObject(bundle.segments) ? bundle.segments : {};
  const needed = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (needed.has(key) || !own(segments, key)) continue;
    needed.add(key);
    const seg = segments[key];
    if (isObject(seg)) segmentRefs(seg.conditions, pending);
  }
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(segments)) if (needed.has(k)) kept[k] = v;
  out.segments = kept;
  return out;
}

/** The two bundle texts the publisher will sign for this preview. */
export function signingTexts(bundle: Record<string, unknown>): { server: string; client: string } {
  const full = typeof bundle.engine === "number" ? bundle : { ...bundle, engine: ENGINE_VERSION };
  return { server: JSON.stringify(full), client: JSON.stringify(clientView(full)) };
}

export const canonical = (environmentId: string, revision: number, checksum: string, text: string) =>
  `nanoflags-bundle-v1\n${environmentId}\n${revision}\n${checksum}\n${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** Reads an Ed25519 private key: a JWK (with `d`) or a PKCS#8 PEM file's text. */
export function privateKeyFrom(text: string): { key: KeyObject; kid: string | null } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const jwk = JSON.parse(trimmed) as { kty?: string; crv?: string; x?: string; d?: string; kid?: unknown };
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new Error("the JWK is not an Ed25519 private key (kty OKP, crv Ed25519, x and d)");
    return { key: createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, format: "jwk" }), kid: typeof jwk.kid === "string" ? jwk.kid : null };
  }
  const key = createPrivateKey(trimmed);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the PEM key is not an Ed25519 key");
  return { key, kid: null };
}

/** The public `x` (base64url) of a private key. */
export const publicX = (key: KeyObject): string => (createPublicKey(key).export({ format: "jwk" }) as { x: string }).x;

export function signPreview(p: CosignPreview, key: KeyObject, kid: string): Cosignature {
  const texts = signingTexts(p.bundle);
  const sig = (text: string) => edSign(null, Buffer.from(canonical(p.environmentId, p.revision, p.checksum, text), "utf8"), key).toString("base64url");
  return { environmentId: p.environmentId, kid, revision: p.revision, checksum: p.checksum, server: sig(texts.server), client: sig(texts.client) };
}

/** True when `sig` verifies for both views with the public key `x`. */
export function verifyCosignature(p: CosignPreview, c: Cosignature, x: string): boolean {
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  const texts = signingTexts(p.bundle);
  return (["server", "client"] as const).every((v) => edVerify(null, Buffer.from(canonical(p.environmentId, p.revision, p.checksum, texts[v]), "utf8"), pub, Buffer.from(c[v], "base64url")));
}

export function generateKey(kid: string): { privateJwk: Record<string, string>; publicJwk: Record<string, string> } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ format: "jwk" }) as Record<string, string>;
  const pub = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { privateJwk: { kty: "OKP", crv: "Ed25519", x: priv.x!, d: priv.d!, kid }, publicJwk: { kty: "OKP", crv: "Ed25519", x: pub.x!, kid } };
}
