<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * `JSON.parse` / `JSON.stringify` with JavaScript semantics for the engine's value model ({@see Js}): numbers become
 * floats (overflow becomes ±INF), objects become {@see JsObject} in JavaScript key order, a repeated key keeps its first
 * position and its last value, and lone UTF-16 surrogates survive as WTF-8.
 */
final class Json
{
    /**
     * Parses JSON text exactly like JavaScript's `JSON.parse`.
     *
     * @throws InvalidJsonException
     */
    public static function parse(string $text): mixed
    {
        // Fast path: ext/json, then the result is converted. Lone surrogates, invalid UTF-8 and property names that
        // PHP objects cannot hold make json_decode fail; the exact parser below handles those.
        try {
            $decoded = json_decode($text, false, 100000, JSON_THROW_ON_ERROR);
            return self::convert($decoded);
        } catch (\JsonException) {
            return (new JsonParser($text))->parseDocument();
        }
    }

    private static function convert(mixed $v): mixed
    {
        if (is_int($v)) {
            return (float) $v;
        }
        if (is_array($v)) {
            foreach ($v as $i => $e) {
                if (!is_scalar($e) || is_int($e)) {
                    $v[$i] = self::convert($e);
                }
            }
            return $v;
        }
        if ($v instanceof \stdClass) {
            $m = get_object_vars($v);
            foreach ($m as $k => $e) {
                if (!is_scalar($e) || is_int($e)) {
                    $m[$k] = self::convert($e);
                }
            }
            return new JsObject($m);
        }
        return $v;
    }

    /** JSON.stringify(v), or null where JSON.stringify returns undefined. */
    public static function stringify(mixed $v): ?string
    {
        return Js::stringify($v);
    }
}
