"""Bundle signature verification (Ed25519 over the canonical string of RUNTIME.md).

canonical = ``"nanoflags-bundle-v1\\n<environment_id>\\n<revision>\\n<checksum>\\n<sha256 hex of the bundle JSON text>"``

Only PUBLIC keys are handled here; a JWK carrying a private member (``d``) is refused.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, List, Mapping, Optional, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

__all__ = [
    "ImportedKey",
    "SignatureInfo",
    "canonical_string",
    "import_public_keys",
    "is_public_ed25519_jwk",
    "raw_member",
    "verify_bundle_text",
]


@dataclass(frozen=True)
class SignatureInfo:
    signature: str
    kid: Optional[str]
    environment_id: str
    revision: int
    checksum: str

    def to_dict(self) -> dict:
        return {"signature": self.signature, "kid": self.kid, "environmentId": self.environment_id, "revision": self.revision, "checksum": self.checksum}

    @staticmethod
    def from_dict(d: Mapping[str, Any]) -> Optional["SignatureInfo"]:
        if not (isinstance(d, Mapping) and isinstance(d.get("signature"), str) and isinstance(d.get("environmentId"), str) and isinstance(d.get("checksum"), str)):
            return None
        rev = d.get("revision")
        if not isinstance(rev, int) or isinstance(rev, bool):
            return None
        kid = d.get("kid")
        return SignatureInfo(d["signature"], kid if isinstance(kid, str) else None, d["environmentId"], rev, d["checksum"])


@dataclass(frozen=True)
class ImportedKey:
    kid: Optional[str]
    key: Ed25519PublicKey


def canonical_string(environment_id: str, revision: int, checksum: str, bundle_sha256_hex: str) -> str:
    return f"nanoflags-bundle-v1\n{environment_id}\n{revision}\n{checksum}\n{bundle_sha256_hex}"


_B64URL = re.compile(r"^[A-Za-z0-9+/]*$")


def base64url_decode(value: str) -> bytes:
    s = value.replace("-", "+").replace("_", "/").rstrip("=")
    if not _B64URL.match(s) or len(s) % 4 == 1:
        raise ValueError("Malformed base64url value.")
    return base64.b64decode(s + "=" * ((4 - len(s) % 4) % 4), validate=True)


def is_public_ed25519_jwk(v: Any) -> bool:
    return isinstance(v, Mapping) and v.get("kty") == "OKP" and v.get("crv") == "Ed25519" and isinstance(v.get("x"), str) and "d" not in v


def import_public_keys(jwks: Iterable[Any]) -> List[ImportedKey]:
    """Import the public Ed25519 JWKs among ``jwks`` (anything else, including private keys, is skipped)."""
    out: List[ImportedKey] = []
    for jwk in jwks:
        if not is_public_ed25519_jwk(jwk):
            continue
        try:
            raw = base64url_decode(jwk["x"])
            if len(raw) != 32:
                continue
            key = Ed25519PublicKey.from_public_bytes(raw)
        except Exception:  # noqa: BLE001 - malformed key material is skipped
            continue
        kid = jwk.get("kid")
        out.append(ImportedKey(kid if isinstance(kid, str) else None, key))
    return out


def verify_bundle_text(keys: Sequence[ImportedKey], info: SignatureInfo, bundle_text: str) -> bool:
    """True when ``info.signature`` is a valid signature by one of ``keys`` over the canonical string for ``bundle_text``.

    ``bundle_text`` is the exact signed JSON text (hashed as UTF-8). A key id narrows the candidates;
    an unknown key id is never treated as "any key".
    """
    try:
        signature = base64url_decode(info.signature)
    except Exception:  # noqa: BLE001
        return False
    if len(signature) != 64:
        return False
    digest = hashlib.sha256(bundle_text.encode("utf-8", "surrogatepass")).hexdigest()
    data = canonical_string(info.environment_id, info.revision, info.checksum, digest).encode("utf-8")
    candidates = keys if info.kid is None else [k for k in keys if k.kid == info.kid or k.kid is None]
    for k in candidates:
        try:
            k.key.verify(signature, data)
            return True
        except InvalidSignature:
            continue
        except Exception:  # noqa: BLE001
            continue
    return False


_WS = " \n\r\t"


def raw_member(text: str, member: str) -> Optional[str]:
    """Exact source text of the top-level ``member`` of a JSON object, or ``None``.

    The edge embeds the stored (signed) bundle text byte-for-byte in ``/v1/bundle``; hashing that span
    avoids depending on re-serialisation. When the member occurs more than once the LAST one wins.
    """
    n = len(text)
    i = 0

    def ws(j: int) -> int:
        while j < n and text[j] in _WS:
            j += 1
        return j

    def string_end(j: int) -> int:
        """Index after the closing quote of the string starting at ``j``, or -1."""
        if j >= n or text[j] != '"':
            return -1
        j += 1
        while j < n:
            c = text[j]
            if c == "\\":
                j += 2
            elif c == '"':
                return j + 1
            else:
                j += 1
        return -1

    def value_end(j: int) -> int:
        j = ws(j)
        if j >= n:
            return -1
        c = text[j]
        if c == '"':
            return string_end(j)
        if c in "{[":
            depth = 0
            while j < n:
                d = text[j]
                if d == '"':
                    j = string_end(j)
                    if j < 0:
                        return -1
                    continue
                if d in "{[":
                    depth += 1
                elif d in "}]":
                    depth -= 1
                j += 1
                if depth == 0:
                    return j
            return -1
        start = j
        while j < n and text[j] not in ",}] \n\r\t":
            j += 1
        return j if j > start else -1

    i = ws(i)
    if i >= n or text[i] != "{":
        return None
    i += 1
    found: Optional[str] = None
    while True:
        i = ws(i)
        if i < n and text[i] == "}":
            return found
        key_end = string_end(i)
        if key_end < 0:
            return None
        key = text[i:key_end]
        i = ws(key_end)
        if i >= n or text[i] != ":":
            return None
        i = ws(i + 1)
        start = i
        end = value_end(i)
        if end < 0:
            return None
        i = end
        try:
            name = json.loads(key)
        except ValueError:
            return None
        if name == member:
            found = text[start:i]
        i = ws(i)
        if i < n and text[i] == ",":
            i += 1
        elif i < n and text[i] == "}":
            return found
        else:
            return None
