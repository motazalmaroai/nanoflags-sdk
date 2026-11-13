/**
 * Bundle signature verification (Ed25519 over a canonical string; WebCrypto by default, or an injected `SignatureCrypto`).
 *
 * canonical = "nanoflags-bundle-v1\n<environment_id>\n<revision>\n<checksum>\n<sha256 hex of the bundle JSON text>"
 *
 * Only PUBLIC keys are handled here. Private and admin keys never enter the SDK.
 */

export interface VerifyOptions {
  /**
   * Public Ed25519 keys as JWK (`{ kty: "OKP", crv: "Ed25519", x, kid? }`), or `"fetch"` to load them
   * once from `GET /v1/keys` on the configured edge (again, at most once a minute, when a bundle names an unknown
   * key id). Pinning keys in your build is stronger than `"fetch"`: fetched keys are only as trustworthy as the
   * connection they arrived over. Omitted: the embedded production keys for `https://edge.nanoflags.io`, `"fetch"`
   * for any other edge.
   */
  publicKeys?: readonly JsonWebKey[] | "fetch";
  /**
   * Also reject bundles that carry no signature (the edge's unsigned fallback, `X-NanoFlags-Signed: false`): the SDK
   * keeps its bundle and fetches again shortly instead. Default true for `https://edge.nanoflags.io`, false otherwise.
   */
  require?: boolean;
}

export interface SignatureInfo {
  signature: string;
  kid: string | null;
  environmentId: string;
  revision: number;
  checksum: string;
}

export type PublicJwk = JsonWebKey & { kid?: string };

/**
 * The two primitives signature verification needs. Default: WebCrypto (`crypto.subtle`: browsers, Node, Deno, Bun,
 * edge runtimes). Runtimes without WebCrypto Ed25519 (React Native / Hermes) pass an implementation, e.g. one built
 * on an audited pure-JS library. Either function may return synchronously.
 */
export interface SignatureCrypto {
  /** SHA-256 digest (32 bytes). */
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** RFC 8032 Ed25519 verification. `publicKey` is the 32-byte raw key, `signature` 64 bytes. Must not throw for bad input; return false. */
  ed25519Verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean | Promise<boolean>;
}

/** UTF-8 encoding without depending on `TextEncoder` (missing in some embedded runtimes). */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate, as TextEncoder does
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  bytes.set(out);
  return bytes;
}

export function canonicalString(environmentId: string, revision: number, checksum: string, bundleSha256Hex: string): string {
  return `nanoflags-bundle-v1\n${environmentId}\n${revision}\n${checksum}\n${bundleSha256Hex}`;
}

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this runtime.");
  return s;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(text: string, crypto?: SignatureCrypto): Promise<string> {
  const data = utf8(text);
  return hex(crypto ? await crypto.sha256(data) : new Uint8Array(await subtle().digest("SHA-256", data)));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const s = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error("Malformed base64url value.");
  if (typeof atob === "function") {
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // No `atob` (older embedded runtimes): decode by hand.
  const out = new Uint8Array(new ArrayBuffer(Math.floor((s.length * 3) / 4)));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function isPublicEd25519Jwk(v: unknown): v is PublicJwk {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  // A JWK with a `d` member is a PRIVATE key. It is refused outright rather than silently narrowed.
  return k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" && k.d === undefined;
}

export interface ImportedKey {
  kid: string | null;
  /** True when `signature` is valid for `data` under this key. May throw; callers treat that as "no". */
  verify(signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean>;
}

export async function importPublicKeys(jwks: readonly unknown[], crypto?: SignatureCrypto): Promise<ImportedKey[]> {
  const out: ImportedKey[] = [];
  for (const jwk of jwks) {
    if (!isPublicEd25519Jwk(jwk)) continue;
    const kid = typeof jwk.kid === "string" ? jwk.kid : null;
    if (crypto) {
      let raw: Uint8Array;
      try {
        raw = base64UrlDecode(jwk.x!);
      } catch {
        continue;
      }
      if (raw.length !== 32) continue;
      out.push({ kid, verify: async (signature, data) => (await crypto.ed25519Verify(raw, signature, data)) === true });
      continue;
    }
    // Import only the public members: extra members (kid, use, alg, key_ops) never influence the import.
    const key = await subtle().importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    out.push({ kid, verify: (signature, data) => subtle().verify({ name: "Ed25519" }, key, signature, data) });
  }
  return out;
}

/** True when `info.signature` is a valid signature by one of `keys` over the canonical string for `bundleText`. */
export async function verifyBundleText(keys: readonly ImportedKey[], info: SignatureInfo, bundleText: string, crypto?: SignatureCrypto): Promise<boolean> {
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(info.signature);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const data = utf8(canonicalString(info.environmentId, info.revision, info.checksum, await sha256Hex(bundleText, crypto)));
  // A key id narrows the candidates; without a match nothing is tried (an unknown key id is not "any key").
  const candidates = info.kid === null ? keys : keys.filter((k) => k.kid === info.kid || k.kid === null);
  for (const k of candidates) {
    try {
      if (await k.verify(signature, data)) return true;
    } catch {
      /* try the next key */
    }
  }
  return false;
}

/**
 * Returns the exact source text of the top-level `"bundle"` member of a JSON object, or null.
 * The edge embeds the stored bundle text byte-for-byte; hashing that span avoids depending on
 * re-serialisation. When the member occurs more than once the LAST one wins, like `JSON.parse`.
 */
export function rawMember(text: string, member: string): string | null {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
  };
  const str = (): string | null => {
    if (text[i] !== '"') return null;
    const start = i++;
    while (i < n) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === '"') return text.slice(start, ++i);
      else i++;
    }
    return null;
  };
  const value = (): boolean => {
    ws();
    const c = text[i];
    if (c === '"') return str() !== null;
    if (c === "{" || c === "[") {
      let depth = 0;
      while (i < n) {
        const d = text[i];
        if (d === '"') {
          if (str() === null) return false;
          continue;
        }
        if (d === "{" || d === "[") depth++;
        else if (d === "}" || d === "]") depth--;
        i++;
        if (depth === 0) return true;
      }
      return false;
    }
    const start = i;
    while (i < n && !",}] \n\r\t".includes(text[i]!)) i++;
    return i > start;
  };
  ws();
  if (text[i] !== "{") return null;
  i++;
  let found: string | null = null;
  for (;;) {
    ws();
    if (text[i] === "}") return found;
    const key = str();
    if (key === null) return null;
    ws();
    if (text[i] !== ":") return null;
    i++;
    ws();
    const start = i;
    if (!value()) return null;
    let name: unknown;
    try {
      name = JSON.parse(key);
    } catch {
      return null;
    }
    if (name === member) found = text.slice(start, i);
    ws();
    if (text[i] === ",") i++;
    else if (text[i] === "}") return found;
    else return null;
  }
}
