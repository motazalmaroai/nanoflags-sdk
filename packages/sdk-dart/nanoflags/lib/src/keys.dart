/// The hosted NanoFlags edge and the public halves of its bundle-signing keys (Ed25519, safe to embed).
///
/// With `baseUrl` equal to [officialEdgeUrl] the SDK verifies every bundle against these keys by
/// default (and refuses unsigned bundles). A bundle signed with a key id that is not listed here — a
/// rotation that happened after this SDK version was built — makes the SDK load `GET /v1/keys` from
/// the edge once (at most once a minute) and verify against the keys it lists as well.
library;

/// Base URL of the hosted NanoFlags edge.
const String officialEdgeUrl = 'https://edge.nanoflags.io';

/// Public signing keys of [officialEdgeUrl] as JWKs (same kids and keys as every other NanoFlags SDK).
const List<Map<String, String>> officialSigningKeys = [
  {'kty': 'OKP', 'crv': 'Ed25519', 'x': 'wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U', 'kid': 'k1'},
];
