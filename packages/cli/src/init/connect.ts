import { randomInt } from "node:crypto";

/**
 * Browser sign-in for `nanoflags init`, without a device-authorization endpoint (none exists yet):
 *
 *   1. The CLI makes a one-time code (`ABCD-2345`) and opens `<app>/app/cli/connect?code=…` in the browser.
 *   2. The signed-in person compares the code with the terminal, picks the project and confirms. The dashboard creates a
 *      short-lived (1 hour) project-scoped Management API token and, unless the CLI reuses one, a Development SDK key, and
 *      shows them once as a connection string bound to the code.
 *   3. The person pastes the string into the terminal. The CLI refuses a string made for another code.
 *
 * Nothing is stored server-side beyond the token and the key themselves (both hashed, as usual). The proper device flow
 * (the CLI polls; no paste) needs a table for pending codes: see the PR that introduced this file.
 */

/** No 0/O, 1/I/L, so the code survives being read aloud or retyped. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function oneTimeCode(rand: (max: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[rand(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/;

/** What the dashboard hands back. Mirrors apps/web/src/lib/cli-connect.ts. */
export interface Connection {
  v: 1;
  code: string;
  /** Management API token (nf_api_…), project-scoped, expires within the hour. */
  token: string;
  tokenExpiresAt: string;
  /** Created SDK key, or null when the CLI said it reuses an existing one. */
  sdkKey: string | null;
  sdkKeyKind: "server" | "client";
  project: { key: string; name: string };
  environment: { key: string; name: string };
  /** Edge URL of the deployment, or null when the deployment does not configure one. */
  edgeUrl: string | null;
}

export const CONNECTION_PREFIX = "nfcli1_";

export function encodeConnection(c: Connection): string {
  return CONNECTION_PREFIX + Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Parses a pasted connection string; throws a message a person can act on. */
export function decodeConnection(raw: string, expectedCode: string): Connection {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text.startsWith(CONNECTION_PREFIX)) throw new Error("That is not a NanoFlags connection string (it starts with nfcli1_). Copy it from the browser page again.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text.slice(CONNECTION_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("The connection string is incomplete. Copy the whole string with the Copy button and paste it again.");
  }
  const c = parsed as Partial<Connection> | null;
  const ok =
    c !== null && typeof c === "object" && c.v === 1 && typeof c.code === "string" && typeof c.token === "string" && /^nf_api_[0-9a-f]{48}$/.test(c.token) &&
    (c.sdkKey === null || (typeof c.sdkKey === "string" && /^nf_(srv|pub)_/.test(c.sdkKey))) && (c.sdkKeyKind === "server" || c.sdkKeyKind === "client") &&
    typeof c.project?.key === "string" && typeof c.environment?.key === "string";
  if (!ok) throw new Error("The connection string is not valid. Start `init` again.");
  if (c.code !== expectedCode) throw new Error(`This connection string was made for code ${c.code}, not ${expectedCode}. Use the browser tab that shows ${expectedCode}, or start \`init\` again.`);
  return c as Connection;
}

/** The dashboard page that confirms the connection. */
export function connectUrl(appUrl: string, p: { code: string; framework: string; kind: "server" | "client"; reuseKey: boolean; publish: boolean; project?: string; environment: string }): string {
  const u = new URL("/app/cli/connect", appUrl);
  u.searchParams.set("code", p.code);
  u.searchParams.set("framework", p.framework);
  u.searchParams.set("kind", p.kind);
  u.searchParams.set("env", p.environment);
  if (p.reuseKey) u.searchParams.set("reuse", "1");
  if (p.publish) u.searchParams.set("publish", "1");
  if (p.project) u.searchParams.set("project", p.project);
  return u.toString();
}
