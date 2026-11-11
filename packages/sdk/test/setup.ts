// Node ≥ 22 has a global WebSocket, which the SDK would use for the live transport by default.
// Unit tests must never open real sockets: tests of the live transport inject a mock (`webSocket` option).
delete (globalThis as { WebSocket?: unknown }).WebSocket;
