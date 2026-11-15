<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * The JavaScript value semantics the engine depends on.
 *
 * The reference engine is TypeScript: its results depend on truthiness, loose property access, `Number()`,
 * `String()`, `JSON.stringify` and UTF-16 string semantics. This class reproduces exactly those for the value model
 * of this package, so the PHP engine returns the same results as every other NanoFlags engine for the same JSON
 * input (asserted by the shared parity fixtures):
 *
 * - `undefined` is {@see Undefined}, `null` is null, booleans are bool, numbers are float (always),
 * - strings are PHP strings in UTF-8; a lone UTF-16 surrogate (only expressible as a `\u` escape in JSON) is kept in
 *   its three-byte WTF-8 form,
 * - arrays are PHP lists, objects are {@see JsObject}.
 *
 * @internal
 */
final class Js
{
    private const STRING_METHODS = [
        'anchor', 'at', 'big', 'blink', 'bold', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'constructor', 'endsWith',
        'fixed', 'fontcolor', 'fontsize', 'includes', 'indexOf', 'isWellFormed', 'italics', 'lastIndexOf', 'link',
        'localeCompare', 'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll',
        'search', 'slice', 'small', 'split', 'strike', 'sub', 'substr', 'substring', 'sup', 'toLocaleLowerCase',
        'toLocaleUpperCase', 'toLowerCase', 'toString', 'toUpperCase', 'toWellFormed', 'trim', 'trimEnd', 'trimLeft',
        'trimRight', 'trimStart', 'valueOf',
    ];

    private const ARRAY_METHODS = [
        'at', 'concat', 'constructor', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find', 'findIndex',
        'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'keys', 'lastIndexOf',
        'map', 'pop', 'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice',
        'toLocaleString', 'toReversed', 'toSorted', 'toSpliced', 'toString', 'unshift', 'values', 'with',
    ];

    /** Object.prototype members, as `${words[name]}` renders them in describeCondition. */
    public const OBJECT_PROTO_STRINGS = [
        'constructor' => 'function Object() { [native code] }',
        '__defineGetter__' => 'function __defineGetter__() { [native code] }',
        '__defineSetter__' => 'function __defineSetter__() { [native code] }',
        'hasOwnProperty' => 'function hasOwnProperty() { [native code] }',
        '__lookupGetter__' => 'function __lookupGetter__() { [native code] }',
        '__lookupSetter__' => 'function __lookupSetter__() { [native code] }',
        'isPrototypeOf' => 'function isPrototypeOf() { [native code] }',
        'propertyIsEnumerable' => 'function propertyIsEnumerable() { [native code] }',
        'toString' => 'function toString() { [native code] }',
        'valueOf' => 'function valueOf() { [native code] }',
        '__proto__' => '[object Object]',
        'toLocaleString' => 'function toLocaleString() { [native code] }',
    ];

    /** ECMAScript WhiteSpace and LineTerminator code points (String.prototype.trim, StringToNumber). */
    private const WS_CLASS = '\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

    /** @var array<string, true>|null */
    private static ?array $stringMethods = null;
    /** @var array<string, true>|null */
    private static ?array $arrayMethods = null;

    public static function isUndefined(mixed $v): bool
    {
        return $v instanceof Undefined;
    }

    public static function isNullish(mixed $v): bool
    {
        return $v === null || $v instanceof Undefined;
    }

    /** "null", "array", or the JavaScript `typeof` ("undefined", "boolean", "number", "string", "object", "function"). */
    public static function typeName(mixed $v): string
    {
        return match (true) {
            $v instanceof Undefined => 'undefined',
            $v === null => 'null',
            is_bool($v) => 'boolean',
            is_float($v), is_int($v) => 'number',
            is_string($v) => 'string',
            is_array($v) => 'array',
            $v instanceof JsFunction => 'function',
            default => 'object',
        };
    }

    /** ToBoolean. */
    public static function truthy(mixed $v): bool
    {
        if ($v === null || $v === false || $v instanceof Undefined) {
            return false;
        }
        if (is_float($v) || is_int($v)) {
            return $v != 0 && !is_nan((float) $v);
        }
        if (is_string($v)) {
            return $v !== '';
        }
        return true;
    }

    /* ---------------------------------------------------------------- numbers */

    /** Number::toString(x) for radix 10 (shortest round-trip digits), as String(x) produces it. */
    public static function numberToString(float $x): string
    {
        if (is_nan($x)) {
            return 'NaN';
        }
        if ($x == 0.0) {
            return '0';
        }
        if (is_infinite($x)) {
            return $x > 0 ? 'Infinity' : '-Infinity';
        }
        $sign = $x < 0 ? '-' : '';
        $a = abs($x);
        if ($a < 9007199254740992.0 && floor($a) === $a) {
            return $sign . (string) (int) $a;
        }
        // Shortest digit string that round-trips; sprintf rounds correctly, so it is the closest of that length.
        $s = '';
        for ($p = 1; $p <= 17; $p++) {
            $s = sprintf('%.' . ($p - 1) . 'e', $a);
            if ((float) $s === $a) {
                break;
            }
        }
        [$mantissa, $exp] = explode('e', $s);
        $digits = rtrim(str_replace('.', '', $mantissa), '0');
        if ($digits === '') {
            $digits = '0';
        }
        $n = (int) $exp + 1;
        $k = strlen($digits);
        if ($k <= $n && $n <= 21) {
            $out = $digits . str_repeat('0', $n - $k);
        } elseif ($n > 0 && $n <= 21) {
            $out = substr($digits, 0, $n) . '.' . substr($digits, $n);
        } elseif ($n > -6 && $n <= 0) {
            $out = '0.' . str_repeat('0', -$n) . $digits;
        } else {
            $e = $n - 1;
            $es = ($e < 0 ? '-' : '+') . abs($e);
            $out = $k === 1 ? $digits . 'e' . $es : $digits[0] . '.' . substr($digits, 1) . 'e' . $es;
        }
        return $sign . $out;
    }

    /** String.prototype.trim (ECMAScript white space and line terminators). */
    public static function trim(string $s): string
    {
        if (!self::isValidUtf8($s)) {
            return trim($s, " \t\n\r\x0B\x0C");
        }
        return (string) preg_replace('/^[' . self::WS_CLASS . ']+|[' . self::WS_CLASS . ']+$/u', '', $s);
    }

    /** ECMAScript StringToNumber: `Number(s)`. */
    public static function stringToNumber(string $input): float
    {
        $s = self::trim($input);
        if ($s === '') {
            return 0.0;
        }
        if ($s === 'Infinity' || $s === '+Infinity') {
            return INF;
        }
        if ($s === '-Infinity') {
            return -INF;
        }
        if (preg_match('/^0([xXoObB])(.+)$/D', $s, $m) === 1) {
            $base = match (strtolower($m[1])) {
                'x' => 16,
                'o' => 8,
                default => 2,
            };
            $pattern = match ($base) {
                16 => '/^[0-9a-fA-F]+$/D',
                8 => '/^[0-7]+$/D',
                default => '/^[01]+$/D',
            };
            if (preg_match($pattern, $m[2]) !== 1) {
                return NAN;
            }
            return self::radixToFloat($m[2], $base);
        }
        if (preg_match('/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/D', $s) !== 1) {
            return NAN;
        }
        return (float) $s;
    }

    /** The double nearest to the integer written in $digits (base 2, 8 or 16), rounding half to even. */
    private static function radixToFloat(string $digits, int $base): float
    {
        $bitsPer = $base === 16 ? 4 : ($base === 8 ? 3 : 1);
        $bits = '';
        $len = strlen($digits);
        for ($i = 0; $i < $len; $i++) {
            $bits .= str_pad(decbin((int) hexdec($digits[$i])), $bitsPer, '0', STR_PAD_LEFT);
        }
        $bits = ltrim($bits, '0');
        $l = strlen($bits);
        if ($l === 0) {
            return 0.0;
        }
        if ($l <= 53) {
            return (float) bindec($bits);
        }
        if ($l > 1024) {
            return INF;
        }
        $mantissa = bindec(substr($bits, 0, 53));
        $round = $bits[53] === '1';
        $sticky = strpos(substr($bits, 54), '1') !== false;
        if ($round && ($sticky || ($mantissa & 1) === 1)) {
            $mantissa++;
        }
        $r = (float) $mantissa * (2.0 ** ($l - 53));
        return $r;
    }

    /** ToNumber(ToPrimitive(v, number)). */
    public static function toNumber(mixed $v): float
    {
        return match (true) {
            $v instanceof Undefined => NAN,
            $v === null, $v === false => 0.0,
            $v === true => 1.0,
            is_float($v), is_int($v) => (float) $v,
            is_string($v) => self::stringToNumber($v),
            default => self::stringToNumber(self::toStr($v)),
        };
    }

    /* ---------------------------------------------------------------- strings */

    /** String(v). */
    public static function toStr(mixed $v): string
    {
        return match (true) {
            $v instanceof Undefined => 'undefined',
            $v === null => 'null',
            $v === true => 'true',
            $v === false => 'false',
            is_float($v), is_int($v) => self::numberToString((float) $v),
            is_string($v) => $v,
            is_array($v) => self::join($v, ','),
            $v instanceof JsFunction => 'function ' . $v->name . '() { [native code] }',
            default => '[object Object]',
        };
    }

    /** Array.prototype.join. @param list<mixed> $items */
    public static function join(array $items, string $sep): string
    {
        $parts = [];
        foreach ($items as $e) {
            $parts[] = self::isNullish($e) ? '' : self::toStr($e);
        }
        return implode($sep, $parts);
    }

    public static function isValidUtf8(string $s): bool
    {
        return preg_match('//u', $s) === 1;
    }

    /**
     * The code points of a WTF-8 string with their byte width: lone surrogates included, invalid bytes as U+FFFD.
     *
     * @return list<array{int, int}>
     */
    public static function codePoints(string $s): array
    {
        $out = [];
        $n = strlen($s);
        $i = 0;
        while ($i < $n) {
            $c = ord($s[$i]);
            if ($c < 0x80) {
                $out[] = [$c, 1];
                $i++;
                continue;
            }
            $need = $c >= 0xF0 ? 3 : ($c >= 0xE0 ? 2 : ($c >= 0xC2 ? 1 : -1));
            if ($need < 0 || $c > 0xF4 || $i + $need >= $n) {
                $out[] = [0xFFFD, 1];
                $i++;
                continue;
            }
            $cp = $c & (0x3F >> $need);
            $ok = true;
            for ($j = 1; $j <= $need; $j++) {
                $b = ord($s[$i + $j]);
                if (($b & 0xC0) !== 0x80) {
                    $ok = false;
                    break;
                }
                $cp = ($cp << 6) | ($b & 0x3F);
            }
            $min = [0, 0x80, 0x800, 0x10000][$need];
            if (!$ok || $cp < $min || $cp > 0x10FFFF) {
                $out[] = [0xFFFD, 1];
                $i++;
                continue;
            }
            $out[] = [$cp, $need + 1];
            $i += $need + 1;
        }
        return $out;
    }

    /** UTF-16 code units of a WTF-8 string. @return list<int> */
    public static function toUnits(string $s): array
    {
        $units = [];
        foreach (self::codePoints($s) as [$cp]) {
            if ($cp >= 0x10000) {
                $cp -= 0x10000;
                $units[] = 0xD800 + ($cp >> 10);
                $units[] = 0xDC00 + ($cp & 0x3FF);
            } else {
                $units[] = $cp;
            }
        }
        return $units;
    }

    /** One BMP code point (lone surrogates in WTF-8) as a string. */
    public static function encodeUnit(int $u): string
    {
        if ($u < 0x80) {
            return chr($u);
        }
        if ($u < 0x800) {
            return chr(0xC0 | ($u >> 6)) . chr(0x80 | ($u & 0x3F));
        }
        if ($u < 0x10000) {
            return chr(0xE0 | ($u >> 12)) . chr(0x80 | (($u >> 6) & 0x3F)) . chr(0x80 | ($u & 0x3F));
        }
        return chr(0xF0 | ($u >> 18)) . chr(0x80 | (($u >> 12) & 0x3F)) . chr(0x80 | (($u >> 6) & 0x3F)) . chr(0x80 | ($u & 0x3F));
    }

    /** JavaScript's string length (UTF-16 code units). */
    public static function utf16Len(string $s): int
    {
        if (strspn($s, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\x7f") === strlen($s)) {
            return strlen($s);
        }
        if (self::isValidUtf8($s)) {
            return strlen($s) - (int) preg_match_all('/[\x80-\xBF]/', $s) + (int) preg_match_all('/[\xF0-\xF4]/', $s);
        }
        return count(self::toUnits($s));
    }

    /** `s[i]`: the code unit at index i as a one-unit string, or Undefined. */
    public static function utf16At(string $s, int $i): mixed
    {
        $units = self::toUnits($s);
        return $i < count($units) ? self::encodeUnit($units[$i]) : Undefined::value();
    }

    /** String.prototype.includes. */
    public static function includes(string $h, string $n): bool
    {
        if (self::isValidUtf8($h) && self::isValidUtf8($n)) {
            // For well-formed strings a code-unit match always starts and ends on code point boundaries.
            return str_contains($h, $n);
        }
        $hu = self::toUnits($h);
        $nu = self::toUnits($n);
        $hl = count($hu);
        $nl = count($nu);
        for ($i = 0; $i + $nl <= $hl; $i++) {
            if (array_slice($hu, $i, $nl) === $nu) {
                return true;
            }
        }
        return false;
    }

    public static function startsWith(string $h, string $n): bool
    {
        if (self::isValidUtf8($h) && self::isValidUtf8($n)) {
            return str_starts_with($h, $n);
        }
        $hu = self::toUnits($h);
        $nu = self::toUnits($n);
        return count($nu) <= count($hu) && array_slice($hu, 0, count($nu)) === $nu;
    }

    public static function endsWith(string $h, string $n): bool
    {
        if (self::isValidUtf8($h) && self::isValidUtf8($n)) {
            return str_ends_with($h, $n);
        }
        $hu = self::toUnits($h);
        $nu = self::toUnits($n);
        return count($nu) <= count($hu) && array_slice($hu, count($hu) - count($nu)) === $nu;
    }

    /* ---------------------------------------------------------------- JSON.stringify */

    /** JSON.stringify(v), or null where JSON.stringify returns undefined. */
    public static function stringify(mixed $v): ?string
    {
        if ($v instanceof Undefined || $v instanceof JsFunction) {
            return null;
        }
        return self::writeJson($v);
    }

    private static function writeJson(mixed $v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_float($v) || is_int($v)) {
            $f = (float) $v;
            return is_nan($f) || is_infinite($f) ? 'null' : self::numberToString($f);
        }
        if (is_string($v)) {
            return self::quote($v);
        }
        if (is_array($v)) {
            $parts = [];
            foreach ($v as $e) {
                $parts[] = ($e instanceof Undefined || $e instanceof JsFunction) ? 'null' : self::writeJson($e);
            }
            return '[' . implode(',', $parts) . ']';
        }
        if ($v instanceof JsObject) {
            $parts = [];
            foreach ($v->members() as $k => $e) {
                if ($e instanceof Undefined || $e instanceof JsFunction) {
                    continue;
                }
                $parts[] = self::quote((string) $k) . ':' . self::writeJson($e);
            }
            return '{' . implode(',', $parts) . '}';
        }
        return 'null';
    }

    /** JSON.stringify of a string (well-formed JSON.stringify: lone surrogates are escaped). */
    public static function quote(string $s): string
    {
        if (preg_match('/["\\\\\x00-\x1F]|\xED[\xA0-\xBF]/', $s) !== 1) {
            return '"' . $s . '"';
        }
        return '"' . preg_replace_callback('/["\\\\\x00-\x1F]|\xED[\xA0-\xBF][\x80-\xBF]/', static function (array $m): string {
            $c = $m[0];
            switch ($c) {
                case '"':
                    return '\\"';
                case '\\':
                    return '\\\\';
                case "\x08":
                    return '\\b';
                case "\x0C":
                    return '\\f';
                case "\n":
                    return '\\n';
                case "\r":
                    return '\\r';
                case "\t":
                    return '\\t';
            }
            if (strlen($c) === 1) {
                return sprintf('\\u%04x', ord($c));
            }
            $u = ((ord($c[0]) & 0x0F) << 12) | ((ord($c[1]) & 0x3F) << 6) | (ord($c[2]) & 0x3F);
            return sprintf('\\u%04x', $u);
        }, $s) . '"';
    }

    /* ---------------------------------------------------------------- property access */

    /**
     * The property read `v[name]` for the fixed property names the engine reads. Plain objects only expose own
     * properties here: none of those names exist on Object.prototype.
     *
     * @throws JsTypeError for null and undefined, like JavaScript
     */
    public static function get(mixed $v, string $name): mixed
    {
        if ($v === null || $v instanceof Undefined) {
            throw new JsTypeError(sprintf("Cannot read properties of %s (reading '%s')", self::toStr($v), $name));
        }
        if ($v instanceof JsObject) {
            return $v->get($name);
        }
        if (is_string($v)) {
            if ($name === 'length') {
                return (float) self::utf16Len($v);
            }
            $n = JsObject::arrayIndex($name);
            if ($n >= 0) {
                return self::utf16At($v, $n);
            }
            self::$stringMethods ??= array_fill_keys(self::STRING_METHODS, true);
            if (isset(self::$stringMethods[$name])) {
                return new JsFunction($name);
            }
            return Undefined::value();
        }
        if (is_array($v)) {
            if ($name === 'length') {
                return (float) count($v);
            }
            $n = JsObject::arrayIndex($name);
            if ($n >= 0) {
                return array_key_exists($n, $v) ? $v[$n] : Undefined::value();
            }
            self::$arrayMethods ??= array_fill_keys(self::ARRAY_METHODS, true);
            if (isset(self::$arrayMethods[$name])) {
                return new JsFunction($name);
            }
        }
        return Undefined::value();
    }

    /** The engine's `own(obj, key)`: an own-property lookup that never reads inherited members. */
    public static function own(mixed $obj, string $key): mixed
    {
        if ($obj instanceof JsObject) {
            return $obj->get($key);
        }
        if ((is_array($obj) || is_string($obj)) && ($key === 'length' || JsObject::arrayIndex($key) >= 0)) {
            return self::get($obj, $key);
        }
        return Undefined::value();
    }

    /* ---------------------------------------------------------------- conversion */

    /**
     * Converts PHP data to an engine value: null, bool, int and float (as float), string, lists (arrays), associative
     * arrays and stdClass (objects), JsObject / Undefined (as they are), backed enums (their value), unit enums (their
     * name), DateTimeInterface (ISO 8601 in UTC, as `Date.toJSON()`), JsonSerializable (its data) and Stringable (its
     * string). Anything else becomes null.
     */
    public static function fromPhp(mixed $x, int $depth = 0): mixed
    {
        if ($x === null || is_bool($x) || is_string($x) || is_float($x) || $x instanceof Undefined || $x instanceof JsObject) {
            return $x;
        }
        if (is_int($x)) {
            return (float) $x;
        }
        if ($depth > 32) {
            return null;
        }
        if (is_array($x)) {
            if (array_is_list($x)) {
                return array_map(static fn ($e) => self::fromPhp($e, $depth + 1), $x);
            }
            $m = [];
            foreach ($x as $k => $e) {
                $m[(string) $k] = self::fromPhp($e, $depth + 1);
            }
            return new JsObject($m);
        }
        if ($x instanceof \BackedEnum) {
            return self::fromPhp($x->value, $depth + 1);
        }
        if ($x instanceof \UnitEnum) {
            return $x->name;
        }
        if ($x instanceof \DateTimeInterface) {
            return \DateTimeImmutable::createFromInterface($x)->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
        }
        if ($x instanceof \JsonSerializable) {
            return self::fromPhp($x->jsonSerialize(), $depth + 1);
        }
        if ($x instanceof \stdClass) {
            $m = [];
            foreach (get_object_vars($x) as $k => $e) {
                $m[(string) $k] = self::fromPhp($e, $depth + 1);
            }
            return new JsObject($m);
        }
        if ($x instanceof \Stringable) {
            return (string) $x;
        }
        return null;
    }

    /**
     * Converts an engine value to plain PHP data: null (also for undefined), bool, int (whole numbers up to 2^53) or
     * float, string, lists and associative arrays (in configuration order).
     */
    public static function toPhp(mixed $v): mixed
    {
        if (is_float($v)) {
            return (floor($v) === $v && abs($v) <= 9007199254740992.0) ? (int) $v : $v;
        }
        if (is_array($v)) {
            return array_map([self::class, 'toPhp'], $v);
        }
        if ($v instanceof JsObject) {
            $out = [];
            foreach ($v->members() as $k => $e) {
                if ($e instanceof Undefined || $e instanceof JsFunction) {
                    continue;
                }
                $out[$k] = self::toPhp($e);
            }
            return $out;
        }
        if ($v instanceof Undefined || $v instanceof JsFunction) {
            return null;
        }
        return $v;
    }
}
