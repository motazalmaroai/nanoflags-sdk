/**
 * The hosted NanoFlags edge and the public halves of its bundle-signing keys (Ed25519, safe to embed).
 *
 * With `baseUrl` equal to `OFFICIAL_EDGE_URL` the SDK verifies every bundle against these keys by default
 * (`verify.require` defaults to true there). A bundle signed with a key id that is not listed here — a rotation that
 * happened after this SDK version was built — makes the SDK load `GET /v1/keys` from the edge once and verify against
 * the keys it lists as well. Rotation procedure: RUNTIME.md, "Signing-key rotation".
 */
export const OFFICIAL_EDGE_URL = "https://edge.nanoflags.io";

export const OFFICIAL_SIGNING_KEYS: readonly (JsonWebKey & { kid: string })[] = Object.freeze([
  Object.freeze({ kty: "OKP", crv: "Ed25519", x: "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", kid: "k1" }),
]);
