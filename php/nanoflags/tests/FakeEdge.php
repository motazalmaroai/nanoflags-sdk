<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Http\Response;
use NanoFlags\Http\Transport;

/**
 * An in-memory edge: /v1/bundle (ETag, 304, signatures exactly as the hosted edge makes them), /v1/keys,
 * /v1/events and /v1/session, signing with a throwaway Ed25519 key.
 */
final class FakeEdge implements Transport
{
    public const ENV_ID = '11111111-2222-3333-4444-555555555555';
    public const BASE = 'https://flags.test';

    public string $secretKey;
    /** @var array{kty: string, crv: string, x: string, kid: string} */
    public array $jwk;
    public string $kid = 't1';
    public string $text = '';
    public int $revision = 0;
    public string $checksum = '';
    public string $signature = '';
    public string $envId = self::ENV_ID;
    public bool $signed = true;
    public bool $tamper = false;
    public bool $stale = false;
    public bool $down = false;
    public ?int $statusOverride = null;
    /** @var list<array{method: string, path: string, headers: array<string, string>}> */
    public array $requests = [];
    /** @var list<array<string, mixed>> */
    public array $events = [];
    /** @var array<string, array<string, mixed>|int> test sessions by token (an int: answer with that status) */
    public array $sessions = [];

    public function __construct()
    {
        $kp = sodium_crypto_sign_keypair();
        $this->secretKey = sodium_crypto_sign_secretkey($kp);
        $this->jwk = ['kty' => 'OKP', 'crv' => 'Ed25519', 'x' => rtrim(strtr(base64_encode(sodium_crypto_sign_publickey($kp)), '+/', '-_'), '='), 'kid' => 't1'];
        $this->setBundle(self::bundle(1));
    }

    /** @param array<string, mixed>|null $flags */
    public static function bundle(int $revision, ?array $flags = null, array $extra = []): array
    {
        $flags ??= [
            'new-checkout' => ['type' => 'boolean', 'enabled' => true, 'default' => false, 'off' => false, 'rules' => [
                ['id' => 'beta', 'match' => 'all', 'conditions' => [['attribute' => 'plan', 'op' => 'eq', 'value' => 'beta']], 'serve' => ['type' => 'fixed', 'value' => true]],
                ['id' => 'half', 'match' => 'all', 'conditions' => [], 'serve' => ['type' => 'rollout', 'percentage' => 50, 'value' => true, 'otherwise' => false]],
            ]],
            'accent' => ['type' => 'string', 'enabled' => true, 'default' => 'blue', 'off' => 'grey', 'rules' => []],
            'limit' => ['type' => 'number', 'enabled' => true, 'default' => 10, 'off' => 0, 'rules' => []],
            'ratio' => ['type' => 'number', 'enabled' => true, 'default' => 0.5, 'off' => 0, 'rules' => []],
            'layout' => ['type' => 'json', 'enabled' => true, 'default' => ['cols' => 3], 'off' => null, 'rules' => []],
            'disabled' => ['type' => 'string', 'enabled' => false, 'default' => 'on', 'off' => 'off', 'rules' => []],
            'region' => ['type' => 'string', 'enabled' => true, 'default' => 'world', 'off' => 'off', 'rules' => [
                ['id' => 'eu', 'match' => 'any', 'conditions' => [['attribute' => 'country', 'op' => 'in', 'value' => ['DE', 'FR']], ['attribute' => 'email', 'op' => 'ends_with', 'value' => '.eu']], 'serve' => ['type' => 'fixed', 'value' => 'eu']],
            ]],
        ];
        $base = ['schema' => 1, 'engine' => 1, 'project' => 'p', 'environment' => 'test', 'revision' => $revision, 'flags' => $flags, 'segments' => new \stdClass()];
        return array_merge($base, $extra);
    }

    public function sign(string $text, int $revision, string $checksum, ?string $secretKey = null, ?string $env = null): string
    {
        $canonical = "nanoflags-bundle-v1\n" . ($env ?? $this->envId) . "\n$revision\n$checksum\n" . hash('sha256', $text);
        return rtrim(strtr(base64_encode(sodium_crypto_sign_detached($canonical, $secretKey ?? $this->secretKey)), '+/', '-_'), '=');
    }

    /** @param array<string, mixed> $bundle */
    public function setBundle(array $bundle): void
    {
        // Pretty-printed: the text differs from JSON.stringify of the parsed bundle, so verification must hash the raw span.
        $this->text = (string) json_encode($bundle, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        $this->revision = $bundle['revision'];
        $this->checksum = md5($this->text);
        $this->signature = $this->sign($this->text, $this->revision, $this->checksum);
    }

    public function count(string $path): int
    {
        return count(array_filter($this->requests, static fn ($r) => $r['path'] === $path));
    }

    public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
    {
        $path = (string) parse_url($url, PHP_URL_PATH);
        $this->requests[] = ['method' => $method, 'path' => $path, 'headers' => $headers];
        if ($this->down) {
            throw new \RuntimeException('connection refused');
        }
        if ($path === '/v1/keys') {
            return new Response(200, ['content-type' => 'application/json'], (string) json_encode(['keys' => [$this->jwk + ['alg' => 'EdDSA', 'use' => 'sig']]]));
        }
        if ($this->statusOverride !== null) {
            return new Response($this->statusOverride, [], '{"error":{"code":"x","message":"x"}}');
        }
        if ($path === '/v1/session') {
            $sess = $this->sessions[$headers['X-NanoFlags-Session'] ?? ''] ?? null;
            if ($sess === null) {
                return new Response(404, [], '{"error":{"code":"session_not_found","message":"x"}}');
            }
            if (is_int($sess)) {
                return new Response($sess, [], '{"error":{"code":"x","message":"x"}}');
            }
            return new Response(200, ['content-type' => 'application/json'], (string) json_encode($sess, JSON_UNESCAPED_SLASHES));
        }
        if ($path === '/v1/events' && $method === 'POST') {
            $this->events[] = json_decode((string) $body, true);
            return new Response(202, [], '{"accepted":0}');
        }
        if ($path === '/v1/bundle') {
            $etag = '"' . $this->checksum . '-server"';
            $h = ['etag' => $etag, 'x-nanoflags-environment-id' => $this->envId, 'x-nanoflags-signed' => $this->signed ? 'true' : 'false'];
            if ($this->signed) {
                $h['x-nanoflags-signature'] = $this->signature;
                $h['x-nanoflags-key-id'] = $this->kid;
            }
            if ($this->stale) {
                $h['x-nanoflags-stale'] = 'true';
            }
            if (($headers['If-None-Match'] ?? null) === $etag) {
                return new Response(304, $h, '');
            }
            $text = $this->tamper ? str_replace('"blue"', '"red"', $this->text) : $this->text;
            return new Response(200, $h + ['content-type' => 'application/json'], sprintf('{"revision":%d,"checksum":"%s","bundle":%s}', $this->revision, $this->checksum, $text));
        }
        return new Response(404, [], '');
    }
}
