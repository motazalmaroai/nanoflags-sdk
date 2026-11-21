package engine

import "math"

// Version (semver_*) and date (before / after) operators: the engine's parseSemver, compareSemver and parseInstant.
// Inputs are compared byte-wise as ASCII; any non-ASCII byte (including lone surrogates in WTF-8) makes a value invalid,
// exactly as the TypeScript engine's character checks do.

const maxVersionLength = 256

type semVer struct {
	core [3]string
	pre  []string
}

func isDigitByte(c byte) bool { return c >= '0' && c <= '9' }
func isIdentByte(c byte) bool {
	return isDigitByte(c) || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-'
}

func stripZeros(d string) string {
	i := 0
	for i < len(d)-1 && d[i] == '0' {
		i++
	}
	return d[i:]
}

func allDigitsStr(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isDigitByte(s[i]) {
			return false
		}
	}
	return true
}

// parseSemver returns the parsed version of v, or false when v is not a string or not a (lenient) semantic version.
func parseSemver(v Value) (semVer, bool) {
	var out semVer
	if v.k != kString || len(v.s) == 0 || len(v.s) > 4*maxVersionLength {
		return out, false
	}
	s := v.s
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return out, false
		}
	}
	if len(s) > maxVersionLength {
		return out, false
	}
	i := 0
	if s[0] == 'v' || s[0] == 'V' {
		i = 1
	}
	n := 0
	for {
		start := i
		for i < len(s) && isDigitByte(s[i]) {
			i++
		}
		if i == start {
			return out, false
		}
		out.core[n] = stripZeros(s[start:i])
		n++
		if n < 3 && i < len(s) && s[i] == '.' {
			i++
			continue
		}
		break
	}
	for ; n < 3; n++ {
		out.core[n] = "0"
	}
	idents := func(from int, stopAtPlus bool) ([]string, int, bool) {
		var list []string
		j, start := from, from
		for {
			if j < len(s) && isIdentByte(s[j]) {
				j++
				continue
			}
			if j == start {
				return nil, 0, false
			}
			list = append(list, s[start:j])
			if j < len(s) && s[j] == '.' {
				j++
				start = j
				continue
			}
			if j == len(s) || (stopAtPlus && s[j] == '+') {
				return list, j, true
			}
			return nil, 0, false
		}
	}
	if i < len(s) && s[i] == '-' {
		list, j, ok := idents(i+1, true)
		if !ok {
			return out, false
		}
		out.pre, i = list, j
	}
	if i < len(s) && s[i] == '+' {
		_, j, ok := idents(i+1, false)
		if !ok {
			return out, false
		}
		i = j
	}
	if i != len(s) {
		return out, false
	}
	return out, true
}

func compareDigits(a, b string) int {
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func compareSemver(a, b semVer) int {
	for i := 0; i < 3; i++ {
		if c := compareDigits(a.core[i], b.core[i]); c != 0 {
			return c
		}
	}
	if len(a.pre) == 0 || len(b.pre) == 0 {
		switch {
		case len(a.pre) == len(b.pre):
			return 0
		case len(a.pre) == 0:
			return 1
		}
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		x, y := a.pre[i], b.pre[i]
		xn, yn := allDigitsStr(x), allDigitsStr(y)
		var c int
		switch {
		case xn && yn:
			c = compareDigits(stripZeros(x), stripZeros(y))
		case xn:
			c = -1
		case yn:
			c = 1
		case x < y:
			c = -1
		case x > y:
			c = 1
		}
		if c != 0 {
			return c
		}
	}
	switch {
	case len(a.pre) == len(b.pre):
		return 0
	case len(a.pre) < len(b.pre):
		return -1
	}
	return 1
}

func matchSemver(op string, actual, expected Value) bool {
	a, ok := parseSemver(actual)
	if !ok {
		return false
	}
	b, ok := parseSemver(expected)
	if !ok {
		return false
	}
	c := compareSemver(a, b)
	switch op {
	case "semver_eq":
		return c == 0
	case "semver_neq":
		return c != 0
	case "semver_gt":
		return c > 0
	case "semver_gte":
		return c >= 0
	case "semver_lt":
		return c < 0
	}
	return c <= 0
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func daysFromCivil(y, m, d int64) int64 {
	if m <= 2 {
		y--
	}
	era := floorDiv(y, 400)
	yoe := y - era*400
	mp := m - 3
	if m <= 2 {
		mp = m + 9
	}
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

// digitsAt reads exactly n ASCII digits of s at i.
func digitsAt(s string, i, n int) (int64, bool) {
	if i+n > len(s) {
		return 0, false
	}
	var v int64
	for j := i; j < i+n; j++ {
		if !isDigitByte(s[j]) {
			return 0, false
		}
		v = v*10 + int64(s[j]-'0')
	}
	return v, true
}

// parseInstant is the engine's parseInstant: epoch milliseconds, or false.
func parseInstant(v Value) (float64, bool) {
	if v.k == kNumber {
		if math.IsNaN(v.n) || math.IsInf(v.n, 0) {
			return 0, false
		}
		if math.Abs(v.n) >= 1e12 {
			return v.n, true
		}
		return v.n * 1000, true
	}
	if v.k != kString || len(v.s) > 4*maxVersionLength {
		return 0, false
	}
	s := v.s
	y, ok1 := digitsAt(s, 0, 4)
	mo, ok2 := digitsAt(s, 5, 2)
	d, ok3 := digitsAt(s, 8, 2)
	if !ok1 || !ok2 || !ok3 || s[4] != '-' || s[7] != '-' {
		return 0, false
	}
	if mo < 1 || mo > 12 || d < 1 {
		return 0, false
	}
	leap := y%4 == 0 && (y%100 != 0 || y%400 == 0)
	dim := int64(31)
	switch mo {
	case 2:
		dim = 28
		if leap {
			dim = 29
		}
	case 4, 6, 9, 11:
		dim = 30
	}
	if d > dim {
		return 0, false
	}
	ms := daysFromCivil(y, mo, d) * 86400000
	if len(s) == 10 {
		return float64(ms), true
	}
	if c := s[10]; c != 'T' && c != 't' && c != ' ' {
		return 0, false
	}
	h, ok1 := digitsAt(s, 11, 2)
	mi, ok2 := digitsAt(s, 14, 2)
	if !ok1 || !ok2 || s[13] != ':' {
		return 0, false
	}
	i := 16
	var sec, frac int64
	if i < len(s) && s[i] == ':' {
		var ok bool
		if sec, ok = digitsAt(s, i+1, 2); !ok {
			return 0, false
		}
		i += 3
		if i < len(s) && s[i] == '.' {
			start := i + 1
			j := start
			for j < len(s) && isDigitByte(s[j]) {
				j++
			}
			if j == start || j-start > 9 {
				return 0, false
			}
			f := s[start:j] + "00"
			frac, _ = digitsAt(f, 0, 3)
			i = j
		}
	}
	if h > 23 || mi > 59 || sec > 59 || i >= len(s) {
		return 0, false
	}
	ms += h*3600000 + mi*60000 + sec*1000 + frac
	switch z := s[i]; {
	case (z == 'Z' || z == 'z') && i+1 == len(s):
	case (z == '+' || z == '-') && i+6 == len(s) && s[i+3] == ':':
		oh, ok1 := digitsAt(s, i+1, 2)
		om, ok2 := digitsAt(s, i+4, 2)
		if !ok1 || !ok2 || oh > 23 || om > 59 {
			return 0, false
		}
		off := (oh*60 + om) * 60000
		if z == '-' {
			ms += off
		} else {
			ms -= off
		}
	default:
		return 0, false
	}
	return float64(ms), true
}

func matchDate(op string, actual, expected Value) bool {
	a, ok := parseInstant(actual)
	if !ok {
		return false
	}
	b, ok := parseInstant(expected)
	if !ok {
		return false
	}
	if op == "before" {
		return a < b
	}
	return a > b
}
