<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * The NanoFlags evaluation engine: a port of the TypeScript engine (`@nanoflags/engine`) that the dashboard, the edge
 * and every SDK share.
 *
 * Pure and deterministic: the same bundle, flag key and context always produce the same result, including the bucket
 * of percentage rollouts (MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of "seed:identity"). Rules are
 * data; no user code ever runs. Configuration is JSON evaluated with JavaScript semantics ({@see Js}); the
 * cross-language parity fixtures (packages/engine/fixtures/parity.json) pin the behaviour, malformed configurations
 * included.
 */
final class Engine
{
    /** The engine version implemented here (`ENGINE_VERSION` of the TypeScript engine). Newer bundles are refused. */
    public const VERSION = 1;

    private const OP_WORDS = [
        'eq' => '=', 'neq' => '≠', 'in' => 'in', 'not_in' => 'not in', 'contains' => 'contains',
        'starts_with' => 'starts with', 'ends_with' => 'ends with', 'gt' => '>', 'gte' => '≥', 'lt' => '<', 'lte' => '≤',
        'exists' => 'exists', 'not_exists' => 'does not exist', 'segment' => 'in segment', 'not_segment' => 'not in segment',
    ];

    /* ---------------------------------------------------------------- hashing */

    /** `TextEncoder.encode(input.normalize("NFC"))`: lone surrogates and invalid bytes become U+FFFD. */
    public static function hashInput(string $s): string
    {
        if (strspn($s, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\x7f") === strlen($s)) {
            return $s;
        }
        if (Js::isValidUtf8($s)) {
            return self::nfc($s);
        }
        $out = '';
        $run = '';
        foreach (Js::codePoints($s) as [$cp, $size]) {
            if (($cp >= 0xD800 && $cp <= 0xDFFF) || ($cp === 0xFFFD && $size === 1)) {
                $out .= self::nfc($run) . "\u{FFFD}";
                $run = '';
                continue;
            }
            $run .= Js::encodeUnit($cp);
        }
        return $out . self::nfc($run);
    }

    private static function nfc(string $s): string
    {
        if ($s === '') {
            return '';
        }
        $n = \Normalizer::normalize($s, \Normalizer::FORM_C);
        return is_string($n) ? $n : $s;
    }

    /** 32-bit multiplication modulo 2^32 without overflowing PHP's 64-bit integers. */
    private static function mul32(int $a, int $b): int
    {
        return ((($a & 0xFFFF) * $b) + (((($a >> 16) * $b) & 0xFFFF) << 16)) & 0xFFFFFFFF;
    }

    /** MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of $input (unsigned). Distribution only. */
    public static function murmur3(string $input, int $seed = 0): int
    {
        $data = self::hashInput($input);
        $c1 = 0xCC9E2D51;
        $c2 = 0x1B873593;
        $h = $seed & 0xFFFFFFFF;
        $n = strlen($data);
        $blocks = $n >> 2;
        $words = $blocks > 0 ? unpack('V*', substr($data, 0, $blocks * 4)) : [];
        foreach ($words as $k) {
            $k = self::mul32($k, $c1);
            $k = (($k << 15) | ($k >> 17)) & 0xFFFFFFFF;
            $k = self::mul32($k, $c2);
            $h ^= $k;
            $h = (($h << 13) | ($h >> 19)) & 0xFFFFFFFF;
            $h = (self::mul32($h, 5) + 0xE6546B64) & 0xFFFFFFFF;
        }
        $k = 0;
        $tail = $blocks * 4;
        $rem = $n & 3;
        if ($rem >= 3) {
            $k ^= ord($data[$tail + 2]) << 16;
        }
        if ($rem >= 2) {
            $k ^= ord($data[$tail + 1]) << 8;
        }
        if ($rem >= 1) {
            $k ^= ord($data[$tail]);
            $k = self::mul32($k, $c1);
            $k = (($k << 15) | ($k >> 17)) & 0xFFFFFFFF;
            $k = self::mul32($k, $c2);
            $h ^= $k;
        }
        $h ^= $n & 0xFFFFFFFF;
        $h ^= $h >> 16;
        $h = self::mul32($h, 0x85EBCA6B);
        $h ^= $h >> 13;
        $h = self::mul32($h, 0xC2B2AE35);
        $h ^= $h >> 16;
        return $h;
    }

    /** Bucket in [0, 100) with two decimals of resolution, stable for a given seed + identity. */
    public static function bucketOf(string $seed, string $identity): float
    {
        return (float) (self::murmur3($seed . ':' . $identity) % 10000) / 100.0;
    }

    /* ---------------------------------------------------------------- conditions */

    private static function looseEq(mixed $a, mixed $b): bool
    {
        if ($a instanceof Undefined || $b instanceof Undefined) {
            return false;
        }
        $objA = $a === null || is_array($a) || $a instanceof JsObject;
        $objB = $b === null || is_array($b) || $b instanceof JsObject;
        if ($objA || $objB) {
            return Js::stringify($a) === Js::stringify($b);
        }
        if (is_float($a) && is_float($b)) {
            return $a == $b;
        }
        if (is_bool($a) && is_bool($b)) {
            return $a === $b;
        }
        if (is_string($a) && is_string($b)) {
            return $a === $b;
        }
        return false;
    }

    private static function num(mixed $v): ?float
    {
        if (is_float($v)) {
            return is_nan($v) || is_infinite($v) ? null : $v;
        }
        if (is_string($v) && Js::trim($v) !== '') {
            $n = Js::stringToNumber($v);
            return is_nan($n) || is_infinite($n) ? null : $n;
        }
        return null;
    }

    private static function lookup(JsObject|array|null $ctx, string $name): mixed
    {
        if ($ctx instanceof JsObject) {
            return $ctx->get($name);
        }
        if (is_array($ctx)) {
            return array_key_exists($name, $ctx) ? $ctx[$name] : Undefined::value();
        }
        return Undefined::value();
    }

    private static function matchCondition(mixed $c, JsObject|array|null $ctx, mixed $segments, int $depth): bool
    {
        $op = Js::get($c, 'op');
        if ($op === 'segment' || $op === 'not_segment') {
            $value = Js::get($c, 'value');
            $seg = is_string($value) ? Js::own($segments, $value) : Undefined::value();
            $inSeg = false;
            if (!($seg instanceof Undefined) && $depth < 4) {
                $match = Js::get($seg, 'match');
                $conds = Js::get($seg, 'conditions');
                $inSeg = self::matchAll($match, $conds, $ctx, $segments, $depth + 1);
            }
            return $op === 'segment' ? $inSeg : (!($seg instanceof Undefined) && !$inSeg);
        }
        $actual = self::lookup($ctx, Js::toStr(Js::get($c, 'attribute')));
        $value = Js::get($c, 'value');
        if (!is_string($op)) {
            return false;
        }
        switch ($op) {
            case 'exists':
                return !Js::isNullish($actual);
            case 'not_exists':
                return Js::isNullish($actual);
            case 'eq':
                return self::looseEq($actual, $value);
            case 'neq':
                return !($actual instanceof Undefined) && !self::looseEq($actual, $value);
            case 'in':
                if (!is_array($value)) {
                    return false;
                }
                foreach ($value as $v) {
                    if (self::looseEq($actual, $v)) {
                        return true;
                    }
                }
                return false;
            case 'not_in':
                if ($actual instanceof Undefined || !is_array($value)) {
                    return false;
                }
                foreach ($value as $v) {
                    if (self::looseEq($actual, $v)) {
                        return false;
                    }
                }
                return true;
            case 'contains':
                return is_string($actual) && is_string($value) && Js::includes($actual, $value);
            case 'starts_with':
                return is_string($actual) && is_string($value) && Js::startsWith($actual, $value);
            case 'ends_with':
                return is_string($actual) && is_string($value) && Js::endsWith($actual, $value);
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte':
                $a = self::num($actual);
                $b = self::num($value);
                if ($a === null || $b === null) {
                    return false;
                }
                return match ($op) {
                    'gt' => $a > $b,
                    'gte' => $a >= $b,
                    'lt' => $a < $b,
                    default => $a <= $b,
                };
        }
        return false;
    }

    /** The engine's matchAll(mode, conditions, …), including its failure modes. */
    private static function matchAll(mixed $mode, mixed $conditions, JsObject|array|null $ctx, mixed $segments, int $depth): bool
    {
        $length = Js::get($conditions, 'length');
        if (is_float($length) && $length == 0.0) {
            return true;
        }
        $some = $mode === 'any';
        if (!is_array($conditions)) {
            throw new JsTypeError('conditions.' . ($some ? 'some' : 'every') . ' is not a function');
        }
        foreach ($conditions as $c) {
            $ok = self::matchCondition($c, $ctx, $segments, $depth);
            if ($some && $ok) {
                return true;
            }
            if (!$some && !$ok) {
                return false;
            }
        }
        return !$some;
    }

    /** Human-readable condition, as shown in traces (describeCondition of the TypeScript engine). */
    public static function describeCondition(mixed $c): string
    {
        $value = Js::get($c, 'value');
        $v = is_array($value) ? Js::join($value, ', ') : ($value instanceof Undefined ? '' : Js::toStr($value));
        $op = Js::get($c, 'op');
        $key = Js::toStr($op);
        $word = self::OP_WORDS[$key] ?? Js::OBJECT_PROTO_STRINGS[$key] ?? 'undefined';
        if ($op === 'segment' || $op === 'not_segment') {
            return $word . ' ' . $v;
        }
        $attribute = Js::toStr(Js::get($c, 'attribute'));
        if ($op === 'exists' || $op === 'not_exists') {
            return $attribute . ' ' . $word;
        }
        return $attribute . ' ' . $word . ' ' . $v;
    }

    /** The engine's fmt(v): strings as they are, everything else as JSON ("undefined" when there is none). */
    public static function fmt(mixed $v): string
    {
        return is_string($v) ? $v : (Js::stringify($v) ?? 'undefined');
    }

    /* ---------------------------------------------------------------- evaluation */

    /**
     * Evaluates one flag of $bundle (a parsed bundle document; null or {@see Undefined} for "no configuration
     * loaded") for $ctx (an object value, or a PHP array of engine values). Never throws: on any problem it returns
     * $fallback with reason "flag_not_found" or "error".
     */
    public static function evaluate(mixed $bundle, string $flagKey, JsObject|array|null $ctx, mixed $fallback): Result
    {
        $nullish = Js::isNullish($bundle);
        $revision = 0.0;
        if (!$nullish) {
            try {
                $r = Js::get($bundle, 'revision');
            } catch (\Throwable) {
                $r = Undefined::value();
            }
            if (!Js::isNullish($r)) {
                $revision = $r;
            }
        }
        $trace = [];
        $undefined = Undefined::value();
        try {
            $flag = $nullish ? $undefined : Js::own(Js::get($bundle, 'flags'), $flagKey);
            if (!Js::truthy($bundle) || !Js::truthy($flag)) {
                $detail = Js::truthy($bundle) ? 'Flag is not in this configuration. The application fallback applies.' : 'No configuration is loaded. The application fallback applies.';
                $trace[] = new TraceStep('result', 'Returned ' . self::fmt($fallback), $detail);
                return new Result($flagKey, $fallback, 'flag_not_found', $revision, null, $undefined, null, null, $trace);
            }
            $trace[] = new TraceStep('config', 'Configuration loaded', Js::toNumber($revision) > 0 ? 'r' . Js::toStr($revision) : 'draft');
            if (!Js::truthy(Js::get($flag, 'enabled'))) {
                $off = Js::get($flag, 'off');
                $trace[] = new TraceStep('result', 'Returned ' . self::fmt($off), 'Flag is disabled in this environment.');
                return new Result($flagKey, $off, 'off', $revision, null, $undefined, null, null, $trace);
            }
            $rules = Js::get($flag, 'rules');
            $segments = Js::get($bundle, 'segments');
            for ($i = 0; ; $i++) {
                $length = Js::get($rules, 'length');
                if (!((float) $i < Js::toNumber($length))) {
                    break;
                }
                $rule = Js::get($rules, (string) $i);
                $match = Js::get($rule, 'match');
                $conditions = Js::get($rule, 'conditions');
                $matched = self::matchAll($match, $conditions, $ctx, $segments, 0);
                $label = sprintf('Rule %02d', $i + 1);
                $summary = 'all contexts';
                if (Js::truthy(Js::get($conditions, 'length'))) {
                    $parts = [];
                    foreach ($conditions as $c) {
                        $parts[] = self::describeCondition($c);
                    }
                    $summary = implode($match === 'any' ? ' OR ' : ' AND ', $parts);
                }
                $trace[] = new TraceStep('rule', $matched ? "$label matched" : "$label did not match", $summary, $matched);
                if (!$matched) {
                    continue;
                }
                $serve = Js::get($rule, 'serve');
                $serveType = Js::get($serve, 'type');
                $ruleId = Js::get($rule, 'id');
                if ($serveType === 'fixed') {
                    $value = Js::get($serve, 'value');
                    $trace[] = new TraceStep('result', 'Returned ' . self::fmt($value), "$label serves a fixed value.");
                    return new Result($flagKey, $value, 'rule_match', $revision, $i, $ruleId, null, null, $trace);
                }
                $attrV = Js::get($serve, 'bucketBy');
                $attr = Js::isNullish($attrV) ? 'key' : Js::toStr($attrV);
                $identity = self::lookup($ctx, $attr);
                $otherwise = Js::get($serve, 'otherwise');
                if (Js::isNullish($identity) || $identity === '') {
                    $trace[] = new TraceStep('allocation', 'Allocation skipped', "Context has no \"$attr\" to bucket by; treated as outside the allocation.", false);
                    $trace[] = new TraceStep('result', 'Returned ' . self::fmt($otherwise), 'Remaining eligible users.');
                    return new Result($flagKey, $otherwise, 'rule_match', $revision, $i, $ruleId, false, null, $trace);
                }
                $seedV = Js::get($serve, 'seed');
                $seed = Js::isNullish($seedV) ? $flagKey : Js::toStr($seedV);
                $hash = self::murmur3($seed . ':' . Js::toStr($identity)) % 10000;
                $bucket = (float) $hash / 100.0;
                $percentage = Js::get($serve, 'percentage');
                $inRollout = $bucket < Js::toNumber($percentage);
                $pct = Js::toStr($percentage);
                $fixed = sprintf('%d.%02d', intdiv($hash, 100), $hash % 100);
                $trace[] = new TraceStep('allocation', 'Allocation evaluated', "$pct% rollout · $attr " . ($inRollout ? 'inside' : 'outside') . " allocation (bucket $fixed)", $inRollout);
                $value = $inRollout ? Js::get($serve, 'value') : $otherwise;
                $trace[] = new TraceStep('result', 'Returned ' . self::fmt($value), $inRollout ? "Inside the $pct% allocation." : 'Remaining eligible users.');
                return new Result($flagKey, $value, 'rule_match', $revision, $i, $ruleId, $inRollout, $bucket, $trace);
            }
            $default = Js::get($flag, 'default');
            $trace[] = new TraceStep('result', 'Returned ' . self::fmt($default), 'No rule matched. The flag default applies.');
            return new Result($flagKey, $default, 'default', $revision, null, $undefined, null, null, $trace);
        } catch (\Throwable $e) {
            $msg = $e->getMessage() !== '' ? $e->getMessage() : get_class($e);
            $trace[] = new TraceStep('result', 'Returned ' . self::fmt($fallback), "Evaluation error: $msg. The application fallback applies.");
            return new Result($flagKey, $fallback, 'error', $revision, null, $undefined, null, null, $trace, $msg);
        }
    }

    /* ---------------------------------------------------------------- bundles */

    /** True when this engine can evaluate a bundle whose `engine` member is $e ({@see Undefined} when absent). */
    public static function supportsEngine(mixed $e): bool
    {
        if ($e instanceof Undefined) {
            return true;
        }
        return is_float($e) && !is_infinite($e) && floor($e) === $e && $e >= 1 && $e <= self::VERSION;
    }

    /** The shape the SDKs accept as a bundle: `schema` 1, a numeric `revision`, object `flags` and `segments`. */
    public static function isBundle(mixed $v): bool
    {
        if (!($v instanceof JsObject)) {
            return false;
        }
        $segments = $v->get('segments');
        return $v->get('schema') === 1.0 && is_float($v->get('revision')) && $v->get('flags') instanceof JsObject
            && ($segments instanceof JsObject || is_array($segments));
    }

    /**
     * The browser-key view: only client-exposed flags, and only the segments they reference (directly or through
     * other segments). Mirrors `clientBundle()` of the TypeScript engine.
     */
    public static function clientBundle(JsObject $bundle): JsObject
    {
        $flags = $bundle->get('flags');
        $kept = [];
        $pending = [];
        $refs = static function (mixed $conditions) use (&$pending): void {
            if (!is_array($conditions)) {
                return;
            }
            foreach ($conditions as $c) {
                $op = Js::own($c, 'op');
                $v = Js::own($c, 'value');
                if (($op === 'segment' || $op === 'not_segment') && is_string($v)) {
                    $pending[] = $v;
                }
            }
        };
        if ($flags instanceof JsObject) {
            foreach ($flags as $k => $f) {
                if (Js::own($f, 'clientExposed') !== true) {
                    continue;
                }
                $kept[$k] = $f;
                $rules = Js::own($f, 'rules');
                if (is_array($rules)) {
                    foreach ($rules as $r) {
                        $refs(Js::own($r, 'conditions'));
                    }
                }
            }
        }
        $segments = $bundle->get('segments');
        $needed = [];
        while ($pending !== []) {
            $k = array_pop($pending);
            if (isset($needed[$k]) || !($segments instanceof JsObject) || !$segments->has($k)) {
                continue;
            }
            $needed[$k] = true;
            $refs(Js::own($segments->get($k), 'conditions'));
        }
        $segOut = [];
        if ($segments instanceof JsObject) {
            foreach ($segments as $k => $s) {
                if (isset($needed[$k])) {
                    $segOut[$k] = $s;
                }
            }
        }
        $out = [];
        foreach ($bundle as $k => $v) {
            $out[$k] = match ($k) {
                'flags' => new JsObject($kept),
                'segments' => new JsObject($segOut),
                default => $v,
            };
        }
        $out['flags'] ??= new JsObject($kept);
        $out['segments'] ??= new JsObject($segOut);
        return new JsObject($out);
    }

    /**
     * The context attributes that the rules of $flagKey reference (through segments up to the engine's nesting
     * limit), plus the bucketing attribute of rollouts. The SDK reports only these attribute names, with the type of
     * the value and never the value, in sampled evaluation events.
     *
     * @return list<string>
     */
    public static function attributesUsedBy(mixed $bundle, string $flagKey): array
    {
        $names = [];
        try {
            $segments = Js::own($bundle, 'segments');
            $visit = static function (mixed $conds, int $depth) use (&$visit, &$names, $segments): bool {
                if (!is_array($conds)) {
                    // `for…of` over a non-iterable throws in the TypeScript SDK: nothing is reported.
                    return is_string($conds);
                }
                foreach ($conds as $c) {
                    $op = Js::get($c, 'op');
                    if ($op === 'segment' || $op === 'not_segment') {
                        $value = Js::get($c, 'value');
                        if (is_string($value)) {
                            $seg = Js::own($segments, $value);
                            if (Js::truthy($seg) && $depth < 4 && !$visit(Js::get($seg, 'conditions'), $depth + 1)) {
                                return false;
                            }
                        }
                    } else {
                        $attr = Js::get($c, 'attribute');
                        if (Js::truthy($attr)) {
                            $names[Js::toStr($attr)] = true;
                        }
                    }
                }
                return true;
            };
            $rules = Js::get(Js::own(Js::own($bundle, 'flags'), $flagKey), 'rules');
            if (!is_array($rules)) {
                return [];
            }
            foreach ($rules as $r) {
                if (!$visit(Js::get($r, 'conditions'), 0)) {
                    return [];
                }
                $serve = Js::get($r, 'serve');
                if (Js::get($serve, 'type') === 'rollout') {
                    $by = Js::get($serve, 'bucketBy');
                    $names[Js::isNullish($by) ? 'key' : Js::toStr($by)] = true;
                }
            }
        } catch (\Throwable) {
            return [];
        }
        return array_map('strval', array_keys($names));
    }
}
