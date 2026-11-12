"""asyncio wrapper around :class:`nanoflags.NanoFlags`.

Evaluation is local and synchronous, so the variation methods are plain (non-async) calls and safe to use
inside coroutines. Only the operations that may wait — readiness, refresh, flush, close — are coroutines;
they run the blocking client call in a worker thread. ``on_change`` accepts coroutine functions, which are
scheduled on the event loop that created the client.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, Callable, Mapping, Optional, Union

from .client import NanoFlags, NanoFlagsError, UpdateEvent
from .engine import Evaluation

__all__ = ["AsyncNanoFlags"]


class AsyncNanoFlags:
    """``async with AsyncNanoFlags(sdk_key, ...) as flags: await flags.wait_until_ready(5)``.

    Accepts the same keyword arguments as :class:`~nanoflags.NanoFlags`."""

    def __init__(self, sdk_key: str, **options: Any) -> None:
        try:
            self._loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        on_change = options.pop("on_change", None)
        on_error = options.pop("on_error", None)
        self.client = NanoFlags(sdk_key, **options)
        if on_change:
            self.on_change(on_change)
        if on_error:
            self.on_error(on_error)

    def _bridge(self, callback: Callable[[Any], Any]) -> Callable[[Any], None]:
        if not inspect.iscoroutinefunction(callback):
            return callback
        loop = self._loop

        def run(arg: Any) -> None:
            if loop is not None and not loop.is_closed():
                asyncio.run_coroutine_threadsafe(callback(arg), loop)

        return run

    def on_change(self, callback: Callable[[UpdateEvent], Any]) -> Callable[[], None]:
        return self.client.on("update", self._bridge(callback))

    def on_error(self, callback: Callable[[NanoFlagsError], Any]) -> Callable[[], None]:
        return self.client.on("error", self._bridge(callback))

    async def wait_until_ready(self, timeout: Optional[float] = None) -> bool:
        return await asyncio.to_thread(self.client.wait_until_ready, timeout)

    ready = wait_until_ready

    async def refresh(self) -> None:
        await asyncio.to_thread(self.client.refresh)

    async def flush(self) -> None:
        await asyncio.to_thread(self.client.flush)

    async def close(self) -> None:
        await asyncio.to_thread(self.client.close)

    async def __aenter__(self) -> "AsyncNanoFlags":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    @property
    def status(self) -> str:
        return self.client.status

    @property
    def revision(self) -> Optional[int]:
        return self.client.revision

    @property
    def transport(self) -> str:
        return self.client.transport

    def bool_variation(self, key: str, default: bool, context: Optional[Mapping[str, Any]] = None) -> bool:
        return self.client.bool_variation(key, default, context)

    def string_variation(self, key: str, default: str, context: Optional[Mapping[str, Any]] = None) -> str:
        return self.client.string_variation(key, default, context)

    def number_variation(self, key: str, default: Union[int, float], context: Optional[Mapping[str, Any]] = None) -> Union[int, float]:
        return self.client.number_variation(key, default, context)

    def json_variation(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Any:
        return self.client.json_variation(key, default, context)

    def bool_variation_detail(self, key: str, default: bool, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self.client.bool_variation_detail(key, default, context)

    def string_variation_detail(self, key: str, default: str, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self.client.string_variation_detail(key, default, context)

    def number_variation_detail(self, key: str, default: Union[int, float], context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self.client.number_variation_detail(key, default, context)

    def json_variation_detail(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self.client.json_variation_detail(key, default, context)

    def evaluate(self, key: str, default: Any, context: Optional[Mapping[str, Any]] = None) -> Evaluation:
        return self.client.evaluate(key, default, context)

    def all_flags(self, context: Optional[Mapping[str, Any]] = None) -> dict:
        return self.client.all_flags(context)
