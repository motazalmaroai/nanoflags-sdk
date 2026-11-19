/**
 * `nanoflags log verify` / `nanoflags log monitor`: checks an environment's transparency log (verifiable publish history)
 * on this machine. Same format as the SDK (`@nanoflags/sdk`, src/log.ts) and the edge: RFC 9162 hashing
 * (leaf = SHA-256(0x00 || leaf text), node = SHA-256(0x01 || left || right)), tree heads signed with NanoFlags'
 * bundle-signing key over `nanoflags-log-head-v1\n<env>\n<size>\n<root hex>\n<timestamp ms>`.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

export const LOG_LEAF_VERSION = "nanoflags-log-v1";

export interface TreeHead {
  size: number;
  root: string;
  timestamp: number;
  kid: string;
  signature: string;
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

export function isTreeHead(v: unknown): v is TreeHead {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return typeof h.size === "number" && Number.isInteger(h.size) && h.size >= 1 && typeof h.root === "string" && HEX64.test(h.root) && typeof h.timestamp === "number" && typeof h.kid === "string" && typeof h.signature === "string";
}

export const headText = (environmentId: string, h: Pick<TreeHead, "size" | "root" | "timestamp">) => `nanoflags-log-head-v1\n${environmentId}\n${h.size}\n${h.root}\n${h.timestamp}`;

const sha = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
export const leafHash = (text: string): Buffer => sha(Buffer.from([0]), Buffer.from(text, "utf8"));
const node = (l: Buffer, r: Buffer) => sha(Buffer.from([1]), l, r);

/** Root of the tree over `leaves` (RFC 9162 MTH), computed incrementally: complete subtrees, largest first, folded from the right. */
export function rootOf(leaves: readonly Buffer[]): string {
  if (leaves.length === 0) return sha().toString("hex");
  const frontier: Buffer[] = [];
  leaves.forEach((h, i) => {
    let c = h;
    for (let k = i; k % 2 === 1; k = Math.floor(k / 2)) c = node(frontier.pop()!, c);
    frontier.push(c);
  });
  let r = frontier[frontier.length - 1]!;
  for (let j = frontier.length - 2; j >= 0; j--) r = node(frontier[j]!, r);
  return r.toString("hex");
}

/** RFC 9162 2.1.4.2. */
export function verifyConsistency(size1: number, size2: number, root1: string, root2: string, proof: readonly string[]): boolean {
  if (!(Number.isInteger(size1) && Number.isInteger(size2) && size1 >= 1 && size1 <= size2)) return false;
  if (size1 === size2) return proof.length === 0 && root1 === root2;
  if (!proof.every((p) => HEX64.test(p))) return false;
  let path = proof.map((p) => Buffer.from(p, "hex"));
  if ((size1 & (size1 - 1)) === 0) path = [Buffer.from(root1, "hex"), ...path];
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
      fr = node(c, fr);
      sr = node(c, sr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else sr = node(sr, c);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr.toString("hex") === root1 && sr.toString("hex") === root2;
}

export type PublicJwk = { kty?: string; crv?: string; x?: string; kid?: string; d?: string };

/** True when `head` is signed by one of `keys` (by `kid`). Private members of a JWK are never used. */
export function verifyHead(keys: readonly PublicJwk[], environmentId: string, head: TreeHead): boolean {
  for (const k of keys) {
    if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string" || (k.kid !== undefined && k.kid !== head.kid)) continue;
    try {
      const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" });
      if (edVerify(null, Buffer.from(headText(environmentId, head), "utf8"), pub, Buffer.from(head.signature, "base64url"))) return true;
    } catch {
      /* next key */
    }
  }
  return false;
}

export interface HistoryReport {
  entries: number;
  revisions: { first: number | null; last: number | null };
  cosigned: number;
  emergencies: { index: number; revision: number; publishedAt: number }[];
  /** Revisions logged more than once (re-signed with new bytes). */
  resigned: number[];
  /** Revision numbers between first and last that have no entry (published before the log, or not logged). */
  missing: number[];
  problems: string[];
}

/** Checks every leaf of a downloaded history and recomputes the root of `head.size` leaves. */
export function checkHistory(environmentId: string, texts: readonly string[], head: TreeHead): HistoryReport {
  const report: HistoryReport = { entries: texts.length, revisions: { first: null, last: null }, cosigned: 0, emergencies: [], resigned: [], missing: [], problems: [] };
  const seen = new Set<number>();
  texts.forEach((t, i) => {
    const leaf = parseLeaf(t);
    if (!leaf) return void report.problems.push(`entry ${i} is malformed`);
    if (leaf.environmentId !== environmentId) report.problems.push(`entry ${i} belongs to environment ${leaf.environmentId}`);
    if (seen.has(leaf.revision)) report.resigned.push(leaf.revision);
    seen.add(leaf.revision);
    if (leaf.mode === "cosigned") report.cosigned++;
    if (leaf.mode === "emergency") report.emergencies.push({ index: i, revision: leaf.revision, publishedAt: leaf.publishedAt });
  });
  if (seen.size > 0) {
    const list = [...seen];
    report.revisions = { first: Math.min(...list), last: Math.max(...list) };
    for (let n = report.revisions.first!; n <= report.revisions.last!; n++) if (!seen.has(n)) report.missing.push(n);
  }
  if (texts.length !== head.size) report.problems.push(`downloaded ${texts.length} entries, the head says ${head.size}`);
  else if (rootOf(texts.map(leafHash)) !== head.root) report.problems.push("the entries do not hash to the signed root");
  return report;
}

/** The state file of `log monitor` / `log verify --state`: the last verified head per environment. */
export interface MonitorState {
  version: 1;
  heads: Record<string, TreeHead & { checkedAt: string }>;
}
export function isMonitorState(v: unknown): v is MonitorState {
  return typeof v === "object" && v !== null && (v as MonitorState).version === 1 && typeof (v as MonitorState).heads === "object" && (v as MonitorState).heads !== null;
}
