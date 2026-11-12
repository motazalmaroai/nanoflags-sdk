"""Opt-in checks against the hosted edge: NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=<key> pytest -m production"""

from __future__ import annotations

import os
import time

import pytest

from nanoflags import NanoFlags

pytestmark = [
    pytest.mark.production,
    pytest.mark.skipif(not (os.environ.get("NANOFLAGS_PRODUCTION_TESTS") == "1" and os.environ.get("NANOFLAGS_SDK_KEY")), reason="production tests are opt-in"),
]


def test_default_client_loads_a_verified_bundle_and_goes_live() -> None:
    with NanoFlags(os.environ["NANOFLAGS_SDK_KEY"], service="python-sdk-ci", events=False) as flags:
        assert flags.wait_until_ready(15) is True
        assert flags.status == "ready"
        assert flags._sig is not None and flags._sig.kid  # accepted only because the signature verified
        end = time.time() + 15
        while flags.transport != "live" and time.time() < end:
            time.sleep(0.05)
        assert flags.transport == "live"
        assert isinstance(flags.all_flags({"key": "ci"}), dict)
