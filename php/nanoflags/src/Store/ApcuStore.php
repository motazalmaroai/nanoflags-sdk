<?php

declare(strict_types=1);

namespace NanoFlags\Store;

/**
 * APCu shared memory: shared by the requests of one PHP-FPM pool (or one mod_php server) on one machine. The
 * default store when ext-apcu is enabled.
 */
final class ApcuStore implements Store
{
    public function __construct(private readonly string $prefix = '')
    {
    }

    public static function available(): bool
    {
        return function_exists('apcu_enabled') && apcu_enabled();
    }

    public function get(string $key): ?string
    {
        $ok = false;
        $v = apcu_fetch($this->prefix . $key, $ok);
        return $ok && is_string($v) ? $v : null;
    }

    public function set(string $key, string $value, int $ttl = 0): void
    {
        apcu_store($this->prefix . $key, $value, $ttl);
    }
}
