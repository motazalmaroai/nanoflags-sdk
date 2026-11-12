"""OpenFeature provider for NanoFlags (``pip install "nanoflags[openfeature]"``).

>>> from openfeature import api                                   # doctest: +SKIP
>>> from nanoflags import NanoFlags                               # doctest: +SKIP
>>> from nanoflags.openfeature import NanoFlagsProvider           # doctest: +SKIP
>>> api.set_provider_and_wait(NanoFlagsProvider(NanoFlags("nf_srv_…")))  # doctest: +SKIP

Evaluations are local (the native engine), mapped like ``@nanoflags/openfeature-provider``:
``targetingKey`` becomes the bucketing identity ``key``; ``off`` → DISABLED, ``default`` → DEFAULT, a fixed rule →
TARGETING_MATCH, a rollout rule → SPLIT (variant = rule id). Status changes become provider events.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Callable, List, Mapping, Optional, Sequence, Union

from openfeature.evaluation_context import EvaluationContext
from openfeature.event import ProviderEventDetails
from openfeature.exception import ErrorCode, ProviderNotReadyError
from openfeature.flag_evaluation import FlagResolutionDetails, Reason
from openfeature.provider import AbstractProvider, Metadata

from .client import NanoFlags, NanoFlagsError, UpdateEvent
from .engine import Evaluation, type_of

__all__ = ["NanoFlagsProvider", "to_nanoflags_context"]


def _to_json(v: Any, depth: int) -> Any:
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    if isinstance(v, datetime):
        return v.isoformat()
    if depth >= 8:
        return None
    if isinstance(v, (list, tuple)):
        return [_to_json(x, depth + 1) for x in v]
    if isinstance(v, Mapping):
        return {str(k): _to_json(x, depth + 1) for k, x in v.items()}
    return None


def to_nanoflags_context(context: Optional[EvaluationContext]) -> dict:
    """OpenFeature context → NanoFlags context. ``targeting_key`` becomes ``key`` and wins over an attribute ``key``."""
    out: dict = {}
    if context is None:
        return out
    for name, value in (context.attributes or {}).items():
        if name == "targetingKey":
            continue
        out[name] = _to_json(value, 0)
    if isinstance(context.targeting_key, str) and context.targeting_key != "":
        out["key"] = context.targeting_key
    return out


class NanoFlagsProvider(AbstractProvider):
    """OpenFeature provider backed by a :class:`~nanoflags.NanoFlags` client.

    :param client: the NanoFlags client (one per process).
    :param ready_timeout: seconds ``initialize`` waits for the first configuration.
    :param close_client: close the client on ``shutdown`` (default false: the client is yours).
    :param evaluator: optional callable returning the evaluator to use per call (e.g. a test-session evaluator).
    """

    def __init__(self, client: NanoFlags, *, ready_timeout: float = 10.0, close_client: bool = False, evaluator: Optional[Callable[[], Any]] = None) -> None:
        super().__init__()
        self.client = client
        self.ready_timeout = ready_timeout
        self.close_client = close_client
        self._evaluator = evaluator
        self._offs: List[Callable[[], None]] = []

    def get_metadata(self) -> Metadata:
        return Metadata(name="NanoFlags")

    def initialize(self, evaluation_context: EvaluationContext) -> None:
        self._offs.append(self.client.on("update", self._on_update))
        self._offs.append(self.client.on("status", self._on_status))
        self._offs.append(self.client.on("error", self._on_error))
        if not self.client.wait_until_ready(self.ready_timeout):
            raise ProviderNotReadyError("NanoFlags has no configuration loaded yet.")

    def shutdown(self) -> None:
        for off in self._offs:
            off()
        self._offs = []
        if self.close_client:
            self.client.close()

    # ---- events
    def _on_update(self, e: UpdateEvent) -> None:
        self.emit_provider_configuration_changed(ProviderEventDetails(message=f"Revision {e.revision} is now in use.", metadata={"revision": e.revision}))

    def _on_status(self, status: str) -> None:
        if status == "ready":
            self.emit_provider_ready(ProviderEventDetails())
        elif status == "stale":
            self.emit_provider_stale(ProviderEventDetails(message="The configuration in use is not known to be current."))

    def _on_error(self, e: NanoFlagsError) -> None:
        if self.client.status == "not-ready":
            self.emit_provider_error(ProviderEventDetails(message=str(e), error_code=ErrorCode.GENERAL))

    # ---- resolution
    def _resolve(self, flag_key: str, default_value: Any, context: Optional[EvaluationContext], kind: str) -> FlagResolutionDetails:
        try:
            target = self._evaluator() if self._evaluator else self.client
            e: Evaluation = target.evaluate(flag_key, None, to_nanoflags_context(context))
        except Exception as err:  # noqa: BLE001
            return FlagResolutionDetails(default_value, ErrorCode.GENERAL, str(err), Reason.ERROR)
        meta = {"revision": e.revision} if isinstance(e.revision, int) else {}

        def failure(code: ErrorCode, message: str) -> FlagResolutionDetails:
            return FlagResolutionDetails(default_value, code, message, Reason.ERROR, flag_metadata=meta)

        if e.reason == "flag_not_found":
            if self.client.revision is None:
                return failure(ErrorCode.PROVIDER_NOT_READY, "NanoFlags has no configuration loaded yet.")
            return failure(ErrorCode.FLAG_NOT_FOUND, f'Flag "{flag_key}" is not in the loaded configuration (r{e.revision}).')
        if e.reason == "error":
            return failure(ErrorCode.GENERAL, e.error or "Evaluation failed.")
        value = e.value
        ok = False
        if kind == "boolean":
            ok = isinstance(value, bool)
        elif kind == "string":
            ok = isinstance(value, str)
        elif kind in ("integer", "float"):
            ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            if ok and kind == "integer":
                ok = float(value).is_integer()
                value = int(value) if ok else value
            elif ok:
                value = float(value)
        elif kind == "object":
            ok = isinstance(value, (dict, list))
        if not ok:
            return failure(ErrorCode.TYPE_MISMATCH, f'Flag "{flag_key}" has a {type_of(e.value)} value; a {kind} was requested.')
        if e.reason == "off":
            reason = Reason.DISABLED
        elif e.reason == "default":
            reason = Reason.DEFAULT
        else:
            reason = Reason.TARGETING_MATCH if e.in_rollout is None else Reason.SPLIT
        variant = e.rule_id if isinstance(e.rule_id, str) else None
        return FlagResolutionDetails(value, reason=reason, variant=variant, flag_metadata=meta)

    def resolve_boolean_details(self, flag_key: str, default_value: bool, evaluation_context: Optional[EvaluationContext] = None) -> FlagResolutionDetails[bool]:
        return self._resolve(flag_key, default_value, evaluation_context, "boolean")

    def resolve_string_details(self, flag_key: str, default_value: str, evaluation_context: Optional[EvaluationContext] = None) -> FlagResolutionDetails[str]:
        return self._resolve(flag_key, default_value, evaluation_context, "string")

    def resolve_integer_details(self, flag_key: str, default_value: int, evaluation_context: Optional[EvaluationContext] = None) -> FlagResolutionDetails[int]:
        return self._resolve(flag_key, default_value, evaluation_context, "integer")

    def resolve_float_details(self, flag_key: str, default_value: float, evaluation_context: Optional[EvaluationContext] = None) -> FlagResolutionDetails[float]:
        return self._resolve(flag_key, default_value, evaluation_context, "float")

    def resolve_object_details(
        self, flag_key: str, default_value: Union[Sequence[Any], Mapping[str, Any]], evaluation_context: Optional[EvaluationContext] = None
    ) -> FlagResolutionDetails[Union[Sequence[Any], Mapping[str, Any]]]:
        return self._resolve(flag_key, default_value, evaluation_context, "object")
