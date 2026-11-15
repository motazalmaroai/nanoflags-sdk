<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * The TypeError the TypeScript engine would throw for a malformed configuration. The message matches V8's.
 *
 * @internal
 */
final class JsTypeError extends \RuntimeException
{
}
