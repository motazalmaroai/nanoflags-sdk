<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Client;
use NanoFlags\Engine\Engine;
use NanoFlags\Http\Response;
use NanoFlags\Http\Transport;
use NanoFlags\Keys;
use NanoFlags\NanoFlagsException;
use NanoFlags\Status;
use NanoFlags\Store\MemoryStore;
use PHPUnit\Framework\TestCase;

/** Verification hardening: revision floor, status after a refused update, address spelling, key sources. */
final class VerificationTest extends TestCase
{
    private FakeEdge $edge;
    private MemoryStore $store;
    private float $now = 1_800_000_000.0;
    /** @var list<NanoFlagsException> */
    private array $errors = [];

    protected function setUp(): void
    {
        FakeEdge::resetProcessState();
        $this->edge = new FakeEdge();
        $this->store = new MemoryStore();
        $this->errors = [];
    }

    private function client(array $options = []): Client
    {
        return new Client(...$options + [
            'sdkKey' => 'nf_srv_test',
            'baseUrl' => FakeEdge::BASE,
            'cache' => $this->store,
            'http' => $this->edge,
            'verify' => ['publicKeys' => [$this->edge->jwk], 'require' => true],
            'events' => false,
            'onError' => function (NanoFlagsException $e): void {
                $this->errors[] = $e;
            },
            'clock' => fn (): float => $this->now,
        ]);
    }

    /** @return list<string> */
    private function codes(): array
    {
        return array_map(static fn (NanoFlagsException $e) => $e->errorCode, $this->errors);
    }

    private function entryKey(): string
    {
        return 'nanoflags.bundle.' . sprintf('%08x', Engine::murmur3(FakeEdge::BASE . '|nf_srv_test'));
    }

    /** The cache entry a client with its own cache has after loading $revision from the edge. */
    private function entryFor(int $revision): string
    {
        $this->edge->setBundle(FakeEdge::bundle($revision));
        $store = new MemoryStore();
        $this->client(['cache' => $store])->revision();
        return (string) $store->get($this->entryKey());
    }

    public function testAnOlderRevisionThanTheCachedOneIsNotAdopted(): void
    {
        $this->edge->setBundle(FakeEdge::bundle(3));
        self::assertSame(3, $this->client()->revision());
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->now += 31;
        $c = $this->client();
        self::assertSame(3, $c->revision());
        self::assertSame(Status::STALE, $c->status());
        self::assertSame(['rollback'], $this->codes());
        // The cache still holds the newer copy for the next request.
        $this->now += 31;
        self::assertSame(3, $this->client()->revision());
        $this->edge->setBundle(FakeEdge::bundle(4));
        $this->now += 31;
        $c = $this->client();
        self::assertSame(4, $c->revision());
        self::assertSame(Status::READY, $c->status());
    }

    public function testAnOlderCachedCopyIsNotAdoptedByAClientThatHasANewerOne(): void
    {
        $older = $this->entryFor(2);
        $this->edge->setBundle(FakeEdge::bundle(3));
        $c = $this->client();
        self::assertSame(3, $c->revision());
        $this->store->set($this->entryKey(), $older);
        $this->now += 31;
        self::assertTrue($c->refresh()); // the edge confirms the copy in use
        self::assertSame(3, $c->revision());
        self::assertSame(['rollback'], $this->codes());
        self::assertSame(3, $this->client()->revision()); // the cache holds the confirmed copy again

        // Without a network the copy in use stays and is stale.
        $d = $this->client(['refresh' => false]);
        self::assertSame(3, $d->revision());
        $this->store->set($this->entryKey(), $older);
        $this->now += 31;
        self::assertFalse($d->refresh());
        self::assertSame(3, $d->revision());
        self::assertSame(Status::STALE, $d->status());
        self::assertSame(['rollback', 'rollback'], $this->codes());
    }

    public function testAnAnswerOvertakenByAnotherRequestIsDroppedWithoutAnError(): void
    {
        $newer = $this->entryFor(5);
        $this->edge->setBundle(FakeEdge::bundle(3));
        $this->client()->revision();
        $this->edge->setBundle(FakeEdge::bundle(4));
        $edge = $this->edge;
        $store = $this->store;
        $key = $this->entryKey();
        $transport = new class($edge, $store, $key, $newer) implements Transport {
            public function __construct(private FakeEdge $edge, private MemoryStore $store, private string $key, private string $entry)
            {
            }

            public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
            {
                $res = $this->edge->send($method, $url, $headers, $body, $timeout);
                if (str_ends_with($url, '/v1/bundle')) {
                    $this->store->set($this->key, $this->entry); // another request stored a newer revision meanwhile
                }
                return $res;
            }
        };
        $this->now += 31;
        $c = $this->client(['http' => $transport]);
        self::assertSame(5, $c->revision());
        self::assertSame(Status::READY, $c->status());
        self::assertSame([], $this->errors);
    }

    public function testAnOlderCopyMarkedStaleByTheEdgeKeepsTheCurrentBehaviour(): void
    {
        $this->edge->setBundle(FakeEdge::bundle(3));
        $this->client()->revision();
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->edge->stale = true;
        $this->now += 31;
        $c = $this->client();
        self::assertSame(3, $c->revision());
        self::assertSame(Status::STALE, $c->status());
        self::assertSame([], $this->errors);
    }

    public function testUnverifiedRevisionsDoNotSetTheFloor(): void
    {
        $text = (string) json_encode(FakeEdge::bundle(10));
        $this->edge->setBundle(FakeEdge::bundle(2));
        $c = $this->client(['bootstrap' => $text]);
        self::assertSame(2, $c->revision());
        self::assertSame([], $this->errors);

        // Without verification there is no floor at all.
        $store = new MemoryStore();
        $this->edge->setBundle(FakeEdge::bundle(3));
        $this->client(['cache' => $store, 'verify' => false])->revision();
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->now += 31;
        self::assertSame(2, $this->client(['cache' => $store, 'verify' => false])->revision());
        self::assertSame([], $this->errors);
    }

    public function testTheFloorIsPerClient(): void
    {
        $this->edge->setBundle(FakeEdge::bundle(3));
        $this->client()->revision();
        $this->edge->setBundle(FakeEdge::bundle(2));
        $other = $this->client(['sdkKey' => 'nf_srv_other']);
        self::assertSame(2, $other->revision());
        self::assertSame([], $this->errors);
    }

    public function testARefusedUpdateMakesALoadedClientStale(): void
    {
        $this->edge->setBundle(FakeEdge::bundle(1));
        $c = $this->client();
        self::assertSame(Status::READY, $c->status());
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->edge->tamper = true;
        $this->now += 31;
        self::assertFalse($c->refresh());
        self::assertSame(Status::STALE, $c->status());
        self::assertSame(1, $c->revision());
        self::assertSame(['signature'], $this->codes());
        $this->edge->tamper = false;
        $this->now += 31;
        self::assertTrue($c->refresh());
        self::assertSame(Status::READY, $c->status());
        self::assertSame(2, $c->revision());
    }

    public function testAnUnsignedAnswerWhileTheEdgeCatchesUpAndAnUnsupportedEngineLeaveTheStatus(): void
    {
        $c = $this->client();
        self::assertSame(Status::READY, $c->status());
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->edge->signed = false;
        $this->now += 31;
        $c->refresh();
        self::assertSame(Status::READY, $c->status());
        self::assertSame(['signature'], $this->codes());
        $this->edge->signed = true;
        $this->edge->setBundle(FakeEdge::bundle(3, null, ['engine' => 99]));
        $this->now += 31;
        $c->refresh();
        self::assertSame(Status::READY, $c->status());
        self::assertSame(1, $c->revision());
        self::assertSame(['signature', 'engine'], $this->codes());
    }

    /** @return array<string, array{string, bool}> */
    public static function addresses(): array
    {
        return [
            'plain' => ['https://edge.nanoflags.io', true],
            'slashes' => ['https://edge.nanoflags.io///', true],
            'upper case and port' => ['https://EDGE.nanoflags.io:443', true],
            'port and slash' => ['https://edge.nanoflags.io:443/', true],
            'trailing dot' => ['https://edge.nanoflags.io.', true],
            'trailing dot and port' => ['https://edge.nanoflags.io.:443/', true],
            'other host' => ['https://edge.example.com', false],
            'suffix host' => ['https://sub.edge.nanoflags.io', false],
            'prefix host' => ['https://edge.nanoflags.io.example.com', false],
            'http' => ['http://edge.nanoflags.io', false],
            'other port' => ['https://edge.nanoflags.io:8443', false],
            'path' => ['https://edge.nanoflags.io/v1', false],
            'user info' => ['https://user@edge.nanoflags.io', false],
            'user info lookalike' => ['https://edge.nanoflags.io@example.com', false],
            'query' => ['https://edge.nanoflags.io?x=1', false],
            'fragment' => ['https://edge.nanoflags.io#x', false],
        ];
    }

    /** @dataProvider addresses */
    #[\PHPUnit\Framework\Attributes\DataProvider('addresses')]
    public function testAddressSpellings(string $url, bool $official): void
    {
        // The hosted edge verifies and requires signatures by default; any other address does not.
        $seen = new class implements Transport {
            public array $urls = [];

            public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
            {
                $this->urls[] = $url;
                $b = FakeEdge::bundle(1);
                return new Response(200, ['content-type' => 'application/json', 'x-nanoflags-signed' => 'false'], sprintf('{"revision":1,"checksum":"c","bundle":%s}', json_encode($b)));
            }
        };
        $c = new Client('nf_srv_test', $url, cache: false, http: $seen, events: false);
        $c->status();
        if ($official) {
            self::assertSame(Status::NOT_READY, $c->status()); // unsigned: refused
            self::assertSame(Keys::OFFICIAL_EDGE_URL . '/v1/bundle', $seen->urls[0]);
        } else {
            self::assertSame(Status::READY, $c->status());
        }
    }

    public function testKeysAreNotTakenFromTheCache(): void
    {
        // The cache lists a key for the edge's signing key id that /v1/keys does not publish: it is not used.
        $kp = sodium_crypto_sign_keypair();
        $this->edge->secretKey = sodium_crypto_sign_secretkey($kp);
        $this->edge->setBundle(FakeEdge::bundle(1));
        $cachedKey = ['kty' => 'OKP', 'crv' => 'Ed25519', 'x' => rtrim(strtr(base64_encode(sodium_crypto_sign_publickey($kp)), '+/', '-_'), '='), 'kid' => 't1'];
        $id = sprintf('%08x', Engine::murmur3(FakeEdge::BASE . '|nf_srv_test'));
        $this->store->set('nanoflags.keys.' . $id, (string) json_encode(['keys' => [$cachedKey], 'at' => $this->now]));

        $c = $this->client(['verify' => true]);
        self::assertSame('x', $c->stringVariation('accent', 'x'));
        self::assertSame(Status::NOT_READY, $c->status());
        self::assertContains('signature', $this->codes());
        self::assertGreaterThanOrEqual(1, $this->edge->count('/v1/keys')); // fetched instead

        // A cached signed copy is verified again against the real keys, not the cached ones.
        $this->errors = [];
        $this->store->set($this->entryKey(), (string) json_encode([
            'v' => 1, 'id' => $id, 'raw' => $this->edge->text, 'revision' => 1, 'fetchedAt' => $this->now, 'stale' => false, 'env' => FakeEdge::ENV_ID,
            'sig' => ['signature' => $this->edge->signature, 'kid' => 't1', 'environmentId' => FakeEdge::ENV_ID, 'revision' => 1, 'checksum' => $this->edge->checksum],
        ]));
        FakeEdge::resetProcessState();
        $d = $this->client(['verify' => true, 'refresh' => false]);
        self::assertSame('x', $d->stringVariation('accent', 'x'));
        self::assertContains('signature', $this->codes());
    }

    public function testKeysFetchedByThisProcessStillVerifyAndAreNotWrittenToTheCache(): void
    {
        $c = $this->client(['verify' => true]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        $id = sprintf('%08x', Engine::murmur3(FakeEdge::BASE . '|nf_srv_test'));
        self::assertNull($this->store->get('nanoflags.keys.' . $id));
        $this->now += 31;
        self::assertSame('blue', $this->client(['verify' => true])->stringVariation('accent', 'x'));
        self::assertSame(1, $this->edge->count('/v1/keys'));
    }
}
