/**
 * Bundle signature verification (Ed25519 over a canonical string, WebCrypto only).
 *
 * canonical = "nanoflags-bundle-v1\n<environment_id>\n<revision>\n<checksum>\n<sha256 hex of the bundle JSON text>"
 *
 * Only PUBLIC keys are handled here. Private and admin keys never enter the SDK.
 */

export interface VerifyOptions {
  /**
   * Public Ed25519 keys as JWK (`{ kty: "OKP", crv: "Ed25519", x, kid? }`), or `"fetch"` to load them
   * once from `GET /v1/keys` on the configured edge. Pinning keys in your build is stronger than
   * `"fetch"`: fetched keys are only as trustworthy as the connection they arrived over.
   */
  publicKeys: JsonWebKey[] | "fetch";
  /** Also reject bundles that carry no signature. Default false. */
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

const encoder = new TextEncoder();

export function canonicalString(environmentId: string, revision: number, checksum: string, bundleSha256Hex: string): string {
  return `nanoflags-bundle-v1\n${environmentId}\n${revision}\n${checksum}\n${bundleSha256Hex}`;
}

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this runtime.");
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", encoder.encode(text)));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const s = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error("Malformed base64url value.");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
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
  key: CryptoKey;
}

export async function importPublicKeys(jwks: readonly unknown[]): Promise<ImportedKey[]> {
  const out: ImportedKey[] = [];
  for (const jwk of jwks) {
    if (!isPublicEd25519Jwk(jwk)) continue;
    // Import only the public members: extra members (kid, use, alg, key_ops) never influence the import.
    const key = await subtle().importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    out.push({ kid: typeof jwk.kid === "string" ? jwk.kid : null, key });
  }
  return out;
}

/** True when `info.signature` is a valid signature by one of `keys` over the canonical string for `bundleText`. */
export async function verifyBundleText(keys: readonly ImportedKey[], info: SignatureInfo, bundleText: string): Promise<boolean> {
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(info.signature);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const data = encoder.encode(canonicalString(info.environmentId, info.revision, info.checksum, await sha256Hex(bundleText)));
  // A key id narrows the candidates; without a match nothing is tried (an unknown key id is not "any key").
  const candidates = info.kid === null ? keys : keys.filter((k) => k.kid === info.kid || k.kid === null);
  for (const k of candidates) {
    try {
      if (await subtle().verify({ name: "Ed25519" }, k.key, signature, data)) return true;
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
