<?php

declare(strict_types=1);

namespace NanoFlags\Engine;

/**
 * Byte-level `JSON.parse` for the inputs ext/json refuses: lone UTF-16 surrogates are kept as their three-byte WTF-8
 * form (so that `JSON.stringify` can reproduce them), invalid UTF-8 in the text becomes U+FFFD (as a TextDecoder
 * would), and any property name is accepted.
 *
 * @internal
 */
final class JsonParser
{
    private int $i = 0;
    private int $n;

    public function __construct(private readonly string $s)
    {
        $this->n = strlen($s);
    }

    public function parseDocument(): mixed
    {
        $this->ws();
        $v = $this->value(0);
        $this->ws();
        if ($this->i !== $this->n) {
            $this->fail('unexpected trailing data');
        }
        return $v;
    }

    private function fail(string $msg): never
    {
        throw new InvalidJsonException(sprintf('invalid JSON: %s at offset %d', $msg, $this->i));
    }

    private function ws(): void
    {
        $this->i += strspn($this->s, " \t\n\r", $this->i);
    }

    private function value(int $depth): mixed
    {
        if ($depth > 10000) {
            $this->fail('nesting too deep');
        }
        if ($this->i >= $this->n) {
            $this->fail('unexpected end');
        }
        $c = $this->s[$this->i];
        if ($c === '{') {
            $this->i++;
            $m = [];
            $this->ws();
            if ($this->i < $this->n && $this->s[$this->i] === '}') {
                $this->i++;
                return new JsObject($m);
            }
            while (true) {
                $this->ws();
                if ($this->i >= $this->n || $this->s[$this->i] !== '"') {
                    $this->fail('expected a string key');
                }
                $k = $this->str();
                $this->ws();
                if ($this->i >= $this->n || $this->s[$this->i] !== ':') {
                    $this->fail("expected ':'");
                }
                $this->i++;
                $this->ws();
                $m[$k] = $this->value($depth + 1);
                $this->ws();
                if ($this->i < $this->n && $this->s[$this->i] === ',') {
                    $this->i++;
                    continue;
                }
                if ($this->i < $this->n && $this->s[$this->i] === '}') {
                    $this->i++;
                    return new JsObject($m);
                }
                $this->fail("expected ',' or '}'");
            }
        }
        if ($c === '[') {
            $this->i++;
            $out = [];
            $this->ws();
            if ($this->i < $this->n && $this->s[$this->i] === ']') {
                $this->i++;
                return $out;
            }
            while (true) {
                $this->ws();
                $out[] = $this->value($depth + 1);
                $this->ws();
                if ($this->i < $this->n && $this->s[$this->i] === ',') {
                    $this->i++;
                    continue;
                }
                if ($this->i < $this->n && $this->s[$this->i] === ']') {
                    $this->i++;
                    return $out;
                }
                $this->fail("expected ',' or ']'");
            }
        }
        if ($c === '"') {
            return $this->str();
        }
        if ($c === 't') {
            return $this->lit('true', true);
        }
        if ($c === 'f') {
            return $this->lit('false', false);
        }
        if ($c === 'n') {
            return $this->lit('null', null);
        }
        if ($c === '-' || ($c >= '0' && $c <= '9')) {
            return $this->number();
        }
        $this->fail('unexpected character');
    }

    private function lit(string $word, mixed $v): mixed
    {
        if (substr($this->s, $this->i, strlen($word)) !== $word) {
            $this->fail('invalid literal');
        }
        $this->i += strlen($word);
        return $v;
    }

    private function digits(): int
    {
        $d = strspn($this->s, '0123456789', $this->i);
        $this->i += $d;
        return $d;
    }

    private function number(): float
    {
        $start = $this->i;
        if ($this->s[$this->i] === '-') {
            $this->i++;
        }
        if ($this->i < $this->n && $this->s[$this->i] === '0') {
            $this->i++;
        } elseif ($this->digits() === 0) {
            $this->fail('invalid number');
        }
        if ($this->i < $this->n && $this->s[$this->i] === '.') {
            $this->i++;
            if ($this->digits() === 0) {
                $this->fail('invalid number');
            }
        }
        if ($this->i < $this->n && ($this->s[$this->i] === 'e' || $this->s[$this->i] === 'E')) {
            $this->i++;
            if ($this->i < $this->n && ($this->s[$this->i] === '+' || $this->s[$this->i] === '-')) {
                $this->i++;
            }
            if ($this->digits() === 0) {
                $this->fail('invalid number');
            }
        }
        return (float) substr($this->s, $start, $this->i - $start);
    }

    private function hex4(): int
    {
        if ($this->n - $this->i < 4) {
            return -1;
        }
        $h = substr($this->s, $this->i, 4);
        if (strspn($h, '0123456789abcdefABCDEF') !== 4) {
            return -1;
        }
        $this->i += 4;
        return (int) hexdec($h);
    }

    private function str(): string
    {
        $this->i++; // opening quote
        $sb = '';
        while (true) {
            // Run of plain ASCII.
            $run = strcspn($this->s, "\"\\\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a\x8b\x8c\x8d\x8e\x8f\x90\x91\x92\x93\x94\x95\x96\x97\x98\x99\x9a\x9b\x9c\x9d\x9e\x9f\xa0\xa1\xa2\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xab\xac\xad\xae\xaf\xb0\xb1\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xbb\xbc\xbd\xbe\xbf\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf\xd0\xd1\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xdb\xdc\xdd\xde\xdf\xe0\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xeb\xec\xed\xee\xef\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xfb\xfc\xfd\xfe\xff", $this->i);
            $sb .= substr($this->s, $this->i, $run);
            $this->i += $run;
            if ($this->i >= $this->n) {
                $this->fail('unterminated string');
            }
            $c = $this->s[$this->i];
            $o = ord($c);
            if ($c === '"') {
                $this->i++;
                return $sb;
            }
            if ($o < 0x20) {
                $this->fail('control character in string');
            }
            if ($o >= 0x80) {
                // One UTF-8 sequence; an invalid one becomes U+FFFD (one per byte).
                $cps = Js::codePoints(substr($this->s, $this->i, 4));
                [$cp, $size] = $cps[0];
                if (($cp === 0xFFFD && $size === 1) || ($cp >= 0xD800 && $cp <= 0xDFFF)) {
                    $sb .= "\u{FFFD}";
                    $this->i++;
                } else {
                    $sb .= substr($this->s, $this->i, $size);
                    $this->i += $size;
                }
                continue;
            }
            // Backslash.
            $this->i++;
            if ($this->i >= $this->n) {
                $this->fail('unterminated escape');
            }
            $e = $this->s[$this->i++];
            switch ($e) {
                case '"':
                case '\\':
                case '/':
                    $sb .= $e;
                    break;
                case 'b':
                    $sb .= "\x08";
                    break;
                case 'f':
                    $sb .= "\x0C";
                    break;
                case 'n':
                    $sb .= "\n";
                    break;
                case 'r':
                    $sb .= "\r";
                    break;
                case 't':
                    $sb .= "\t";
                    break;
                case 'u':
                    $u = $this->hex4();
                    if ($u < 0) {
                        $this->fail('invalid unicode escape');
                    }
                    if ($u >= 0xD800 && $u <= 0xDBFF && $this->i + 1 < $this->n && $this->s[$this->i] === '\\' && $this->s[$this->i + 1] === 'u') {
                        $save = $this->i;
                        $this->i += 2;
                        $lo = $this->hex4();
                        if ($lo >= 0xDC00 && $lo <= 0xDFFF) {
                            $sb .= Js::encodeUnit(0x10000 + (($u - 0xD800) << 10) + ($lo - 0xDC00));
                            break;
                        }
                        $this->i = $save;
                    }
                    $sb .= Js::encodeUnit($u);
                    break;
                default:
                    $this->fail('invalid escape');
            }
        }
    }
}
