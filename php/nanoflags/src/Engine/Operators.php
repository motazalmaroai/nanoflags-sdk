<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * Version (`semver_*`) and date (`before` / `after`) operators: the engine's parseSemver, compareSemver and
 * parseInstant. Values are compared as ASCII bytes; any non-ASCII byte makes a value invalid, exactly as the
 * TypeScript engine's character checks do. JSON numbers are floats here, as in JavaScript.
 *
 * @internal
 */
final class Operators
{
    private const MAX_LENGTH = 256;

    private static function isDigit(string $c): bool
    {
        $o = ord($c);
        return $o >= 48 && $o <= 57;
    }

    private static function isIdent(string $c): bool
    {
        $o = ord($c);
        return ($o >= 48 && $o <= 57) || ($o >= 65 && $o <= 90) || ($o >= 97 && $o <= 122) || $o === 45;
    }

    private static function stripZeros(string $d): string
    {
        $s = ltrim($d, '0');
        return $s === '' ? '0' : $s;
    }

    private static function allDigits(string $s): bool
    {
        return $s !== '' && strspn($s, '0123456789') === strlen($s);
    }

    private static function ascii(mixed $v): ?string
    {
        if (!is_string($v) || strlen($v) > self::MAX_LENGTH || preg_match('/[\x80-\xff]/', $v) === 1) {
            return null;
        }
        return $v;
    }

    /**
     * @param list<string> $out
     */
    private static function idents(string $s, int $from, bool $stopAtPlus, array &$out): int
    {
        $n = strlen($s);
        $j = $from;
        $start = $j;
        while (true) {
            while ($j < $n && self::isIdent($s[$j])) {
                $j++;
            }
            if ($j === $start) {
                return -1;
            }
            $out[] = substr($s, $start, $j - $start);
            if ($j < $n && $s[$j] === '.') {
                $j++;
                $start = $j;
                continue;
            }
            if ($j === $n || ($stopAtPlus && $s[$j] === '+')) {
                return $j;
            }
            return -1;
        }
    }

    /**
     * @return array{0: list<string>, 1: list<string>}|null core numbers (digit strings) and prerelease identifiers
     */
    public static function parseSemver(mixed $v): ?array
    {
        $s = self::ascii($v);
        if ($s === null || $s === '') {
            return null;
        }
        $n = strlen($s);
        $i = ($s[0] === 'v' || $s[0] === 'V') ? 1 : 0;
        $core = [];
        while (true) {
            $start = $i;
            while ($i < $n && self::isDigit($s[$i])) {
                $i++;
            }
            if ($i === $start) {
                return null;
            }
            $core[] = self::stripZeros(substr($s, $start, $i - $start));
            if (count($core) < 3 && $i < $n && $s[$i] === '.') {
                $i++;
                continue;
            }
            break;
        }
        while (count($core) < 3) {
            $core[] = '0';
        }
        $pre = [];
        if ($i < $n && $s[$i] === '-') {
            $i = self::idents($s, $i + 1, true, $pre);
            if ($i < 0) {
                return null;
            }
        }
        if ($i < $n && $s[$i] === '+') {
            $build = [];
            $i = self::idents($s, $i + 1, false, $build);
            if ($i < 0) {
                return null;
            }
        }
        if ($i !== $n) {
            return null;
        }
        return [$core, $pre];
    }

    private static function compareDigits(string $a, string $b): int
    {
        if (strlen($a) !== strlen($b)) {
            return strlen($a) < strlen($b) ? -1 : 1;
        }
        return strcmp($a, $b) <=> 0;
    }

    /**
     * @param array{0: list<string>, 1: list<string>} $a
     * @param array{0: list<string>, 1: list<string>} $b
     */
    public static function compareSemver(array $a, array $b): int
    {
        for ($k = 0; $k < 3; $k++) {
            $c = self::compareDigits($a[0][$k], $b[0][$k]);
            if ($c !== 0) {
                return $c;
            }
        }
        [$pa, $pb] = [$a[1], $b[1]];
        if (count($pa) === 0 || count($pb) === 0) {
            return count($pa) === count($pb) ? 0 : (count($pa) === 0 ? 1 : -1);
        }
        $len = min(count($pa), count($pb));
        for ($k = 0; $k < $len; $k++) {
            $x = $pa[$k];
            $y = $pb[$k];
            $xn = self::allDigits($x);
            $yn = self::allDigits($y);
            if ($xn && $yn) {
                $c = self::compareDigits(self::stripZeros($x), self::stripZeros($y));
            } elseif ($xn) {
                $c = -1;
            } elseif ($yn) {
                $c = 1;
            } else {
                $c = strcmp($x, $y) <=> 0;
            }
            if ($c !== 0) {
                return $c;
            }
        }
        return count($pa) <=> count($pb);
    }

    public static function matchSemver(string $op, mixed $actual, mixed $expected): bool
    {
        $a = self::parseSemver($actual);
        $b = self::parseSemver($expected);
        if ($a === null || $b === null) {
            return false;
        }
        $c = self::compareSemver($a, $b);
        return match ($op) {
            'semver_eq' => $c === 0,
            'semver_neq' => $c !== 0,
            'semver_gt' => $c > 0,
            'semver_gte' => $c >= 0,
            'semver_lt' => $c < 0,
            default => $c <= 0,
        };
    }

    private static function daysFromCivil(int $year, int $m, int $d): int
    {
        $y = $m <= 2 ? $year - 1 : $year;
        $era = intdiv($y >= 0 ? $y : $y - 399, 400);
        $yoe = $y - $era * 400;
        $doy = intdiv(153 * ($m + ($m > 2 ? -3 : 9)) + 2, 5) + $d - 1;
        $doe = $yoe * 365 + intdiv($yoe, 4) - intdiv($yoe, 100) + $doy;
        return $era * 146097 + $doe - 719468;
    }

    private static function digitsAt(string $s, int $i, int $n): ?int
    {
        if ($i + $n > strlen($s)) {
            return null;
        }
        $part = substr($s, $i, $n);
        return strspn($part, '0123456789') === $n ? (int) $part : null;
    }

    /** Unix epoch milliseconds, or null when `$v` is not a point in time. */
    public static function parseInstant(mixed $v): ?float
    {
        if (is_float($v) || is_int($v)) {
            $x = (float) $v;
            if (is_nan($x) || is_infinite($x)) {
                return null;
            }
            return abs($x) >= 1e12 ? $x : $x * 1000;
        }
        $s = self::ascii($v);
        if ($s === null) {
            return null;
        }
        $n = strlen($s);
        if ($n < 10) {
            return null;
        }
        $y = self::digitsAt($s, 0, 4);
        $mo = self::digitsAt($s, 5, 2);
        $d = self::digitsAt($s, 8, 2);
        if ($y === null || $mo === null || $d === null || $s[4] !== '-' || $s[7] !== '-' || $mo < 1 || $mo > 12 || $d < 1) {
            return null;
        }
        $leap = $y % 4 === 0 && ($y % 100 !== 0 || $y % 400 === 0);
        $dim = $mo === 2 ? ($leap ? 29 : 28) : (in_array($mo, [4, 6, 9, 11], true) ? 30 : 31);
        if ($d > $dim) {
            return null;
        }
        $ms = self::daysFromCivil($y, $mo, $d) * 86400000;
        if ($n === 10) {
            return (float) $ms;
        }
        if ($s[10] !== 'T' && $s[10] !== 't' && $s[10] !== ' ') {
            return null;
        }
        $h = self::digitsAt($s, 11, 2);
        $mi = self::digitsAt($s, 14, 2);
        if ($h === null || $mi === null || $s[13] !== ':') {
            return null;
        }
        $i = 16;
        $sec = 0;
        $frac = 0;
        if ($i < $n && $s[$i] === ':') {
            $sec = self::digitsAt($s, $i + 1, 2);
            if ($sec === null) {
                return null;
            }
            $i += 3;
            if ($i < $n && $s[$i] === '.') {
                $len = strspn($s, '0123456789', $i + 1);
                if ($len === 0 || $len > 9) {
                    return null;
                }
                $frac = (int) substr(substr($s, $i + 1, $len) . '00', 0, 3);
                $i += 1 + $len;
            }
        }
        if ($h > 23 || $mi > 59 || $sec > 59 || $i >= $n) {
            return null;
        }
        $ms += $h * 3600000 + $mi * 60000 + $sec * 1000 + $frac;
        $z = $s[$i];
        if (($z === 'Z' || $z === 'z') && $i + 1 === $n) {
            return (float) $ms;
        }
        if (($z === '+' || $z === '-') && $i + 6 === $n && $s[$i + 3] === ':') {
            $oh = self::digitsAt($s, $i + 1, 2);
            $om = self::digitsAt($s, $i + 4, 2);
            if ($oh === null || $om === null || $oh > 23 || $om > 59) {
                return null;
            }
            $off = ($oh * 60 + $om) * 60000;
            return (float) ($z === '-' ? $ms + $off : $ms - $off);
        }
        return null;
    }

    public static function matchDate(string $op, mixed $actual, mixed $expected): bool
    {
        $a = self::parseInstant($actual);
        $b = self::parseInstant($expected);
        if ($a === null || $b === null) {
            return false;
        }
        return $op === 'before' ? $a < $b : $a > $b;
    }
}
