package nanoflags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

const typedFlags = boolFlag +
	`,"accent":{"type":"string","enabled":true,"default":"blue","off":"grey","rules":[]}` +
	`,"limit":{"type":"number","enabled":true,"default":25,"off":0,"rules":[]}` +
	`,"layout":{"type":"json","enabled":true,"default":{"z":1,"a":[1,"x"]},"off":null,"rules":[]}` +
	`,"rollout":{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"half","match":"all","conditions":[],"serve":{"type":"rollout","percentage":50,"value":true,"otherwise":false}}]}` +
	`,"disabled":{"type":"string","enabled":false,"default":"on","off":"off-value","rules":[]}`

func TestPollVerifyAndVariations(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, bundleText(3, typedFlags))
	c := must(t)(New(testKey, e.options(WithLive(false), WithStreaming(false))...))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	if c.Status() != StatusReady || c.Revision() != 3 || c.Transport() != TransportPoll {
		t.Fatalf("status %s revision %d transport %s", c.Status(), c.Revision(), c.Transport())
	}
	beta := Context{"key": "u1", "plan": "beta"}
	if !c.BoolVariation("checkout", beta, false) || c.BoolVariation("checkout", Context{"plan": "free"}, true) {
		t.Fatal("checkout")
	}
	v, d := c.BoolVariationDetail("checkout", beta, false)
	if !v || d.Reason != ReasonRuleMatch || d.RuleIndex != 0 || d.RuleID != "beta" || d.Revision != 3 || len(d.Trace) != 3 {
		t.Fatalf("detail %+v", d)
	}
	if s := c.StringVariation("accent", nil, "x"); s != "blue" {
		t.Fatal(s)
	}
	if n := c.Float64Variation("limit", nil, 1); n != 25 {
		t.Fatal(n)
	}
	j, jd := c.JSONVariationDetail("layout", nil, nil)
	if m, ok := j.(map[string]any); !ok || m["z"] != 1.0 || string(jd.JSON()) != `{"z":1,"a":[1,"x"]}` {
		t.Fatalf("json %#v %s", j, jd.JSON())
	}
	// Type mismatch: the fallback, reason error.
	s, sd := c.StringVariationDetail("checkout", beta, "fb")
	if s != "fb" || sd.Reason != ReasonError || !strings.Contains(sd.Error, "boolean value") || sd.Value != "fb" {
		t.Fatalf("mismatch %q %+v", s, sd)
	}
	if b, bd := c.BoolVariationDetail("missing", nil, true); !b || bd.Reason != ReasonFlagNotFound {
		t.Fatalf("missing %+v", bd)
	}
	if s, sd := c.StringVariationDetail("disabled", nil, "fb"); s != "off-value" || sd.Reason != ReasonOff {
		t.Fatalf("off %+v", sd)
	}
	_, rd := c.BoolVariationDetail("rollout", Context{"key": "user-42"}, false)
	if rd.Bucket == nil || rd.InRollout == nil || rd.Reason != ReasonRuleMatch {
		t.Fatalf("rollout %+v", rd)
	}
	want := engine.BucketOf("rollout", "user-42")
	if *rd.Bucket != want || *rd.InRollout != (want < 50) {
		t.Fatalf("bucket %v, want %v", *rd.Bucket, want)
	}
	all := c.AllFlags(beta)
	if len(all) != 6 || all["checkout"] != true || all["accent"] != "blue" || all["disabled"] != "off-value" {
		t.Fatalf("AllFlags %#v", all)
	}
	// A second request is conditional.
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.count("/v1/bundle") != 2 || c.Status() != StatusReady {
		t.Fatalf("requests %d", e.count("/v1/bundle"))
	}
}

func TestRejectsBadAndUnsignedBundles(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, e.options(WithLive(false), WithStreaming(false))...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	// A bad signature changes nothing.
	e.mu.Lock()
	e.corrupt = true
	e.mu.Unlock()
	e.set(2, bundleText(2, boolFlag))
	err := c.Refresh(context.Background())
	var ne *Error
	if !errors.As(err, &ne) || ne.Code != ErrSignature || c.Revision() != 1 || c.Status() != StatusReady {
		t.Fatalf("bad signature: %v, r%d %s", err, c.Revision(), c.Status())
	}
	if !errors.Is(err, &Error{Code: ErrSignature}) {
		t.Fatal("errors.Is by code")
	}
	// Unsigned bundles are refused with Require.
	e.mu.Lock()
	e.corrupt, e.signed = false, false
	e.mu.Unlock()
	if err := c.Refresh(context.Background()); !errors.As(err, &ne) || ne.Code != ErrSignature || c.Revision() != 1 {
		t.Fatalf("unsigned: %v", err)
	}
	eventually(t, "signature errors", func() bool { return r.hasError(ErrSignature) })

	// Without Require they are accepted.
	c2 := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithVerification(VerifyOptions{PublicKeys: []JWK{e.pub}}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false)))
	if err := waitReady(t, c2); err != nil || c2.Revision() != 2 {
		t.Fatalf("unsigned accepted: %v r%d", err, c2.Revision())
	}
	// A pinned key that never signed anything rejects everything, even on the first load.
	e.mu.Lock()
	e.signed = true
	e.mu.Unlock()
	other := JWK{Kty: "OKP", Crv: "Ed25519", X: "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", Kid: "t1"}
	c3 := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithVerification(VerifyOptions{PublicKeys: []JWK{other}}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false)))
	if err := waitReady(t, c3); !errors.As(err, &ne) || ne.Code != ErrSignature || c3.Status() != StatusNotReady {
		t.Fatalf("wrong key: %v %s", err, c3.Status())
	}
	if c3.BoolVariation("checkout", Context{"plan": "beta"}, false) {
		t.Fatal("evaluated an unverified bundle")
	}
}

func TestPrivateKeysAreRefused(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	priv := e.pub
	priv.D = "secret"
	c := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithVerification(VerifyOptions{PublicKeys: []JWK{priv}}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false)))
	r := record(c)
	_ = waitReady(t, c)
	if c.Status() != StatusNotReady {
		t.Fatal("a private JWK must not be used for verification")
	}
	eventually(t, "config error", func() bool { return r.hasError(ErrConfig) || r.hasError(ErrSignature) })
}

func TestKeyRotationFetchesKeysOnce(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	// The client trusts what /v1/keys serves (FetchKeys): a new kid triggers one reload.
	c := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithVerification(VerifyOptions{FetchKeys: true}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false)))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	if n := e.count("/v1/keys"); n != 1 {
		t.Fatalf("keys requests %d", n)
	}
	_ = c.Refresh(context.Background())
	_ = c.Refresh(context.Background())
	if n := e.count("/v1/keys"); n != 1 {
		t.Fatalf("keys requests after refresh %d", n)
	}
	// An unknown kid is checked against a reload at most once a minute.
	e.mu.Lock()
	e.kid = "t2"
	e.mu.Unlock()
	e.set(2, bundleText(2, boolFlag))
	err := c.Refresh(context.Background())
	if err == nil || c.Revision() != 1 {
		t.Fatalf("unknown kid accepted: %v", err)
	}
	if n := e.count("/v1/keys"); n != 1 {
		t.Fatalf("unknown kid within a minute must not reload keys (%d)", n)
	}
}

func TestLivePushes(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live transport", func() bool { return c.Transport() == TransportLive })
	e.publish(2, bundleText(2, strings.Replace(boolFlag, `"default":false`, `"default":true`, 1)))
	eventually(t, "r2", func() bool { return c.Revision() == 2 })
	if !c.BoolVariation("checkout", nil, false) {
		t.Fatal("r2 not in use")
	}
	eventually(t, "change event", func() bool { return r.changeCount() == 2 })
	ev := r.last()
	if ev.Transport != TransportLive || !ev.HasLatency || ev.Latency < 40*time.Millisecond || ev.PreviousRevision != 1 || ev.Source != SourceNetwork {
		t.Fatalf("event %+v", ev)
	}
	// The ETag of a pushed revision is what /v1/bundle would send: the safety poll gets a 304.
	before := e.count("/v1/bundle")
	_ = c.Refresh(context.Background())
	if e.count("/v1/bundle") != before+1 || c.Revision() != 2 || r.changeCount() != 2 {
		t.Fatal("safety poll changed something")
	}
	// Older pushes and pushes with a bad signature are ignored.
	e.publish(1, bundleText(1, boolFlag))
	e.mu.Lock()
	e.corrupt = true
	e.mu.Unlock()
	e.publish(3, bundleText(3, boolFlag))
	eventually(t, "signature error", func() bool { return r.hasError(ErrSignature) })
	if c.Revision() != 2 {
		t.Fatalf("revision %d", c.Revision())
	}
}

func TestLiveReconnectAndHello(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	// Lost socket; meanwhile r2 is published; the reconnect's hello catches up.
	e.closeSockets(websocket.StatusGoingAway)
	e.set(2, bundleText(2, boolFlag))
	eventually(t, "caught up from hello", func() bool { return c.Revision() == 2 })
	eventually(t, "live again", func() bool { return c.Transport() == TransportLive })
}

func TestEnvironmentDeleted(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	opened := e.count("/v1/live")
	e.closeSockets(CloseEnvironmentDeleted)
	eventually(t, "environment_deleted", func() bool { return r.hasError(ErrEnvironmentDeleted) })
	if c.Status() != StatusStale || c.Revision() != 1 || !c.BoolVariation("checkout", Context{"plan": "beta"}, false) {
		t.Fatalf("status %s", c.Status())
	}
	time.Sleep(1500 * time.Millisecond)
	if e.count("/v1/live") != opened || e.count("/v1/stream") != 0 || c.Transport() != TransportPoll {
		t.Fatalf("reconnected after 4004: live %d stream %d", e.count("/v1/live"), e.count("/v1/stream"))
	}
}

func TestEngineVersionRefused(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	newer := strings.Replace(bundleText(2, boolFlag), `"engine":1`, `"engine":2`, 1)
	e.publish(2, newer)
	eventually(t, "engine error (push)", func() bool { return r.hasError(ErrEngine) })
	err := c.Refresh(context.Background())
	var ne *Error
	if !errors.As(err, &ne) || ne.Code != ErrEngine || c.Revision() != 1 || c.Status() != StatusReady {
		t.Fatalf("poll: %v r%d %s", err, c.Revision(), c.Status())
	}
	// Bootstrap bundles are checked too.
	b, _ := engine.ParseBundle([]byte(newer))
	c2 := must(t)(New(testKey, WithBaseURL("http://127.0.0.1:1"), WithBootstrap(b), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)))
	if c2.Revision() != -1 {
		t.Fatal("bootstrap with newer engine adopted")
	}
}

func TestBootstrapStaleAndOffline(t *testing.T) {
	c := must(t)(New(testKey, WithBaseURL("http://127.0.0.1:1"), WithBootstrapJSON([]byte(bundleText(5, boolFlag))), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	if c.Revision() != 5 || !c.BoolVariation("checkout", Context{"plan": "beta"}, false) {
		t.Fatal("bootstrap not in use")
	}
	eventually(t, "stale after failed request", func() bool { return c.Status() == StatusStale && r.hasError(ErrNetwork) })

	// No bootstrap, no edge: WaitForReady reports the failure, evaluations return fallbacks.
	c2 := must(t)(New(testKey, WithBaseURL("http://127.0.0.1:1"), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)))
	err := waitReady(t, c2)
	var ne *Error
	if !errors.As(err, &ne) || ne.Code != ErrNetwork || c2.Status() != StatusNotReady || c2.StringVariation("x", nil, "fb") != "fb" {
		t.Fatalf("offline: %v", err)
	}
}

func TestUnauthorized(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New("nf_srv_revoked", e.options()...))
	err := waitReady(t, c)
	var ne *Error
	if !errors.As(err, &ne) || ne.Code != ErrUnauthorized || ne.HTTPStatus != 401 {
		t.Fatalf("got %v", err)
	}
}

func TestServedStaleNeverGoesBackwards(t *testing.T) {
	e := newFakeEdge(t)
	e.set(4, bundleText(4, boolFlag))
	c := must(t)(New(testKey, e.options(WithLive(false), WithStreaming(false))...))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.stale = true
	e.mu.Unlock()
	e.set(3, bundleText(3, boolFlag))
	_ = c.Refresh(context.Background())
	if c.Revision() != 4 || c.Status() != StatusStale {
		t.Fatalf("r%d %s", c.Revision(), c.Status())
	}
}

func TestStoreRestoresAndVerifies(t *testing.T) {
	e := newFakeEdge(t)
	e.set(7, bundleText(7, boolFlag))
	path := filepath.Join(t.TempDir(), "flags.json")
	c := must(t)(New(testKey, e.options(WithStore(FileStore(path)), WithLive(false), WithStreaming(false))...))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("store file: %v", err)
	}
	// Edge down: the persisted copy (verified again) is used, marked stale.
	opts := []Option{WithBaseURL("http://127.0.0.1:1"), WithVerification(VerifyOptions{PublicKeys: []JWK{e.pub}, Require: ptr(true)}), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)}
	// The persisted copy is bound to edge + key: point the id at the original edge.
	c2 := must(t)(New(testKey, append(opts, WithStore(rebind(FileStore(path), e.srv.URL, "http://127.0.0.1:1")))...))
	r2 := record(c2)
	if err := waitReady(t, c2); err != nil {
		t.Fatal(err)
	}
	if c2.Revision() != 7 || c2.Status() != StatusStale {
		t.Fatalf("restored r%d %s", c2.Revision(), c2.Status())
	}
	eventually(t, "store change event", func() bool { return r2.changeCount() == 1 && r2.last().Source == SourceStore })
	// A tampered copy is ignored.
	data, _ := os.ReadFile(path)
	_ = os.WriteFile(path, []byte(strings.Replace(string(data), `"default":false`, `"default":true`, 1)), 0o600)
	c3 := must(t)(New(testKey, append(opts, WithStore(rebind(FileStore(path), e.srv.URL, "http://127.0.0.1:1")))...))
	r3 := record(c3)
	_ = waitReady(t, c3)
	if c3.Revision() != -1 {
		t.Fatal("tampered store adopted")
	}
	eventually(t, "signature error", func() bool { return r3.hasError(ErrSignature) })
}

// rebind rewrites the persisted id so a copy saved for one edge URL can be read by a client of another.
type rebound struct {
	Store
	from, to string
}

func rebind(s Store, from, to string) Store { return rebound{s, from, to} }

func (r rebound) Load(ctx context.Context) ([]byte, error) {
	data, err := r.Store.Load(ctx)
	if err != nil || data == nil {
		return data, err
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(data, &m)
	id, _ := json.Marshal(clientID(r.to, testKey))
	m["id"] = id
	return json.Marshal(m)
}

func clientID(baseURL, key string) string {
	return fmt.Sprintf("%08x", engine.Murmur3(baseURL+"|"+key, 0))
}

type offline struct{}

func (offline) RoundTrip(*http.Request) (*http.Response, error) { return nil, errors.New("offline") }

func TestSSEFallback(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	e.mu.Lock()
	e.liveStatus = 503 // socket cap reached
	e.mu.Unlock()
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "stream transport", func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return c.Transport() == TransportStream && len(e.sse) == 1
	})
	e.publish(2, bundleText(2, boolFlag))
	eventually(t, "r2 via SSE", func() bool { return c.Revision() == 2 })
	eventually(t, "change", func() bool { return r.changeCount() == 2 && r.last().Transport == TransportStream })
}

func TestEventsAndServiceReport(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithVerification(VerifyOptions{PublicKeys: []JWK{e.pub}}), WithService("checkout-api"),
		WithEvents(EventsOptions{SampleRate: 1, FlushInterval: time.Hour}), WithStreaming(false)))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	c.BoolVariation("checkout", Context{"key": "u1", "plan": "beta", "email": "secret@example.com"}, false)
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.events) != 1 {
		t.Fatalf("events posts %d", len(e.events))
	}
	body := e.events[0]
	evs := body["events"].([]any)
	ev := evs[0].(map[string]any)
	ctx := ev["context"].(map[string]any)
	if body["service"] != "checkout-api" || body["sdk"] != "go/"+SDKVersion || body["revision"] != 1.0 || ev["flagKey"] != "checkout" || ev["value"] != true || ev["reason"] != "rule_match" || ev["ruleIndex"] != 0.0 {
		t.Fatalf("body %#v", body)
	}
	if len(ctx) != 1 || ctx["plan"] != "string" {
		t.Fatalf("context must carry attribute types only: %#v", ctx)
	}
}

func TestConcurrentEvaluationDuringPushes(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c := must(t)(New(testKey, e.options(WithEvents(EventsOptions{SampleRate: 1, FlushInterval: 20 * time.Millisecond}))...))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				c.BoolVariation("checkout", Context{"key": i, "plan": "beta"}, false)
				c.AllFlags(nil)
				_ = c.Status()
				_ = c.Transport()
			}
		}(i)
	}
	for rev := int64(2); rev <= 20; rev++ {
		e.publish(rev, bundleText(rev, boolFlag))
	}
	eventually(t, "r20", func() bool { return c.Revision() == 20 })
	close(stop)
	wg.Wait()
}

func TestCloseIsCleanAndIdempotent(t *testing.T) {
	e := newFakeEdge(t)
	e.set(1, bundleText(1, boolFlag))
	c, err := New(testKey, e.options()...)
	if err != nil {
		t.Fatal(err)
	}
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	done := make(chan struct{})
	go func() { _ = c.Close(); _ = c.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return")
	}
	if c.Transport() != TransportPoll || !c.BoolVariation("checkout", Context{"plan": "beta"}, false) {
		t.Fatal("evaluations must keep working after Close")
	}
	if err := c.Refresh(context.Background()); err == nil {
		t.Fatal("Refresh after Close")
	}
}

func TestNewValidation(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Fatal("empty key accepted")
	}
	if _, err := New(testKey, WithBaseURL("edge.nanoflags.io")); err == nil {
		t.Fatal("URL without scheme accepted")
	}
	c, err := New(testKey, WithStreaming(false), WithPollInterval(0), WithEvents(EventsOptions{Disabled: true}), WithBaseURL("http://127.0.0.1:1"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.verifier != nil {
		t.Fatal("verification must be off by default for a non-official edge")
	}
	o, _ := New(testKey, WithStreaming(false), WithPollInterval(0), WithEvents(EventsOptions{Disabled: true}), WithHTTPClient(&http.Client{Transport: offline{}}))
	defer o.Close()
	if o.verifier == nil || !o.verifier.require || len(o.verifier.base) != 1 || o.verifier.base[0].kid != "k1" {
		t.Fatal("official edge must verify against the embedded keys by default")
	}
}
