/**
 * Bounded tool outputs. Every list a tool returns has a `limit` (with a maximum) and, where it can continue, an opaque
 * cursor; on top of that every tool result is held to MAX_OUTPUT_BYTES (text plus structured content, UTF-8). A result
 * that had to be shortened says so: `truncated: true` in the structured content and a marker line in the text, so an
 * agent knows it saw part of the answer and can narrow the request (limit, cursor, environment, window).
 */
import { isObject } from "./api.js";

/** Upper bound of one tool result: the text and the JSON of the structured content together. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const TRUNCATED_MARKER = "[truncated: the answer was longer than the output limit; ask for less with limit/cursor or a narrower filter]";

const enc = new TextEncoder();
export const byteLength = (s: string) => enc.encode(s).byteLength;

/** `limit` argument schema: 1..max, `def` when omitted. */
export const limitArg = (max: number, def: number, what: string) => ({ type: "integer", minimum: 1, maximum: max, description: `How many ${what} to return (1–${max}, default ${def}).` });
export const cursorArg = { type: "string", maxLength: 500, description: "`nextCursor` of the previous answer, for the next page." };

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};

/** An opaque offset cursor for lists the API answers in one piece (e.g. environments), bound to one list `kind`. */
export function offsetCursor(kind: string, offset: number): string {
  return b64url(`mcp1:${kind}:${offset}`);
}
export function readOffsetCursor(kind: string, cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const m = new RegExp(`^mcp1:${kind}:(\\d{1,6})$`).exec(unb64url(cursor) ?? "");
  return m ? Number(m[1]) : null;
}

/** One page of an in-memory list: `{ items, nextCursor, total }`. */
export function pageOf<T>(kind: string, all: T[], offset: number, limit: number): { items: T[]; nextCursor: string | null; total: number } {
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, nextCursor: next < all.length ? offsetCursor(kind, next) : null, total: all.length };
}

/** The first `limit` items and whether anything was left out. */
export function capList<T>(all: readonly T[] | undefined | null, limit: number): { items: T[]; total: number; truncated: boolean } {
  const list = Array.isArray(all) ? all : [];
  return { items: list.slice(0, limit), total: list.length, truncated: list.length > limit };
}

/** The longest array inside `v` (by serialized size), as a holder + key so it can be shortened in place. */
function largestArray(v: unknown, best: { holder: Record<string, unknown> | unknown[]; key: string | number; size: number } | null = null) {
  const visit = (holder: Record<string, unknown> | unknown[], key: string | number, value: unknown) => {
    if (Array.isArray(value)) {
      const size = JSON.stringify(value).length;
      if (value.length > 1 && (!best || size > best.size)) best = { holder, key, size };
      value.forEach((x, i) => visit(value, i, x));
    } else if (isObject(value)) {
      for (const [k, x] of Object.entries(value)) visit(value, k, x);
    }
  };
  if (isObject(v)) for (const [k, x] of Object.entries(v)) visit(v, k, x);
  return best as { holder: Record<string, unknown> | unknown[]; key: string | number; size: number } | null;
}

/** Cuts a string to at most `max` UTF-8 bytes without splitting a character. */
export function cutBytes(s: string, max: number): string {
  const bytes = enc.encode(s);
  if (bytes.byteLength <= max) return s;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/�+$/, "");
}

/**
 * Holds a tool result to `max` bytes. Structured content is shortened by halving its longest arrays (never below one
 * item) and gets `truncated: true`; the text is cut and ends with TRUNCATED_MARKER. Results within the limit are
 * returned unchanged.
 */
export function capResult(text: string, data: unknown, max = MAX_OUTPUT_BYTES): { text: string; data: unknown; truncated: boolean } {
  const size = () => byteLength(text) + (data === undefined ? 0 : byteLength(JSON.stringify(data)));
  if (size() <= max) return { text, data, truncated: false };
  const dataBudget = Math.floor(max * 0.6);
  if (isObject(data)) {
    data = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    (data as Record<string, unknown>).truncated = true;
    for (let i = 0; i < 64 && byteLength(JSON.stringify(data)) > dataBudget; i++) {
      const big = largestArray(data);
      if (!big) break;
      const arr = (big.holder as Record<string | number, unknown>)[big.key] as unknown[];
      (big.holder as Record<string | number, unknown>)[big.key] = arr.slice(0, Math.max(1, Math.floor(arr.length / 2)));
    }
    if (byteLength(JSON.stringify(data)) > dataBudget) data = { truncated: true, note: TRUNCATED_MARKER };
  } else if (data !== undefined && byteLength(JSON.stringify(data)) > dataBudget) {
    data = undefined;
  }
  // A closing "More: cursor=…" line survives the cut, so text-only clients can still page on.
  const more = /\nMore: cursor=[A-Za-z0-9_=-]{1,600}$/.exec(text)?.[0] ?? "";
  const body = more ? text.slice(0, -more.length) : text;
  const textBudget = Math.max(256, max - (data === undefined ? 0 : byteLength(JSON.stringify(data))) - byteLength(TRUNCATED_MARKER) - byteLength(more) - 2);
  text = `${cutBytes(body, textBudget)}${more}\n${TRUNCATED_MARKER}`;
  return { text, data, truncated: true };
}
