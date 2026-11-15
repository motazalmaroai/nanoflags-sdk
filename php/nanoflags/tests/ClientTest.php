<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Client;
use NanoFlags\Http\Response;
use NanoFlags\Http\Transport;
use NanoFlags\Keys;
use NanoFlags\NanoFlagsException;
use NanoFlags\Reason;
use NanoFlags\Status;
use NanoFlags\Store\MemoryStore;
use NanoFlags\Store\Store;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    private FakeEdge $edge;
    private MemoryStore $store;
    private float $now = 1_800_000_000.0;
    /** @var list<NanoFlagsException> */
    private array $errors = [];

    protected function setUp(): void
    {
        $this->edge = new FakeEdge();
        $this->store = new MemoryStore();
        $this->errors = [];
    }

    /** A new client, as a new request would create it. */
    private function client(array $options = []): Client
    {
        return new Client(...$options + [
            'sdkKey' => 'nf_srv_test',
            'baseUrl' => FakeEdge::BASE,
            'service' => 'php-tests',
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

    public function testTypedGettersAndDetails(): void
    {
        $c = $this->client();
        self::assertTrue($c->boolVariation('new-checkout', false, ['key' => 'u1', 'plan' => 'beta']));
        self::assertSame(Status::READY, $c->status());
        self::assertSame(1, $c->revision());
        self::assertSame('network', $c->source());
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame(10, $c->numberVariation('limit', 0));
        self::assertSame(0.5, $c->numberVariation('ratio', 0));
        self::assertSame(['cols' => 3], $c->jsonVariation('layout', []));
        self::assertSame('off', $c->stringVariation('disabled', 'x'));
        self::assertSame('eu', $c->stringVariation('region', 'x', ['email' => 'a@b.eu']));

        $d = $c->boolVariationDetail('new-checkout', false, ['key' => 'u1', 'plan' => 'beta']);
        self::assertSame(Reason::RULE_MATCH, $d->reason);
        self::assertSame(0, $d->ruleIndex);
        self::assertSame('beta', $d->ruleId);
        self::assertSame('Rule 01 matched', $d->trace[1]->title);

        $d = $c->boolVariationDetail('new-checkout', false, ['key' => 'user-42']);
        self::assertSame('half', $d->ruleId);
        self::assertNotNull($d->bucket);
        self::assertSame($d->bucket < 50, $d->value);
        self::assertSame($d->inRollout, $d->value);

        // Type mismatch: the default, reason error, and the engine trace plus an explanation.
        $d = $c->boolVariationDetail('accent', true);
        self::assertTrue($d->value);
        self::assertSame(Reason::ERROR, $d->reason);
        self::assertSame('Flag "accent" has a string value, which does not match the requested type.', $d->error);
        self::assertSame('Returned the fallback', $d->trace[count($d->trace) - 1]->title);
        self::assertSame(7, $c->numberVariation('accent', 7));

        $d = $c->stringVariationDetail('missing', 'fb');
        self::assertSame(['fb', Reason::FLAG_NOT_FOUND], [$d->value, $d->reason]);

        $all = $c->allFlags(['key' => 'u1', 'plan' => 'beta']);
        self::assertSame(['new-checkout' => true, 'accent' => 'blue', 'limit' => 10, 'ratio' => 0.5, 'layout' => ['cols' => 3], 'disabled' => 'off', 'region' => 'world'], $all);
        self::assertSame([], $this->errors);
        // The SDK key goes in the Authorization header only.
        self::assertSame('Bearer nf_srv_test', $this->edge->requests[0]['headers']['Authorization']);
        self::assertStringStartsWith('nanoflags-php/', $this->edge->requests[0]['headers']['User-Agent']);
    }

    public function testCacheIsSharedBetweenRequestsAndRevalidatedWithEtag(): void
    {
        $this->client()->boolVariation('new-checkout', false);
        self::assertSame(1, $this->edge->count('/v1/bundle'));

        // Next request within the TTL: no network at all.
        $c2 = $this->client();
        self::assertSame('blue', $c2->stringVariation('accent', 'x'));
        self::assertSame('cache', $c2->source());
        self::assertSame(Status::READY, $c2->status());
        self::assertSame(1, $this->edge->count('/v1/bundle'));

        // After the TTL: one conditional request, answered 304.
        $this->now += 31;
        $c3 = $this->client();
        self::assertSame('blue', $c3->stringVariation('accent', 'x'));
        self::assertSame(2, $this->edge->count('/v1/bundle'));
        self::assertSame('"' . $this->edge->checksum . '-server"', $this->edge->requests[1]['headers']['If-None-Match']);
        self::assertSame(Status::READY, $c3->status());

        // A new revision is picked up on the next revalidation.
        $flags = FakeEdge::bundle(2)['flags'];
        $flags['accent']['default'] = 'green';
        $this->edge->setBundle(FakeEdge::bundle(2, $flags));
        $this->now += 31;
        $c4 = $this->client();
        self::assertSame('green', $c4->stringVariation('accent', 'x'));
        self::assertSame(2, $c4->revision());
        self::assertSame([], $this->errors);
    }

    public function testLongRunningClientRevalidatesAfterTheTtl(): void
    {
        $c = $this->client(['cacheTtl' => 10.0]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        $flags = FakeEdge::bundle(2)['flags'];
        $flags['accent']['default'] = 'green';
        $this->edge->setBundle(FakeEdge::bundle(2, $flags));
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        $this->now += 11;
        self::assertSame('green', $c->stringVariation('accent', 'x'));
        self::assertTrue($c->refresh());
    }

    public function testEdgeDownServesLastGoodBundleAndBacksOff(): void
    {
        $this->client()->boolVariation('new-checkout', false);
        $this->edge->down = true;
        $this->now += 31;
        $c = $this->client();
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame(Status::STALE, $c->status());
        self::assertSame(['network'], $this->codes());
        self::assertSame(NanoFlagsException::NETWORK, $c->lastError()?->errorCode);
        $requests = count($this->edge->requests);

        // Other requests within the retry interval do not hit the edge again.
        $this->now += 1;
        $c2 = $this->client();
        self::assertSame('blue', $c2->stringVariation('accent', 'x'));
        self::assertSame(Status::STALE, $c2->status());
        self::assertSame($requests, count($this->edge->requests));
        self::assertSame(NanoFlagsException::NETWORK, $c2->lastError()?->errorCode);

        // Recovery.
        $this->edge->down = false;
        $this->now += 5;
        $c3 = $this->client();
        self::assertSame(Status::READY, $c3->status());
    }

    public function testNothingLoadedReturnsDefaults(): void
    {
        $this->edge->down = true;
        $c = $this->client();
        self::assertFalse($c->boolVariation('new-checkout', false));
        self::assertSame('fb', $c->stringVariation('accent', 'fb'));
        self::assertSame(Status::NOT_READY, $c->status());
        self::assertNull($c->revision());
        self::assertSame([], $c->allFlags());
        $d = $c->evaluate('accent', 'fb');
        self::assertSame(Reason::FLAG_NOT_FOUND, $d->reason);
        self::assertSame('No configuration is loaded. The application fallback applies.', $d->trace[0]->detail);
    }

    public function testUnauthorizedAndHttpErrors(): void
    {
        $this->edge->statusOverride = 401;
        $c = $this->client();
        self::assertSame('x', $c->stringVariation('accent', 'x'));
        self::assertSame(['unauthorized'], $this->codes());
        self::assertSame(401, $this->errors[0]->httpStatus);
        $this->edge->statusOverride = 503;
        $this->now += 10;
        $this->client()->stringVariation('accent', 'x');
        self::assertSame(['unauthorized', 'http'], $this->codes());
    }

    public function testTamperedUnsignedAndForeignBundlesAreRejected(): void
    {
        $this->edge->tamper = true;
        $c = $this->client();
        self::assertSame('x', $c->stringVariation('accent', 'x'));
        self::assertSame(['signature'], $this->codes());
        self::assertStringContainsString('its signature does not verify', $this->errors[0]->getMessage());

        $this->edge->tamper = false;
        $this->edge->signed = false;
        $this->now += 10;
        $this->client()->stringVariation('accent', 'x');
        self::assertStringContainsString('unsigned bundles are refused', end($this->errors)->getMessage());

        // Once a bundle of one environment was accepted, a bundle signed for another one is refused.
        $this->edge->signed = true;
        $this->now += 10;
        self::assertSame('blue', $this->client()->stringVariation('accent', 'x'));
        $this->edge->envId = 'ffffffff-2222-3333-4444-555555555555';
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->now += 31;
        $c = $this->client();
        self::assertSame(1, $c->revision());
        self::assertStringContainsString('signed for a different environment', end($this->errors)->getMessage());
    }

    public function testUnsignedBundlesAreAcceptedWithoutRequire(): void
    {
        $this->edge->signed = false;
        $c = $this->client(['verify' => ['publicKeys' => [$this->edge->jwk], 'require' => false]]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        $c = $this->client(['verify' => false]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame([], $this->errors);
    }

    public function testATamperedCacheEntryIsIgnored(): void
    {
        $this->client()->boolVariation('new-checkout', false);
        $key = 'nanoflags.bundle.' . sprintf('%08x', \NanoFlags\Engine\Engine::murmur3(FakeEdge::BASE . '|nf_srv_test'));
        $entry = json_decode((string) $this->store->get($key), true);
        $entry['raw'] = str_replace('"blue"', '"red"', $entry['raw']);
        $this->store->set($key, (string) json_encode($entry));
        $this->edge->down = true;
        $c = $this->client();
        self::assertSame('x', $c->stringVariation('accent', 'x'));
        self::assertContains('signature', $this->codes());
    }

    public function testKeysAreFetchedFromTheEdgeWhenNotPinned(): void
    {
        $c = $this->client(['verify' => true]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame(1, $this->edge->count('/v1/keys'));
        $keysRequest = array_values(array_filter($this->edge->requests, static fn ($r) => $r['path'] === '/v1/keys'))[0];
        self::assertArrayNotHasKey('Authorization', $keysRequest['headers']);
        // Shared through the cache: the next request does not ask again.
        $this->now += 31;
        $this->client(['verify' => true])->stringVariation('accent', 'x');
        self::assertSame(1, $this->edge->count('/v1/keys'));
    }

    public function testServedStaleNeverGoesBackwards(): void
    {
        $this->edge->setBundle(FakeEdge::bundle(3));
        $this->client()->boolVariation('new-checkout', false);
        $this->edge->setBundle(FakeEdge::bundle(2));
        $this->edge->stale = true;
        $this->now += 31;
        $c = $this->client();
        self::assertSame(3, $c->revision());
        self::assertSame(Status::STALE, $c->status());
    }

    public function testNewerEngineIsRefused(): void
    {
        $this->edge->setBundle(FakeEdge::bundle(1, null, ['engine' => 2]));
        $c = $this->client();
        self::assertSame('x', $c->stringVariation('accent', 'x'));
        self::assertSame(['engine'], $this->codes());
        self::assertStringContainsString('needs evaluation engine 2', $this->errors[0]->getMessage());
    }

    public function testBootstrapAndOffline(): void
    {
        $text = (string) json_encode(FakeEdge::bundle(5));
        $c = $this->client(['offline' => true, 'bootstrap' => $text, 'cache' => false]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame(Status::READY, $c->status());
        self::assertSame('bootstrap', $c->source());
        self::assertSame([], $this->edge->requests);

        // With the edge down, a bootstrap bundle serves (stale).
        $this->edge->down = true;
        $c = $this->client(['bootstrap' => json_decode($text, true), 'cache' => false]);
        self::assertSame(10, $c->numberVariation('limit', 0));
        self::assertSame(Status::STALE, $c->status());

        $this->client(['bootstrap' => '{"nope":1}', 'offline' => true])->status();
        self::assertContains('invalid_bundle', $this->codes());
    }

    public function testCacheOnlyModeNeverFetches(): void
    {
        $this->client()->boolVariation('new-checkout', false); // e.g. bin/nanoflags-sync filled the cache
        $n = count($this->edge->requests);
        $this->now += 120;
        $c = $this->client(['refresh' => false]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertSame(Status::STALE, $c->status()); // older than the TTL: not known to be current
        self::assertSame($n, count($this->edge->requests));
    }

    public function testEventsUseDefaultRedactionAndAreBufferedBetweenRequests(): void
    {
        $opts = ['events' => ['sampleRate' => 1.0, 'flushInterval' => 10.0], 'random' => fn (): float => 0.0];
        $c = $this->client($opts);
        $c->boolVariation('new-checkout', false, ['key' => 'u1', 'plan' => 'beta', 'email' => 'secret@example.com']);
        $c->stringVariation('region', 'x', ['country' => 'DE', 'email' => 'secret@example.com', 'n' => 3]);
        $c->shutdown();
        self::assertCount(1, $this->edge->events);
        $p = $this->edge->events[0];
        self::assertSame('php-tests', $p['service']);
        self::assertSame('php/' . Client::SDK_VERSION, $p['sdk']);
        self::assertSame(1, $p['revision']);
        self::assertCount(2, $p['events']);
        $e = $p['events'][0];
        self::assertSame(['flagKey' => 'new-checkout', 'value' => true, 'reason' => 'rule_match', 'ruleIndex' => 0, 'revision' => 1], array_intersect_key($e, array_flip(['flagKey', 'value', 'reason', 'ruleIndex', 'revision'])));
        // No attribute values leave the process: only the names the rules use, with the value's type.
        self::assertSame(['plan' => 'string', 'key' => 'string'], $e['context']);
        self::assertSame(['country' => 'string', 'email' => 'string'], $p['events'][1]['context']);
        self::assertStringNotContainsString('secret@example.com', (string) json_encode($this->edge->events));
        self::assertSame(1, $e['sampleRate']);
        self::assertMatchesRegularExpression('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/', $e['at']);

        // The next request within the flush interval buffers in the cache …
        $this->now += 2;
        $c2 = $this->client($opts);
        $c2->stringVariation('accent', 'x');
        $c2->shutdown();
        self::assertCount(1, $this->edge->events);
        // … and a later one sends the buffer with its own events.
        $this->now += 10;
        $c3 = $this->client($opts);
        $c3->stringVariation('accent', 'x', ['key' => 'k']);
        $c3->shutdown();
        self::assertCount(2, $this->edge->events);
        self::assertCount(2, $this->edge->events[1]['events']);
    }

    public function testCustomRedactAndValueLimits(): void
    {
        $flags = FakeEdge::bundle(1)['flags'];
        $flags['long'] = ['type' => 'string', 'enabled' => true, 'default' => str_repeat('€', 2000), 'off' => '', 'rules' => []];
        $flags['big'] = ['type' => 'json', 'enabled' => true, 'default' => ['x' => str_repeat('a', 2000)], 'off' => null, 'rules' => []];
        $this->edge->setBundle(FakeEdge::bundle(1, $flags));
        $c = $this->client(['events' => ['sampleRate' => 1.0, 'redact' => static fn (array $ctx): array => ['plan' => $ctx['plan'] ?? null]], 'random' => fn (): float => 0.0]);
        $c->stringVariation('long', '', ['plan' => 'beta', 'email' => 'x@y.z']);
        $c->jsonVariation('big', null);
        $c->flush();
        $events = $this->edge->events[0]['events'];
        self::assertSame(['plan' => 'beta'], $events[0]['context']);
        self::assertSame(1024, mb_strlen($events[0]['value']));
        self::assertNull($events[1]['value']);
    }

    public function testSamplingAndDisabledEvents(): void
    {
        $c = $this->client(['events' => ['sampleRate' => 0.5], 'random' => fn (): float => 0.7]);
        $c->boolVariation('new-checkout', false);
        $c->flush();
        self::assertSame([], $this->edge->events[0]['events']); // the service report alone
        $c = $this->client(['events' => false]);
        $c->boolVariation('new-checkout', false);
        $c->flush();
        self::assertCount(1, $this->edge->events);
    }

    public function testProductionSignatureVector(): void
    {
        $path = Parity::root() . '/go/internal/testdata/signed-demo-response.json';
        if (!is_file($path)) {
            self::markTestSkipped('signed-demo-response.json not found');
        }
        $v = json_decode((string) file_get_contents($path), true);
        $transport = new class ($v) implements Transport {
            public int $calls = 0;
            public bool $tamper = false;

            public function __construct(private readonly array $v)
            {
            }

            public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
            {
                $this->calls++;
                $text = $this->v['body'];
                if ($this->tamper) {
                    $p = strrpos($text, 'e');
                    $text[$p] = 'E';
                }
                return new Response(200, $this->v['headers'], $text);
            }
        };
        $c = new Client('nf_pub_demo', cache: false, http: $transport, events: false);
        self::assertSame('blue', $c->stringVariation('demo-accent', 'x'));
        self::assertSame(55, $c->revision());
        self::assertSame(Status::READY, $c->status());
        self::assertNull($c->lastError());

        $transport->tamper = true;
        $c = new Client('nf_pub_demo', cache: false, http: $transport, events: false);
        self::assertSame('x', $c->stringVariation('demo-accent', 'x'));
        self::assertSame(NanoFlagsException::SIGNATURE, $c->lastError()?->errorCode);
        self::assertSame(Keys::OFFICIAL_EDGE_URL, 'https://edge.nanoflags.io');
    }

    public function testConfigErrors(): void
    {
        $c = $this->client(['sdkKey' => '', 'verify' => ['publicKeys' => [['kty' => 'OKP', 'crv' => 'Ed25519', 'x' => 'abc', 'd' => 'secret']]]]);
        $c->status();
        self::assertSame(['config', 'config'], array_slice($this->codes(), 0, 2));
    }

    public function testStoreFailuresAreReportedNotThrown(): void
    {
        $broken = new class implements Store {
            public function get(string $key): ?string
            {
                throw new \RuntimeException('down');
            }

            public function set(string $key, string $value, int $ttl = 0): void
            {
                throw new \RuntimeException('down');
            }
        };
        $c = $this->client(['cache' => $broken]);
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        self::assertContains('store', $this->codes());
    }
}
