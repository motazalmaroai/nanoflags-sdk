<?php

declare(strict_types=1);

namespace NanoFlags;

/**
 * The hosted NanoFlags edge and the public halves of its bundle-signing keys (Ed25519, safe to embed).
 *
 * With `baseUrl` equal to {@see Keys::OFFICIAL_EDGE_URL} (the default) the client verifies every bundle against these
 * keys and refuses unsigned bundles. A bundle signed with a key id that is not listed here (a rotation after this
 * release) makes the client load `GET /v1/keys` once (again at most once a minute). Keep in sync with
 * packages/sdk/src/keys.ts.
 */
final class Keys
{
    public const OFFICIAL_EDGE_URL = 'https://edge.nanoflags.io';

    /** @var list<array{kty: string, crv: string, x: string, kid: string}> */
    public const OFFICIAL_SIGNING_KEYS = [
        ['kty' => 'OKP', 'crv' => 'Ed25519', 'x' => 'wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U', 'kid' => 'k1'],
    ];
}
