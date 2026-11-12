"""Persistence for the last good configuration (outside the trust boundary: restored copies are verified again)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Optional, Union

try:  # Python 3.8+: typing.Protocol
    from typing import Protocol
except ImportError:  # pragma: no cover
    from typing_extensions import Protocol  # type: ignore

__all__ = ["FileStore", "Store"]


class Store(Protocol):
    """Where the client keeps its last good bundle. ``get`` returns what ``set`` stored last, or ``None``."""

    def get(self) -> Optional[str]: ...

    def set(self, value: str) -> None: ...


class FileStore:
    """A JSON file, written atomically (temporary file + rename) with mode 0600.

    Share one path per SDK key and edge; the file records which key/edge it belongs to and is ignored otherwise.
    """

    def __init__(self, path: Union[str, "os.PathLike[str]"]) -> None:
        self.path = Path(path)

    def get(self) -> Optional[str]:
        try:
            return self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def set(self, value: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".nanoflags-", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(value)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def __repr__(self) -> str:
        return f"FileStore({str(self.path)!r})"
