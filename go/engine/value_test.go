package engine

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestNumberToString(t *testing.T) {
	for f, want := range map[float64]string{
		0: "0", 1: "1", -1: "-1", 1.5: "1.5", 100: "100", 1e21: "1e+21", 1e20: "100000000000000000000", 1e-7: "1e-7",
		0.000001: "0.000001", 123456789012: "123456789012", 0.30000000000000004: "0.30000000000000004", 33.33: "33.33", -0.5: "-0.5",
		1.7976931348623157e308: "1.7976931348623157e+308", 5e-324: "5e-324", 9007199254740993: "9007199254740992", 1.25e-7: "1.25e-7",
		math.Inf(1): "Infinity", math.Inf(-1): "-Infinity",
	} {
		if got := numberToString(f); got != want {
			t.Errorf("numberToString(%v) = %q, want %q", f, got, want)
		}
	}
	if got := numberToString(math.NaN()); got != "NaN" {
		t.Errorf("NaN: %q", got)
	}
}

func TestStringToNumber(t *testing.T) {
	for s, want := range map[string]float64{
		"": 0, " ": 0, "10": 10, " 10 ": 10, "1e1": 10, "0x10": 16, "0X1f": 31, "0b11": 3, "0o7": 7, ".5": 0.5, "5.": 5, "+5": 5,
		"-5": -5, "Infinity": math.Inf(1), "-Infinity": math.Inf(-1), "\u00a07\u2003": 7, "\ufeff7": 7, "1E+2": 100,
	} {
		if got := stringToNumber(s); got != want {
			t.Errorf("stringToNumber(%q) = %v, want %v", s, got, want)
		}
	}
	for _, s := range []string{"-0x10", "5_0", "NaN", "abc", "١٢", "0x", "1e", "e1", ".", "+", "inf", "infinity", "0x1p3", "1 2"} {
		if got := stringToNumber(s); !math.IsNaN(got) {
			t.Errorf("stringToNumber(%q) = %v, want NaN", s, got)
		}
	}
}

func TestParseJSONOrderAndStringify(t *testing.T) {
	for in, want := range map[string]string{
		`{"b":1,"a":2,"2":3,"1":4,"01":5}`: `{"1":4,"2":3,"b":1,"a":2,"01":5}`,
		`{"a":1,"b":2,"a":3}`:              `{"a":3,"b":2}`,
		`[1e400,-0,1E2,"é😀\ud800",null]`:   `[null,0,100,"é😀\ud800",null]`,
		`"\u0001\u001f\"\\\/\b\f\n\r\t"`:   `"\u0001\u001f\"\\/\b\f\n\r\t"`,
		` { "x" : [ true , false ] } `:     `{"x":[true,false]}`,
	} {
		v, err := ParseJSON([]byte(in))
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got, _ := v.JSON(); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	for _, bad := range []string{``, `{`, `[1,]`, `{"a":1,}`, `01`, `1.`, `.5`, `+1`, `"a`, "\"\x01\"", `nul`, `{"a" 1}`, `1 2`, `NaN`, `'a'`} {
		if _, err := ParseJSON([]byte(bad)); err == nil {
			t.Errorf("ParseJSON(%q) accepted invalid JSON", bad)
		}
	}
}

func TestFromGo(t *testing.T) {
	type S struct {
		A int    `json:"a"`
		B string `json:"b"`
	}
	for _, c := range []struct {
		in   any
		want string
	}{
		{nil, "null"}, {true, "true"}, {int64(7), "7"}, {uint8(3), "3"}, {float32(1.5), "1.5"}, {"x", `"x"`},
		{[]any{1, "a", nil}, `[1,"a",null]`}, {[]int{1, 2}, "[1,2]"}, {map[string]any{"b": 1, "a": 2}, `{"a":2,"b":1}`},
		{map[string]int{"z": 1, "y": 2}, `{"y":2,"z":1}`}, {json.RawMessage(`{"b":1,"a":2}`), `{"b":1,"a":2}`},
		{json.Number("1e3"), "1000"}, {S{1, "x"}, `{"a":1,"b":"x"}`}, {&S{2, "y"}, `{"a":2,"b":"y"}`},
		{time.Date(2026, 1, 2, 3, 4, 5, 6e6, time.UTC), `"2026-01-02T03:04:05.006Z"`}, {math.NaN(), "null"},
	} {
		if got, _ := FromGo(c.in).JSON(); got != c.want {
			t.Errorf("FromGo(%#v) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestBundle(t *testing.T) {
	b, err := ParseBundle([]byte(`{"schema":1,"revision":4,"flags":{"f":{"type":"boolean","enabled":true,"default":true,"off":false,"rules":[]}},"segments":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if b.Revision() != 4 || !b.SupportsEngine() || len(b.FlagKeys()) != 1 {
		t.Fatalf("unexpected bundle %+v", b)
	}
	r := b.Evaluate("f", MapContext{"key": "u"}, boolValue(false))
	if v, _ := r.Value.Bool(); !v || r.Reason != ReasonDefault {
		t.Fatalf("unexpected result %+v", r)
	}
	for _, bad := range []string{`{}`, `{"schema":2,"revision":1,"flags":{},"segments":{}}`, `{"schema":1,"revision":"1","flags":{},"segments":{}}`, `{"schema":1,"revision":1,"flags":[],"segments":{}}`, `[]`} {
		if _, err := ParseBundle([]byte(bad)); err == nil {
			t.Errorf("ParseBundle(%s) accepted", bad)
		}
	}
	var nilBundle *Bundle
	if r := nilBundle.Evaluate("f", nil, stringValue("fb")); r.Reason != ReasonFlagNotFound || r.Value.s != "fb" {
		t.Fatalf("nil bundle: %+v", r)
	}
}

func TestAttributesUsedBy(t *testing.T) {
	v, _ := ParseJSON([]byte(`{"flags":{"f":{"rules":[{"conditions":[{"attribute":"region","op":"eq","value":"x"},{"attribute":"","op":"segment","value":"s"}],"serve":{"type":"rollout","bucketBy":"org"}}]}},"segments":{"s":{"conditions":[{"attribute":"plan","op":"exists"}]}}}`))
	got := AttributesUsedBy(v, "f")
	if len(got) != 3 || got[0] != "region" || got[1] != "plan" || got[2] != "org" {
		t.Fatalf("AttributesUsedBy = %v", got)
	}
}

func BenchmarkEvaluateRollout(b *testing.B) {
	bundle, _ := ParseBundle([]byte(`{"schema":1,"revision":4,"flags":{"f":{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"r","match":"all","conditions":[{"attribute":"region","op":"in","value":["US","CA"]}],"serve":{"type":"rollout","percentage":25,"value":true,"otherwise":false}}]}},"segments":{}}`))
	ctx := MapContext{"key": "user-123", "region": "US"}
	for i := 0; i < b.N; i++ {
		bundle.Evaluate("f", ctx, boolValue(false))
	}
}
