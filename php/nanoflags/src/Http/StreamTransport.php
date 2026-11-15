<?php

declare(strict_types=1);

namespace NanoFlags\Http;

/**
 * Fallback transport on PHP's http:// stream wrapper, for hosts without ext-curl. It does not read proxy settings
 * from the environment; pass a PSR-18 client or use ext-curl behind a proxy.
 */
final class StreamTransport implements Transport
{
    public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
    {
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "$k: $v";
        }
        $ctx = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $lines),
                'content' => $body ?? '',
                'timeout' => $timeout,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 0,
                'protocol_version' => 1.1,
            ],
        ]);
        $http_response_header = [];
        $data = @file_get_contents($url, false, $ctx, 0, 16 * 1024 * 1024 + 1);
        if ($data === false || $http_response_header === []) {
            $e = error_get_last();
            throw new \RuntimeException($e['message'] ?? 'request failed');
        }
        $status = 0;
        $out = [];
        foreach ($http_response_header as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                $status = (int) $m[1];
                $out = [];
                continue;
            }
            $p = strpos($line, ':');
            if ($p !== false) {
                $out[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
            }
        }
        if (strlen($data) > 16 * 1024 * 1024) {
            throw new \RuntimeException('response body larger than 16 MiB');
        }
        return new Response($status, $out, $data);
    }
}
