# frozen_string_literal: true

module NanoFlags
  # The hosted NanoFlags edge. With this base URL (the default) every bundle is verified against
  # {OFFICIAL_SIGNING_KEYS}, and unsigned bundles are refused.
  OFFICIAL_EDGE_URL = "https://edge.nanoflags.io"

  # The public halves of the production bundle-signing keys (Ed25519, safe to embed). A bundle signed with a key id
  # that is not listed here (a rotation after this release) makes the client load `GET /v1/keys` once (again at
  # most once a minute). Keep in sync with packages/sdk/src/keys.ts.
  OFFICIAL_SIGNING_KEYS = [
    { "kty" => "OKP", "crv" => "Ed25519", "x" => "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", "kid" => "k1" }.freeze
  ].freeze
end
