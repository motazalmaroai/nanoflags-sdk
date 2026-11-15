<?php

declare(strict_types=1);

namespace NanoFlags\Store;

use Psr\SimpleCache\CacheInterface;

/**
 * Any PSR-16 cache: Laravel's `Cache::store()` (Illuminate\Cache\Repository), Symfony's `Psr16Cache`, a Redis or
 * Memcached adapter… Use a cache shared by every web server to share one bundle between them.
 */
final class Psr16Store implements Store
{
    public function __construct(private readonly CacheInterface $cache)
    {
    }

    public function get(string $key): ?string
    {
        $v = $this->cache->get($key);
        return is_string($v) ? $v : null;
    }

    public function set(string $key, string $value, int $ttl = 0): void
    {
        $this->cache->set($key, $value, $ttl > 0 ? $ttl : null);
    }
}
