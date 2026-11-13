// Node >= 22 has a global WebSocket (and no XMLHttpRequest). Unit tests must never open real sockets: tests of the
// transports inject fakes through the client options, like the JS SDK's tests do.
delete (globalThis as { WebSocket?: unknown }).WebSocket;
