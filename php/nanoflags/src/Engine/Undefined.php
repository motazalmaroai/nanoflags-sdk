<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * JavaScript `undefined`: an absent value (a missing property, a flag that serves nothing). Distinct from `null`
 * (JSON null). Use {@see Undefined::value()} for the singleton and `instanceof Undefined` to test for it.
 */
final class Undefined
{
    private static ?self $instance = null;

    private function __construct()
    {
    }

    public static function value(): self
    {
        return self::$instance ??= new self();
    }

    public function __toString(): string
    {
        return 'undefined';
    }
}
