package ofprovider

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/open-feature/go-sdk/openfeature"

	nanoflags "github.com/motazalmaroai/nanoflags-sdk/go"
)

const flags = `"checkout":{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"beta","match":"all","conditions":[{"attribute":"plan","op":"eq","value":"beta"}],"serve":{"type":"fixed","value":true}}]},` +
	`"accent":{"type":"string","enabled":false,"default":"blue","off":"grey","rules":[]},` +
	`"limit":{"type":"number","enabled":true,"default":25,"off":0,"rules":[]},` +
	`"ratio":{"type":"number","enabled":true,"default":0.5,"off":0,"rules":[]},` +
	`"layout":{"type":"json","enabled":true,"default":{"columns":2},"off":null,"rules":[]},` +
	`"split":{"type":"string","enabled":true,"default":"a","off":"a","rules":[{"id":"half","match":"all","conditions":[],"serve":{"type":"rollout","percentage":50,"value":"b","otherwise":"c"}}]}`

func bundle(rev int, extra string) string {
	return fmt.Sprintf(`{"schema":1,"project":"p","environment":"e","revision":%d,"flags":{%s%s},"segments":{}}`, rev, flags, extra)
}

// edge serves unsigned bundles (no verification is configured for a non-official edge).
func edge(t *testing.T) (*httptest.Server, *atomic.Value) {
	var current atomic.Value
	current.Store(bundle(1, ""))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/bundle" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-NanoFlags-Signed", "false")
		fmt.Fprintf(w, `{"revision":1,"checksum":"c","bundle":%s}`, current.Load())
	}))
	t.Cleanup(srv.Close)
	return srv, &current
}

func TestProviderThroughOpenFeature(t *testing.T) {
	srv, current := edge(t)
	client, err := nanoflags.New("nf_srv_test", nanoflags.WithBaseURL(srv.URL), nanoflags.WithStreaming(false), nanoflags.WithPollInterval(time.Hour), nanoflags.WithEvents(nanoflags.EventsOptions{Disabled: true}))
	if err != nil {
		t.Fatal(err)
	}
	p := New(client, WithCloseClient())
	var mu sync.Mutex
	var changed []string
	cb := openfeature.EventCallback(ptr(func(d openfeature.EventDetails) {
		mu.Lock()
		changed = append(changed, d.FlagChanges...)
		mu.Unlock()
	}))
	openfeature.AddHandler(openfeature.ProviderConfigChange, cb)
	if err := openfeature.SetNamedProviderAndWait(t.Name(), p); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { openfeature.Shutdown() })
	of := openfeature.NewClient(t.Name())
	ctx := context.Background()
	beta := openfeature.NewEvaluationContext("user-1", map[string]any{"plan": "beta"})

	d, err := of.BooleanValueDetails(ctx, "checkout", false, beta)
	if err != nil || !d.Value || d.Reason != openfeature.TargetingMatchReason || d.Variant != "beta" || d.FlagMetadata["revision"] != int64(1) {
		t.Fatalf("checkout %+v %v", d, err)
	}
	if v, _ := of.BooleanValue(ctx, "checkout", true, openfeature.NewEvaluationContext("u", nil)); v {
		t.Fatal("default expected")
	}
	if s, _ := of.StringValueDetails(ctx, "accent", "x", beta); s.Value != "grey" || s.Reason != openfeature.DisabledReason {
		t.Fatalf("accent %+v", s)
	}
	if n, _ := of.IntValue(ctx, "limit", 1, beta); n != 25 {
		t.Fatal(n)
	}
	if n, err := of.IntValueDetails(ctx, "ratio", 1, beta); n.Value != 1 || n.ErrorCode != openfeature.TypeMismatchCode || err == nil {
		t.Fatalf("ratio as int: %+v", n)
	}
	if f, _ := of.FloatValue(ctx, "ratio", 1, beta); f != 0.5 {
		t.Fatal(f)
	}
	if o, _ := of.ObjectValue(ctx, "layout", nil, beta); o.(map[string]any)["columns"] != 2.0 {
		t.Fatal(o)
	}
	if s, err := of.StringValueDetails(ctx, "checkout", "fb", beta); s.Value != "fb" || s.ErrorCode != openfeature.TypeMismatchCode || err == nil {
		t.Fatalf("mismatch %+v", s)
	}
	if s, _ := of.StringValueDetails(ctx, "missing", "fb", beta); s.ErrorCode != openfeature.FlagNotFoundCode {
		t.Fatalf("missing %+v", s)
	}
	sp, _ := of.StringValueDetails(ctx, "split", "fb", openfeature.NewEvaluationContext("user-42", map[string]any{"key": "ignored"}))
	direct := client.StringVariation("split", nanoflags.Context{"key": "user-42"}, "fb")
	if sp.Reason != openfeature.SplitReason || sp.Value != direct || sp.Variant != "half" {
		t.Fatalf("split %+v, direct %q", sp, direct)
	}

	// A new revision → PROVIDER_CONFIGURATION_CHANGED naming the changed flag.
	current.Store(bundle(2, `,"fresh":{"type":"boolean","enabled":true,"default":true,"off":false,"rules":[]}`))
	if err := client.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		got := append([]string(nil), changed...)
		mu.Unlock()
		if len(got) == 1 && got[0] == "fresh" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("changed flags %v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if v, _ := of.BooleanValue(ctx, "fresh", false, beta); !v {
		t.Fatal("fresh")
	}
}

func TestProviderNotReady(t *testing.T) {
	client, _ := nanoflags.New("nf_srv_test", nanoflags.WithBaseURL("http://127.0.0.1:1"), nanoflags.WithStreaming(false), nanoflags.WithEvents(nanoflags.EventsOptions{Disabled: true}))
	p := New(client, WithCloseClient(), WithInitTimeout(2*time.Second))
	defer p.Shutdown()
	if err := p.Init(openfeature.EvaluationContext{}); err == nil {
		t.Fatal("Init must fail without a configuration")
	}
	r := p.BooleanEvaluation(context.Background(), "x", true, nil)
	if !r.Value || r.ResolutionDetail().ErrorCode != openfeature.ProviderNotReadyCode {
		t.Fatalf("%+v", r)
	}
}

func ptr[T any](v T) *T { return &v }
