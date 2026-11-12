"""The hosted NanoFlags edge and the public halves of its bundle-signing keys (Ed25519, safe to embed).

With ``base_url`` equal to :data:`OFFICIAL_EDGE_URL` the client verifies every bundle against these keys by default
and refuses unsigned bundles. A bundle signed with a key id that is not listed here (a rotation after this release)
makes the client load ``GET /v1/keys`` once and verify against those keys as well. Keep in sync with
``packages/sdk/src/keys.ts``; rotation procedure: RUNTIME.md, "Signing-key rotation".
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping, Tuple

OFFICIAL_EDGE_URL = "https://edge.nanoflags.io"

OFFICIAL_SIGNING_KEYS: Tuple[Mapping[str, str], ...] = (
    MappingProxyType({"kty": "OKP", "crv": "Ed25519", "x": "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", "kid": "k1"}),
)
