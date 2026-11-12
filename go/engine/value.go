package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The engine is specified by its TypeScript implementation, which evaluates configuration that is
// plain JSON data with JavaScript semantics (truthiness, loose property access, Number(), String(),
// JSON.stringify). Value models exactly that subset of JavaScript so that the Go port produces
// byte-identical results, including for malformed configurations.

type kind uint8

const (
	kUndefined kind = iota
	kNull
	kBool
	kNumber
	kString
	kArray
	kObject
	kFunction // only ever produced by reading a String.prototype / Array.prototype method
)

// Value is a JSON value with JavaScript semantics. The zero Value is JavaScript `undefined`.
// Values are immutable once built; they are safe to share between goroutines.
type Value struct {
	k kind
	b bool
	n float64
	s string // string value (WTF-8: lone UTF-16 surrogates are kept), or the function name
	a []Value
	o *object
}

// Undefined is the JavaScript `undefined` (an absent value).
var Undefined = Value{}

// Null is the JSON null.
var Null = Value{k: kNull}

func boolValue(b bool) Value      { return Value{k: kBool, b: b} }
func numberValue(n float64) Value { return Value{k: kNumber, n: n} }
func stringValue(s string) Value  { return Value{k: kString, s: s} }

// IsUndefined reports whether v is JavaScript `undefined` (no value at all).
func (v Value) IsUndefined() bool { return v.k == kUndefined }

// IsNull reports whether v is JSON null.
func (v Value) IsNull() bool { return v.k == kNull }

// object is a JavaScript plain object: own properties in JavaScript order (array-index keys in
// ascending numeric order first, then the other keys in insertion order).
type object struct {
	index []string // array-index keys, ascending
	names []string // other keys, insertion order
	m     map[string]Value
}

func newObject() *object { return &object{m: map[string]Value{}} }

func (o *object) set(k string, v Value) {
	if _, ok := o.m[k]; !ok {
		if n, ok := arrayIndex(k); ok {
			i := sort.Search(len(o.index), func(i int) bool { m, _ := arrayIndex(o.index[i]); return m >= n })
			o.index = append(o.index, "")
			copy(o.index[i+1:], o.index[i:])
			o.index[i] = k
		} else {
			o.names = append(o.names, k)
		}
	}
	o.m[k] = v
}

func (o *object) get(k string) (Value, bool) {
	v, ok := o.m[k]
	return v, ok
}

func (o *object) keys() []string {
	out := make([]string, 0, len(o.index)+len(o.names))
	out = append(out, o.index...)
	return append(out, o.names...)
}

// arrayIndex reports whether k is a canonical array index (0 … 2^32-2).
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n < 4294967295
}

/* ---------------- JSON.parse ---------------- */

// ErrInvalidJSON is returned by ParseJSON for text that JSON.parse would reject.
var ErrInvalidJSON = errors.New("invalid JSON")

// ParseJSON parses JSON text like JavaScript's JSON.parse: numbers become IEEE-754 doubles
// (overflow becomes ±Infinity), duplicate keys keep their first position and last value, and
// object key order follows JavaScript's own-property order.
func ParseJSON(data []byte) (Value, error) {
	p := parser{d: data}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return Undefined, err
	}
	p.ws()
	if p.i != len(p.d) {
		return Undefined, p.fail("unexpected trailing data")
	}
	return v, nil
}

type parser struct {
	d []byte
	i int
}

const maxDepth = 10000

func (p *parser) fail(msg string) error {
	return fmt.Errorf("%w: %s at offset %d", ErrInvalidJSON, msg, p.i)
}

func (p *parser) ws() {
	for p.i < len(p.d) {
		switch p.d[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (Value, error) {
	if depth > maxDepth {
		return Undefined, p.fail("nesting too deep")
	}
	if p.i >= len(p.d) {
		return Undefined, p.fail("unexpected end")
	}
	switch c := p.d[p.i]; {
	case c == '{':
		p.i++
		o := newObject()
		p.ws()
		if p.i < len(p.d) && p.d[p.i] == '}' {
			p.i++
			return Value{k: kObject, o: o}, nil
		}
		for {
			p.ws()
			if p.i >= len(p.d) || p.d[p.i] != '"' {
				return Undefined, p.fail("expected a string key")
			}
			k, err := p.str()
			if err != nil {
				return Undefined, err
			}
			p.ws()
			if p.i >= len(p.d) || p.d[p.i] != ':' {
				return Undefined, p.fail("expected ':'")
			}
			p.i++
			p.ws()
			v, err := p.value(depth + 1)
			if err != nil {
				return Undefined, err
			}
			o.set(k, v)
			p.ws()
			if p.i < len(p.d) && p.d[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.d) && p.d[p.i] == '}' {
				p.i++
				return Value{k: kObject, o: o}, nil
			}
			return Undefined, p.fail("expected ',' or '}'")
		}
	case c == '[':
		p.i++
		arr := []Value{}
		p.ws()
		if p.i < len(p.d) && p.d[p.i] == ']' {
			p.i++
			return Value{k: kArray, a: arr}, nil
		}
		for {
			p.ws()
			v, err := p.value(depth + 1)
			if err != nil {
				return Undefined, err
			}
			arr = append(arr, v)
			p.ws()
			if p.i < len(p.d) && p.d[p.i] == ',' {
				p.i++
				continue
			}
			if p.i < len(p.d) && p.d[p.i] == ']' {
				p.i++
				return Value{k: kArray, a: arr}, nil
			}
			return Undefined, p.fail("expected ',' or ']'")
		}
	case c == '"':
		s, err := p.str()
		if err != nil {
			return Undefined, err
		}
		return stringValue(s), nil
	case c == 't':
		return p.lit("true", boolValue(true))
	case c == 'f':
		return p.lit("false", boolValue(false))
	case c == 'n':
		return p.lit("null", Null)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return Undefined, p.fail("unexpected character")
}

func (p *parser) lit(word string, v Value) (Value, error) {
	if len(p.d)-p.i < len(word) || string(p.d[p.i:p.i+len(word)]) != word {
		return Undefined, p.fail("invalid literal")
	}
	p.i += len(word)
	return v, nil
}

func (p *parser) number() (Value, error) {
	start := p.i
	digits := func() int {
		n := 0
		for p.i < len(p.d) && p.d[p.i] >= '0' && p.d[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.d[p.i] == '-' {
		p.i++
	}
	if p.i < len(p.d) && p.d[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return Undefined, p.fail("invalid number")
	}
	if p.i < len(p.d) && p.d[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return Undefined, p.fail("invalid number")
		}
	}
	if p.i < len(p.d) && (p.d[p.i] == 'e' || p.d[p.i] == 'E') {
		p.i++
		if p.i < len(p.d) && (p.d[p.i] == '+' || p.d[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return Undefined, p.fail("invalid number")
		}
	}
	f, err := strconv.ParseFloat(string(p.d[start:p.i]), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return Undefined, p.fail("invalid number")
	}
	return numberValue(f), nil
}

func hexVal(c byte) (rune, bool) {
	switch {
	case c >= '0' && c <= '9':
		return rune(c - '0'), true
	case c >= 'a' && c <= 'f':
		return rune(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return rune(c-'A') + 10, true
	}
	return 0, false
}

// str decodes a JSON string. Lone UTF-16 surrogates (only expressible as \u escapes) are kept as
// their three-byte WTF-8 form so that JSON.stringify can reproduce them; invalid UTF-8 in the raw
// text is replaced by U+FFFD as a TextDecoder would.
func (p *parser) str() (string, error) {
	p.i++ // opening quote
	var sb strings.Builder
	for {
		start := p.i
		for p.i < len(p.d) {
			c := p.d[p.i]
			if c == '"' || c == '\\' || c < 0x20 || c >= 0x80 {
				break
			}
			p.i++
		}
		sb.Write(p.d[start:p.i])
		if p.i >= len(p.d) {
			return "", p.fail("unterminated string")
		}
		c := p.d[p.i]
		switch {
		case c == '"':
			p.i++
			return sb.String(), nil
		case c < 0x20:
			return "", p.fail("control character in string")
		case c >= 0x80:
			r, size := utf8.DecodeRune(p.d[p.i:])
			if r == utf8.RuneError && size <= 1 {
				sb.WriteRune(utf8.RuneError)
				p.i++
			} else {
				sb.Write(p.d[p.i : p.i+size])
				p.i += size
			}
		default: // backslash
			p.i++
			if p.i >= len(p.d) {
				return "", p.fail("unterminated escape")
			}
			e := p.d[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				sb.WriteByte(e)
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				u, ok := p.hex4()
				if !ok {
					return "", p.fail("invalid unicode escape")
				}
				if u >= 0xD800 && u <= 0xDBFF && p.i+1 < len(p.d) && p.d[p.i] == '\\' && p.d[p.i+1] == 'u' {
					save := p.i
					p.i += 2
					if lo, ok := p.hex4(); ok && lo >= 0xDC00 && lo <= 0xDFFF {
						sb.WriteRune(0x10000 + (u-0xD800)<<10 + (lo - 0xDC00))
						continue
					}
					p.i = save
				}
				writeCodeUnit(&sb, u)
			default:
				return "", p.fail("invalid escape")
			}
		}
	}
}

func (p *parser) hex4() (rune, bool) {
	if len(p.d)-p.i < 4 {
		return 0, false
	}
	var r rune
	for j := 0; j < 4; j++ {
		h, ok := hexVal(p.d[p.i+j])
		if !ok {
			return 0, false
		}
		r = r<<4 | h
	}
	p.i += 4
	return r, true
}

// writeCodeUnit writes a BMP code point, encoding a lone surrogate in WTF-8.
func writeCodeUnit(sb *strings.Builder, u rune) {
	if u >= 0xD800 && u <= 0xDFFF {
		sb.WriteByte(byte(0xE0 | (u >> 12)))
		sb.WriteByte(byte(0x80 | ((u >> 6) & 0x3F)))
		sb.WriteByte(byte(0x80 | (u & 0x3F)))
		return
	}
	sb.WriteRune(u)
}

// codeUnits iterates a WTF-8 string as UTF-16 code units' worth of code points: it calls fn with
// each code point (lone surrogates included) and its byte width. Invalid bytes yield U+FFFD.
func codePoints(s string, fn func(r rune, size int)) {
	for i := 0; i < len(s); {
		c := s[i]
		if c == 0xED && i+2 < len(s) && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2]&0xC0 == 0x80 {
			fn(rune(c&0x0F)<<12|rune(s[i+1]&0x3F)<<6|rune(s[i+2]&0x3F), 3)
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		fn(r, size)
		i += size
	}
}

// utf16Len is JavaScript's string length.
func utf16Len(s string) int {
	n := 0
	codePoints(s, func(r rune, _ int) {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	})
	return n
}

// utf16At returns the code unit at index i as a one-unit string (String.prototype[i]).
func utf16At(s string, i int) Value {
	n := 0
	var out Value
	found := false
	codePoints(s, func(r rune, _ int) {
		if found {
			return
		}
		if r >= 0x10000 {
			hi, lo := 0xD800+((r-0x10000)>>10), 0xDC00+((r-0x10000)&0x3FF)
			if n == i || n+1 == i {
				var sb strings.Builder
				if n == i {
					writeCodeUnit(&sb, hi)
				} else {
					writeCodeUnit(&sb, lo)
				}
				out, found = stringValue(sb.String()), true
			}
			n += 2
			return
		}
		if n == i {
			var sb strings.Builder
			writeCodeUnit(&sb, r)
			out, found = stringValue(sb.String()), true
		}
		n++
	})
	return out
}

/* ---------------- JSON.stringify ---------------- */

// JSON returns JSON.stringify(v) and false when JSON.stringify would return undefined.
func (v Value) JSON() (string, bool) {
	if v.k == kUndefined || v.k == kFunction {
		return "", false
	}
	var sb strings.Builder
	v.writeJSON(&sb)
	return sb.String(), true
}

func (v Value) writeJSON(sb *strings.Builder) {
	switch v.k {
	case kNull:
		sb.WriteString("null")
	case kBool:
		if v.b {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case kNumber:
		if math.IsNaN(v.n) || math.IsInf(v.n, 0) {
			sb.WriteString("null")
		} else {
			sb.WriteString(numberToString(v.n))
		}
	case kString:
		quoteJSON(sb, v.s)
	case kArray:
		sb.WriteByte('[')
		for i, e := range v.a {
			if i > 0 {
				sb.WriteByte(',')
			}
			if e.k == kUndefined || e.k == kFunction {
				sb.WriteString("null")
			} else {
				e.writeJSON(sb)
			}
		}
		sb.WriteByte(']')
	case kObject:
		sb.WriteByte('{')
		first := true
		for _, k := range v.o.keys() {
			e := v.o.m[k]
			if e.k == kUndefined || e.k == kFunction {
				continue
			}
			if !first {
				sb.WriteByte(',')
			}
			first = false
			quoteJSON(sb, k)
			sb.WriteByte(':')
			e.writeJSON(sb)
		}
		sb.WriteByte('}')
	}
}

const hexDigits = "0123456789abcdef"

func quoteJSON(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	codePoints(s, func(r rune, size int) {
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r < 0x20 || (r >= 0xD800 && r <= 0xDFFF):
			sb.WriteString(`\u`)
			sb.WriteByte(hexDigits[(r>>12)&0xF])
			sb.WriteByte(hexDigits[(r>>8)&0xF])
			sb.WriteByte(hexDigits[(r>>4)&0xF])
			sb.WriteByte(hexDigits[r&0xF])
		default:
			sb.WriteRune(r)
		}
	})
	sb.WriteByte('"')
}

// numberToString is ECMAScript Number::toString(x) for radix 10.
func numberToString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case f == 0:
		return "0"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	sign := ""
	if f < 0 {
		sign, f = "-", -f
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±XX, shortest round-trip digits
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	x, _ := strconv.Atoi(exp)
	k, n := len(digits), x+1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		es := "+"
		if n-1 < 0 {
			es = "-"
		}
		ev := n - 1
		if ev < 0 {
			ev = -ev
		}
		if k == 1 {
			out = digits + "e" + es + strconv.Itoa(ev)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(ev)
		}
	}
	return sign + out
}

/* ---------------- abstract operations ---------------- */

// toString is String(v).
func (v Value) toString() string {
	switch v.k {
	case kUndefined:
		return "undefined"
	case kNull:
		return "null"
	case kBool:
		if v.b {
			return "true"
		}
		return "false"
	case kNumber:
		return numberToString(v.n)
	case kString:
		return v.s
	case kArray:
		return v.join(",")
	case kFunction:
		return "function " + v.s + "() { [native code] }"
	}
	return "[object Object]"
}

// join is Array.prototype.join.
func (v Value) join(sep string) string {
	var sb strings.Builder
	for i, e := range v.a {
		if i > 0 {
			sb.WriteString(sep)
		}
		if e.k != kUndefined && e.k != kNull {
			sb.WriteString(e.toString())
		}
	}
	return sb.String()
}

// truthy is ToBoolean(v).
func (v Value) truthy() bool {
	switch v.k {
	case kUndefined, kNull:
		return false
	case kBool:
		return v.b
	case kNumber:
		return v.n != 0 && !math.IsNaN(v.n)
	case kString:
		return v.s != ""
	}
	return true
}

// toNumber is ToNumber(ToPrimitive(v, number)).
func (v Value) toNumber() float64 {
	switch v.k {
	case kUndefined:
		return math.NaN()
	case kNull:
		return 0
	case kBool:
		if v.b {
			return 1
		}
		return 0
	case kNumber:
		return v.n
	case kString:
		return stringToNumber(v.s)
	}
	return stringToNumber(v.toString())
}

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSWhitespace)
}

// stringToNumber is ECMAScript StringToNumber.
func stringToNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			for i := 2; i < len(s); i++ {
				d, ok := hexVal(s[i])
				if !ok || int(d) >= base {
					return math.NaN()
				}
			}
			n, ok := new(big.Int).SetString(s[2:], base)
			if !ok {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	// StrDecimalLiteral: [+-] (digits [. digits] | . digits) [e [+-] digits]
	i := 0
	if s[i] == '+' || s[i] == '-' {
		i++
	}
	intDigits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		intDigits++
	}
	fracDigits := 0
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			fracDigits++
		}
	}
	if intDigits+fracDigits == 0 {
		return math.NaN()
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		expDigits := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			expDigits++
		}
		if expDigits == 0 {
			return math.NaN()
		}
	}
	if i != len(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// lessThan is `a < v` for a number a (the only shape the engine uses).
func lessThan(a float64, v Value) bool { return a < v.toNumber() }

// typeError mirrors the TypeError messages of V8 for the operations the engine performs.
type typeError struct{ msg string }

func (e *typeError) Error() string { return e.msg }

var stringMethods = map[string]bool{
	"anchor": true, "at": true, "big": true, "blink": true, "bold": true, "charAt": true, "charCodeAt": true, "codePointAt": true,
	"concat": true, "constructor": true, "endsWith": true, "fixed": true, "fontcolor": true, "fontsize": true, "includes": true,
	"indexOf": true, "isWellFormed": true, "italics": true, "lastIndexOf": true, "link": true, "localeCompare": true, "match": true,
	"matchAll": true, "normalize": true, "padEnd": true, "padStart": true, "repeat": true, "replace": true, "replaceAll": true,
	"search": true, "slice": true, "small": true, "split": true, "strike": true, "sub": true, "substr": true, "substring": true,
	"sup": true, "toLocaleLowerCase": true, "toLocaleUpperCase": true, "toLowerCase": true, "toString": true, "toUpperCase": true,
	"toWellFormed": true, "trim": true, "trimEnd": true, "trimLeft": true, "trimRight": true, "trimStart": true, "valueOf": true,
}

var arrayMethods = map[string]bool{
	"at": true, "concat": true, "constructor": true, "copyWithin": true, "entries": true, "every": true, "fill": true, "filter": true,
	"find": true, "findIndex": true, "findLast": true, "findLastIndex": true, "flat": true, "flatMap": true, "forEach": true,
	"includes": true, "indexOf": true, "join": true, "keys": true, "lastIndexOf": true, "map": true, "pop": true, "push": true,
	"reduce": true, "reduceRight": true, "reverse": true, "shift": true, "slice": true, "some": true, "sort": true, "splice": true,
	"toLocaleString": true, "toReversed": true, "toSorted": true, "toSpliced": true, "toString": true, "unshift": true, "values": true,
	"with": true,
}

// Object.prototype members, as `${words[name]}` renders them in describeCondition.
var objectProtoStrings = map[string]string{
	"constructor":          "function Object() { [native code] }",
	"__defineGetter__":     "function __defineGetter__() { [native code] }",
	"__defineSetter__":     "function __defineSetter__() { [native code] }",
	"hasOwnProperty":       "function hasOwnProperty() { [native code] }",
	"__lookupGetter__":     "function __lookupGetter__() { [native code] }",
	"__lookupSetter__":     "function __lookupSetter__() { [native code] }",
	"isPrototypeOf":        "function isPrototypeOf() { [native code] }",
	"propertyIsEnumerable": "function propertyIsEnumerable() { [native code] }",
	"toString":             "function toString() { [native code] }",
	"valueOf":              "function valueOf() { [native code] }",
	"__proto__":            "[object Object]",
	"toLocaleString":       "function toLocaleString() { [native code] }",
}

// get is the property read `v[name]` for the fixed property names the engine reads. Plain objects
// only expose own properties here: none of those names exist on Object.prototype.
func (v Value) get(name string) (Value, error) {
	switch v.k {
	case kUndefined, kNull:
		return Undefined, &typeError{fmt.Sprintf("Cannot read properties of %s (reading '%s')", v.toString(), name)}
	case kString:
		if name == "length" {
			return numberValue(float64(utf16Len(v.s))), nil
		}
		if n, ok := arrayIndex(name); ok {
			if int(n) < utf16Len(v.s) {
				return utf16At(v.s, int(n)), nil
			}
			return Undefined, nil
		}
		if stringMethods[name] {
			return Value{k: kFunction, s: name}, nil
		}
	case kArray:
		if name == "length" {
			return numberValue(float64(len(v.a))), nil
		}
		if n, ok := arrayIndex(name); ok {
			if int(n) < len(v.a) {
				return v.a[n], nil
			}
			return Undefined, nil
		}
		if arrayMethods[name] {
			return Value{k: kFunction, s: name}, nil
		}
	case kObject:
		if e, ok := v.o.get(name); ok {
			return e, nil
		}
	}
	return Undefined, nil
}

// own is the engine's `own(obj, key)`: an own-property lookup that never reads inherited members.
func own(obj Value, key string) Value {
	switch obj.k {
	case kObject:
		e, _ := obj.o.get(key)
		return e
	case kArray, kString:
		if _, ok := arrayIndex(key); ok || key == "length" {
			e, _ := obj.get(key)
			return e
		}
	}
	return Undefined
}

/* ---------------- conversion from and to Go values ---------------- */

// FromGo converts a Go value to a Value: nil → null, bool, every integer and float type → number
// (as float64, like JavaScript), string, json.Number, json.RawMessage (parsed), Value, time.Time
// (ISO 8601 string), slices and maps (map keys sorted, since Go maps have no order). Anything else
// is converted through encoding/json; values it cannot encode become null.
func FromGo(x any) Value {
	switch t := x.(type) {
	case nil:
		return Null
	case Value:
		return t
	case bool:
		return boolValue(t)
	case string:
		return stringValue(t)
	case float64:
		return numberValue(t)
	case float32:
		return numberValue(float64(t))
	case int:
		return numberValue(float64(t))
	case int8:
		return numberValue(float64(t))
	case int16:
		return numberValue(float64(t))
	case int32:
		return numberValue(float64(t))
	case int64:
		return numberValue(float64(t))
	case uint:
		return numberValue(float64(t))
	case uint8:
		return numberValue(float64(t))
	case uint16:
		return numberValue(float64(t))
	case uint32:
		return numberValue(float64(t))
	case uint64:
		return numberValue(float64(t))
	case json.Number:
		if v, err := ParseJSON([]byte(t)); err == nil && v.k == kNumber {
			return v
		}
		return stringValue(string(t))
	case json.RawMessage:
		if v, err := ParseJSON(t); err == nil {
			return v
		}
		return Null
	case time.Time:
		return stringValue(t.UTC().Format("2006-01-02T15:04:05.000Z"))
	case []any:
		out := make([]Value, len(t))
		for i, e := range t {
			out[i] = FromGo(e)
		}
		return Value{k: kArray, a: out}
	case []string:
		out := make([]Value, len(t))
		for i, e := range t {
			out[i] = stringValue(e)
		}
		return Value{k: kArray, a: out}
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := newObject()
		for _, k := range keys {
			o.set(k, FromGo(t[k]))
		}
		return Value{k: kObject, o: o}
	}
	rv := reflect.ValueOf(x)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return Null
		}
		return FromGo(rv.Elem().Interface())
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			return Null
		}
		if rv.Type().Elem().Kind() != reflect.Uint8 {
			out := make([]Value, rv.Len())
			for i := range out {
				out[i] = FromGo(rv.Index(i).Interface())
			}
			return Value{k: kArray, a: out}
		}
	case reflect.Map:
		if rv.Type().Key().Kind() == reflect.String {
			if rv.IsNil() {
				return Null
			}
			keys := make([]string, 0, rv.Len())
			for _, k := range rv.MapKeys() {
				keys = append(keys, k.String())
			}
			sort.Strings(keys)
			o := newObject()
			for _, k := range keys {
				o.set(k, FromGo(rv.MapIndex(reflect.ValueOf(k).Convert(rv.Type().Key())).Interface()))
			}
			return Value{k: kObject, o: o}
		}
	case reflect.Bool:
		return boolValue(rv.Bool())
	case reflect.String:
		return stringValue(rv.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return numberValue(float64(rv.Int()))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return numberValue(float64(rv.Uint()))
	case reflect.Float32, reflect.Float64:
		return numberValue(rv.Float())
	}
	data, err := json.Marshal(x)
	if err != nil {
		return Null
	}
	v, err := ParseJSON(data)
	if err != nil {
		return Null
	}
	return v
}

// Go converts v to plain Go data: nil (null and undefined), bool, float64, string, []any and
// map[string]any. Map order is lost; use JSON for the exact text.
func (v Value) Go() any {
	switch v.k {
	case kBool:
		return v.b
	case kNumber:
		return v.n
	case kString:
		return v.s
	case kArray:
		out := make([]any, len(v.a))
		for i, e := range v.a {
			out[i] = e.Go()
		}
		return out
	case kObject:
		out := make(map[string]any, len(v.o.m))
		for k, e := range v.o.m {
			if e.k != kUndefined {
				out[k] = e.Go()
			}
		}
		return out
	}
	return nil
}

// MarshalJSON encodes v exactly as JSON.stringify does (undefined encodes as null).
func (v Value) MarshalJSON() ([]byte, error) {
	s, ok := v.JSON()
	if !ok {
		return []byte("null"), nil
	}
	return []byte(s), nil
}

// UnmarshalJSON decodes JSON text with JSON.parse semantics.
func (v *Value) UnmarshalJSON(data []byte) error {
	x, err := ParseJSON(data)
	if err != nil {
		return err
	}
	*v = x
	return nil
}

// TypeName is the engine's typeOf: "null", "array", or the JavaScript typeof.
func (v Value) TypeName() string {
	switch v.k {
	case kUndefined:
		return "undefined"
	case kNull:
		return "null"
	case kBool:
		return "boolean"
	case kNumber:
		return "number"
	case kString:
		return "string"
	case kArray:
		return "array"
	case kFunction:
		return "function"
	}
	return "object"
}

// Bool returns the value of a boolean Value.
func (v Value) Bool() (bool, bool) { return v.b, v.k == kBool }

// Number returns the value of a finite number Value.
func (v Value) Number() (float64, bool) {
	return v.n, v.k == kNumber && !math.IsNaN(v.n) && !math.IsInf(v.n, 0)
}

// Str returns the value of a string Value.
func (v Value) Str() (string, bool) { return v.s, v.k == kString }

// Keys returns the own keys of an object Value in JavaScript order (nil for other values).
func (v Value) Keys() []string {
	if v.k != kObject {
		return nil
	}
	return v.o.keys()
}

// Field returns the own property name of an object Value.
func (v Value) Field(name string) Value { return own(v, name) }

// Len returns the number of elements of an array Value.
func (v Value) Len() int { return len(v.a) }

// Index returns element i of an array Value.
func (v Value) Index(i int) Value {
	if v.k != kArray || i < 0 || i >= len(v.a) {
		return Undefined
	}
	return v.a[i]
}

// IsArray, IsObject and IsString report the shape of v.
func (v Value) IsArray() bool  { return v.k == kArray }
func (v Value) IsObject() bool { return v.k == kObject }
func (v Value) IsString() bool { return v.k == kString }
func (v Value) IsNumber() bool { return v.k == kNumber }
func (v Value) IsBool() bool   { return v.k == kBool }
