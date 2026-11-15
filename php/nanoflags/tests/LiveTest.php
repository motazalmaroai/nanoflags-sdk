<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Client;
use NanoFlags\Status;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/**
 * Opt-in check against the hosted edge (read-only): NANOFLAGS_LIVE=1 vendor/bin/phpunit --group live
 * Uses NANOFLAGS_SDK_KEY, or the PUBLIC demo browser key (client view of the public demo environment; not a secret).
 */
#[Group('live')]
final class LiveTest extends TestCase
{
    public function testHostedEdgeServesAVerifiedBundle(): void
    {
        if (getenv('NANOFLAGS_LIVE') !== '1') {
            self::markTestSkipped('set NANOFLAGS_LIVE=1');
        }
        $key = getenv('NANOFLAGS_SDK_KEY') ?: 'nf_pub_4ced72c484c4f388a900aeeaf81e130c110c11730d555dd8';
        $c = new Client($key, service: 'php-sdk-ci', cache: false, events: false, timeout: 10.0);
        self::assertSame(Status::READY, $c->status(), (string) $c->lastError()?->getMessage());
        self::assertNull($c->lastError());
        self::assertGreaterThan(0, $c->revision());
        self::assertIsArray($c->allFlags(['key' => 'ci']));
        self::assertStringContainsString('"flags"', (string) $c->bundleJson());
    }
}
