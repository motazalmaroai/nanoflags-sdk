"""Minimal blocking HTTP on the standard library (proxy settings and CA bundle from the environment)."""

from __future__ import annotations

import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterator, Mapping, Optional, Tuple

__all__ = ["HttpResponse", "http_request", "iter_sse"]


class _Headers:
    """Case-insensitive, read-only header view."""

    def __init__(self, items: Mapping[str, str]) -> None:
        self._d = {k.lower(): v for k, v in items.items()}

    def get(self, name: str, default: Optional[str] = None) -> Optional[str]:
        return self._d.get(name.lower(), default)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name.lower() in self._d

    def __repr__(self) -> str:
        return f"Headers({self._d!r})"


@dataclass
class HttpResponse:
    status: int
    headers: _Headers
    body: bytes = field(repr=False, default=b"")

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def text(self) -> str:
        return self.body.decode("utf-8")


#: (method, url, headers, body, timeout) -> HttpResponse. Injectable for tests and custom stacks.
HttpFunction = Callable[[str, str, Dict[str, str], Optional[bytes], float], HttpResponse]

_ctx: Optional[ssl.SSLContext] = None


def _ssl_context() -> ssl.SSLContext:
    global _ctx
    if _ctx is None:
        _ctx = ssl.create_default_context()  # honours SSL_CERT_FILE / SSL_CERT_DIR
    return _ctx


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # The SDK key travels in a header: never follow a redirect to another origin with it.
    def redirect_request(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return None


_opener: Optional[urllib.request.OpenerDirector] = None


def _get_opener() -> urllib.request.OpenerDirector:
    global _opener
    if _opener is None:
        _opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ssl_context()), _NoRedirect())
    return _opener


def http_request(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> HttpResponse:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with _get_opener().open(req, timeout=timeout) as res:
            return HttpResponse(res.status, _Headers(dict(res.headers.items())), res.read())
    except urllib.error.HTTPError as e:  # non-2xx (incl. 304) still is an answer
        try:
            data = e.read()
        except Exception:  # noqa: BLE001
            data = b""
        return HttpResponse(e.code, _Headers(dict(e.headers.items()) if e.headers else {}), data)


def open_stream(url: str, headers: Dict[str, str], timeout: float) -> Tuple[int, object]:
    """Open a long-lived GET; returns (status, response). The caller closes the response."""
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        res = _get_opener().open(req, timeout=timeout)
        return res.status, res
    except urllib.error.HTTPError as e:
        e.close()
        return e.code, None


def iter_sse(lines: Iterator[bytes]) -> Iterator[Tuple[str, str]]:
    """Yield (event, data) pairs from a server-sent-events byte line iterator."""
    event = "message"
    data: list = []
    for raw in lines:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
            continue
        if line.startswith(":"):
            continue
        name, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)
