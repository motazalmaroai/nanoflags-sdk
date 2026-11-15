<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * A JavaScript plain object (a JSON object). Members are kept in JavaScript own-property order: array-index keys
 * ("0", "1", …) ascending first, then the other keys in insertion order. A repeated key keeps its first position and
 * its last value, as `JSON.parse` does. Treat instances as immutable.
 *
 * JSON arrays are PHP lists; JSON objects are always JsObject, so `{}` and `[]` stay distinct.
 */
final class JsObject implements \Countable, \IteratorAggregate
{
    /** @var array<string|int, mixed> members in JavaScript order (PHP turns canonical integer keys into ints) */
    private array $members;

    /** @param array<string|int, mixed> $members */
    public function __construct(array $members = [])
    {
        $needsSort = false;
        foreach ($members as $k => $_) {
            if (self::arrayIndex((string) $k) >= 0) {
                $needsSort = true;
                break;
            }
        }
        if ($needsSort) {
            $index = [];
            $names = [];
            foreach ($members as $k => $v) {
                $n = self::arrayIndex((string) $k);
                if ($n >= 0) {
                    $index[$n] = [$k, $v];
                } else {
                    $names[$k] = $v;
                }
            }
            ksort($index, SORT_NUMERIC);
            $ordered = [];
            foreach ($index as [$k, $v]) {
                $ordered[$k] = $v;
            }
            foreach ($names as $k => $v) {
                $ordered[$k] = $v;
            }
            $members = $ordered;
        }
        $this->members = $members;
    }

    /** The canonical array index of $k (0 … 2^32-2), or -1. */
    public static function arrayIndex(string $k): int
    {
        $len = strlen($k);
        if ($len === 0 || $len > 10 || ($len > 1 && $k[0] === '0') || strspn($k, '0123456789') !== $len) {
            return -1;
        }
        $n = (int) $k;
        return $n < 4294967295 ? $n : -1;
    }

    public function has(string $key): bool
    {
        return array_key_exists($key, $this->members);
    }

    /** The member, or {@see Undefined} when absent. */
    public function get(string $key): mixed
    {
        return array_key_exists($key, $this->members) ? $this->members[$key] : Undefined::value();
    }

    /** @return list<string> */
    public function keys(): array
    {
        return array_map('strval', array_keys($this->members));
    }

    /** @return array<string|int, mixed> members in JavaScript order */
    public function members(): array
    {
        return $this->members;
    }

    public function count(): int
    {
        return count($this->members);
    }

    /** @return \Generator<string, mixed> */
    public function getIterator(): \Generator
    {
        foreach ($this->members as $k => $v) {
            yield (string) $k => $v;
        }
    }
}
