/**
 * Verifiable publish history (transparency log) and customer co-signatures — the checks behind the `verifyLog`,
 * `coSignerKeys` and `allowEmergencyWithoutCosign` options.
 *
 * The edge's publisher appends every published revision of an environment to an append-only Merkle tree hashed as in
 * RFC 6962 / RFC 9162 (leaf = SHA-256(0x00 || leaf text), node = SHA-256(0x01 || left || right)) and signs tree heads
 * with the same Ed25519 key as bundles. A bundle comes with its leaf, an inclusion proof and a signed head; this module
 * checks that the leaf describes exactly the bytes received, that the proof leads to the head's root, that the head is
 * signed, and that every new head extends the previous one (consistency proof). A NanoFlags compromise could still sign
 * a bad bundle, but it could not hide it: it would be in the log every other client and auditor sees.
 *
 * Only PUBLIC keys are handled here.
 */
import { base64UrlDecode, sha256Hex, utf8, type ImportedKey, type SignatureCrypto } from "./verify.js";

export const LOG_LEAF_VERSION = "nanoflags-log-v1";
export const LOG_HEAD_VERSION = "nanoflags-log-head-v1";

export interface TreeHead {
  size: number;
  root: string;
  timestamp: number;
  kid: string;
  signature: string;
}

export interface LogEvidence {
  index: number;
  leaf: string;
  proof: string[];
  head: TreeHead;
}

export interface LogLeaf {
  environmentId: string;
  revision: number;
  checksum: string;
  bundleSha256: string;
  clientSha256: string;
  publishedAt: number;
  kind: string;
  mode: "standard" | "cosigned" | "emergency";
  cosignerKid: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const LINE = /^[^\n]{1,200}$/;

export function parseLeaf(text: string): LogLeaf | null {
  const p = text.split("\n");
  if (p.length !== 10 || p[0] !== LOG_LEAF_VERSION) return null;
  const [, environmentId, rev, checksum, bundleSha256, clientSha256, at, kind, mode, kid] = p as [string, string, string, string, string, string, string, string, string, string];
  if (!/^[1-9][0-9]{0,9}$/.test(rev) || !/^[0-9]{1,16}$/.test(at) || !LINE.test(environmentId) || !LINE.test(checksum) || !HEX64.test(bundleSha256) || !HEX64.test(clientSha256) || !LINE.test(kind) || !LINE.test(kid)) return null;
  if (mode !== "standard" && mode !== "cosigned" && mode !== "emergency") return null;
  return { environmentId, revision: Number(rev), checksum, bundleSha256, clientSha256, publishedAt: Number(at), kind, mode, cosignerKid: kid === "-" ? null : kid };
}

export function headText(environmentId: string, h: Pick<TreeHead, "size" | "root" | "timestamp">): string {
  return `${LOG_HEAD_VERSION}\n${environmentId}\n${h.size}\n${h.root}\n${h.timestamp}`;
}

export function isTreeHead(v: unknown): v is TreeHead {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return typeof h.size === "number" && Number.isInteger(h.size) && h.size >= 1 && typeof h.root === "string" && HEX64.test(h.root) && typeof h.timestamp === "number" && Number.isFinite(h.timestamp) && typeof h.kid === "string" && typeof h.signature === "string";
}

export function isLogEvidence(v: unknown): v is LogEvidence {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.index === "number" && Number.isInteger(e.index) && e.index >= 0 && typeof e.leaf === "string" && Array.isArray(e.proof) && e.proof.every((x) => typeof x === "string" && HEX64.test(x)) && isTreeHead(e.head);
}

/** Decodes the `X-NanoFlags-Log` header (base64url JSON); null when absent or malformed. */
export function decodeEvidence(header: string | null): LogEvidence | null {
  if (!header) return null;
  try {
    const bytes = base64UrlDecode(header);
    let text = "";
    if (typeof TextDecoder === "function") text = new TextDecoder().decode(bytes);
    else for (const b of bytes) text += String.fromCharCode(b); // ASCII-only content (hex, digits, ids)
    const v: unknown = JSON.parse(text);
    return isLogEvidence(v) ? v : null;
  } catch {
    return null;
  }
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function digest(data: Uint8Array, crypto?: SignatureCrypto): Promise<Uint8Array> {
  if (crypto) return crypto.sha256(data);
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this runtime.");
  return new Uint8Array(await s.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function leafHash(text: string, crypto?: SignatureCrypto): Promise<string> {
  return toHex(await digest(concat(new Uint8Array([0]), utf8(text)), crypto));
}
const node = (l: Uint8Array, r: Uint8Array, crypto?: SignatureCrypto) => digest(concat(new Uint8Array([1]), l, r), crypto);

/** RFC 9162 2.1.3.2. */
export async function verifyInclusion(index: number, size: number, leaf: string, proof: readonly string[], root: string, crypto?: SignatureCrypto): Promise<boolean> {
  if (!(Number.isInteger(index) && Number.isInteger(size) && index >= 0 && index < size) || !HEX64.test(leaf) || !HEX64.test(root)) return false;
  let fn = index;
  let sn = size - 1;
  let r = fromHex(leaf);
  for (const p of proof) {
    if (sn === 0 || !HEX64.test(p)) return false;
    const h = fromHex(p);
    if (fn % 2 === 1 || fn === sn) {
      r = await node(h, r, crypto);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else r = await node(r, h, crypto);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && toHex(r) === root;
}

/** RFC 9162 2.1.4.2. */
export async function verifyConsistency(size1: number, size2: number, root1: string, root2: string, proof: readonly string[], crypto?: SignatureCrypto): Promise<boolean> {
  if (!(Number.isInteger(size1) && Number.isInteger(size2) && size1 >= 1 && size1 <= size2) || !HEX64.test(root1) || !HEX64.test(root2)) return false;
  if (size1 === size2) return proof.length === 0 && root1 === root2;
  if (!proof.every((p) => HEX64.test(p))) return false;
  let path = proof.map(fromHex);
  if ((size1 & (size1 - 1)) === 0) path = [fromHex(root1), ...path];
  if (path.length === 0) return false;
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await node(c, fr, crypto);
      sr = await node(c, sr, crypto);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else sr = await node(sr, c, crypto);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && toHex(fr) === root1 && toHex(sr) === root2;
}

/** True when `head` is signed by one of `keys` (by `kid`). */
export async function verifyHead(keys: readonly ImportedKey[], environmentId: string, head: TreeHead): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlDecode(head.signature);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const data = utf8(headText(environmentId, head));
  for (const k of keys.filter((k) => k.kid === head.kid || k.kid === null)) {
    try {
      if (await k.verify(sig, data)) return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * The checks of one received revision against its evidence: the leaf names this environment, revision, checksum and
 * the SHA-256 of exactly the bundle text received (server or browser view), and the inclusion proof leads to the head.
 * Returns the reason when something does not match, else null. The head's signature and consistency are checked by the
 * caller (they need keys and network).
 */
export async function checkEvidence(e: LogEvidence, expected: { environmentId: string; revision: number; checksum: string; text: string; browser: boolean }, crypto?: SignatureCrypto): Promise<{ leaf: LogLeaf } | { problem: string }> {
  const leaf = parseLeaf(e.leaf);
  if (!leaf) return { problem: "its log entry is malformed." };
  if (leaf.environmentId !== expected.environmentId || leaf.revision !== expected.revision || leaf.checksum !== expected.checksum) return { problem: "its log entry describes another revision." };
  const sha = await sha256Hex(expected.text, crypto);
  if ((expected.browser ? leaf.clientSha256 : leaf.bundleSha256) !== sha) return { problem: "its bytes differ from the ones recorded in the log." };
  if (e.index >= e.head.size || !(await verifyInclusion(e.index, e.head.size, await leafHash(e.leaf, crypto), e.proof, e.head.root, crypto))) return { problem: "its inclusion proof does not verify against the signed tree head." };
  return { leaf };
}

/* ---------------- co-signing: the kill-switch exception ---------------- */

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * True when `next` differs from `prev` only by flags switched off (`enabled: true` → `false`) — what a kill-switch
 * revision does — and its revision number. Anything else (a new rule, a new value, a flag added or removed, a segment
 * changed) is not an emergency revision.
 */
export function onlyTurnsFlagsOff(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (k === "revision" || k === "flags") continue;
    if (stable(prev[k]) !== stable(next[k])) return false;
  }
  const pf = (prev.flags ?? {}) as Record<string, Record<string, unknown>>;
  const nf = (next.flags ?? {}) as Record<string, Record<string, unknown>>;
  if (typeof pf !== "object" || typeof nf !== "object") return false;
  const names = new Set([...Object.keys(pf), ...Object.keys(nf)]);
  for (const name of names) {
    const a = pf[name];
    const b = nf[name];
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const { enabled: ea, ...ra } = a;
    const { enabled: eb, ...rb } = b;
    if (stable(ra) !== stable(rb)) return false;
    if (ea !== eb && !(ea === true && eb === false)) return false;
  }
  return true;
}
