<?php

declare(strict_types=1);

namespace NanoFlags\Http;

/**
 * ext-curl transport (the default when ext-curl is loaded). Honours the usual proxy environment variables
 * (`HTTPS_PROXY`, `NO_PROXY`) and a CA bundle named by `CURL_CA_BUNDLE` or `SSL_CERT_FILE` (when `curl.cainfo` is not
 * set), never follows redirects, and caps response bodies at 16 MiB.
 */
final class CurlTransport implements StreamingTransport
{
    private const MAX_BODY = 16 * 1024 * 1024;

    /** @var \CurlHandle|null reused for keep-alive within a process */
    private $handle = null;

    /** @var array<int, mixed> */
    private readonly array $curlOptions;

    /** @param array<int, mixed> $curlOptions extra CURLOPT_* settings (CA bundle, proxy, …) */
    public function __construct(array $curlOptions = [])
    {
        if (!isset($curlOptions[CURLOPT_CAINFO]) && (string) ini_get('curl.cainfo') === '') {
            foreach (['CURL_CA_BUNDLE', 'SSL_CERT_FILE'] as $var) {
                $f = getenv($var);
                if (is_string($f) && $f !== '' && is_readable($f)) {
                    $curlOptions[CURLOPT_CAINFO] = $f;
                    break;
                }
            }
        }
        $this->curlOptions = $curlOptions;
    }

    public static function available(): bool
    {
        return function_exists('curl_init');
    }

    public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
    {
        $h = $this->handle ??= curl_init();
        curl_reset($h);
        $responseHeaders = [];
        $buffer = '';
        $tooLarge = false;
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "$k: $v";
        }
        $lines[] = 'Expect:';
        $opts = [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_CONNECTTIMEOUT_MS => (int) max(1, $timeout * 1000),
            CURLOPT_TIMEOUT_MS => (int) max(1, $timeout * 1000),
            CURLOPT_NOSIGNAL => true,
            CURLOPT_ENCODING => '',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$responseHeaders): int {
                $p = strpos($line, ':');
                if ($p !== false) {
                    $responseHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
                } elseif (str_starts_with($line, 'HTTP/')) {
                    $responseHeaders = [];
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$buffer, &$tooLarge): int {
                if (strlen($buffer) + strlen($chunk) > self::MAX_BODY) {
                    $tooLarge = true;
                    return 0;
                }
                $buffer .= $chunk;
                return strlen($chunk);
            },
        ];
        if ($method === 'HEAD') {
            $opts[CURLOPT_NOBODY] = true;
        }
        if ($body !== null) {
            $opts[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($h, $this->curlOptions + $opts);
        $ok = curl_exec($h);
        if ($tooLarge) {
            throw new \RuntimeException('response body larger than 16 MiB');
        }
        if ($ok === false) {
            $err = curl_error($h);
            $this->handle = null;
            throw new \RuntimeException($err !== '' ? $err : 'request failed');
        }
        return new Response((int) curl_getinfo($h, CURLINFO_RESPONSE_CODE), $responseHeaders, $buffer);
    }

    public function stream(string $url, array $headers, callable $onEvent, float $connectTimeout, float $maxSeconds): int
    {
        $h = curl_init();
        $parser = new SseParser();
        $status = 0;
        $stop = false;
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = "$k: $v";
        }
        curl_setopt_array($h, $this->curlOptions + [
            CURLOPT_URL => $url,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT_MS => (int) max(1, $connectTimeout * 1000),
            CURLOPT_TIMEOUT_MS => (int) max(1, $maxSeconds * 1000),
            CURLOPT_NOSIGNAL => true,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$status): int {
                if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m) === 1) {
                    $status = (int) $m[1];
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use ($parser, $onEvent, &$status, &$stop): int {
                if ($status !== 200) {
                    return strlen($chunk);
                }
                foreach ($parser->feed($chunk) as [$event, $data]) {
                    if ($onEvent($event, $data) === false) {
                        $stop = true;
                        return 0;
                    }
                }
                return strlen($chunk);
            },
        ]);
        curl_exec($h);
        $code = (int) curl_getinfo($h, CURLINFO_RESPONSE_CODE);
        curl_close($h);
        return $code !== 0 ? $code : $status;
    }
}
