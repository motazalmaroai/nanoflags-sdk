<?php

declare(strict_types=1);

namespace NanoFlags\Tests;

use NanoFlags\Engine\Engine;
use NanoFlags\Engine\Js;
use NanoFlags\Engine\Json;
use NanoFlags\Engine\JsObject;
use NanoFlags\Engine\Result;
use NanoFlags\Engine\Undefined;

/**
 * Runs the cross-language parity fixtures (shared with every NanoFlags engine port): evaluations are compared as
 * canonical JSON text, built the same way from the PHP result and from the TypeScript engine's expected result.
 */
final class Parity
{
    public static function root(): string
    {
        return dirname(__DIR__, 3);
    }

    public static function parityPath(): string
    {
        return getenv('NANOFLAGS_PARITY_FIXTURES') ?: self::root() . '/packages/engine/fixtures/parity.json';
    }

    public static function extraPath(): string
    {
        return getenv('NANOFLAGS_EXTRA_FIXTURES') ?: self::root() . '/go/internal/testdata/extra.json';
    }

    public static function load(string $path): ?JsObject
    {
        if (!is_file($path)) {
            return null;
        }
        $doc = Json::parse((string) file_get_contents($path));
        return $doc instanceof JsObject ? $doc : null;
    }

    private static function js(mixed $v): string
    {
        return Js::stringify($v) ?? 'undefined';
    }

    public static function canonicalResult(Result $r, bool $withTrace, bool $mask): string
    {
        $s = '{"reason":' . Js::quote($r->reason) . ',"revision":' . self::js($r->revision);
        if (!($r->value instanceof Undefined)) {
            $s .= ',"value":' . self::js($r->value);
        }
        if ($r->ruleIndex !== null) {
            $s .= ',"ruleIndex":' . $r->ruleIndex;
            if (!($r->ruleId instanceof Undefined)) {
                $s .= ',"ruleId":' . self::js($r->ruleId);
            }
        }
        if ($r->inRollout !== null) {
            $s .= ',"inRollout":' . ($r->inRollout ? 'true' : 'false');
        }
        if ($r->bucket !== null) {
            $s .= ',"bucket":' . Js::numberToString($r->bucket);
        }
        if ($r->reason === 'error') {
            $s .= ',"error":true';
        }
        if ($withTrace) {
            $steps = [];
            $n = count($r->trace);
            foreach ($r->trace as $i => $t) {
                $detail = $mask && $i === $n - 1 ? '<error>' : $t->detail;
                $x = '{"kind":' . Js::quote($t->kind) . ',"title":' . Js::quote($t->title) . ',"detail":' . Js::quote($detail);
                if ($t->matched !== null) {
                    $x .= ',"matched":' . ($t->matched ? 'true' : 'false');
                }
                $steps[] = $x . '}';
            }
            $s .= ',"trace":[' . implode(',', $steps) . ']';
        }
        return $s . '}';
    }

    public static function canonicalExpected(JsObject $e, bool $mask): string
    {
        $s = '{"reason":' . self::js($e->get('reason')) . ',"revision":' . self::js($e->get('revision'));
        foreach (['value', 'ruleIndex', 'ruleId', 'inRollout', 'bucket', 'error'] as $k) {
            if ($e->has($k)) {
                $s .= ',"' . $k . '":' . self::js($e->get($k));
            }
        }
        if ($e->has('trace')) {
            $steps = [];
            $trace = $e->get('trace');
            $n = count($trace);
            foreach ($trace as $i => $t) {
                $detail = $mask && $i === $n - 1 ? '<error>' : $t->get('detail');
                $x = '{"kind":' . self::js($t->get('kind')) . ',"title":' . self::js($t->get('title')) . ',"detail":' . self::js($detail);
                if ($t->has('matched')) {
                    $x .= ',"matched":' . self::js($t->get('matched'));
                }
                $steps[] = $x . '}';
            }
            $s .= ',"trace":[' . implode(',', $steps) . ']';
        }
        return $s . '}';
    }

    /**
     * Evaluates every case of a fixture document.
     *
     * @return array{int, list<string>} the number of cases and the failures (at most 20 described)
     */
    public static function runCases(JsObject $doc, bool $compareErrorMessages): array
    {
        $bundles = $doc->get('bundles');
        $contexts = $doc->get('contexts');
        $cases = $doc->get('cases');
        $failures = [];
        $failed = 0;
        foreach ($cases as $i => $c) {
            $bi = (int) $c->get('bundle');
            $bundle = $bi >= 0 ? $bundles[$bi] : null;
            $ctx = $contexts[(int) $c->get('context')];
            $expected = $c->get('expected');
            $withTrace = $expected->has('trace');
            $mask = $expected->has('error') && !$compareErrorMessages;
            $got = Engine::evaluate($bundle, $c->get('flag'), $ctx instanceof JsObject ? $ctx : null, $c->get('fallback'));
            $g = self::canonicalResult($got, $withTrace, $mask);
            $w = self::canonicalExpected($expected, $mask);
            if ($compareErrorMessages && $expected->has('errorMessage') && $expected->get('errorMessage') !== $got->error) {
                $g .= ' err=' . Js::quote((string) $got->error);
                $w .= ' err=' . Js::quote((string) $expected->get('errorMessage'));
            }
            if ($g !== $w) {
                $failed++;
                if (count($failures) < 20) {
                    $failures[] = "case $i " . $c->get('name') . "\n got: $g\nwant: $w";
                }
            }
        }
        if ($failed > count($failures)) {
            $failures[] = "… $failed cases differ in total";
        }
        return [count($cases), $failures];
    }
}
