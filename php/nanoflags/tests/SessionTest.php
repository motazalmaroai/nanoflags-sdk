<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Client;
use NanoFlags\NanoFlagsException;
use NanoFlags\Reason;
use NanoFlags\SessionMiddleware;
use NanoFlags\Store\MemoryStore;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

/** Test sessions (x-nanoflags-session): Client::session, the shared cache, telemetry and the PSR-15 middleware. */
final class SessionTest extends TestCase
{
    private const SID = '8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11';

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
        $pinned = FakeEdge::bundle(9, [
            'accent' => ['type' => 'string', 'enabled' => true, 'default' => 'session', 'off' => 'x', 'rules' => [
                ['id' => 'r', 'match' => 'all', 'conditions' => [['attribute' => 'plan', 'op' => 'eq', 'value' => 'pro']], 'serve' => ['type' => 'fixed', 'value' => 'session-pro']],
            ]],
        ]);
        $this->edge->sessions['nf_ts_abc'] = ['id' => self::SID, 'checksum' => 'c', 'source' => 'draft', 'revision' => 9, 'context' => ['plan' => 'pro'], 'expires_at' => '2027-02-01T00:00:00Z', 'bundle' => $pinned];
    }

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

    /** @return list<array{method: string, path: string, headers: array<string, string>}> */
    private function sessionRequests(): array
    {
        return array_values(array_filter($this->edge->requests, static fn ($r) => $r['path'] === '/v1/session'));
    }

    public function testSessionOverrideAndContextMerge(): void
    {
        $c = $this->client();
        $s = $c->session('nf_ts_abc');
        self::assertTrue($s->isActive());
        self::assertSame([self::SID, '2027-02-01T00:00:00.000Z', 9], [$s->id(), $s->expiresAt(), $s->revision()]);
        self::assertSame('session-pro', $s->stringVariation('accent', 'x'));
        self::assertSame('session', $s->stringVariation('accent', 'x', ['plan' => 'free'])); // the request's context wins
        self::assertSame(Reason::RULE_MATCH, $s->stringVariationDetail('accent', 'x')->reason);
        self::assertSame('fb', $s->stringVariation('new-checkout', 'fb')); // not in the snapshot
        self::assertSame(['x-nanoflags-session' => 'nf_ts_abc'], $s->headers());
        self::assertSame('blue', $c->stringVariation('accent', 'x')); // the client itself is unaffected
        self::assertSame(1, $c->revision());

        $req = $this->sessionRequests()[0];
        self::assertSame(['nf_ts_abc', 'php-tests', 'Bearer nf_srv_test'], [$req['headers']['X-NanoFlags-Session'], $req['headers']['X-NanoFlags-Service'], $req['headers']['Authorization']]);
        self::assertTrue($c->session('nf_ts_abc')->isActive());
        self::assertCount(1, $this->sessionRequests()); // cached in the client
        $c->session('nf_ts_abc', 'billing');
        self::assertSame('billing', $this->sessionRequests()[1]['headers']['X-NanoFlags-Service']); // per token and service
        self::assertSame([], $this->errors);
    }

    public function testSharedCacheKeepsSessionsApartFromTheBundle(): void
    {
        $this->client()->session('nf_ts_abc');
        $bundleEntry = $this->store->get('nanoflags.bundle.' . $this->clientId());
        // A new request (a new client) reuses the session from the shared cache: no second lookup.
        $c = $this->client();
        $s = $c->session('nf_ts_abc');
        self::assertTrue($s->isActive());
        self::assertSame('session-pro', $s->stringVariation('accent', 'x'));
        self::assertCount(1, $this->sessionRequests());
        // The bundle entry is untouched and still the published configuration; nothing stores the raw token.
        self::assertSame($bundleEntry, $this->store->get('nanoflags.bundle.' . $this->clientId()));
        self::assertSame(1, $c->revision());
        self::assertSame('blue', $c->stringVariation('accent', 'x'));
        $items = (fn () => $this->items)->call($this->store);
        $keys = array_keys($items);
        self::assertCount(1, array_filter($keys, static fn ($k) => str_starts_with($k, 'nanoflags.session.')));
        foreach ($items as $k => [$v]) {
            self::assertStringNotContainsString('nf_ts_abc', $k . $v);
        }
        // Unknown tokens are never written to the shared cache.
        $c->session('nf_ts_random1');
        $c->session('nf_ts_random2');
        self::assertSame($keys, array_keys((fn () => $this->items)->call($this->store)));
        // Another service is another entry.
        $this->client()->session('nf_ts_abc', 'billing');
        self::assertCount(4, $this->sessionRequests()); // the first lookup, two unknown tokens, the other service
        self::assertSame('billing', end($this->edge->requests)['headers']['X-NanoFlags-Service']);
    }

    public function testUnknownMalformedAndMissingTokens(): void
    {
        $c = $this->client();
        $none = $c->session('nf_ts_unknown');
        self::assertFalse($none->isActive());
        self::assertNull($none->id());
        self::assertNull($none->expiresAt());
        self::assertSame(1, $none->revision());
        self::assertSame('blue', $none->stringVariation('accent', 'x'));
        self::assertSame(['x-nanoflags-session' => 'nf_ts_unknown'], $none->headers()); // still propagated
        $c->session('nf_ts_unknown');
        self::assertCount(1, $this->sessionRequests()); // remembered for 15 s
        $this->now += 16;
        $c->session('nf_ts_unknown');
        self::assertCount(2, $this->sessionRequests());
        foreach ([null, '', 'has space', str_repeat('x', 513), "nf\n"] as $bad) {
            $e = $c->session($bad);
            self::assertFalse($e->isActive());
            self::assertSame([], $e->headers());
        }
        self::assertCount(2, $this->sessionRequests());
        self::assertSame([], $this->errors); // "no such session" is not an error
    }

    public function testFailuresExpiryAndOffline(): void
    {
        $this->edge->sessions['nf_ts_old'] = ['expires_at' => '2001-01-01T00:00:00Z'] + $this->edge->sessions['nf_ts_abc'];
        $this->edge->sessions['nf_ts_err'] = 500;
        $this->edge->sessions['nf_ts_401'] = 401;
        $this->edge->sessions['nf_ts_bad'] = ['id' => 1];
        $c = $this->client();
        self::assertFalse($c->session('nf_ts_old')->isActive());
        self::assertSame([], $this->errors);
        self::assertFalse($c->session('nf_ts_err')->isActive());
        self::assertFalse($c->session('nf_ts_bad')->isActive());
        self::assertFalse($c->session('nf_ts_401')->isActive());
        self::assertSame(['session', 'session', 'unauthorized'], array_map(static fn ($e) => $e->errorCode, $this->errors));
        self::assertSame(['Session request failed with HTTP 500.', 'The edge returned an invalid session.'], [$this->errors[0]->getMessage(), $this->errors[1]->getMessage()]);
        $n = count($this->sessionRequests());
        $c->session('nf_ts_err');
        self::assertCount($n, $this->sessionRequests()); // failures are remembered for 3 s
        $this->now += 4;
        $c->session('nf_ts_err');
        self::assertCount($n + 1, $this->sessionRequests());

        $this->edge->down = true;
        self::assertFalse($c->session('nf_ts_new')->isActive());
        self::assertStringStartsWith('Could not load the test session', end($this->errors)->getMessage());

        $this->edge->down = false;
        $offline = $this->client(['offline' => true, 'bootstrap' => FakeEdge::bundle(1)]);
        self::assertFalse($offline->session('nf_ts_abc')->isActive());
    }

    public function testExpiryMidFlightFallsBackToThePublishedConfiguration(): void
    {
        $c = $this->client();
        $s = $c->session('nf_ts_abc');
        self::assertTrue($s->isActive());
        $this->now = 1_800_000_000.0 + 86400 * 365 * 10; // long after 2027-02-01
        self::assertFalse($s->isActive());
        self::assertSame(['blue', 1], [$s->stringVariation('accent', 'x'), $s->revision()]);
        self::assertFalse($c->session('nf_ts_abc')->isActive()); // refetched, now expired
    }

    public function testSampledEventsCarryTheSessionId(): void
    {
        $c = $this->client(['events' => ['sampleRate' => 1.0], 'random' => fn (): float => 0.0]);
        $c->session('nf_ts_abc')->stringVariation('accent', 'x');
        $c->stringVariation('accent', 'x');
        $c->flush();
        $events = end($this->edge->events)['events'];
        self::assertSame([self::SID, null], array_map(static fn ($e) => $e['sessionId'] ?? null, $events));
        self::assertSame(['plan' => 'string'], $events[0]['context']); // default redaction over the merged context
        self::assertSame(9, $events[0]['revision']);
        self::assertSame(['flagKey', 'value', 'reason', 'ruleIndex', 'revision', 'context', 'at', 'sessionId', 'sampleRate'], array_keys($events[0]));
    }

    public function testSessionFromGlobals(): void
    {
        $c = $this->client();
        $_SERVER['HTTP_X_NANOFLAGS_SESSION'] = ' nf_ts_abc ';
        try {
            self::assertTrue($c->sessionFromGlobals()->isActive());
        } finally {
            unset($_SERVER['HTTP_X_NANOFLAGS_SESSION']);
        }
        self::assertFalse($c->sessionFromGlobals()->isActive());
    }

    public function testPsr15Middleware(): void
    {
        $c = $this->client();
        $seen = [];
        $response = $this->createMock(ResponseInterface::class);
        $handler = new class ($seen, $response) implements RequestHandlerInterface {
            /** @param list<ServerRequestInterface> $seen */
            public function __construct(private array &$seen, private ResponseInterface $response)
            {
            }

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->seen[] = $request;
                return $this->response;
            }
        };
        foreach ([' nf_ts_abc ', ''] as $header) {
            $request = $this->createMock(ServerRequestInterface::class);
            $request->method('getHeaderLine')->with('x-nanoflags-session')->willReturn($header);
            $with = $this->createMock(ServerRequestInterface::class);
            $request->expects(self::once())->method('withAttribute')->with(SessionMiddleware::ATTRIBUTE, self::anything())
                ->willReturnCallback(function (string $name, mixed $value) use ($with) {
                    $with->method('getAttribute')->willReturn($value);
                    return $with;
                });
            (new SessionMiddleware($c, 'web'))->process($request, $handler);
        }
        $active = $seen[0]->getAttribute(SessionMiddleware::ATTRIBUTE);
        $plain = $seen[1]->getAttribute(SessionMiddleware::ATTRIBUTE);
        self::assertTrue($active->isActive());
        self::assertSame('session-pro', $active->stringVariation('accent', 'x'));
        self::assertSame(['x-nanoflags-session' => 'nf_ts_abc'], $active->headers());
        self::assertFalse($plain->isActive());
        self::assertSame('blue', $plain->stringVariation('accent', 'x'));
        self::assertSame('web', $this->sessionRequests()[0]['headers']['X-NanoFlags-Service']);
    }

    private function clientId(): string
    {
        return sprintf('%08x', \NanoFlags\Engine\Engine::murmur3(FakeEdge::BASE . '|nf_srv_test'));
    }
}
