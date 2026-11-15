<?php

declare(strict_types=1);

namespace NanoFlags\Store;

/** A store held by this object only (tests, long-running workers that need no sharing). */
final class MemoryStore implements Store
{
    /** @var array<string, array{string, float}> */
    private array $items = [];

    public function get(string $key): ?string
    {
        $e = $this->items[$key] ?? null;
        if ($e === null) {
            return null;
        }
        if ($e[1] > 0 && $e[1] < microtime(true)) {
            unset($this->items[$key]);
            return null;
        }
        return $e[0];
    }

    public function set(string $key, string $value, int $ttl = 0): void
    {
        $this->items[$key] = [$value, $ttl > 0 ? microtime(true) + $ttl : 0.0];
    }
}
