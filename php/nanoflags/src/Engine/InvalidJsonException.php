<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/** Thrown by {@see Json::parse()} for text that `JSON.parse` rejects. */
final class InvalidJsonException extends \InvalidArgumentException
{
}
