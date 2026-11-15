<?php

declare(strict_types=1);

namespace NanoFlags\Http;

/** A transport that can also read a server-sent event stream (used by `bin/nanoflags-sync --stream`). */
interface StreamingTransport extends Transport
{
    /**
     * Opens $url and calls $onEvent(string $event, string $data) for each event until the stream ends, $onEvent
     * returns false, or $maxSeconds pass. Returns the HTTP status (0 when no response arrived).
     *
     * @param array<string, string> $headers
     * @param callable(string, string): (bool|null) $onEvent
     */
    public function stream(string $url, array $headers, callable $onEvent, float $connectTimeout, float $maxSeconds): int;
}
