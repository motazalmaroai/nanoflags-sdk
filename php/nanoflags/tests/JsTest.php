<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Engine\Js;
use NanoFlags\Engine\Json;
use NanoFlags\Engine\JsObject;
use NanoFlags\Engine\Undefined;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class JsTest extends TestCase
{
    /** @return list<array{float, string}> */
    public static function numbers(): array
    {
        return [
            [0.0, '0'], [-0.0, '0'], [1.0, '1'], [-1.5, '-1.5'], [0.1, '0.1'], [0.1 + 0.2, '0.30000000000000004'],
            [1e21, '1e+21'], [1e20, '100000000000000000000'], [123456789012345680000.0, '123456789012345680000'],
            [1e-7, '1e-7'], [0.000001, '0.000001'], [1.5e-10, '1.5e-10'], [2.0 ** 60, '1152921504606847000'],
            [5e-324, '5e-324'], [1.7976931348623157e308, '1.7976931348623157e+308'], [INF, 'Infinity'], [NAN, 'NaN'],
            [12.34, '12.34'], [100.0, '100'],
        ];
    }

    #[DataProvider('numbers')]
    public function testNumberToString(float $x, string $want): void
    {
        self::assertSame($want, Js::numberToString($x));
    }

    public function testStringToNumber(): void
    {
        self::assertSame(0.0, Js::stringToNumber('  '));
        self::assertSame(255.0, Js::stringToNumber('0xff'));
        self::assertSame(8.0, Js::stringToNumber('0o10'));
        self::assertSame(5.0, Js::stringToNumber("\u{00A0}5\u{FEFF}"));
        self::assertSame(0.5, Js::stringToNumber('.5'));
        self::assertSame(5.0, Js::stringToNumber('5.'));
        self::assertSame(INF, Js::stringToNumber('-Infinity') * -1);
        self::assertNan(Js::stringToNumber('1_000'));
        self::assertNan(Js::stringToNumber('0x'));
        self::assertNan(Js::stringToNumber('infinity'));
        self::assertSame(18446744073709551616.0, Js::stringToNumber('0x10000000000000000'));
        self::assertSame(9007199254740992.0, Js::stringToNumber('0x20000000000001')); // ties to even
    }

    public function testJsonRoundTripKeepsJavaScriptSemantics(): void
    {
        $v = Json::parse('{"b":1,"2":true,"a":[],"1":{},"b":2,"s":"\ud800x\u0001"}');
        self::assertInstanceOf(JsObject::class, $v);
        self::assertSame(['1', '2', 'b', 'a', 's'], $v->keys());
        self::assertSame('{"1":{},"2":true,"b":2,"a":[],"s":"\ud800x\u0001"}', Js::stringify($v));
        self::assertSame(2, Js::utf16Len("\u{1F600}"));
        self::assertSame(2.0, Js::get("\u{1F600}", 'length'));
        self::assertInstanceOf(Undefined::class, Js::get(new JsObject([]), 'x'));
    }

    public function testFromPhpAndToPhp(): void
    {
        $d = new \DateTimeImmutable('2026-01-02T03:04:05.678+02:00');
        $v = Js::fromPhp(['n' => 3, 'list' => [1, 'a'], 'when' => $d, 'empty' => []]);
        self::assertSame('{"n":3,"list":[1,"a"],"when":"2026-01-02T01:04:05.678Z","empty":[]}', Js::stringify($v));
        self::assertSame(['n' => 3, 'list' => [1, 'a'], 'when' => '2026-01-02T01:04:05.678Z', 'empty' => []], Js::toPhp($v));
        self::assertSame(1.5, Js::toPhp(1.5));
    }
}
