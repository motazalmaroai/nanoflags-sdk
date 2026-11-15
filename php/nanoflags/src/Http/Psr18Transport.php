<?php

declare(strict_types=1);

namespace NanoFlags\Http;

use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * Any PSR-18 client (Guzzle, Symfony HttpClient's Psr18Client, …) with PSR-17 factories. Timeouts and proxies are
 * configured on the client itself; keep its timeout short (a bundle request can run on the request path).
 * The client must not follow redirects.
 */
final class Psr18Transport implements Transport
{
    public function __construct(
        private readonly ClientInterface $client,
        private readonly RequestFactoryInterface $requestFactory,
        private readonly StreamFactoryInterface $streamFactory,
    ) {
    }

    public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
    {
        $req = $this->requestFactory->createRequest($method, $url);
        foreach ($headers as $k => $v) {
            $req = $req->withHeader($k, $v);
        }
        if ($body !== null) {
            $req = $req->withBody($this->streamFactory->createStream($body));
        }
        $res = $this->client->sendRequest($req);
        $out = [];
        foreach ($res->getHeaders() as $k => $values) {
            $out[strtolower((string) $k)] = implode(', ', $values);
        }
        $stream = $res->getBody();
        $data = '';
        while (!$stream->eof()) {
            $data .= $stream->read(65536);
            if (strlen($data) > 16 * 1024 * 1024) {
                throw new \RuntimeException('response body larger than 16 MiB');
            }
        }
        return new Response($res->getStatusCode(), $out, $data);
    }
}
