/**
 * A React-Native-like environment for Node, so the BUILT package (dist/) runs its React Native code path outside a
 * device:
 *
 *   - `react-native` resolves to ./rn-shim.mjs (`AppState` with a scriptable state; nothing else is used);
 *   - the global `WebSocket` takes React Native's constructor signature `(url, protocols, { headers })` and forwards
 *     the headers (User-Agent) to Node's WebSocket — the same contract React Native's native module implements;
 *   - WebCrypto is removed (`globalThis.crypto` undefined), as on Hermes, so signatures are checked by the bundled
 *     pure-JS SHA-256 / Ed25519 only;
 *   - `navigator.product` is "ReactNative".
 *
 * Usage: node --use-env-proxy --import ./scripts/rn-env.mjs scripts/live-check.mjs
 */
import { register } from "node:module";

register(new URL("./rn-loader.mjs", import.meta.url));

const NodeWebSocket = globalThis.WebSocket;
if (typeof NodeWebSocket !== "function") throw new Error("Node >= 22 is required (global WebSocket).");

/** React Native's WebSocket signature on top of Node's (undici accepts `{ protocols, headers }`). */
class ReactNativeLikeWebSocket {
  constructor(url, protocols, options) {
    const ws = new NodeWebSocket(url, { protocols: protocols ?? [], headers: options?.headers ?? {} });
    ReactNativeLikeWebSocket.opened.push({ url, protocols, headers: options?.headers ?? {} });
    return ws;
  }
}
/** What the SDK asked for (url, subprotocols, headers) — the live check prints it. */
ReactNativeLikeWebSocket.opened = [];
globalThis.WebSocket = ReactNativeLikeWebSocket;

Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: { product: "ReactNative" }, configurable: true, writable: true });
