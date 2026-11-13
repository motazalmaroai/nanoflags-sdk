/**
 * Network adapters for React Native.
 *
 * - Every request carries a NanoFlags `User-Agent`. The edge sits behind Cloudflare, which answers `403` (error 1010)
 *   to the default agents of HTTP libraries (e.g. Android's `okhttp/x.y`). React Native, unlike browsers, may set it.
 * - The live socket uses React Native's WebSocket, whose third constructor argument carries headers. The SDK key still
 *   travels in the subprotocol list (`nanoflags.v1`, `key.<sdk key>`), never in the URL.
 * - React Native's `fetch` buffers the whole response, so the SSE fallback (`/v1/stream`) reads through
 *   `XMLHttpRequest`'s incremental `progress` events instead.
 */
import type { StreamOpener, WebSocketConstructor, WebSocketLike } from "@nanoflags/sdk";

/** React Native's WebSocket: WHATWG shape plus an options argument with `headers`. */
export type ReactNativeWebSocketConstructor = new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) => WebSocketLike;

/** Adds `headers` (User-Agent) to every socket the SDK opens. */
export function webSocketWithHeaders(Base: ReactNativeWebSocketConstructor, headers: Record<string, string>): WebSocketConstructor {
  return function NanoFlagsWebSocket(url: string, protocols?: string | string[]) {
    return new Base(url, protocols, { headers: { ...headers } });
  } as unknown as WebSocketConstructor;
}

/** Adds `headers` (User-Agent) to every request unless the request sets them itself. */
export function fetchWithHeaders(base: typeof fetch, headers: Record<string, string>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const merged: Record<string, string> = { ...headers };
    const own = init?.headers;
    if (own) {
      if (typeof (own as Headers).forEach === "function" && !Array.isArray(own)) (own as Headers).forEach((v, k) => (merged[k] = v));
      else if (Array.isArray(own)) for (const [k, v] of own) merged[k!] = v!;
      else Object.assign(merged, own);
    }
    return base(input, { ...init, headers: merged });
  }) as typeof fetch;
}

/** The part of XMLHttpRequest the SSE reader uses. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: null): void;
  abort(): void;
  readonly responseText: string;
  readonly status: number;
  onprogress: ((e: unknown) => void) | null;
  onload: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  ontimeout: ((e: unknown) => void) | null;
  onabort: ((e: unknown) => void) | null;
}
export type XhrConstructor = new () => XhrLike;

const MAX_BUFFER = 65_536;

/**
 * `StreamOpener` over XMLHttpRequest (React Native delivers partial `responseText` while `onprogress` is set).
 * The edge ends an SSE response after a few minutes and the SDK reconnects, so `responseText` stays small.
 */
export function xhrStreamOpener(Xhr: XhrConstructor, headers: Record<string, string> = {}): StreamOpener {
  return (url, init, onEvent) =>
    new Promise<number>((resolve, reject) => {
      const xhr = new Xhr();
      let seen = 0;
      let buffer = "";
      let settled = false;
      const dispatch = (block: string) => {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line === "" || line.startsWith(":")) continue;
          const i = line.indexOf(":");
          const field = i === -1 ? line : line.slice(0, i);
          const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0) onEvent(event, data.join("\n"));
      };
      const feed = () => {
        let text: string;
        try {
          text = xhr.responseText ?? "";
        } catch {
          return;
        }
        if (text.length <= seen) return;
        buffer = (buffer + text.slice(seen)).replace(/\r\n?/g, "\n");
        seen = text.length;
        let i: number;
        while ((i = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          try {
            dispatch(block);
          } catch {
            /* a listener must not break the reader */
          }
        }
        if (buffer.length > MAX_BUFFER) buffer = ""; // defensive: never buffer unbounded garbage
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        init.signal.removeEventListener?.("abort", onAbort);
        xhr.onprogress = xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
        fn();
      };
      const onAbort = () => {
        try {
          xhr.abort();
        } catch {
          /* not open */
        }
        finish(() => resolve(0));
      };
      if (init.signal.aborted) return resolve(0);
      init.signal.addEventListener?.("abort", onAbort);
      xhr.onprogress = feed;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) feed();
        finish(() => resolve(xhr.status));
      };
      xhr.onerror = () => finish(() => reject(new Error("SSE request failed")));
      xhr.ontimeout = () => finish(() => reject(new Error("SSE request timed out")));
      xhr.onabort = () => finish(() => resolve(0));
      try {
        xhr.open("GET", url);
        for (const [k, v] of Object.entries({ ...headers, ...init.headers })) xhr.setRequestHeader(k, v);
        xhr.send(null);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
}
