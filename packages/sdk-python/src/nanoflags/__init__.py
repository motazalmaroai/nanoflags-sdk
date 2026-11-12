"""NanoFlags server SDK for Python.

Flags are evaluated locally and synchronously against a signed, in-memory configuration bundle that is
kept current in the background (live WebSocket, SSE or polling). See the README for a quickstart.
"""

from .client import (
    CLOSE_ENVIRONMENT_DELETED,
    LIVE_PROTOCOL,
    SDK_VERSION,
    SESSION_HEADER,
    SUPPORTED_ENGINE_VERSION,
    EventsOptions,
    NanoFlags,
    NanoFlagsError,
    SessionEvaluator,
    UpdateEvent,
    VerifyOptions,
)
from .engine import ENGINE_VERSION, Evaluation, TraceStep
from .keys import OFFICIAL_EDGE_URL, OFFICIAL_SIGNING_KEYS
from .store import FileStore, Store

#: Alias: the detail returned by ``*_variation_detail`` (value, reason, matched rule, trace).
EvaluationDetail = Evaluation

__version__ = SDK_VERSION

__all__ = [
    "CLOSE_ENVIRONMENT_DELETED",
    "ENGINE_VERSION",
    "Evaluation",
    "EvaluationDetail",
    "EventsOptions",
    "FileStore",
    "LIVE_PROTOCOL",
    "NanoFlags",
    "NanoFlagsError",
    "OFFICIAL_EDGE_URL",
    "OFFICIAL_SIGNING_KEYS",
    "SDK_VERSION",
    "SESSION_HEADER",
    "SUPPORTED_ENGINE_VERSION",
    "SessionEvaluator",
    "Store",
    "TraceStep",
    "UpdateEvent",
    "VerifyOptions",
    "__version__",
]
