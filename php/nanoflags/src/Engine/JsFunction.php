<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * A function value. Only ever produced by reading a String / Array prototype method by name (e.g. `"ab".match`),
 * which a malformed configuration can make the engine do.
 *
 * @internal
 */
final class JsFunction
{
    public function __construct(public readonly string $name)
    {
    }
}
