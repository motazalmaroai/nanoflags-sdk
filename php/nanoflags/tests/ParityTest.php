<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Engine\Engine;
use NanoFlags\Engine\Js;
use NanoFlags\Engine\JsObject;
use PHPUnit\Framework\TestCase;

/**
 * Cross-language parity: the PHP engine must reproduce every result of the TypeScript engine.
 * Fixtures: packages/engine/fixtures/parity.json (shared by every port) and go/internal/testdata/extra.json
 * (JavaScript corner cases, with V8's error messages). Override with NANOFLAGS_PARITY_FIXTURES / NANOFLAGS_EXTRA_FIXTURES.
 */
final class ParityTest extends TestCase
{
    private static ?JsObject $parity = null;

    private static function parity(): JsObject
    {
        if (self::$parity === null) {
            $doc = Parity::load(Parity::parityPath());
            if ($doc === null) {
                self::markTestSkipped('parity fixtures not found at ' . Parity::parityPath());
            }
            self::$parity = $doc;
        }
        return self::$parity;
    }

    public function testFixtureEngineVersionMatches(): void
    {
        $d = self::parity();
        self::assertSame((float) Engine::VERSION, $d->get('engineVersion'));
        self::assertSame($d->get('counts')->get('cases'), (float) count($d->get('cases')));
    }

    public function testEvaluationCases(): void
    {
        [$n, $failures] = Parity::runCases(self::parity(), false);
        self::assertGreaterThan(20000, $n);
        self::assertSame([], $failures, implode("\n", $failures));
    }

    public function testExtraCasesWithErrorMessages(): void
    {
        $doc = Parity::load(Parity::extraPath());
        if ($doc === null) {
            self::markTestSkipped('extra fixtures not found at ' . Parity::extraPath());
        }
        [$n, $failures] = Parity::runCases($doc, true);
        self::assertGreaterThan(3000, $n);
        self::assertSame([], $failures, implode("\n", $failures));
    }

    public function testMurmur3Vectors(): void
    {
        $vectors = self::parity()->get('murmur3');
        self::assertGreaterThan(300, count($vectors));
        foreach ($vectors as $c) {
            self::assertSame((int) $c->get('hash'), Engine::murmur3($c->get('input'), (int) $c->get('seed')), Js::quote($c->get('input')));
        }
    }

    public function testBucketVectors(): void
    {
        foreach (self::parity()->get('buckets') as $c) {
            self::assertSame($c->get('bucket'), Engine::bucketOf($c->get('seed'), $c->get('identity')));
        }
    }

    public function testSupportsEngine(): void
    {
        foreach (self::parity()->get('supportsEngine') as $c) {
            $b = $c->get('bundle');
            self::assertSame($c->get('expected'), Engine::supportsEngine($b->get('engine')), (string) Js::stringify($b));
        }
    }

    public function testClientBundle(): void
    {
        foreach (self::parity()->get('clientBundle') as $c) {
            self::assertSame(Js::stringify($c->get('expected')), Js::stringify(Engine::clientBundle($c->get('bundle'))));
        }
    }
}
