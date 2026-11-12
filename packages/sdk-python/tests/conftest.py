"""A local fake edge: /v1/bundle, /v1/keys, /v1/events, /v1/session over HTTP and /v1/live over WebSocket,
signing bundles with a throwaway Ed25519 key exactly as RUNTIME.md describes."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ENV_ID = "11111111-2222-3333-4444-555555555555"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_bundle(revision: int, flags: Optional[Dict[str, Any]] = None, **extra: Any) -> Dict[str, Any]:
    if flags is None:
        flags = {
            "new-checkout": {"type": "boolean", "enabled": True, "default": False, "off": False, "rules": [
                {"id": "beta", "match": "all", "conditions": [{"attribute": "plan", "op": "eq", "value": "beta"}], "serve": {"type": "fixed", "value": True}},
                {"id": "half", "match": "all", "conditions": [], "serve": {"type": "rollout", "percentage": 50, "value": True, "otherwise": False}},
            ]},
            "accent": {"type": "string", "enabled": True, "default": "blue", "off": "grey", "rules": []},
            "limit": {"type": "number", "enabled": True, "default": 10, "off": 0, "rules": []},
            "layout": {"type": "json", "enabled": True, "default": {"cols": 3}, "off": None, "rules": []},
            "disabled": {"type": "string", "enabled": False, "default": "on", "off": "off", "rules": []},
        }
    return {"schema": 1, "engine": 1, "project": "p", "environment": "test", "revision": revision, "flags": flags, "segments": {}, **extra}


class FakeEdge:
    def __init__(self) -> None:
        self.key = Ed25519PrivateKey.generate()
        raw = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.jwk = {"kty": "OKP", "crv": "Ed25519", "x": b64url(raw), "kid": "t1"}
        self.kid = "t1"
        self.lock = threading.Lock()
        self.signed = True
        self.tamper = False
        self.status_override: Optional[int] = None
        self.requests: List[Dict[str, Any]] = []
        self.events: List[Dict[str, Any]] = []
        self.sockets: List[Any] = []
        self.ws_connects = 0
        self.ws_accept = True
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.set_bundle(make_bundle(1))
        self._http = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._http.daemon_threads = True
        threading.Thread(target=self._http.serve_forever, daemon=True).start()
        from websockets.sync.server import serve

        self._ws = serve(self._ws_handler, "127.0.0.1", 0, subprotocols=["nanoflags.v1"])
        threading.Thread(target=self._ws.serve_forever, daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self._http.server_address[1]}"
        self.live_url = f"ws://127.0.0.1:{self._ws.socket.getsockname()[1]}/v1/live"

    # ---- signing
    def sign(self, text: str, revision: int, checksum: str, key: Optional[Ed25519PrivateKey] = None) -> str:
        digest = hashlib.sha256(text.encode()).hexdigest()
        canonical = f"nanoflags-bundle-v1\n{ENV_ID}\n{revision}\n{checksum}\n{digest}"
        return b64url((key or self.key).sign(canonical.encode()))

    def set_bundle(self, bundle: Dict[str, Any]) -> None:
        with self.lock:
            # Key order and spacing deliberately differ from what Python's json.dumps(parsed) would produce
            # back, so verification must hash the raw span.
            self.text = json.dumps(bundle, separators=(", ", ": "))
            self.revision = bundle["revision"]
            self.checksum = hashlib.md5(self.text.encode()).hexdigest()
            self.signature = self.sign(self.text, self.revision, self.checksum)

    def push(self, bundle: Dict[str, Any], *, tamper: bool = False, committed_at: Optional[float] = None, sign_key: Optional[Ed25519PrivateKey] = None) -> None:
        self.set_bundle(bundle)
        msg = self.message("rev", tamper=tamper, committed_at=committed_at, sign_key=sign_key)
        for ws in list(self.sockets):
            try:
                ws.send(msg)
            except Exception:
                pass

    def message(self, t: str, *, tamper: bool = False, committed_at: Optional[float] = None, sign_key: Optional[Ed25519PrivateKey] = None) -> str:
        with self.lock:
            text = self.text
            sig = self.sign(text, self.revision, self.checksum, sign_key) if sign_key else self.signature
            if tamper:
                text = text.replace('"default": "blue"', '"default": "red"')
            return json.dumps({"t": t, "revision": self.revision, "checksum": self.checksum, "signature": sig, "kid": self.kid, "environmentId": ENV_ID, "bundle": text, "committedAt": committed_at, "sentAt": time.time() * 1000})

    def close_sockets(self, code: int, reason: str = "") -> None:
        for ws in list(self.sockets):
            try:
                ws.close(code, reason)
            except Exception:
                pass

    # ---- servers
    def _ws_handler(self, ws: Any) -> None:
        self.ws_connects += 1
        auth = ws.request.headers.get("Authorization")
        if not self.ws_accept or not auth:
            ws.close(1011, "nope")
            return
        self.sockets.append(ws)
        try:
            ws.send(self.message("hello"))
            for msg in ws:
                if msg == "ping":
                    ws.send("pong")
        except Exception:
            pass
        finally:
            if ws in self.sockets:
                self.sockets.remove(ws)

    def _handler(self) -> type:
        edge = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _send(self, status: int, body: bytes = b"", headers: Optional[Dict[str, str]] = None) -> None:
                self.send_response(status)
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802
                edge.requests.append({"path": self.path, "headers": dict(self.headers)})
                if self.path == "/v1/keys":
                    return self._send(200, json.dumps({"keys": [{**edge.jwk, "alg": "EdDSA", "use": "sig", "status": "active"}]}).encode())
                if edge.status_override:
                    return self._send(edge.status_override, b'{"error":{"code":"x","message":"x"}}')
                if self.path == "/v1/bundle":
                    with edge.lock:
                        etag = f'"{edge.checksum}-server"'
                        headers = {"ETag": etag, "X-NanoFlags-Environment-Id": ENV_ID, "X-NanoFlags-Signed": "true" if edge.signed else "false"}
                        if edge.signed:
                            headers.update({"X-NanoFlags-Signature": edge.signature, "X-NanoFlags-Key-Id": edge.kid})
                        if self.headers.get("If-None-Match") == etag:
                            return self._send(304, b"", headers)
                        text = edge.text.replace('"default": "blue"', '"default": "red"') if edge.tamper else edge.text
                        body = f'{{"revision":{edge.revision},"checksum":"{edge.checksum}","bundle":{text}}}'.encode()
                    return self._send(200, body, headers)
                if self.path == "/v1/session":
                    tok = self.headers.get("X-NanoFlags-Session")
                    s = edge.sessions.get(tok or "")
                    if not s:
                        return self._send(404, b'{"error":{"code":"session_not_found","message":"x"}}')
                    return self._send(200, json.dumps(s).encode())
                return self._send(404)

            def do_POST(self) -> None:  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n)
                edge.requests.append({"path": self.path, "headers": dict(self.headers)})
                if self.path == "/v1/events":
                    edge.events.append(json.loads(body))
                    return self._send(202, b'{"accepted":0,"capped":false}')
                return self._send(404)

        return H

    def shutdown(self) -> None:
        self._http.shutdown()
        self._ws.shutdown()


@pytest.fixture
def edge():
    e = FakeEdge()
    yield e
    e.shutdown()


def wait_for(pred, timeout: float = 5.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()
