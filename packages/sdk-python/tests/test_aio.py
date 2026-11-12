from __future__ import annotations

import asyncio
from typing import Any, List

from conftest import FakeEdge, make_bundle, wait_for

from nanoflags import VerifyOptions
from nanoflags.aio import AsyncNanoFlags


def test_async_client(edge: FakeEdge) -> None:
    async def main() -> None:
        seen: List[Any] = []

        async def on_change(e: Any) -> None:
            seen.append(e.revision)

        async with AsyncNanoFlags("nf_srv_test", base_url=edge.base_url, live_url=edge.live_url, verify=VerifyOptions(public_keys=[edge.jwk]), events=False, on_change=on_change) as flags:
            assert await flags.wait_until_ready(5)
            assert flags.string_variation("accent", "x") == "blue"
            edge.set_bundle(make_bundle(2))
            await flags.refresh()
            await asyncio.sleep(0.05)
            assert flags.revision == 2 and 2 in seen
            assert flags.bool_variation_detail("new-checkout", False, {"plan": "beta"}).reason == "rule_match"

    asyncio.run(main())
