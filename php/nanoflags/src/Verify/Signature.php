<?php

declare(strict_types=1);

namespace NanoFlags\Verify;

/**
 * Bundle signature verification: Ed25519 over the canonical string
 * `"nanoflags-bundle-v1\n<environment id>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>"`.
 *
 * Only PUBLIC keys are handled here; a JWK that carries a private member (`d`) is refused. Verification needs
 * `sodium_crypto_sign_verify_detached()` (ext-sodium, or paragonie/sodium_compat).
 *
 * @internal
 */
final class Signature
{
    public static function available(): bool
    {
        return function_exists('sodium_crypto_sign_verify_detached');
    }

    public static function base64UrlDecode(string $value): ?string
    {
        $s = rtrim(strtr($value, '-_', '+/'), '=');
        if (preg_match('#^[A-Za-z0-9+/]*$#D', $s) !== 1 || strlen($s) % 4 === 1) {
            return null;
        }
        $d = base64_decode($s . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        return $d === false ? null : $d;
    }

    public static function isPublicEd25519(mixed $jwk): bool
    {
        return is_array($jwk) && ($jwk['kty'] ?? null) === 'OKP' && ($jwk['crv'] ?? null) === 'Ed25519'
            && is_string($jwk['x'] ?? null) && $jwk['x'] !== '' && !array_key_exists('d', $jwk);
    }

    /**
     * The public Ed25519 JWKs among $jwks (anything else, including private keys, is skipped).
     *
     * @param iterable<mixed> $jwks
     * @return list<array{kid: ?string, key: string}>
     */
    public static function importKeys(iterable $jwks): array
    {
        $out = [];
        foreach ($jwks as $jwk) {
            if (!self::isPublicEd25519($jwk)) {
                continue;
            }
            $raw = self::base64UrlDecode($jwk['x']);
            if ($raw === null || strlen($raw) !== 32) {
                continue;
            }
            $kid = $jwk['kid'] ?? null;
            $out[] = ['kid' => is_string($kid) && $kid !== '' ? $kid : null, 'key' => $raw];
        }
        return $out;
    }

    public static function canonical(string $environmentId, int $revision, string $checksum, string $bundleText): string
    {
        return "nanoflags-bundle-v1\n$environmentId\n$revision\n$checksum\n" . hash('sha256', $bundleText);
    }

    /**
     * Whether $info['signature'] is a valid signature by one of $keys over the canonical string for $bundleText.
     * A key id narrows the candidates; an unknown key id matches no key.
     *
     * @param list<array{kid: ?string, key: string}> $keys
     * @param array{signature: string, kid: ?string, environmentId: string, revision: int, checksum: string} $info
     */
    public static function verify(array $keys, array $info, string $bundleText): bool
    {
        if (!self::available()) {
            return false;
        }
        $sig = self::base64UrlDecode($info['signature']);
        if ($sig === null || strlen($sig) !== 64) {
            return false;
        }
        $msg = self::canonical($info['environmentId'], $info['revision'], $info['checksum'], $bundleText);
        $kid = $info['kid'] ?? null;
        foreach ($keys as $k) {
            if ($kid !== null && $k['kid'] !== null && $k['kid'] !== $kid) {
                continue;
            }
            try {
                if (sodium_crypto_sign_verify_detached($sig, $msg, $k['key'])) {
                    return true;
                }
            } catch (\Throwable) {
                // a malformed key never verifies
            }
        }
        return false;
    }

    /**
     * The exact source text of the top-level member $name of a JSON object (the last one when it repeats, like
     * JSON.parse), or null. The edge embeds the stored, signed bundle text byte-for-byte; hashing that span avoids
     * any re-serialisation.
     */
    public static function rawMember(string $text, string $name): ?string
    {
        $n = strlen($text);
        $i = 0;
        $ws = static function () use (&$i, $text, $n): void {
            $i += strspn($text, " \n\r\t", $i);
        };
        $str = static function () use (&$i, $text, $n): ?array {
            if ($i >= $n || $text[$i] !== '"') {
                return null;
            }
            $start = $i;
            $i++;
            while ($i < $n) {
                $c = $text[$i];
                if ($c === '\\') {
                    $i += 2;
                } elseif ($c === '"') {
                    $i++;
                    return [$start, $i];
                } else {
                    $i++;
                }
            }
            return null;
        };
        $value = static function () use (&$i, $text, $n, $ws, $str): bool {
            $ws();
            if ($i >= $n) {
                return false;
            }
            $c = $text[$i];
            if ($c === '"') {
                return $str() !== null;
            }
            if ($c === '{' || $c === '[') {
                $depth = 0;
                while ($i < $n) {
                    $c = $text[$i];
                    if ($c === '"') {
                        if ($str() === null) {
                            return false;
                        }
                        continue;
                    }
                    if ($c === '{' || $c === '[') {
                        $depth++;
                    } elseif ($c === '}' || $c === ']') {
                        $depth--;
                    }
                    $i++;
                    if ($depth === 0) {
                        return true;
                    }
                }
                return false;
            }
            $start = $i;
            $i += strcspn($text, ",}] \n\r\t", $i);
            return $i > $start;
        };
        $ws();
        if ($i >= $n || $text[$i] !== '{') {
            return null;
        }
        $i++;
        $found = null;
        while (true) {
            $ws();
            if ($i < $n && $text[$i] === '}') {
                return $found;
            }
            $key = $str();
            if ($key === null) {
                return null;
            }
            $ws();
            if ($i >= $n || $text[$i] !== ':') {
                return null;
            }
            $i++;
            $ws();
            $start = $i;
            if (!$value()) {
                return null;
            }
            try {
                $k = \NanoFlags\Engine\Json::parse(substr($text, $key[0], $key[1] - $key[0]));
            } catch (\Throwable) {
                $k = null;
            }
            if ($k === $name) {
                $found = substr($text, $start, $i - $start);
            }
            $ws();
            if ($i < $n && $text[$i] === ',') {
                $i++;
            } elseif ($i < $n && $text[$i] === '}') {
                return $found;
            } else {
                return null;
            }
        }
    }
}
