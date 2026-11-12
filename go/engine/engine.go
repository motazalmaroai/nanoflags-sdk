// Package engine is the NanoFlags evaluation engine: a byte-for-byte port of the TypeScript
// engine (`@nanoflags/engine`) that the dashboard, the edge Worker and every SDK share.
//
// It is pure and deterministic: the same bundle, flag key and context always produce the same
// result, including the bucket of percentage rollouts (MurmurHash3 x86 32-bit over the NFC-
// normalised UTF-8 bytes of "seed:identity"). Rules are data; no user code ever runs.
//
// Configuration is JSON evaluated with JavaScript semantics, so the engine works on Value, a
// JSON value that behaves like its JavaScript counterpart. The cross-language parity fixtures
// (packages/engine/fixtures/parity.json) pin the behaviour, malformed configurations included.
package engine

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Version is the engine version this package implements (ENGINE_VERSION of the TypeScript engine).
// Bundles whose `engine` is newer are refused by SDKs.
const Version = 1

// Reason says why an evaluation produced its value.
type Reason string

const (
	ReasonRuleMatch    Reason = "rule_match"
	ReasonDefault      Reason = "default"
	ReasonOff          Reason = "off"
	ReasonFlagNotFound Reason = "flag_not_found"
	ReasonError        Reason = "error"
)

// TraceStep is one line of the human-readable explanation of an evaluation.
type TraceStep struct {
	Kind   string `json:"kind"` // "config", "rule", "allocation" or "result"
	Title  string `json:"title"`
	Detail string `json:"detail"`
	// Matched is set for rule and allocation steps.
	Matched *bool `json:"matched,omitempty"`
}

// Result is the full outcome of Evaluate, mirroring the engine's Evaluation object.
type Result struct {
	FlagKey string
	// Value is the served value. It is Undefined when the configuration served nothing (a
	// malformed flag without an `off` value, for example).
	Value  Value
	Reason Reason
	// RuleIndex is the zero-based index of the matching rule, or -1.
	RuleIndex int
	// RuleID is the matching rule's `id` (Undefined when there is none).
	RuleID Value
	// InRollout and Bucket are set for percentage rollouts that bucketed the context.
	InRollout *bool
	Bucket    *float64
	// Revision is the bundle's `revision` (0 without a bundle).
	Revision Value
	Trace    []TraceStep
	// Err is the evaluation error message (reason "error" only).
	Err string
}

// Context lookup: the engine only ever reads own attributes by name.
type Context interface {
	// Lookup returns the attribute and whether it exists (an absent attribute is `undefined`).
	Lookup(name string) (Value, bool)
}

// MapContext adapts a Go map; values are converted with FromGo when they are read.
type MapContext map[string]any

func (m MapContext) Lookup(name string) (Value, bool) {
	x, ok := m[name]
	if !ok {
		return Undefined, false
	}
	return FromGo(x), true
}

// ValueContext is a context held as an object Value (as parsed from JSON).
type ValueContext struct{ V Value }

func (c ValueContext) Lookup(name string) (Value, bool) {
	if c.V.k != kObject {
		return Undefined, false
	}
	return c.V.o.get(name)
}

func lookup(ctx Context, name string) Value {
	if ctx == nil {
		return Undefined
	}
	v, ok := ctx.Lookup(name)
	if !ok {
		return Undefined
	}
	return v
}

/* ---------------- hashing ---------------- */

// hashInput is `TextEncoder.encode(input.normalize("NFC"))`: lone surrogates and invalid bytes
// become U+FFFD; valid runs are NFC-normalised (a lone surrogate never composes with neighbours).
func hashInput(s string) []byte {
	if utf8.ValidString(s) {
		return norm.NFC.Bytes([]byte(s))
	}
	var out, run []byte
	flush := func() {
		if len(run) > 0 {
			out = append(out, norm.NFC.Bytes(run)...)
			run = run[:0]
		}
	}
	codePoints(s, func(r rune, size int) {
		if (r >= 0xD800 && r <= 0xDFFF) || r == utf8.RuneError && size == 1 {
			flush()
			out = utf8.AppendRune(out, utf8.RuneError)
			return
		}
		run = utf8.AppendRune(run, r)
	})
	flush()
	return out
}

// Murmur3 is MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of input. Used for
// distribution only — never for security.
func Murmur3(input string, seed uint32) uint32 {
	data := hashInput(input)
	const c1, c2 = 0xcc9e2d51, 0x1b873593
	h := seed
	n := len(data)
	blocks := n / 4
	for i := 0; i < blocks; i++ {
		o := i * 4
		k := uint32(data[o]) | uint32(data[o+1])<<8 | uint32(data[o+2])<<16 | uint32(data[o+3])<<24
		k *= c1
		k = k<<15 | k>>17
		k *= c2
		h ^= k
		h = h<<13 | h>>19
		h = h*5 + 0xe6546b64
	}
	var k uint32
	tail := blocks * 4
	switch n & 3 {
	case 3:
		k ^= uint32(data[tail+2]) << 16
		fallthrough
	case 2:
		k ^= uint32(data[tail+1]) << 8
		fallthrough
	case 1:
		k ^= uint32(data[tail])
		k *= c1
		k = k<<15 | k>>17
		k *= c2
		h ^= k
	}
	h ^= uint32(n)
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return h
}

// BucketOf returns the bucket in [0, 100) with two decimals of resolution for seed + identity.
func BucketOf(seed, identity string) float64 {
	return float64(Murmur3(seed+":"+identity, 0)%10000) / 100
}

/* ---------------- conditions ---------------- */

func looseEq(a, b Value) bool {
	if a.k == kUndefined || b.k == kUndefined {
		return false
	}
	isObj := func(v Value) bool { return v.k == kNull || v.k == kArray || v.k == kObject }
	if isObj(a) || isObj(b) {
		as, aok := a.JSON()
		bs, bok := b.JSON()
		return aok == bok && as == bs
	}
	return strictEq(a, b)
}

func strictEq(a, b Value) bool {
	if a.k != b.k {
		return false
	}
	switch a.k {
	case kUndefined, kNull:
		return true
	case kBool:
		return a.b == b.b
	case kNumber:
		return a.n == b.n
	case kString:
		return a.s == b.s
	}
	return false // objects compare by identity; looseEq never compares them this way
}

func num(v Value) (float64, bool) {
	if v.k == kNumber && !math.IsNaN(v.n) && !math.IsInf(v.n, 0) {
		return v.n, true
	}
	if v.k == kString && jsTrim(v.s) != "" {
		if n := stringToNumber(v.s); !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n, true
		}
	}
	return 0, false
}

func isStr(v Value, s string) bool { return v.k == kString && v.s == s }

// utf16Contains / prefix / suffix work on code units, like String.prototype.includes & co.
func toUnits(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	codePoints(s, func(r rune, _ int) {
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	})
	return out
}

func unitsIndex(h, n []uint16) bool {
	if len(n) > len(h) {
		return false
	}
outer:
	for i := 0; i+len(n) <= len(h); i++ {
		for j := range n {
			if h[i+j] != n[j] {
				continue outer
			}
		}
		return true
	}
	return false
}

func jsIncludes(h, n string) bool {
	if utf8.ValidString(h) && utf8.ValidString(n) {
		// For well-formed strings a code-unit match always starts and ends on code point boundaries.
		return strings.Contains(h, n)
	}
	return unitsIndex(toUnits(h), toUnits(n))
}

// matchCondition is the engine's matchCondition(c, ctx, segments, depth).
func matchCondition(c Value, ctx Context, segments Value, depth int) (bool, error) {
	op, err := c.get("op")
	if err != nil {
		return false, err
	}
	if isStr(op, "segment") || isStr(op, "not_segment") {
		value, _ := c.get("value")
		seg := Undefined
		if value.k == kString {
			seg = own(segments, value.s)
		}
		inSeg := false
		if seg.k != kUndefined && depth < 4 {
			match, err := seg.get("match")
			if err != nil {
				return false, err
			}
			conds, _ := seg.get("conditions")
			inSeg, err = matchAll(match, conds, ctx, segments, depth+1)
			if err != nil {
				return false, err
			}
		}
		if isStr(op, "segment") {
			return inSeg, nil
		}
		return seg.k != kUndefined && !inSeg, nil
	}
	attribute, _ := c.get("attribute")
	actual := lookup(ctx, attribute.toString())
	value, _ := c.get("value")
	if op.k != kString {
		return false, nil
	}
	switch op.s {
	case "exists":
		return actual.k != kUndefined && actual.k != kNull, nil
	case "not_exists":
		return actual.k == kUndefined || actual.k == kNull, nil
	case "eq":
		return looseEq(actual, value), nil
	case "neq":
		return actual.k != kUndefined && !looseEq(actual, value), nil
	case "in":
		if value.k != kArray {
			return false, nil
		}
		for _, v := range value.a {
			if looseEq(actual, v) {
				return true, nil
			}
		}
		return false, nil
	case "not_in":
		if actual.k == kUndefined || value.k != kArray {
			return false, nil
		}
		for _, v := range value.a {
			if looseEq(actual, v) {
				return false, nil
			}
		}
		return true, nil
	case "contains":
		return actual.k == kString && value.k == kString && jsIncludes(actual.s, value.s), nil
	case "starts_with":
		if actual.k != kString || value.k != kString {
			return false, nil
		}
		if utf8.ValidString(actual.s) && utf8.ValidString(value.s) {
			return strings.HasPrefix(actual.s, value.s), nil
		}
		a, b := toUnits(actual.s), toUnits(value.s)
		return len(b) <= len(a) && unitsIndex(a[:len(b)], b), nil
	case "ends_with":
		if actual.k != kString || value.k != kString {
			return false, nil
		}
		if utf8.ValidString(actual.s) && utf8.ValidString(value.s) {
			return strings.HasSuffix(actual.s, value.s), nil
		}
		a, b := toUnits(actual.s), toUnits(value.s)
		return len(b) <= len(a) && unitsIndex(a[len(a)-len(b):], b), nil
	case "gt", "gte", "lt", "lte":
		a, aok := num(actual)
		b, bok := num(value)
		if !aok || !bok {
			return false, nil
		}
		switch op.s {
		case "gt":
			return a > b, nil
		case "gte":
			return a >= b, nil
		case "lt":
			return a < b, nil
		}
		return a <= b, nil
	}
	return false, nil
}

// matchAll is the engine's matchAll(mode, conditions, …), including its failure modes.
func matchAll(mode, conditions Value, ctx Context, segments Value, depth int) (bool, error) {
	length, err := conditions.get("length")
	if err != nil {
		return false, err
	}
	if length.k == kNumber && length.n == 0 {
		return true, nil
	}
	method := "every"
	if isStr(mode, "any") {
		method = "some"
	}
	if conditions.k != kArray {
		return false, &typeError{"conditions." + method + " is not a function"}
	}
	for _, c := range conditions.a {
		ok, err := matchCondition(c, ctx, segments, depth)
		if err != nil {
			return false, err
		}
		if method == "some" && ok {
			return true, nil
		}
		if method == "every" && !ok {
			return false, nil
		}
	}
	return method == "every", nil
}

var opWords = map[string]string{
	"eq": "=", "neq": "≠", "in": "in", "not_in": "not in", "contains": "contains", "starts_with": "starts with", "ends_with": "ends with",
	"gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "exists": "exists", "not_exists": "does not exist", "segment": "in segment", "not_segment": "not in segment",
}

func describeCondition(c Value) (string, error) {
	value, err := c.get("value")
	if err != nil {
		return "", err
	}
	var v string
	switch {
	case value.k == kArray:
		v = value.join(", ")
	case value.k == kUndefined:
		v = ""
	default:
		v = value.toString()
	}
	op, _ := c.get("op")
	key := op.toString()
	word, ok := opWords[key]
	if !ok {
		if s, proto := objectProtoStrings[key]; proto {
			word = s
		} else {
			word = "undefined"
		}
	}
	if isStr(op, "segment") || isStr(op, "not_segment") {
		return word + " " + v, nil
	}
	attribute, _ := c.get("attribute")
	if isStr(op, "exists") || isStr(op, "not_exists") {
		return attribute.toString() + " " + word, nil
	}
	return attribute.toString() + " " + word + " " + v, nil
}

// fmtValue is the engine's fmt(v): strings as they are, everything else as JSON.
func fmtValue(v Value) string {
	if v.k == kString {
		return v.s
	}
	if s, ok := v.JSON(); ok {
		return s
	}
	return "undefined"
}

/* ---------------- evaluation ---------------- */

func ptrBool(b bool) *bool { return &b }

// Evaluate evaluates one flag of bundle (a parsed bundle document; Undefined or Null for "no
// configuration loaded"). It never panics: on any problem it returns fallback with reason
// flag_not_found or error.
func Evaluate(bundle Value, flagKey string, ctx Context, fallback Value) (res Result) {
	revision := numberValue(0)
	nullish := bundle.k == kUndefined || bundle.k == kNull
	if !nullish {
		if r, _ := bundle.get("revision"); r.k != kUndefined && r.k != kNull {
			revision = r
		}
	}
	res = Result{FlagKey: flagKey, RuleIndex: -1, Revision: revision}
	defer func() {
		if p := recover(); p != nil {
			msg := fmt.Sprint(p)
			res = Result{FlagKey: flagKey, Value: fallback, Reason: ReasonError, RuleIndex: -1, Revision: revision, Err: msg,
				Trace: append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(fallback), Detail: "Evaluation error: " + msg + ". The application fallback applies."})}
		}
	}()
	fail := func(err error) Result {
		msg := err.Error()
		res.Trace = append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(fallback), Detail: "Evaluation error: " + msg + ". The application fallback applies."})
		return Result{FlagKey: flagKey, Value: fallback, Reason: ReasonError, RuleIndex: -1, Revision: revision, Trace: res.Trace, Err: msg}
	}
	var flag Value
	if !nullish {
		flags, _ := bundle.get("flags")
		flag = own(flags, flagKey)
	}
	if !bundle.truthy() || !flag.truthy() {
		detail := "No configuration is loaded. The application fallback applies."
		if bundle.truthy() {
			detail = "Flag is not in this configuration. The application fallback applies."
		}
		res.Trace = append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(fallback), Detail: detail})
		res.Value, res.Reason = fallback, ReasonFlagNotFound
		return res
	}
	cfgDetail := "draft"
	if revision.toNumber() > 0 {
		cfgDetail = "r" + revision.toString()
	}
	res.Trace = append(res.Trace, TraceStep{Kind: "config", Title: "Configuration loaded", Detail: cfgDetail})
	enabled, _ := flag.get("enabled")
	if !enabled.truthy() {
		off, _ := flag.get("off")
		res.Trace = append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(off), Detail: "Flag is disabled in this environment."})
		res.Value, res.Reason = off, ReasonOff
		return res
	}
	rules, _ := flag.get("rules")
	segments, _ := bundle.get("segments")
	for i := 0; ; i++ {
		length, err := rules.get("length")
		if err != nil {
			return fail(err)
		}
		if !lessThan(float64(i), length) {
			break
		}
		rule, _ := rules.get(strconv.Itoa(i))
		match, err := rule.get("match")
		if err != nil {
			return fail(err)
		}
		conditions, _ := rule.get("conditions")
		matched, err := matchAll(match, conditions, ctx, segments, 0)
		if err != nil {
			return fail(err)
		}
		label := fmt.Sprintf("Rule %02d", i+1)
		summary := "all contexts"
		if l, _ := conditions.get("length"); l.truthy() {
			parts := make([]string, 0, len(conditions.a))
			for _, c := range conditions.a {
				d, err := describeCondition(c)
				if err != nil {
					return fail(err)
				}
				parts = append(parts, d)
			}
			sep := " AND "
			if isStr(match, "any") {
				sep = " OR "
			}
			summary = strings.Join(parts, sep)
		}
		title := label + " did not match"
		if matched {
			title = label + " matched"
		}
		res.Trace = append(res.Trace, TraceStep{Kind: "rule", Title: title, Detail: summary, Matched: ptrBool(matched)})
		if !matched {
			continue
		}
		serve, _ := rule.get("serve")
		serveType, err := serve.get("type")
		if err != nil {
			return fail(err)
		}
		ruleID, _ := rule.get("id")
		res.RuleIndex, res.RuleID, res.Reason = i, ruleID, ReasonRuleMatch
		if isStr(serveType, "fixed") {
			value, _ := serve.get("value")
			res.Trace = append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(value), Detail: label + " serves a fixed value."})
			res.Value = value
			return res
		}
		attrV, _ := serve.get("bucketBy")
		attr := "key"
		if attrV.k != kUndefined && attrV.k != kNull {
			attr = attrV.toString()
		}
		identity := lookup(ctx, attr)
		otherwise, _ := serve.get("otherwise")
		if identity.k == kUndefined || identity.k == kNull || isStr(identity, "") {
			res.Trace = append(res.Trace,
				TraceStep{Kind: "allocation", Title: "Allocation skipped", Detail: `Context has no "` + attr + `" to bucket by; treated as outside the allocation.`, Matched: ptrBool(false)},
				TraceStep{Kind: "result", Title: "Returned " + fmtValue(otherwise), Detail: "Remaining eligible users."})
			res.Value, res.InRollout = otherwise, ptrBool(false)
			return res
		}
		seedV, _ := serve.get("seed")
		seed := flagKey
		if seedV.k != kUndefined && seedV.k != kNull {
			seed = seedV.toString()
		}
		bucket := BucketOf(seed, identity.toString())
		percentage, _ := serve.get("percentage")
		inRollout := lessThan(bucket, percentage)
		pct := percentage.toString()
		side := "outside"
		if inRollout {
			side = "inside"
		}
		res.Trace = append(res.Trace, TraceStep{Kind: "allocation", Title: "Allocation evaluated", Detail: fmt.Sprintf("%s%% rollout · %s %s allocation (bucket %s)", pct, attr, side, strconv.FormatFloat(bucket, 'f', 2, 64)), Matched: ptrBool(inRollout)})
		value, _ := serve.get("value")
		detail := "Remaining eligible users."
		if inRollout {
			detail = "Inside the " + pct + "% allocation."
		} else {
			value = otherwise
		}
		res.Trace = append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(value), Detail: detail})
		res.Value, res.InRollout, res.Bucket = value, ptrBool(inRollout), &bucket
		return res
	}
	def, _ := flag.get("default")
	res.Trace = append(res.Trace, TraceStep{Kind: "result", Title: "Returned " + fmtValue(def), Detail: "No rule matched. The flag default applies."})
	res.Value, res.Reason = def, ReasonDefault
	return res
}

// SupportsEngine reports whether this engine can evaluate a bundle whose `engine` member is e
// (Undefined when the bundle has none): absent, or an integer between 1 and Version.
func SupportsEngine(e Value) bool {
	if e.k == kUndefined {
		return true
	}
	return e.k == kNumber && e.n == math.Trunc(e.n) && e.n >= 1 && e.n <= Version
}
