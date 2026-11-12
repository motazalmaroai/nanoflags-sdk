package nanoflags

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// A real signed answer of the production edge verifies with the embedded production key,
// hashing the raw bytes of the "bundle" member (never a re-serialisation).
func TestProductionSignatureVector(t *testing.T) {
	data, err := os.ReadFile("internal/testdata/signed-demo-response.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	h := http.Header{}
	for k, x := range v.Headers {
		h.Set(k, x)
	}
	body, err := engine.ParseJSON([]byte(v.Body))
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := engine.NewBundle(body.Field("bundle"))
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{verifier: &verifier{base: importKeys(OfficialSigningKeys), require: true}}
	next := &snapshot{bundle: bundle}
	if err := c.checkSignature(context.Background(), h, []byte(v.Body), body, next); err != nil {
		t.Fatal(err)
	}
	if next.sig == nil || next.sig.Kid != "k1" || string(next.raw) != string(rawMember([]byte(v.Body), "bundle")) {
		t.Fatalf("signature info %+v", next.sig)
	}
	// One flipped byte in the bundle text fails.
	tampered := []byte(v.Body)
	for i := len(tampered) - 1; i >= 0; i-- {
		if tampered[i] == 'e' {
			tampered[i] = 'E'
			break
		}
	}
	body2, _ := engine.ParseJSON(tampered)
	b2, _ := engine.NewBundle(body2.Field("bundle"))
	c2 := &Client{verifier: c.verifier}
	if err := c2.checkSignature(context.Background(), h, tampered, body2, &snapshot{bundle: b2}); err == nil {
		t.Fatal("tampered bundle verified")
	}
}

func TestRawMember(t *testing.T) {
	for in, want := range map[string]string{
		`{"bundle":{"a":"}"}}`:                            `{"a":"}"}`,
		`{ "x" : [1,{"bundle":2}], "bundle" : [ "\"" ] }`: `[ "\"" ]`,
		`{"bundle":1,"bundle":true}`:                      `true`,
		`{"bundle":"esc"}`:                                `"esc"`,
		`{"other":1}`:                                     ``,
		`[{"bundle":1}]`:                                  ``,
		`{"bundle":`:                                      ``,
	} {
		if got := string(rawMember([]byte(in), "bundle")); got != want {
			t.Errorf("rawMember(%s) = %q, want %q", in, got, want)
		}
	}
}
