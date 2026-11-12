package engine

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The parity fixtures are generated from the TypeScript engine by
// packages/engine/fixtures/generate-parity.mjs (shared with the other ports) and, for the
// JavaScript corner cases that file leaves out, by internal/testdata/generate-extra.mjs.
var parityCandidates = []string{
	"../../engine/fixtures/parity.json",          // monorepo: packages/sdk-go/engine
	"../../packages/engine/fixtures/parity.json", // public repository: go/engine
}

func loadFixture(t *testing.T, candidates ...string) (Value, string) {
	t.Helper()
	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		v, err := ParseJSON(data)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		abs, _ := filepath.Abs(p)
		return v, abs
	}
	t.Skipf("parity fixtures not found (looked in %v)", candidates)
	return Undefined, ""
}

func js(v Value) string {
	s, ok := v.JSON()
	if !ok {
		return "undefined"
	}
	return s
}

// canonical renders an evaluation the way the fixture generator's expectedOf does, with a fixed
// key order, so that results are compared as text.
func canonicalResult(r Result, withTrace, maskErrorDetail bool) string {
	var b strings.Builder
	b.WriteString(`{"reason":` + strconv.Quote(string(r.Reason)) + `,"revision":` + js(r.Revision))
	if !r.Value.IsUndefined() {
		b.WriteString(`,"value":` + js(r.Value))
	}
	if r.RuleIndex >= 0 {
		b.WriteString(`,"ruleIndex":` + strconv.Itoa(r.RuleIndex))
	}
	if !r.RuleID.IsUndefined() && r.RuleIndex >= 0 {
		b.WriteString(`,"ruleId":` + js(r.RuleID))
	}
	if r.InRollout != nil {
		b.WriteString(`,"inRollout":` + strconv.FormatBool(*r.InRollout))
	}
	if r.Bucket != nil {
		b.WriteString(`,"bucket":` + numberToString(*r.Bucket))
	}
	if r.Reason == ReasonError {
		b.WriteString(`,"error":true`)
	}
	if withTrace {
		b.WriteString(`,"trace":[`)
		for i, s := range r.Trace {
			if i > 0 {
				b.WriteByte(',')
			}
			detail := s.Detail
			if maskErrorDetail && i == len(r.Trace)-1 {
				detail = "<error>"
			}
			var sb strings.Builder
			quoteJSON(&sb, s.Kind)
			sb.WriteString(`,"title":`)
			quoteJSON(&sb, s.Title)
			sb.WriteString(`,"detail":`)
			quoteJSON(&sb, detail)
			b.WriteString(`{"kind":` + sb.String())
			if s.Matched != nil {
				b.WriteString(`,"matched":` + strconv.FormatBool(*s.Matched))
			}
			b.WriteByte('}')
		}
		b.WriteByte(']')
	}
	b.WriteByte('}')
	return b.String()
}

func canonicalExpected(e Value, maskErrorDetail bool) string {
	var b strings.Builder
	b.WriteString(`{"reason":` + js(e.Field("reason")) + `,"revision":` + js(e.Field("revision")))
	for _, k := range []string{"value", "ruleIndex", "ruleId", "inRollout", "bucket", "error"} {
		if v := e.Field(k); !v.IsUndefined() {
			b.WriteString(`,"` + k + `":` + js(v))
		}
	}
	if tr := e.Field("trace"); !tr.IsUndefined() {
		b.WriteString(`,"trace":[`)
		for i := 0; i < tr.Len(); i++ {
			s := tr.Index(i)
			if i > 0 {
				b.WriteByte(',')
			}
			detail := s.Field("detail")
			if maskErrorDetail && i == tr.Len()-1 {
				detail = stringValue("<error>")
			}
			b.WriteString(`{"kind":` + js(s.Field("kind")) + `,"title":` + js(s.Field("title")) + `,"detail":` + js(detail))
			if m := s.Field("matched"); !m.IsUndefined() {
				b.WriteString(`,"matched":` + js(m))
			}
			b.WriteByte('}')
		}
		b.WriteByte(']')
	}
	b.WriteByte('}')
	return b.String()
}

// runCases evaluates every case of a fixture document and returns the number checked.
func runCases(t *testing.T, doc Value, compareErrorMessages bool) int {
	bundles, contexts, cases := doc.Field("bundles"), doc.Field("contexts"), doc.Field("cases")
	failures := 0
	for i := 0; i < cases.Len(); i++ {
		c := cases.Index(i)
		name, _ := c.Field("name").Str()
		bi, _ := c.Field("bundle").Number()
		ci, _ := c.Field("context").Number()
		flag, _ := c.Field("flag").Str()
		bundle := Null
		if bi >= 0 {
			bundle = bundles.Index(int(bi))
		}
		expected := c.Field("expected")
		withTrace := !expected.Field("trace").IsUndefined()
		mask := !expected.Field("error").IsUndefined() && !compareErrorMessages
		got := Evaluate(bundle, flag, ValueContext{contexts.Index(int(ci))}, c.Field("fallback"))
		g, w := canonicalResult(got, withTrace, mask), canonicalExpected(expected, mask)
		if compareErrorMessages {
			if msg := expected.Field("errorMessage"); !msg.IsUndefined() {
				if m, _ := msg.Str(); m != got.Err {
					g += " err=" + strconv.Quote(got.Err)
					w += " err=" + strconv.Quote(m)
				}
			}
		}
		if g != w {
			failures++
			if failures <= 20 {
				t.Errorf("case %d %q\n got: %s\nwant: %s", i, name, g, w)
			}
		}
	}
	if failures > 0 {
		t.Fatalf("%d of %d cases differ", failures, cases.Len())
	}
	return cases.Len()
}

func TestParityEvaluate(t *testing.T) {
	doc, path := loadFixture(t, parityCandidates...)
	if v, _ := doc.Field("engineVersion").Number(); v != Version {
		t.Fatalf("fixtures are for engine %v, this package implements %d", v, Version)
	}
	n := runCases(t, doc, false)
	t.Logf("%d evaluation cases identical (%s)", n, path)
}

func TestParityExtra(t *testing.T) {
	doc, path := loadFixture(t, "../internal/testdata/extra.json")
	n := runCases(t, doc, true)
	t.Logf("%d extra evaluation cases identical, error messages included (%s)", n, path)
}

func TestParityHashing(t *testing.T) {
	doc, _ := loadFixture(t, parityCandidates...)
	m := doc.Field("murmur3")
	for i := 0; i < m.Len(); i++ {
		c := m.Index(i)
		input, _ := c.Field("input").Str()
		seed, _ := c.Field("seed").Number()
		want, _ := c.Field("hash").Number()
		if got := Murmur3(input, uint32(seed)); float64(got) != want {
			t.Errorf("murmur3(%q, %v) = %d, want %v", input, seed, got, want)
		}
	}
	b := doc.Field("buckets")
	for i := 0; i < b.Len(); i++ {
		c := b.Index(i)
		seed, _ := c.Field("seed").Str()
		identity, _ := c.Field("identity").Str()
		want, _ := c.Field("bucket").Number()
		if got := BucketOf(seed, identity); got != want {
			t.Errorf("bucketOf(%q, %q) = %v, want %v", seed, identity, got, want)
		}
	}
	t.Logf("%d murmur3 vectors and %d buckets identical", m.Len(), b.Len())
}

func TestParitySupportsEngine(t *testing.T) {
	doc, _ := loadFixture(t, parityCandidates...)
	s := doc.Field("supportsEngine")
	for i := 0; i < s.Len(); i++ {
		c := s.Index(i)
		want, _ := c.Field("expected").Bool()
		if got := SupportsEngine(c.Field("bundle").Field("engine")); got != want {
			t.Errorf("supportsEngine(%s) = %v, want %v", js(c.Field("bundle")), got, want)
		}
	}
}
