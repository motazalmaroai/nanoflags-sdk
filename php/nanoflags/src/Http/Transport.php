<?php

declare(strict_types=1);

namespace NanoFlags\Http;

/**
 * How the client talks HTTP. Implementations never follow redirects and throw on transport failures (no
 * connection, timeout); any HTTP status is a Response.
 */
interface Transport
{
    /** @param array<string, string> $headers */
    public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response;
}
