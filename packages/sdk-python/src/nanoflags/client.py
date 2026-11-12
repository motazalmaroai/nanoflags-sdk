"""The NanoFlags server client.

Flags are evaluated locally and synchronously against an in-memory bundle; a variation call never
performs I/O and never raises. The network is used in background threads only: to load the bundle,
to receive new revisions (live WebSocket ``/v1/live``, falling back to SSE ``/v1/stream`` and polling
``/v1/bundle``), and to send sampled telemetry plus the periodic service report (``/v1/events``).
Behaviour follows the TypeScript SDK (``@nanoflags/sdk`` 0.4) and RUNTIME.md.
"""

from __future__ import annotations

import json
import logging
import math
import random
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Union

from . import _http
from ._js import js_stringify
from .engine import ENGINE_VERSION, Evaluation, TraceStep, evaluate as engine_evaluate, is_bundle, murmur3, supports_engine, type_of
from .keys import OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS
from .store import FileStore, Store
from .verify import ImportedKey, SignatureInfo, import_public_keys, is_public_ed25519_jwk, raw_member, verify_bundle_text

try:
    from typing import Literal
except ImportError:  # pragma: no cover
    from typing_extensions import Literal  # type: ignore

__all__ = [
    "CLOSE_ENVIRONMENT_DELETED",
    "EventsOptions",
    "LIVE_PROTOCOL",
    "NanoFlags",
    "NanoFlagsError",
    "SDK_VERSION",
    "SESSION_HEADER",
    "SUPPORTED_ENGINE_VERSION",
    "SessionEvaluator",
    "UpdateEvent",
    "VerifyOptions",
]

SDK_VERSION = "0.1.0"
SUPPORTED_ENGINE_VERSION = ENGINE_VERSION
#: WebSocket close code of the edge for a deleted environment: the client stops reconnecting.
CLOSE_ENVIRONMENT_DELETED = 4004
#: WebSocket subprotocol of ``/v1/live``.
LIVE_PROTOCOL = "nanoflags.v1"
#: Header that carries a test-session token between services.
SESSION_HEADER = "x-nanoflags-session"

Status = Literal["not-ready", "ready", "stale"]
Transport = Literal["live", "stream", "poll"]
ErrorCode = Literal["network", "unauthorized", "http", "invalid_bundle", "store", "config", "signature", "session", "engine", "environment_deleted"]

log = logging.getLogger("nanoflags")

_MAX_QUEUE = 500
_MAX_BATCH = 50
_MAX_EVENT_VALUE_CHARS = 1024
_REQUEST_TIMEOUT = 10.0
_KEYS_REFETCH = 60.0
_LIVE_CONNECT_TIMEOUT = 10.0
_LIVE_PING = 30.0
_LIVE_PONG_TIMEOUT = 10.0
_LIVE_MAX_BACKOFF = 300.0
_LIVE_ROTATE = 50 * 60.0
_SESSION_MISS_TTL = 15.0
_SESSION_ERROR_TTL = 3.0
_MAX_SESSIONS = 1000


class NanoFlagsError(Exception):
    """An error reported to ``on_error`` listeners. Never raised from a variation call."""

    def __init__(self, message: str, code: ErrorCode, http_status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.http_status = http_status

    def __repr__(self) -> str:
        return f"NanoFlagsError({str(self)!r}, code={self.code!r})"


@dataclass(frozen=True)
class UpdateEvent:
    """A new configuration is in use."""

    revision: int
    previous_revision: Optional[int]
    checksum: Optional[str]
    #: ``network``, ``store`` (file cache) or ``bootstrap``.
    source: str
    #: How it arrived: pushed (``live``), fetched after an SSE notification (``stream``), or ``poll``.
    transport: str
    #: Milliseconds from the database commit to this event, for pushed revisions that carry the commit time.
    latency_ms: Optional[float] = None


@dataclass(frozen=True)
class VerifyOptions:
    """Signature verification settings.

    ``public_keys``: public Ed25519 JWKs to verify with, or ``"fetch"`` to load ``GET /v1/keys`` from the edge
    (again at most once a minute when a bundle names an unknown key id). Default: the embedded production keys for
    the official edge, ``"fetch"`` for any other edge. ``require``: also refuse unsigned bundles (default true for
    the official edge).
    """

    public_keys: Union[Sequence[Mapping[str, Any]], str, None] = None
    require: Optional[bool] = None


@dataclass(frozen=True)
class EventsOptions:
    enabled: bool = True
    #: Fraction of evaluations reported, 0–1.
    sample_rate: float = 0.1
    #: Seconds between sends while events are queued.
    flush_interval: float = 10.0
    #: Seconds between service reports while nothing is queued.
    report_interval: float = 60.0
    #: What leaves the process with a sampled event. Default: only the names (and value types) of attributes the
    #: flag's rules reference — never attribute values.
    redact: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None


@dataclass
class _SessionState:
    id: str
    bundle: Dict[str, Any]
    context: Dict[str, Any]
    expires_at: str
    expires_at_ts: float


def _now_ms() -> float:
    return time.time() * 1000.0


def _loads(text: str) -> Any:
    def reject(name: str) -> Any:
        raise ValueError(f"invalid JSON constant {name}")

    return json.loads(text, parse_constant=reject)


def _is_session_token(v: Any) -> bool:
    return isinstance(v, str) and 1 <= len(v) <= 512 and all(0x21 <= ord(c) <= 0x7E for c in v)


def _to_json_context(ctx: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if not ctx:
        return {}

    def conv(v: Any, depth: int) -> Any:
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if depth > 16:
            return None
        if isinstance(v, (list, tuple)):
            return [conv(x, depth + 1) for x in v]
        if isinstance(v, Mapping):
            return {str(k): conv(x, depth + 1) for k, x in v.items()}
        if isinstance(v, datetime):
            return v.isoformat()
        return str(v)

    return {str(k): conv(v, 0) for k, v in ctx.items()}


def _accepts_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _accepts_str(v: Any) -> bool:
    return isinstance(v, str)


def _accepts_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _accepts_any(v: Any) -> bool:
    return True


class SessionEvaluator:
    """Evaluator bound to one test session.

    While ``active``, flags are evaluated against the session's pinned bundle with ``{**session.context, **ctx}``
    and sampled events carry the session id. Unknown, expired or not permitted sessions evaluate exactly like the
    client (``active`` is false).
    """

    def __init__(self, client: "NanoFlags", state: Optional[_SessionState]) -> None:
        self._client = client
        self._state = state

    @property
    def active(self) -> bool:
        return self._state is not None and time.time() < self._state.expires_at_ts

    @property
    def id(self) -> Optional[str]:
        return self._state.id if self._state else None

    @property
    def expires_at(self) -> Optional[str]:
        return self._state.expires_at if self._state else None

    @property
    def revision(self) -> Optional[int]:
        if self.active:
            return self._state.bundle.get("revision")  # type: ignore[union-attr]
        return self._client.revision

    def _scope(self) -> Optional[_SessionState]:
        return self._state if self.active else None

    def bool_variation(self, key: str, default: bool, context: Optional[Mapping[str, Any]] = None) -> bool:
        return self._client._run(key, default, context, _accepts_bool, self._scope()).value

    def string_variation(self, key: str, default: str, context: Optional[Mapping[str, Any]] = None) -> str:
        return self._client._run(key, default, context, _accepts_str, self._scope()).value

    def number_variation(self, key: str, default: Union[int, float], context: Optional[Mapping[str, Any]] = None) -> Union[int, float]:
        return self._client._run(key, default, context, _accepts_number, self._scope()).value

    def json_variation(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Any:
        return self._client._run(key, default, context, _accepts_any, self._scope()).value

    def evaluate(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self._client._run(key, default, context, None, self._scope())


class NanoFlags:
    """NanoFlags client for Python servers. Create one per process and share it between threads.

    >>> flags = NanoFlags("nf_srv_…", service="checkout-api")   # doctest: +SKIP
    >>> flags.wait_until_ready(5)                                  # doctest: +SKIP
    >>> flags.bool_variation("new-checkout", False, {"key": user_id})  # doctest: +SKIP
    """

    def __init__(
        self,
        sdk_key: str,
        *,
        base_url: str = OFFICIAL_EDGE_URL,
        service: Optional[str] = None,
        poll_interval: float = 30.0,
        streaming: bool = True,
        live: bool = True,
        live_poll_interval: float = 300.0,
        bootstrap: Union[Mapping[str, Any], str, None] = None,
        cache_path: Optional[str] = None,
        store: Optional[Store] = None,
        events: Union[EventsOptions, bool, None] = None,
        verify: Union[VerifyOptions, bool, None] = None,
        on_change: Optional[Callable[[UpdateEvent], None]] = None,
        on_error: Optional[Callable[[NanoFlagsError], None]] = None,
        start: bool = True,
        http: Optional[_http.HttpFunction] = None,
        live_url: Optional[str] = None,
    ) -> None:
        """
        :param sdk_key: ``nf_srv_…`` (server view) or ``nf_pub_…`` (client-exposed flags only).
        :param base_url: edge URL. Default: the hosted edge, where signatures are verified by default.
        :param service: name shown in "which revision is this service running".
        :param poll_interval: seconds between polls while no live socket is open (``0`` disables polling).
        :param streaming: receive updates without polling (live WebSocket, else SSE). ``False`` disables both.
        :param live: ``False`` skips the WebSocket and uses SSE + polling.
        :param live_poll_interval: safety-poll seconds while the live socket is healthy.
        :param bootstrap: a bundle (dict or JSON text) to use until the edge answers.
        :param cache_path: keep the last good bundle in this file (restored, and verified again, on start).
        :param store: custom persistence (``get()`` / ``set(text)``); overrides ``cache_path``.
        :param events: ``False`` disables telemetry; ``EventsOptions`` tunes it.
        :param verify: ``False`` disables signature verification; ``VerifyOptions`` configures it.
        :param on_change: called with an :class:`UpdateEvent` whenever a new configuration is adopted.
        :param on_error: called with a :class:`NanoFlagsError` for background failures.
        :param start: ``False`` defers the background work until :meth:`start`.
        :param http: injectable ``(method, url, headers, body, timeout) -> HttpResponse``.
        :param live_url: WebSocket URL of ``/v1/live`` when it is not ``base_url`` with ``ws(s)://`` (advanced).
        """
        self.sdk_key = sdk_key
        self.base_url = str(base_url or "").rstrip("/")
        self.service = service or "unknown"
        self._poll_interval = float(poll_interval)
        self._live_poll_interval = float(live_poll_interval)
        self._streaming = streaming
        self._live_enabled = live
        self._http: _http.HttpFunction = http or _http.http_request
        self._live_url_override = live_url
        if events is False:
            self._ev = EventsOptions(enabled=False)
        elif events is None or events is True:
            self._ev = EventsOptions()
        else:
            self._ev = events
        self._sample_rate = min(1.0, max(0.0, self._ev.sample_rate))
        self._id = format(murmur3(f"{self.base_url}|{sdk_key}"), "08x")
        self._store: Optional[Store] = store if store is not None else (FileStore(cache_path) if cache_path else None)
        self._is_browser_key = isinstance(sdk_key, str) and sdk_key.startswith("nf_pub_")
        self._official = self.base_url == OFFICIAL_EDGE_URL

        # ---- verification
        self._verify: Optional[Dict[str, Any]] = None
        if verify is not False:
            if verify is None or verify is True:
                if self._official or verify is True:
                    self._verify = {"keys": list(OFFICIAL_SIGNING_KEYS) if self._official else "fetch", "require": self._official or verify is True, "refetch": True}
            else:
                pk = verify.public_keys
                keys: Any = "fetch" if pk == "fetch" else (list(pk) if pk is not None and not isinstance(pk, str) else (list(OFFICIAL_SIGNING_KEYS) if self._official else "fetch"))
                self._verify = {"keys": keys, "require": verify.require if verify.require is not None else self._official, "refetch": keys == "fetch" or (self._official and pk is None)}
        self._pinned_keys: Optional[List[ImportedKey]] = None
        self._fetched_keys: List[ImportedKey] = []
        self._keys_fetched_at = 0.0
        self._keys_lock = threading.Lock()

        # ---- state (the bundle is replaced as a whole: every evaluation sees one consistent revision)
        self._lock = threading.RLock()
        self._bundle: Optional[Dict[str, Any]] = None
        self._etag: Optional[str] = None
        self._checksum: Optional[str] = None
        self._status: Status = "not-ready"
        self._sig: Optional[SignatureInfo] = None
        self._raw: Optional[str] = None
        self._pinned_env: Optional[str] = None
        self._live_revision = 0
        self._failures = 0
        self._closed = False
        self._started = False
        self._environment_deleted = False
        self._ready = threading.Event()
        self._listeners: Dict[str, List[Callable[..., None]]] = {"update": [], "error": [], "status": []}
        if on_change:
            self._listeners["update"].append(on_change)
        if on_error:
            self._listeners["error"].append(on_error)

        # ---- background machinery
        self._sync_mutex = threading.Lock()
        self._wake = threading.Event()
        self._sync_requested = False
        self._stream_triggered = False
        self._live_open = False
        self._live_socket: Any = None
        self._live_wake = threading.Event()
        self._stream_active = False
        self._stream_gen = 0
        self._stream_response: Any = None
        self._threads: List[threading.Thread] = []
        self._queue: List[Dict[str, Any]] = []
        self._queue_lock = threading.Lock()
        self._last_report = 0.0
        self._events_wake = threading.Event()
        self._used_attrs: Dict[str, List[str]] = {}
        self._used_attrs_for: Optional[int] = None
        self._sessions: Dict[str, Any] = {}
        self._sessions_lock = threading.Lock()

        if bootstrap is not None:
            b: Any = bootstrap
            if isinstance(b, str):
                try:
                    b = _loads(b)
                except ValueError:
                    b = None
            if is_bundle(b) and not supports_engine(b):
                self._pending_errors = [self._engine_error(b)]
            elif is_bundle(b):
                self._adopt(dict(b), etag=None, checksum=None, status="ready", source="bootstrap", transport="poll")
            else:
                self._pending_errors = [NanoFlagsError("The bootstrap bundle is invalid and was ignored.", "invalid_bundle")]
        if self._verify and isinstance(self._verify["keys"], list) and any(not is_public_ed25519_jwk(k) for k in self._verify["keys"]):
            self._pending_errors = getattr(self, "_pending_errors", []) + [NanoFlagsError("`verify.public_keys` must contain public Ed25519 JWKs only. Other entries (including private keys) were ignored.", "config")]
        if start:
            self.start()

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        """Start the background threads (done by the constructor unless ``start=False``)."""
        with self._lock:
            if self._started or self._closed:
                return
            self._started = True
        for e in getattr(self, "_pending_errors", []):
            self._emit_error(e)
        self._pending_errors = []
        if not isinstance(self.sdk_key, str) or not self.sdk_key or not self.base_url:
            self._emit_error(NanoFlagsError("`sdk_key` and `base_url` are required.", "config"))
            self._ready.set()
            return
        self._spawn(self._main_loop, "nanoflags-sync")

    def _spawn(self, target: Callable[[], None], name: str) -> threading.Thread:
        t = threading.Thread(target=self._guard(target), name=name, daemon=True)
        self._threads.append(t)
        t.start()
        return t

    def _guard(self, fn: Callable[[], None]) -> Callable[[], None]:
        def run() -> None:
            try:
                fn()
            except Exception:  # noqa: BLE001 - a background failure must never surface in the application
                log.exception("nanoflags background thread failed")

        return run

    def close(self) -> None:
        """Stop the background work and send queued telemetry. Evaluations keep working on the last bundle."""
        with self._lock:
            if self._closed:
                return
            started = self._started
        if started:
            try:
                self.flush(timeout=2.0)  # best effort: shutdown must not wait for an unreachable edge
            except Exception:  # noqa: BLE001
                pass
        with self._lock:
            self._closed = True
        self._wake.set()
        self._live_wake.set()
        self._events_wake.set()
        self._drop_live()
        self._stop_stream()
        self._ready.set()
        for t in self._threads:
            if t is not threading.current_thread():
                t.join(timeout=2)

    def __enter__(self) -> "NanoFlags":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def wait_until_ready(self, timeout: Optional[float] = None) -> bool:
        """Block until a usable bundle is loaded, or the first load attempt finished without one. Never raises.

        Returns ``True`` when a bundle is in use (``status`` is ``ready`` or ``stale``)."""
        self._ready.wait(timeout)
        return self._bundle is not None

    def ready(self, timeout: Optional[float] = None) -> bool:
        """Alias of :meth:`wait_until_ready`."""
        return self.wait_until_ready(timeout)

    @property
    def status(self) -> Status:
        return self._status

    @property
    def revision(self) -> Optional[int]:
        b = self._bundle
        return b.get("revision") if b is not None else None

    @property
    def transport(self) -> Transport:
        return "live" if self._live_open else "stream" if self._stream_active else "poll"

    @property
    def initialized(self) -> bool:
        return self._bundle is not None

    # ------------------------------------------------------------------ listeners

    def on(self, event: str, callback: Callable[..., None]) -> Callable[[], None]:
        """Subscribe to ``update`` (:class:`UpdateEvent`), ``error`` (:class:`NanoFlagsError`) or ``status`` (str).
        Returns a function that unsubscribes."""
        if event not in self._listeners:
            raise ValueError(f"unknown event {event!r}")
        with self._lock:
            self._listeners[event].append(callback)

        def off() -> None:
            with self._lock:
                try:
                    self._listeners[event].remove(callback)
                except ValueError:
                    pass

        return off

    def on_change(self, callback: Callable[[UpdateEvent], None]) -> Callable[[], None]:
        """Call ``callback`` whenever a new configuration is adopted. Returns an unsubscribe function."""
        return self.on("update", callback)

    def on_error(self, callback: Callable[[NanoFlagsError], None]) -> Callable[[], None]:
        return self.on("error", callback)

    def _fire(self, event: str, arg: Any) -> None:
        with self._lock:
            callbacks = list(self._listeners[event])
        for cb in callbacks:
            try:
                cb(arg)
            except Exception:  # noqa: BLE001 - a listener must never break the client
                log.exception("nanoflags %s listener failed", event)

    def _emit_error(self, e: NanoFlagsError) -> None:
        log.debug("nanoflags: %s (%s)", e, e.code)
        self._fire("error", e)

    def _set_status(self, status: Status) -> None:
        with self._lock:
            if self._status == status:
                return
            self._status = status
        self._fire("status", status)

    # ------------------------------------------------------------------ evaluation

    def bool_variation(self, key: str, default: bool, context: Optional[Mapping[str, Any]] = None) -> bool:
        """Boolean value of ``key`` for ``context``; ``default`` when unknown, not a boolean, or nothing is loaded."""
        return self._run(key, default, context, _accepts_bool).value

    def string_variation(self, key: str, default: str, context: Optional[Mapping[str, Any]] = None) -> str:
        return self._run(key, default, context, _accepts_str).value

    def number_variation(self, key: str, default: Union[int, float], context: Optional[Mapping[str, Any]] = None) -> Union[int, float]:
        return self._run(key, default, context, _accepts_number).value

    def json_variation(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Any:
        return self._run(key, default, context, _accepts_any).value

    def bool_variation_detail(self, key: str, default: bool, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        """Like :meth:`bool_variation`, with the reason, matched rule and trace (:class:`~nanoflags.Evaluation`)."""
        return self._run(key, default, context, _accepts_bool)

    def string_variation_detail(self, key: str, default: str, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self._run(key, default, context, _accepts_str)

    def number_variation_detail(self, key: str, default: Union[int, float], context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self._run(key, default, context, _accepts_number)

    def json_variation_detail(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self._run(key, default, context, _accepts_any)

    def evaluate(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        """Full engine result (value, reason, matched rule, trace). No type check is applied."""
        return self._run(key, default, context, None)

    def all_flags(self, context: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """Every flag of the loaded configuration evaluated for ``context`` (``{}`` when nothing is loaded).
        Not sampled into telemetry."""
        b = self._bundle
        if b is None:
            return {}
        ctx = _to_json_context(context)
        flags = b.get("flags") or {}
        return {k: engine_evaluate(b, k, ctx, None).value for k in flags}

    def _run(self, key: str, default: Any, context: Optional[Mapping[str, Any]], accepts: Optional[Callable[[Any], bool]], scope: Optional[_SessionState] = None) -> Evaluation:
        try:
            if scope is not None:
                b: Optional[Dict[str, Any]] = scope.bundle
                ctx = {**scope.context, **_to_json_context(context)}
            else:
                b = self._bundle
                ctx = _to_json_context(context)
            result = engine_evaluate(b, key, ctx, default)
            if accepts is not None and result.reason not in ("flag_not_found", "error") and not accepts(result.value):
                error = f'Flag "{key}" has a {type_of(result.value)} value, which does not match the requested type.'
                result = Evaluation(key, default, "error", result.revision, trace=[*result.trace, TraceStep("result", "Returned the fallback", error)], error=error)
            self._record(result, ctx, b, scope.id if scope else None)
            return result
        except Exception as e:  # noqa: BLE001 - accessors never raise
            return Evaluation(key, default, "error", 0, error=str(e))

    # ------------------------------------------------------------------ adoption

    def _engine_error(self, b: Mapping[str, Any]) -> NanoFlagsError:
        return NanoFlagsError(
            f"Bundle r{b.get('revision')} needs evaluation engine {js_stringify(b.get('engine'))}; this SDK supports up to {ENGINE_VERSION}. Upgrade nanoflags. The configuration in use is unchanged.",
            "engine",
        )

    def _adopt(self, nxt: Dict[str, Any], *, etag: Optional[str], checksum: Optional[str], status: Status, source: str, transport: str, latency_ms: Optional[float] = None) -> None:
        with self._lock:
            prev = self._bundle
            prev_rev = prev.get("revision") if prev is not None else None
            is_new = prev is None or prev_rev != nxt.get("revision") or self._checksum != checksum
            self._bundle = nxt  # single assignment: the swap is atomic for concurrent evaluations
            self._etag = etag
            self._checksum = checksum
            status_changed = self._status != status
            self._status = status
        self._ready.set()
        if status_changed:
            self._fire("status", status)
        if is_new:
            self._fire("update", UpdateEvent(nxt["revision"], prev_rev, checksum, source, transport, latency_ms))

    def _persist(self) -> None:
        if not self._store or self._bundle is None:
            return
        with self._lock:
            payload: Dict[str, Any] = {"v": 1, "id": self._id, "etag": self._etag, "checksum": self._checksum, "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "bundle": self._bundle}
            if self._sig:
                payload["sig"] = self._sig.to_dict()
                if self._raw is not None:
                    payload["raw"] = self._raw
        try:
            self._store.set(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        except Exception:  # noqa: BLE001
            self._emit_error(NanoFlagsError("Could not persist the bundle.", "store"))

    def _restore(self) -> None:
        if not self._store:
            return
        try:
            raw = self._store.get()
            if not raw or self._closed:
                return
            p = _loads(raw)
            if not isinstance(p, dict) or p.get("v") != 1 or p.get("id") != self._id or not is_bundle(p.get("bundle")):
                return
            restored = p["bundle"]
            if not supports_engine(restored):
                self._emit_error(self._engine_error(restored))
                return
            cur = self._bundle
            if cur is not None and cur.get("revision", 0) >= restored["revision"]:
                return
            sig: Optional[SignatureInfo] = None
            text: Optional[str] = None
            if self._verify:
                # The store is outside the trust boundary: a signed copy must verify again; with `require` an
                # unsigned copy is not used at all.
                s = SignatureInfo.from_dict(p["sig"]) if isinstance(p.get("sig"), dict) else None
                if s is not None and s.revision == restored["revision"]:
                    text = p["raw"] if isinstance(p.get("raw"), str) else js_stringify(restored)
                    ok = False
                    try:
                        ok = verify_bundle_text(self._load_keys(s.kid), s, text)
                        if ok:
                            parsed = _loads(text)
                            ok = is_bundle(parsed) and parsed.get("revision") == s.revision
                            if ok:
                                restored = parsed
                    except Exception:  # noqa: BLE001
                        ok = False
                    if not ok:
                        self._emit_error(NanoFlagsError("The persisted bundle failed signature verification and was ignored.", "signature"))
                        return
                    sig = s
                elif self._verify["require"]:
                    return
            with self._lock:
                cur = self._bundle
                if self._closed or (cur is not None and cur.get("revision", 0) >= restored["revision"]):
                    return
                self._sig = sig
                self._raw = text if sig else None
                if sig and self._pinned_env is None:
                    self._pinned_env = sig.environment_id
            # Usable but not known to be current: stale until the edge confirms it.
            self._adopt(restored, etag=p.get("etag"), checksum=p.get("checksum"), status="stale", source="store", transport="poll")
        except Exception:  # noqa: BLE001
            self._emit_error(NanoFlagsError("Could not read the persisted bundle.", "store"))

    # ------------------------------------------------------------------ HTTP

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {"Authorization": f"Bearer {self.sdk_key}", "User-Agent": f"nanoflags-python/{SDK_VERSION}"}
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, headers: Optional[Dict[str, str]] = None, body: Optional[bytes] = None, timeout: float = _REQUEST_TIMEOUT) -> _http.HttpResponse:
        return self._http(method, f"{self.base_url}{path}", self._headers(headers), body, timeout)

    # ------------------------------------------------------------------ signature verification

    def _fetch_keys(self) -> List[ImportedKey]:
        # Public endpoint: the SDK key is deliberately not sent.
        res = self._http("GET", f"{self.base_url}/v1/keys", {"User-Agent": f"nanoflags-python/{SDK_VERSION}"}, None, _REQUEST_TIMEOUT)
        if not res.ok:
            raise NanoFlagsError(f"Signing keys request failed with HTTP {res.status}.", "signature", res.status)
        body = _loads(res.text())
        listed = body.get("keys") if isinstance(body, dict) else None
        keys = import_public_keys(listed if isinstance(listed, list) else [])
        if not keys:
            raise NanoFlagsError("The edge returned no usable signing keys.", "signature")
        return keys

    def _load_keys(self, kid: Optional[str]) -> List[ImportedKey]:
        """Pinned/embedded keys plus those from ``/v1/keys``; an unknown ``kid`` reloads ``/v1/keys`` (≤ once a minute)."""
        v = self._verify
        if not v:
            return []
        with self._keys_lock:
            base: List[ImportedKey] = []
            if v["keys"] != "fetch":
                if self._pinned_keys is None:
                    self._pinned_keys = import_public_keys(v["keys"])
                base = self._pinned_keys
            if not v["refetch"]:
                return list(base)
            known = base + self._fetched_keys
            if known and (kid is None or any(k.kid == kid for k in known)):
                return known
            if self._keys_fetched_at and time.monotonic() - self._keys_fetched_at < _KEYS_REFETCH:
                return known
            try:
                self._fetched_keys = self._fetch_keys()
                self._keys_fetched_at = time.monotonic()
            except Exception:
                if not base:
                    raise
                self._keys_fetched_at = time.monotonic()
            return base + self._fetched_keys

    def _check_signature(self, res: _http.HttpResponse, text: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """Returns ``{"bundle", "sig", "raw"}`` to adopt, or raises NanoFlagsError(code="signature")."""
        bundle = body["bundle"]
        if not self._verify:
            return {"bundle": bundle, "sig": None, "raw": None}

        def reject(why: str) -> NanoFlagsError:
            return NanoFlagsError(f"Bundle r{bundle.get('revision')} was rejected: {why} The configuration in use is unchanged.", "signature")

        if res.headers.get("X-NanoFlags-Signed") != "true":
            if self._verify["require"]:
                raise reject("it is not signed (the edge is still distributing it) and unsigned bundles are refused (`verify.require`); fetching again shortly.")
            return {"bundle": bundle, "sig": None, "raw": None}
        signature = res.headers.get("X-NanoFlags-Signature")
        environment_id = res.headers.get("X-NanoFlags-Environment-Id")
        kid = res.headers.get("X-NanoFlags-Key-Id")
        checksum = body.get("checksum")
        if not signature or not environment_id or not isinstance(checksum, str):
            raise reject("the signature headers are incomplete.")
        rev = body.get("revision")
        revision = rev if isinstance(rev, int) and not isinstance(rev, bool) else bundle.get("revision")
        if revision != bundle.get("revision"):
            raise reject("the signed revision does not match the bundle.")
        if self._pinned_env is not None and self._pinned_env != environment_id:
            raise reject("it was signed for a different environment.")
        info = SignatureInfo(signature, kid, environment_id, revision, checksum)
        try:
            keys = self._load_keys(kid)
        except Exception as e:  # noqa: BLE001
            raise reject(f"the signing keys could not be loaded ({e}).") from None
        # The edge embeds the stored bundle text byte-for-byte: hash exactly that span. Re-serialising the parsed
        # bundle the way JavaScript would is the fallback for edges that re-serialise.
        candidates = []
        raw = raw_member(text, "bundle")
        if raw is not None:
            candidates.append(raw)
        again = js_stringify(bundle)
        if isinstance(again, str) and again not in candidates:
            candidates.append(again)
        for candidate in candidates:
            if verify_bundle_text(keys, info, candidate):
                parsed = _loads(candidate)
                if is_bundle(parsed) and parsed.get("revision") == revision:
                    with self._lock:
                        self._pinned_env = environment_id
                    return {"bundle": parsed, "sig": info, "raw": candidate}
        raise reject("its signature does not verify.")

    # ------------------------------------------------------------------ polling

    def _sync_once(self) -> None:
        transport = "stream" if self._stream_triggered else "poll"
        self._stream_triggered = False
        try:
            res = self._request("GET", "/v1/bundle", {"If-None-Match": self._etag} if self._etag else None)
            if self._closed:
                return
            served_stale = res.headers.get("X-NanoFlags-Stale") == "true"
            if res.status == 304:
                self._failures = 0
                if self._bundle is not None:
                    self._set_status("stale" if served_stale else "ready")
                return
            if res.status in (401, 403):
                raise NanoFlagsError("The SDK key was rejected (unknown or revoked).", "unauthorized", res.status)
            if not res.ok:
                raise NanoFlagsError(f"Bundle request failed with HTTP {res.status}.", "http", res.status)
            text = res.text()
            try:
                body = _loads(text)
            except ValueError:
                body = None
            if not isinstance(body, dict) or not is_bundle(body.get("bundle")):
                raise NanoFlagsError("The edge returned an invalid bundle.", "invalid_bundle")
            verified = self._check_signature(res, text, body)
            if self._closed:
                return
            nxt = verified["bundle"]
            if not supports_engine(nxt):
                raise self._engine_error(nxt)
            self._failures = 0
            cur = self._bundle
            # The edge is serving its last-known-good copy: never go backwards because of it.
            if served_stale and cur is not None and cur["revision"] >= nxt["revision"]:
                self._set_status("stale")
                return
            with self._lock:
                cur = self._bundle
                # A revision pushed while this request was under way (or that KV does not point at yet) wins.
                if cur is not None and nxt["revision"] < self._live_revision and cur["revision"] >= self._live_revision:
                    return
                self._sig = verified["sig"]
                self._raw = verified["raw"]
            self._adopt(nxt, etag=res.headers.get("ETag"), checksum=body.get("checksum"), status="stale" if served_stale else "ready", source="network", transport=transport)
            self._persist()
        except Exception as e:  # noqa: BLE001
            if self._closed:
                return
            err = e if isinstance(e, NanoFlagsError) else NanoFlagsError(f"Could not reach the NanoFlags edge: {e}", "network")
            if err.code == "engine":
                self._emit_error(err)
                return
            self._failures += 1
            if err.code == "signature":
                self._emit_error(err)  # same bundle, same status; polling retries with backoff
                return
            if err.code == "unauthorized":
                self._drop_live()
            if self._bundle is not None:
                self._set_status("stale")
            self._emit_error(err)

    def _sync(self) -> None:
        with self._sync_mutex:
            if not self._closed:
                self._sync_once()

    def refresh(self) -> None:
        """Revalidate now (blocking). Errors are reported to ``on_error`` listeners, never raised."""
        self._sync()

    def _request_sync(self) -> None:
        self._sync_requested = True
        self._wake.set()

    def _next_delay(self) -> float:
        jitter = 0.8 + 0.4 * random.random()
        interval = max(self._poll_interval, self._live_poll_interval) if self._live_open else self._poll_interval
        base = min(self._poll_interval, 2.0 ** min(self._failures - 1, 10)) if self._failures > 0 else interval
        return max(0.25, base * jitter)

    def _main_loop(self) -> None:
        self._restore()
        self._sync()
        self._ready.set()  # even without a bundle: callers must not hang; they check `status`
        if self._closed:
            return
        if self._ev.enabled and self._ev.flush_interval > 0:
            self._spawn(self._events_loop, "nanoflags-events")
        if self._streaming:
            if self._live_wanted():
                self._spawn(self._live_loop, "nanoflags-socket")
            else:
                self._start_stream()
        while not self._closed:
            timeout = self._next_delay() if self._poll_interval > 0 else None
            woke = self._wake.wait(timeout)
            self._wake.clear()
            if self._closed:
                return
            if woke and not self._sync_requested:
                continue  # rescheduled (e.g. the live socket opened)
            self._sync_requested = False
            self._sync()

    # ------------------------------------------------------------------ live WebSocket

    def _live_url(self) -> Optional[str]:
        if self._live_url_override:
            return self._live_url_override
        u = self.base_url
        if u.startswith("https://"):
            return "wss://" + u[len("https://"):] + "/v1/live"
        if u.startswith("http://"):
            return "ws://" + u[len("http://"):] + "/v1/live"
        return None

    def _live_wanted(self) -> bool:
        if not (self._streaming and self._live_enabled and self._live_url()):
            return False
        try:
            import websockets.sync.client  # noqa: F401
        except ImportError:  # pragma: no cover
            return False
        return True

    def _drop_live(self) -> None:
        ws = self._live_socket
        if ws is not None:
            try:
                ws.close(1000, "bye")
            except Exception:  # noqa: BLE001
                pass

    def _live_loop(self) -> None:
        from websockets.exceptions import ConnectionClosed
        from websockets.sync.client import connect

        attempt = 0
        url = self._live_url()
        while not self._closed and not self._environment_deleted:
            opened = False
            opened_at = 0.0
            rotating = False
            close_code: Optional[int] = None
            try:
                with connect(
                    url,  # type: ignore[arg-type]
                    additional_headers=self._headers(),
                    subprotocols=[LIVE_PROTOCOL],  # type: ignore[list-item]
                    open_timeout=_LIVE_CONNECT_TIMEOUT,
                    close_timeout=2,
                    ping_interval=None,  # the edge answers the text "ping" without waking anything up
                    max_size=8 * 1024 * 1024,
                    user_agent_header=f"nanoflags-python/{SDK_VERSION}",
                ) as ws:
                    opened = True
                    opened_at = time.monotonic()
                    rotating, close_code = self._live_session(ws, opened_at, ConnectionClosed)
            except Exception as e:  # noqa: BLE001
                log.debug("nanoflags live socket failed: %s", e)
            finally:
                self._live_open = False
                self._live_socket = None
            if self._closed:
                return
            if close_code == CLOSE_ENVIRONMENT_DELETED:
                # Keep evaluating the last bundle; it can no longer be updated. No socket, no stream; the regular poll
                # stays (it reports the key as rejected, and recovers if the environment turns out to exist).
                self._environment_deleted = True
                self._stop_stream()
                if self._bundle is not None:
                    self._set_status("stale")
                self._emit_error(NanoFlagsError("The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated.", "environment_deleted"))
                self._wake.set()
                return
            if rotating:
                continue  # planned replacement: no fallback, no backoff
            attempt = 1 if opened and time.monotonic() - opened_at > 30 else attempt + 1
            if not opened:
                self._start_stream()  # SSE + polling take over until a socket opens again
            else:
                self._wake.set()  # back to the normal poll interval
            wait = min(_LIVE_MAX_BACKOFF, 2.0 ** min(attempt - 1, 10)) * (0.5 + random.random())
            self._live_wake.wait(wait)

    def _live_session(self, ws: Any, opened_at: float, connection_closed: "type[BaseException]") -> "tuple[bool, Optional[int]]":
        """Serve one open socket until it closes, dies or is due for rotation. Returns (rotating, close code)."""
        self._live_socket = ws
        self._live_open = True
        self._stop_stream()  # SSE is not used while the socket is healthy
        self._wake.set()  # the poll becomes a safety net
        rotate_at = opened_at + _LIVE_ROTATE * (0.9 + 0.2 * random.random())
        next_ping = opened_at + _LIVE_PING * (0.9 + 0.2 * random.random())
        pong_deadline: Optional[float] = None
        try:
            while not self._closed:
                now = time.monotonic()
                if now >= rotate_at:
                    return True, None
                if pong_deadline is not None and now >= pong_deadline:
                    return False, None  # silence after a ping: the connection is dead
                if now >= next_ping:
                    ws.send("ping")
                    if pong_deadline is None:
                        pong_deadline = now + _LIVE_PONG_TIMEOUT
                    next_ping = now + _LIVE_PING * (0.9 + 0.2 * random.random())
                wait = min(next_ping, rotate_at, pong_deadline or rotate_at) - time.monotonic()
                try:
                    msg = ws.recv(timeout=max(0.05, wait))
                except TimeoutError:
                    continue
                pong_deadline = None
                if not isinstance(msg, str) or msg == "pong":
                    continue
                try:
                    m = _loads(msg)
                except ValueError:
                    continue
                if isinstance(m, dict):
                    self._apply_push(m)
        except connection_closed as e:
            rcvd = getattr(e, "rcvd", None)
            return False, getattr(rcvd, "code", None) if rcvd is not None else None
        return False, None

    def _apply_push(self, m: Dict[str, Any]) -> None:
        """Apply one ``rev`` / ``hello`` message. A message that cannot be trusted changes nothing."""
        if self._closed or m.get("t") not in ("rev", "hello"):
            return
        revision = m.get("revision")
        text = m.get("bundle")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1 or not isinstance(text, str):
            return  # revision 0 / no bundle: nothing published yet
        cur = self._bundle
        if cur is not None and revision < cur["revision"]:
            return  # never backwards
        pushed_checksum = m.get("checksum") if isinstance(m.get("checksum"), str) else None
        info: Optional[SignatureInfo] = None
        if self._verify:
            def reject(why: str) -> None:
                self._emit_error(NanoFlagsError(f"Pushed bundle r{revision} was rejected: {why} The configuration in use is unchanged.", "signature"))
                self._request_sync()  # the regular (verified) request path says what is really current

            signature, env_id = m.get("signature"), m.get("environmentId")
            if not isinstance(signature, str) or not isinstance(env_id, str) or pushed_checksum is None:
                return reject("it carries no complete signature.")
            if self._pinned_env is not None and self._pinned_env != env_id:
                return reject("it was signed for a different environment.")
            kid = m.get("kid") if isinstance(m.get("kid"), str) else None
            info = SignatureInfo(signature, kid, env_id, revision, pushed_checksum)
            try:
                ok = verify_bundle_text(self._load_keys(kid), info, text)
            except Exception:  # noqa: BLE001
                ok = False
            if self._closed:
                return
            if not ok:
                return reject("its signature does not verify.")
        try:
            parsed = _loads(text)
        except ValueError:
            parsed = None
        if not is_bundle(parsed) or parsed.get("revision") != revision:
            self._emit_error(NanoFlagsError("The edge pushed an invalid bundle; it was ignored.", "invalid_bundle"))
            return
        if not supports_engine(parsed):
            self._emit_error(self._engine_error(parsed))
            return
        with self._lock:
            cur = self._bundle
            if cur is not None and revision < cur["revision"]:
                return
            self._failures = 0
            if cur is not None and revision == cur["revision"]:
                confirm = self._checksum is None or self._checksum == pushed_checksum
                same = True
            else:
                same = False
                if info:
                    self._pinned_env = info.environment_id
                self._sig = info
                self._raw = text if info else None
                self._live_revision = revision
        if same:
            if confirm:
                self._set_status("ready")  # already in use: the push only confirms that it is current
            return
        committed = m.get("committedAt")
        latency = _now_ms() - committed if isinstance(committed, (int, float)) and not isinstance(committed, bool) and math.isfinite(committed) else None
        self._adopt(
            parsed,
            # What /v1/bundle would send as ETag for this revision, so the safety poll gets a 304.
            etag=f'"{pushed_checksum}-{"client" if self._is_browser_key else "server"}"' if pushed_checksum is not None else None,
            checksum=pushed_checksum,
            status="ready",
            source="network",
            transport="live",
            latency_ms=latency,
        )
        self._persist()

    # ------------------------------------------------------------------ SSE fallback

    def _start_stream(self) -> None:
        with self._lock:
            if self._closed or not self._streaming or self._stream_active or self._environment_deleted:
                return
            self._stream_active = True
            self._stream_gen += 1
            gen = self._stream_gen
        self._spawn(lambda: self._stream_loop(gen), "nanoflags-stream")

    def _stop_stream(self) -> None:
        with self._lock:
            self._stream_gen += 1
            self._stream_active = False
            res = self._stream_response
            self._stream_response = None
        if res is not None:
            try:
                res.close()
            except Exception:  # noqa: BLE001
                pass

    def _on_revision(self, data: str) -> None:
        try:
            m = _loads(data)
        except ValueError:
            return
        if not isinstance(m, dict):
            return
        cur = self._bundle
        if cur is None or m.get("revision") != cur["revision"] or m.get("checksum") != self._checksum or self._status != "ready":
            self._stream_triggered = True
            self._request_sync()

    def _stream_loop(self, gen: int) -> None:
        attempt = 0
        current = lambda: not self._closed and gen == self._stream_gen  # noqa: E731
        while current():
            started = time.monotonic()
            stop = False
            try:
                status, res = _http.open_stream(f"{self.base_url}/v1/stream", self._headers({"Accept": "text/event-stream"}), 90.0)
                if status in (401, 403):
                    stop = True  # polling keeps reporting the error
                elif res is not None:
                    with self._lock:
                        self._stream_response = res
                    try:
                        for event, data in _http.iter_sse(iter(res.readline, b"")):  # type: ignore[attr-defined]
                            if not current():
                                break
                            if event == "revision":
                                self._on_revision(data)
                            elif event == "revoked":
                                stop = True
                                self._request_sync()
                                break
                    finally:
                        try:
                            res.close()  # type: ignore[attr-defined]
                        except Exception:  # noqa: BLE001
                            pass
            except Exception as e:  # noqa: BLE001
                log.debug("nanoflags stream failed: %s", e)
            if not current():
                return
            if stop:
                with self._lock:
                    if gen == self._stream_gen:
                        self._stream_active = False
                return
            attempt = 0 if time.monotonic() - started > 30 else attempt + 1
            wait = min(30.0, 2.0 ** min(attempt, 5)) * (0.5 + random.random())
            self._live_wake.wait(wait)

    # ------------------------------------------------------------------ telemetry

    def _attrs_used_by(self, b: Optional[Dict[str, Any]], flag_key: str) -> List[str]:
        if b is None:
            return []
        if self._used_attrs_for != id(b):
            self._used_attrs = {}
            self._used_attrs_for = id(b)
        hit = self._used_attrs.get(flag_key)
        if hit is not None:
            return hit
        names: Dict[str, None] = {}
        raw_segments = b.get("segments")
        segments: Dict[str, Any] = raw_segments if isinstance(raw_segments, dict) else {}

        def visit(conditions: Any, depth: int) -> None:
            for c in conditions:
                if c.get("op") in ("segment", "not_segment"):
                    seg = segments.get(c.get("value")) if isinstance(c.get("value"), str) else None
                    if seg and depth < 4:
                        visit(seg.get("conditions") or [], depth + 1)
                elif c.get("attribute"):
                    names[c["attribute"]] = None

        try:
            flag = (b.get("flags") or {}).get(flag_key)
            for r in (flag or {}).get("rules") or []:
                visit(r.get("conditions") or [], 0)
                serve = r.get("serve") or {}
                if serve.get("type") == "rollout":
                    names[serve.get("bucketBy") or "key"] = None
        except Exception:  # noqa: BLE001 - malformed flag: report nothing
            pass
        out = list(names)
        self._used_attrs[flag_key] = out
        return out

    def _record(self, e: Evaluation, ctx: Dict[str, Any], b: Optional[Dict[str, Any]], session_id: Optional[str]) -> None:
        if not self._ev.enabled or self._closed or self._sample_rate <= 0 or random.random() >= self._sample_rate:
            return
        try:
            if self._ev.redact:
                context = self._ev.redact(dict(ctx))
            else:
                context = {name: type_of(ctx[name]) for name in self._attrs_used_by(b, e.flag_key) if name in ctx}
            event: Dict[str, Any] = {"flagKey": e.flag_key, "value": e.value, "reason": e.reason, "revision": e.revision, "context": context, "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
            if e.rule_index is not None:
                event["ruleIndex"] = e.rule_index
            if session_id is not None:
                event["sessionId"] = session_id
            with self._queue_lock:
                if len(self._queue) < _MAX_QUEUE:  # bounded: drop instead of growing
                    self._queue.append(event)
        except Exception:  # noqa: BLE001 - telemetry must never affect evaluation
            pass

    def flush(self, timeout: float = _REQUEST_TIMEOUT) -> None:
        """Send queued telemetry and the service report now (blocking, best effort, never raises)."""
        if not self._ev.enabled:
            return
        with self._queue_lock:
            batch = self._queue[:_MAX_BATCH]
            del self._queue[:_MAX_BATCH]
        out = []
        for ev in batch:
            value = ev["value"]
            try:
                if isinstance(value, (dict, list)) and len(json.dumps(value)) > _MAX_EVENT_VALUE_CHARS:
                    value = None
                elif isinstance(value, str) and len(value) > _MAX_EVENT_VALUE_CHARS:
                    value = value[:_MAX_EVENT_VALUE_CHARS]
            except Exception:  # noqa: BLE001
                value = None
            out.append({**ev, "flagKey": ev["flagKey"][:63], "value": value})
        self._last_report = time.monotonic()
        rev = self.revision
        payload = {"service": self.service[:60], "sdk": f"python/{SDK_VERSION}", "revision": rev if isinstance(rev, int) and rev >= 0 else 0, "events": out}
        try:
            self._request("POST", "/v1/events", {"Content-Type": "application/json"}, json.dumps(payload).encode("utf-8"), timeout)
        except Exception:  # noqa: BLE001 - dropped on failure, by design: telemetry is never retried
            pass

    def _events_loop(self) -> None:
        while not self._closed:
            self._events_wake.wait(self._ev.flush_interval)
            if self._closed:
                return
            with self._queue_lock:
                empty = not self._queue
            if empty and time.monotonic() - self._last_report < self._ev.report_interval:
                continue  # nothing queued: the service report alone goes out once per report interval
            self.flush()

    # ------------------------------------------------------------------ test sessions

    def session(self, token: Optional[str], service: Optional[str] = None) -> SessionEvaluator:
        """Resolve a test session (``GET /v1/session``, cached until it expires) and return an evaluator scoped to it.

        Blocking on the first call per token; never raises. Pass the incoming ``x-nanoflags-session`` header value.
        """
        if not _is_session_token(token) or self._closed or not self.base_url:
            return SessionEvaluator(self, None)
        name = service or (self.service if self.service != "unknown" else None)
        cache_key = f"{name or ''}\n{token}"
        now = time.time()
        with self._sessions_lock:
            hit = self._sessions.get(cache_key)
            if hit and now < hit[1]:
                return SessionEvaluator(self, hit[0])
            self._sessions.pop(cache_key, None)
            if len(self._sessions) >= _MAX_SESSIONS:
                for k in [k for k, v in self._sessions.items() if now >= v[1]]:
                    del self._sessions[k]
                while len(self._sessions) >= _MAX_SESSIONS:
                    del self._sessions[next(iter(self._sessions))]
        state, failed = self._fetch_session(token, name)  # type: ignore[arg-type]
        until = state.expires_at_ts if state else time.time() + (_SESSION_ERROR_TTL if failed else _SESSION_MISS_TTL)
        with self._sessions_lock:
            self._sessions[cache_key] = (state, until)
        return SessionEvaluator(self, state)

    def _fetch_session(self, token: str, service: Optional[str]) -> "tuple[Optional[_SessionState], bool]":
        try:
            headers = {"X-NanoFlags-Session": token, "Cache-Control": "no-store"}
            if service:
                headers["X-NanoFlags-Service"] = service
            res = self._request("GET", "/v1/session", headers)
            if res.status == 404:
                return None, False
            if not res.ok:
                raise NanoFlagsError(f"Session request failed with HTTP {res.status}.", "unauthorized" if res.status in (401, 403) else "session", res.status)
            body = _loads(res.text())
            expires_ts = None
            if isinstance(body, dict) and isinstance(body.get("expires_at"), str):
                try:
                    expires_ts = datetime.fromisoformat(body["expires_at"].replace("Z", "+00:00")).timestamp()
                except ValueError:
                    expires_ts = None
            if not isinstance(body, dict) or not isinstance(body.get("id"), str) or not is_bundle(body.get("bundle")) or expires_ts is None:
                raise NanoFlagsError("The edge returned an invalid session.", "session")
            if not supports_engine(body["bundle"]):
                raise self._engine_error(body["bundle"])
            if expires_ts <= time.time():
                return None, False
            raw_context = body.get("context")
            context: Dict[str, Any] = raw_context if isinstance(raw_context, dict) else {}
            iso = datetime.fromtimestamp(expires_ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            return _SessionState(body["id"], body["bundle"], context, iso, expires_ts), False
        except Exception as e:  # noqa: BLE001
            if not self._closed:
                self._emit_error(e if isinstance(e, NanoFlagsError) else NanoFlagsError(f"Could not load the test session: {e}", "session"))
            return None, True

    def __repr__(self) -> str:
        return f"<NanoFlags base_url={self.base_url!r} status={self.status!r} revision={self.revision!r} transport={self.transport!r}>"
