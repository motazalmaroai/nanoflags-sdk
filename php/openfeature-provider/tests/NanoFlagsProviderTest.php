<?php

declare(strict_types=1);

namespace NanoFlags\OpenFeature\Tests;

use NanoFlags\Client;
use NanoFlags\Http\Response;
use NanoFlags\Http\Transport;
use NanoFlags\OpenFeature\NanoFlagsProvider;
use NanoFlags\Store\MemoryStore;
use OpenFeature\implementation\flags\Attributes;
use OpenFeature\implementation\flags\EvaluationContext;
use OpenFeature\interfaces\provider\ErrorCode;
use OpenFeature\interfaces\provider\Reason;
use OpenFeature\OpenFeatureAPI;
use PHPUnit\Framework\TestCase;

final class NanoFlagsProviderTest extends TestCase
{
    private static function bundle(): string
    {
        return (string) json_encode(['schema' => 1, 'engine' => 1, 'project' => 'p', 'environment' => 't', 'revision' => 3, 'segments' => new \stdClass(), 'flags' => [
            'new-checkout' => ['type' => 'boolean', 'enabled' => true, 'default' => false, 'off' => false, 'rules' => [
                ['id' => 'beta', 'match' => 'all', 'conditions' => [['attribute' => 'plan', 'op' => 'eq', 'value' => 'beta']], 'serve' => ['type' => 'fixed', 'value' => true]],
                ['id' => 'half', 'match' => 'all', 'conditions' => [], 'serve' => ['type' => 'rollout', 'percentage' => 50, 'value' => true, 'otherwise' => false]],
            ]],
            'accent' => ['type' => 'string', 'enabled' => true, 'default' => 'blue', 'off' => 'grey', 'rules' => []],
            'limit' => ['type' => 'number', 'enabled' => true, 'default' => 10, 'off' => 0, 'rules' => []],
            'ratio' => ['type' => 'number', 'enabled' => true, 'default' => 0.5, 'off' => 0, 'rules' => []],
            'layout' => ['type' => 'json', 'enabled' => true, 'default' => ['cols' => 3], 'off' => null, 'rules' => []],
            'disabled' => ['type' => 'string', 'enabled' => false, 'default' => 'on', 'off' => 'off', 'rules' => []],
        ]]);
    }

    private static function client(bool $loaded = true): Client
    {
        $edge = new class ($loaded) implements Transport {
            public function __construct(private readonly bool $loaded)
            {
            }

            public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
            {
                if (!$this->loaded) {
                    throw new \RuntimeException('down');
                }
                return new Response(200, ['etag' => '"x"'], '{"revision":3,"checksum":"x","bundle":' . NanoFlagsProviderTest::bundleText() . '}');
            }
        };
        return new Client('nf_srv_test', baseUrl: 'https://flags.test', cache: new MemoryStore(), http: $edge, verify: false, events: false);
    }

    public static function bundleText(): string
    {
        return self::bundle();
    }

    public function testContextMapping(): void
    {
        $ctx = new EvaluationContext('user-1', new Attributes(['key' => 'ignored', 'plan' => 'beta', 'n' => 3, 'tags' => ['a', 'b']]));
        self::assertEqualsCanonicalizing(['plan' => 'beta', 'n' => 3, 'tags' => ['a', 'b'], 'key' => 'user-1'], NanoFlagsProvider::toNanoFlagsContext($ctx));
        self::assertSame([], NanoFlagsProvider::toNanoFlagsContext(null));
    }

    public function testResolutionThroughTheOpenFeatureClient(): void
    {
        $api = OpenFeatureAPI::getInstance();
        $api->setProvider(new NanoFlagsProvider(self::client()));
        self::assertSame('NanoFlags', $api->getProviderMetadata()->getName());
        $of = $api->getClient('tests');

        $d = $of->getBooleanDetails('new-checkout', false, new EvaluationContext('u1', new Attributes(['plan' => 'beta'])));
        self::assertTrue($d->getValue());
        self::assertSame(Reason::TARGETING_MATCH, $d->getReason());
        self::assertSame('beta', $d->getVariant());

        $d = $of->getBooleanDetails('new-checkout', false, new EvaluationContext('u1'));
        self::assertSame(Reason::SPLIT, $d->getReason());
        self::assertSame('half', $d->getVariant());

        self::assertSame(Reason::DEFAULT, $of->getStringDetails('accent', 'x')->getReason());
        self::assertSame(Reason::DISABLED, $of->getStringDetails('disabled', 'x')->getReason());
        self::assertSame('off', $of->getStringValue('disabled', 'x'));
        self::assertSame(10, $of->getIntegerValue('limit', 0));
        self::assertSame(10.0, $of->getFloatValue('limit', 0.0)); // whole numbers are fine for the float accessor
        self::assertSame(0.5, $of->getFloatValue('ratio', 0.0));
        self::assertSame(['cols' => 3], $of->getObjectValue('layout', []));

        $d = $of->getIntegerDetails('ratio', 1);
        self::assertSame(1, $d->getValue());
        self::assertEquals(ErrorCode::TYPE_MISMATCH(), $d->getError()?->getResolutionErrorCode());

        $d = $of->getBooleanDetails('accent', true);
        self::assertTrue($d->getValue());
        self::assertEquals(ErrorCode::TYPE_MISMATCH(), $d->getError()?->getResolutionErrorCode());

        $d = $of->getStringDetails('missing', 'fb');
        self::assertSame('fb', $d->getValue());
        self::assertEquals(ErrorCode::FLAG_NOT_FOUND(), $d->getError()?->getResolutionErrorCode());
    }

    public function testTestSessionsThroughTheEvaluator(): void
    {
        $edge = new class () implements Transport {
            public function send(string $method, string $url, array $headers, ?string $body, float $timeout): Response
            {
                if (str_ends_with($url, '/v1/session')) {
                    if (($headers['X-NanoFlags-Session'] ?? null) !== 'nf_ts_of') {
                        return new Response(404, [], '{}');
                    }
                    $pinned = str_replace('"default":"blue"', '"default":"session"', NanoFlagsProviderTest::bundleText());
                    return new Response(200, [], '{"id":"s1","context":{"plan":"beta"},"expires_at":"2999-01-01T00:00:00Z","bundle":' . $pinned . '}');
                }
                return new Response(200, ['etag' => '"x"'], '{"revision":3,"checksum":"x","bundle":' . NanoFlagsProviderTest::bundleText() . '}');
            }
        };
        $flags = new Client('nf_srv_test', baseUrl: 'https://flags.test', cache: new MemoryStore(), http: $edge, verify: false, events: false);
        $token = null;
        $p = new NanoFlagsProvider($flags, function () use ($flags, &$token) {
            return $flags->session($token);
        });
        self::assertSame('blue', $p->resolveStringValue('accent', 'x')->getValue());
        $token = 'nf_ts_of';
        self::assertSame('session', $p->resolveStringValue('accent', 'x')->getValue());
        $d = $p->resolveBooleanValue('new-checkout', false, new EvaluationContext('u1'));
        self::assertTrue($d->getValue()); // the session context (plan: beta) applies
        self::assertSame(Reason::TARGETING_MATCH, $d->getReason());
    }

    public function testProviderNotReady(): void
    {
        $p = new NanoFlagsProvider(self::client(false));
        $d = $p->resolveStringValue('accent', 'fb');
        self::assertSame('fb', $d->getValue());
        self::assertEquals(ErrorCode::PROVIDER_NOT_READY(), $d->getError()?->getResolutionErrorCode());
    }
}
