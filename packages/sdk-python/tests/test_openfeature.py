from __future__ import annotations

from typing import Any, List

import pytest

pytest.importorskip("openfeature")

from conftest import FakeEdge, make_bundle, wait_for  # noqa: E402
from openfeature import api  # noqa: E402
from openfeature.evaluation_context import EvaluationContext  # noqa: E402
from openfeature.event import ProviderEvent  # noqa: E402
from openfeature.exception import ErrorCode  # noqa: E402
from openfeature.flag_evaluation import Reason  # noqa: E402

from nanoflags import NanoFlags, VerifyOptions  # noqa: E402
from nanoflags.openfeature import NanoFlagsProvider, to_nanoflags_context  # noqa: E402


def test_context_mapping() -> None:
    ctx = EvaluationContext(targeting_key="user-1", attributes={"key": "ignored", "plan": "beta", "n": 3, "tags": ("a", "b")})
    assert to_nanoflags_context(ctx) == {"key": "user-1", "plan": "beta", "n": 3, "tags": ["a", "b"]}
    assert to_nanoflags_context(None) == {}


def test_provider_resolution_and_events(edge: FakeEdge) -> None:
    flags = make_bundle(1)["flags"]
    flags["ratio"] = {"type": "number", "enabled": True, "default": 0.5, "off": 0, "rules": []}
    edge.set_bundle(make_bundle(1, flags=flags))
    client = NanoFlags("nf_srv_test", base_url=edge.base_url, live_url=edge.live_url, verify=VerifyOptions(public_keys=[edge.jwk], require=True), events=False)
    provider = NanoFlagsProvider(client, close_client=True)
    changed: List[Any] = []
    api.add_handler(ProviderEvent.PROVIDER_CONFIGURATION_CHANGED, changed.append)
    try:
        # openfeature-sdk >= 0.9 initialises in the background; older versions inside set_provider.
        getattr(api, "set_provider_and_wait", api.set_provider)(provider)
        of = api.get_client()
        d = of.get_boolean_details("new-checkout", False, EvaluationContext(targeting_key="u1", attributes={"plan": "beta"}))
        assert d.value is True and d.reason == Reason.TARGETING_MATCH and d.variant == "beta" and d.flag_metadata == {"revision": 1}
        d = of.get_boolean_details("new-checkout", False, EvaluationContext(targeting_key="u1"))
        assert d.reason == Reason.SPLIT and d.variant == "half"
        assert of.get_string_details("accent", "x").reason == Reason.DEFAULT
        assert of.get_string_details("disabled", "x").reason == Reason.DISABLED
        assert of.get_integer_value("limit", 0) == 10
        assert of.get_float_value("limit", 0.0) == 10.0  # whole numbers are fine for the float accessor
        assert of.get_float_value("ratio", 0.0) == 0.5
        assert of.get_integer_details("ratio", 1).error_code == ErrorCode.TYPE_MISMATCH
        assert of.get_object_value("layout", {}) == {"cols": 3}
        m = of.get_boolean_details("accent", True)
        assert m.value is True and m.error_code == ErrorCode.TYPE_MISMATCH
        nf = of.get_string_details("missing", "fb")
        assert nf.value == "fb" and nf.error_code == ErrorCode.FLAG_NOT_FOUND
        assert wait_for(lambda: client.transport == "live")
        edge.push(make_bundle(2))
        assert wait_for(lambda: len(changed) > 0)
    finally:
        api.remove_handler(ProviderEvent.PROVIDER_CONFIGURATION_CHANGED, changed.append)
        api.shutdown()
