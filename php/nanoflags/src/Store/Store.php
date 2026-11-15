<?php

declare(strict_types=1);

namespace NanoFlags\Store;

/**
 * Where the client keeps the last good bundle (and a little shared state) between requests. Values are opaque
 * strings. Keys consist of `[A-Za-z0-9_.]` only, so they are valid PSR-16 keys.
 *
 * A store sits outside the trust boundary: a signed bundle read back from it is verified again before it is used.
 * Implementations must not throw for a missing key; failures may throw (they are reported as "store" errors).
 */
interface Store
{
    /** The stored value, or null. */
    public function get(string $key): ?string;

    /** Stores $value; $ttl in seconds (0: no expiry). */
    public function set(string $key, string $value, int $ttl = 0): void;
}
