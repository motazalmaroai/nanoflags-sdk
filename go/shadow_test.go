package nanoflags

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// Shadow evaluation of drafts (migration 0179): the draft of a change waiting for approval is
// evaluated next to the live bundle for a sample of evaluations; only counters leave the SDK; the
// shadow bundle is never applied. Mirrors packages/sdk/test/shadow.test.ts.

const (
	shadowSession = "6f1c2a4e-8b1d-4c3e-9f00-1234567890ab"
	shadowDraft   = "0123456789abcdef0123456789abcdef"
	otherEnv      = "6f0c7c1e-0000-4000-8000-000000000999"
)

const checkoutV2 = `"checkout-v2":{"type":"boolean","enabled":true,"default":%s,"off":false,"rules":[` +
	`{"id":"staff","match":"all","conditions":[{"attribute":"","op":"segment","value":"staff"}],"serve":{"type":"fixed","value":true}},` +
	`{"id":"us","match":"all","conditions":[{"attribute":"signedIn","op":"eq","value":true},{"attribute":"region","op":"eq","value":"US"}],"serve":{"type":"fixed","value":true}}]}`

// shadowFlags: checkout-v2 (default as given), search-ranking (label), max-items, plus extra flags.
func shadowFlags(checkoutDefault, ranking string, extra ...string) string {
	s := fmt.Sprintf(checkoutV2, checkoutDefault) +
		`,"search-ranking":{"type":"string","enabled":true,"default":` + ranking + `,"off":"relevance-v2","rules":[]}` +
		`,"max-items":{"type":"number","enabled":true,"default":10,"off":0,"rules":[]}`
	for _, x := range extra {
		s += "," + x
	}
	return s
}

const staffSegment = `{"staff":{"match":"all","conditions":[{"attribute":"email","op":"ends_with","value":"@staff.test"}]}}`

func shadowBundle(rev int64, flags string, rest ...string) string {
	x := ""
	for _, s := range rest {
		x += "," + s
	}
	return fmt.Sprintf(`{"flags":{%s},"schema":1,"project":"p","revision":%d,"segments":%s,"environment":"production","engine":1%s}`, flags, rev, staffSegment, x)
}

var (
	liveText  = shadowBundle(3, shadowFlags("false", `"relevance-v3"`))
	draftText = shadowBundle(3, shadowFlags("true", `"relevance-v3"`))
)

type shadowMarkerJSON struct {
	SessionID     string `json:"sessionId"`
	Checksum      string `json:"checksum"`
	EnvironmentID string `json:"environmentId"`
	BaseRevision  int    `json:"baseRevision"`
}

func (e *fakeEdge) marker() shadowMarkerJSON {
	return shadowMarkerJSON{shadowSession, shadowDraft, e.env, 3}
}

type shadowServe struct {
	tamper      func(string) string
	domain      string // "bundle": signed as a normal bundle
	sessionID   string
	checksum    string
	environment string
	key         ed25519.PrivateKey
	noAnnounce  bool
}

// setShadow serves bundle + marker as the signed shadow bundle on /v1/shadow and announces it.
func (e *fakeEdge) setShadow(bundle string, m shadowMarkerJSON, o shadowServe) {
	mj, _ := json.Marshal(m)
	text := strings.TrimSuffix(bundle, "}") + `,"shadow":` + string(mj) + "}"
	sid, cs, env := m.SessionID, m.Checksum, e.env
	if o.sessionID != "" {
		sid = o.sessionID
	}
	if o.checksum != "" {
		cs = o.checksum
	}
	if o.environment != "" {
		env = o.environment
	}
	key := e.priv
	if o.key != nil {
		key = o.key
	}
	var msg []byte
	if o.domain == "bundle" {
		msg = canonicalString(env, 3, cs, []byte(text))
	} else {
		sum := sha256.Sum256([]byte(text))
		msg = []byte("nanoflags-shadow-v1\n" + env + "\n" + sid + "\n" + cs + "\n" + hex.EncodeToString(sum[:]))
	}
	sig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, msg))
	served := text
	if o.tamper != nil {
		served = o.tamper(text)
	}
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("X-NanoFlags-Signed", "true")
	h.Set("X-NanoFlags-Signature", sig)
	h.Set("X-NanoFlags-Key-Id", e.kid)
	h.Set("X-NanoFlags-Environment-Id", env)
	h.Set("X-NanoFlags-Shadow", sid+"."+cs)
	body := fmt.Sprintf(`{"sessionId":%q,"checksum":%q,"baseRevision":3,"bundle":%s}`, sid, cs, served)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.shadowAnswer = &cannedResponse{status: 200, body: body, header: h}
	if !o.noAnnounce {
		e.shadowHeader = sid + "." + cs
	}
}

func shadowEdge(t *testing.T) *fakeEdge {
	e := newFakeEdge(t)
	e.set(3, liveText)
	e.setShadow(draftText, e.marker(), shadowServe{})
	return e
}

func shadowClient(t *testing.T, e *fakeEdge, extra ...Option) (*Client, *recorder) {
	t.Helper()
	opts := e.options(append([]Option{
		WithEvents(EventsOptions{SampleRate: -1, FlushInterval: time.Hour}),
		WithShadow(ShadowOptions{SampleRate: 1}),
		WithService("checkout-service"), WithServiceVersion("3.1.0"),
		WithStreaming(false),
	}, extra...)...)
	c := must(t)(New(testKey, opts...))
	r := record(c)
	_ = waitReady(t, c)
	settle(c)
	return c, r
}

// settle waits for the shadow fetch that the first load triggered (it runs right after it, under
// the same lock).
func settle(c *Client) {
	c.syncMu.Lock()
	c.syncMu.Unlock() //nolint:staticcheck // an empty critical section: waiting is the point
}

func (e *fakeEdge) eventBodies() []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]any(nil), e.events...)
}

func (e *fakeEdge) lastShadow(t *testing.T) map[string]any {
	t.Helper()
	b := e.eventBodies()
	if len(b) == 0 {
		t.Fatal("no events request")
	}
	s, _ := b[len(b)-1]["shadow"].(map[string]any)
	return s
}

// asJSON is compact JSON text without HTML escaping (so "<fallback>" reads as such).
func asJSON(v any) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(sb.String(), "\n")
}

func flush(t *testing.T, c *Client) {
	t.Helper()
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func firstFlag(t *testing.T, s map[string]any) map[string]any {
	t.Helper()
	if s == nil {
		t.Fatal("no shadow member")
	}
	return s["flags"].([]any)[0].(map[string]any)
}

func (r *recorder) codes() []ErrorCode {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []ErrorCode
	for _, e := range r.errs {
		if ne, ok := e.(*Error); ok {
			out = append(out, ne.Code)
		}
	}
	return out
}

/* ---------------- client ---------------- */

func TestShadowEvaluatesTheDraftAndReportsOnlyCounters(t *testing.T) {
	e := shadowEdge(t)
	c, r := shadowClient(t, e)
	if e.count("/v1/shadow") != 1 {
		t.Fatalf("/v1/shadow requests %d", e.count("/v1/shadow"))
	}
	// Zero behaviour change: the app always gets the live value.
	for i := 0; i < 30; i++ {
		if c.BoolVariation("checkout-v2", Context{"region": "DE", "email": fmt.Sprintf("person%d@example.test", i), "userId": fmt.Sprintf("u%d", i)}, true) {
			t.Fatal("draft value served")
		}
	}
	for i := 0; i < 10; i++ {
		if !c.BoolVariation("checkout-v2", Context{"signedIn": true, "region": "US", "key": "k"}, false) {
			t.Fatal("live rule not served")
		}
	}
	if c.StringVariation("search-ranking", nil, "fb") != "relevance-v3" || c.Revision() != 3 {
		t.Fatal("live configuration changed")
	}
	flush(t, c)
	body := e.eventBodies()[len(e.eventBodies())-1]
	if body["sdk"] != "go/"+SDKVersion || body["service"] != "checkout-service" {
		t.Fatalf("body %v", body)
	}
	want := `{"checksum":"` + shadowDraft + `","flags":[{"flag":"checkout-v2","flips":30,"pairs":[{"count":30,"live":"false","shadow":"true"}],"rules":{"1":10,"default":30},"samples":40}],"sessionId":"` + shadowSession + `","version":"3.1.0"}`
	if got := asJSON(body["shadow"]); got != want {
		t.Fatalf("report\n got %s\nwant %s", got, want)
	}
	// No context, attribute or identifier leaves the SDK with the shadow report.
	text := asJSON(body["shadow"])
	for _, s := range []string{"example.test", "person", "u1", "region", "DE", "signedIn", "US", "userId"} {
		if strings.Contains(text, s) {
			t.Fatalf("report contains %q", s)
		}
	}
	// Counters restart after a report: the next flush carries no shadow member.
	flush(t, c)
	if e.lastShadow(t) != nil {
		t.Fatal("shadow member sent twice")
	}
	if len(r.codes()) != 0 {
		t.Fatalf("errors %v", r.codes())
	}
}

func TestShadowSamplesAtTheConfiguredRateOnlyChangedFlags(t *testing.T) {
	e := shadowEdge(t)
	var n atomic.Int32
	c, _ := shadowClient(t, e, WithShadow(ShadowOptions{SampleRate: 0.25}), withShadowRandom(func() float64 {
		return float64((n.Add(1)-1)%4) / 4 // 0, .25, .5, .75 …
	}))
	for i := 0; i < 100; i++ {
		c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	}
	for i := 0; i < 50; i++ {
		c.Float64Variation("max-items", nil, 0)
	}
	if n.Load() != 100 {
		t.Fatalf("unchanged flags must never draw: %d draws", n.Load())
	}
	flush(t, c)
	if got := asJSON(e.lastShadow(t)["flags"]); got != `[{"flag":"checkout-v2","flips":25,"pairs":[{"count":25,"live":"false","shadow":"true"}],"rules":{"default":25},"samples":25}]` {
		t.Fatal(got)
	}
}

func TestShadowTamperedBundleIsIgnored(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, liveText)
	e.setShadow(draftText, e.marker(), shadowServe{tamper: func(s string) string { return strings.Replace(s, `"default":true`, `"default":"evil"`, 1) }})
	c, r := shadowClient(t, e)
	for i := 0; i < 5; i++ {
		if c.BoolVariation("checkout-v2", Context{"region": "DE"}, true) {
			t.Fatal("draft value served")
		}
	}
	flush(t, c)
	if e.lastShadow(t) != nil {
		t.Fatal("a tampered shadow bundle was evaluated")
	}
	eventually(t, "shadow error", func() bool { return len(r.codes()) == 1 && r.codes()[0] == ErrShadow })
	if c.Revision() != 3 {
		t.Fatal("revision changed")
	}
}

func TestShadowRejections(t *testing.T) {
	_, unknown, _ := ed25519.GenerateKey(nil)
	cases := []struct {
		name   string
		marker func(shadowMarkerJSON) shadowMarkerJSON
		serve  shadowServe
	}{
		{"signed by an unknown key", nil, shadowServe{key: unknown}},
		{"signed as a normal bundle", nil, shadowServe{domain: "bundle"}},
		{"marker of another session", func(m shadowMarkerJSON) shadowMarkerJSON {
			m.SessionID = "11111111-2222-4333-8444-555555555555"
			return m
		}, shadowServe{sessionID: shadowSession}},
		{"marker of another environment", func(m shadowMarkerJSON) shadowMarkerJSON { m.EnvironmentID = otherEnv; return m }, shadowServe{}},
		{"signed for another environment", nil, shadowServe{environment: otherEnv}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newFakeEdge(t)
			e.set(3, liveText)
			m := e.marker()
			if tc.marker != nil {
				m = tc.marker(m)
			}
			e.setShadow(draftText, m, tc.serve)
			c, r := shadowClient(t, e)
			c.BoolVariation("checkout-v2", Context{"region": "DE"}, true)
			flush(t, c)
			if e.lastShadow(t) != nil {
				t.Fatal("rejected shadow bundle evaluated")
			}
			eventually(t, "shadow error", func() bool { return len(r.codes()) == 1 && r.codes()[0] == ErrShadow })
		})
	}
}

type memStore struct{ data []byte }

func (m *memStore) Load(context.Context) ([]byte, error)   { return m.data, nil }
func (m *memStore) Save(_ context.Context, d []byte) error { m.data = d; return nil }

func TestShadowBundleIsNeverAppliedAsConfiguration(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, liveText)
	draft := strings.TrimSuffix(shadowBundle(4, shadowFlags("true", `"relevance-v3"`)), "}") + `,"shadow":` + asJSON(e.marker()) + "}"
	c := must(t)(New(testKey, e.options(WithEvents(EventsOptions{Disabled: true}))...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live socket", func() bool { return c.Transport() == TransportLive })
	// Pushed over the live socket, validly signed: refused.
	e.publish(4, draft)
	eventually(t, "invalid push", func() bool { return r.hasError(ErrInvalidBundle) })
	// Served on /v1/bundle with a valid bundle signature over its bytes: refused.
	if err := c.Refresh(context.Background()); err == nil || c.Revision() != 3 {
		t.Fatalf("refresh err %v, r%d", err, c.Revision())
	}
	if c.BoolVariation("checkout-v2", Context{"region": "DE"}, true) {
		t.Fatal("draft value served")
	}
	// Without verification as well.
	c2 := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithoutVerification(), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)))
	if err := waitReady(t, c2); err == nil || c2.Status() != StatusNotReady {
		t.Fatalf("unverified shadow bundle adopted: %v", err)
	}
	// Nor as a bootstrap.
	c3 := must(t)(New(testKey, WithBaseURL("http://127.0.0.1:1"), WithoutVerification(), WithBootstrapJSON([]byte(draft)), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)))
	if c3.Revision() != -1 {
		t.Fatal("shadow bootstrap adopted")
	}
	// Nor restored from the store.
	data, _ := json.Marshal(persisted{V: 1, ID: clientID("http://127.0.0.1:1", testKey), Bundle: json.RawMessage(draft)})
	c4 := must(t)(New(testKey, WithBaseURL("http://127.0.0.1:1"), WithoutVerification(), WithStore(&memStore{data: data}), WithEvents(EventsOptions{Disabled: true}), WithStreaming(false)))
	_ = waitReady(t, c4)
	if c4.Revision() != -1 {
		t.Fatal("shadow bundle restored from the store")
	}
	// Nor as a test session's snapshot.
	e.set(3, liveText)
	e.sessions = map[string]func() (int, string){"nf_ts_shadowss": func() (int, string) {
		return 200, fmt.Sprintf(`{"id":"8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11","context":{},"expires_at":%q,"bundle":%s}`, time.Now().Add(time.Minute).UTC().Format(time.RFC3339), draft)
	}}
	if c.Session(context.Background(), "nf_ts_shadowss").Active() {
		t.Fatal("shadow bundle used as a session snapshot")
	}
}

func TestShadowWithdrawnWhenNoLongerAnnounced(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e)
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	e.mu.Lock()
	e.shadowHeader = ""
	e.mu.Unlock()
	_ = c.Refresh(context.Background()) // 304 without the header: pending counters go out first
	if firstFlag(t, e.lastShadow(t))["samples"] != 1.0 {
		t.Fatal("pending counters not sent")
	}
	before := len(e.eventBodies())
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	flush(t, c)
	if len(e.eventBodies()) != before+1 || e.lastShadow(t) != nil {
		t.Fatal("withdrawn shadow bundle still evaluated")
	}
}

func TestShadowWithdrawnWhenShadowIs404(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e)
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	e.mu.Lock()
	e.shadowHeader, e.shadowAnswer = shadowSession+"."+strings.Repeat("e", 32), nil
	e.mu.Unlock()
	_ = c.Refresh(context.Background())
	if e.lastShadow(t)["checksum"] != shadowDraft {
		t.Fatal("pending counters not sent")
	}
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	flush(t, c)
	if e.lastShadow(t) != nil {
		t.Fatal("dropped shadow bundle still evaluated")
	}
}

func TestShadowNewDraftReplacesTheSession(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e)
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	next := strings.Repeat("f", 32)
	m := e.marker()
	m.Checksum = next
	e.setShadow(draftText, m, shadowServe{})
	_ = c.Refresh(context.Background())
	if s := e.lastShadow(t); s["checksum"] != shadowDraft || firstFlag(t, s)["samples"] != 1.0 {
		t.Fatalf("old counters %v", s)
	}
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	flush(t, c)
	if s := e.lastShadow(t); s["checksum"] != next || firstFlag(t, s)["samples"] != 1.0 {
		t.Fatalf("new counters %v", s)
	}
}

func TestShadowFailedFetchIsNotRetriedWithinAMinute(t *testing.T) {
	e := shadowEdge(t)
	e.mu.Lock()
	good := e.shadowAnswer
	e.shadowAnswer = &cannedResponse{status: 500, body: "{}"}
	e.mu.Unlock()
	c, _ := shadowClient(t, e)
	e.mu.Lock()
	e.shadowAnswer = good
	e.mu.Unlock()
	_ = c.Refresh(context.Background())
	_ = c.Refresh(context.Background())
	if e.count("/v1/shadow") != 1 {
		t.Fatalf("retried within a minute: %d", e.count("/v1/shadow"))
	}
	c.shadow.mu.Lock()
	c.shadow.fetch.at = c.shadow.fetch.at.Add(-61 * time.Second)
	c.shadow.mu.Unlock()
	_ = c.Refresh(context.Background())
	if e.count("/v1/shadow") != 2 {
		t.Fatalf("not retried after a minute: %d", e.count("/v1/shadow"))
	}
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	flush(t, c)
	if firstFlag(t, e.lastShadow(t))["samples"] != 1.0 {
		t.Fatal("not evaluated after the retry")
	}
}

func TestShadowCountersRideWithTimerFlushesAtMostOnceAMinute(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e, WithEvents(EventsOptions{SampleRate: 1, FlushInterval: 20 * time.Millisecond}))
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	eventually(t, "timer flush", func() bool { return len(e.eventBodies()) > 0 })
	time.Sleep(100 * time.Millisecond)
	for _, b := range e.eventBodies() {
		if b["shadow"] != nil {
			t.Fatal("shadow counters sent before a minute passed")
		}
	}
	flush(t, c)
	if firstFlag(t, e.lastShadow(t))["samples"] != 1.0 {
		t.Fatal("Flush must send the counters")
	}
}

func TestShadowCloseSendsPendingCounters(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e)
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	_ = c.Close()
	if firstFlag(t, e.lastShadow(t))["samples"] != 1.0 {
		t.Fatal("Close must send the counters")
	}
}

func TestShadowOptOut(t *testing.T) {
	for name, opt := range map[string]Option{
		"WithShadow(Disabled)": WithShadow(ShadowOptions{Disabled: true}),
		"events disabled":      WithEvents(EventsOptions{Disabled: true}),
	} {
		t.Run(name, func(t *testing.T) {
			e := shadowEdge(t)
			c, _ := shadowClient(t, e, opt)
			c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
			flush(t, c)
			if e.count("/v1/shadow") != 0 {
				t.Fatal("shadow bundle fetched")
			}
			for _, b := range e.eventBodies() {
				if b["shadow"] != nil {
					t.Fatal("shadow counters sent")
				}
			}
		})
	}
}

func TestShadowWithoutVerificationStillChecksWithKeysEndpoint(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e, WithoutVerification())
	c.BoolVariation("checkout-v2", Context{"region": "DE"}, false)
	flush(t, c)
	if e.count("/v1/keys") != 1 || firstFlag(t, e.lastShadow(t))["samples"] != 1.0 {
		t.Fatalf("keys %d", e.count("/v1/keys"))
	}
	// The SDK key is never sent to the public keys endpoint.
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.keysAuth[0] != "" {
		t.Fatal("SDK key sent to /v1/keys")
	}
}

func TestShadowAppFallbackNeverLeavesTheSDK(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, liveText)
	brandNew := `"brand-new":{"type":"string","enabled":true,"default":"x","off":"off","rules":[]}`
	e.setShadow(shadowBundle(3, shadowFlags("true", "42", brandNew)), e.marker(), shadowServe{}) // search-ranking: wrong type
	c, _ := shadowClient(t, e)
	if c.StringVariation("brand-new", nil, "alice@example.test") != "alice@example.test" || c.StringVariation("search-ranking", nil, "bob@example.test") != "relevance-v3" {
		t.Fatal("live values changed")
	}
	flush(t, c)
	s := e.lastShadow(t)
	if strings.Contains(asJSON(s), "example.test") {
		t.Fatal("the app's fallback left the SDK")
	}
	pairs := map[string]string{}
	for _, f := range s["flags"].([]any) {
		m := f.(map[string]any)
		pairs[m["flag"].(string)] = asJSON(m["pairs"])
	}
	if pairs["brand-new"] != `[{"count":1,"live":"<fallback>","shadow":"\"x\""}]` || pairs["search-ranking"] != `[{"count":1,"live":"\"relevance-v3\"","shadow":"<fallback>"}]` {
		t.Fatalf("pairs %v", pairs)
	}
}

func TestShadowTestSessionsAreNeverShadowed(t *testing.T) {
	e := shadowEdge(t)
	e.sessions = map[string]func() (int, string){"nf_ts_aaaaaaaa": func() (int, string) {
		return 200, fmt.Sprintf(`{"id":"8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11","context":{"region":"DE"},"expires_at":%q,"bundle":%s}`, time.Now().Add(time.Minute).UTC().Format(time.RFC3339), liveText)
	}}
	c, _ := shadowClient(t, e)
	s := c.Session(context.Background(), "nf_ts_aaaaaaaa")
	if !s.Active() {
		t.Fatal("session not active")
	}
	for i := 0; i < 5; i++ {
		if s.BoolVariation("checkout-v2", nil, true) {
			t.Fatal("draft value served")
		}
	}
	flush(t, c)
	if e.lastShadow(t) != nil {
		t.Fatal("test session evaluations were shadowed")
	}
	// An unknown session evaluates like the client, and is shadowed like the client.
	c.Session(context.Background(), "nf_ts_unknown0").BoolVariation("checkout-v2", Context{"region": "DE"}, true)
	flush(t, c)
	if firstFlag(t, e.lastShadow(t))["samples"] != 1.0 {
		t.Fatal("inactive session not shadowed")
	}
}

func TestShadowBrowserKeysWorkTheSameWay(t *testing.T) {
	e := shadowEdge(t)
	e.altKey = "nf_pub_test-key-not-a-real-key"
	c := must(t)(New(e.altKey, e.options(WithEvents(EventsOptions{SampleRate: -1, FlushInterval: time.Hour}), WithShadow(ShadowOptions{SampleRate: 1}), WithStreaming(false))...))
	_ = waitReady(t, c)
	settle(c)
	if c.BoolVariation("checkout-v2", Context{"region": "DE"}, true) {
		t.Fatal("draft value served")
	}
	flush(t, c)
	if firstFlag(t, e.lastShadow(t))["flips"] != 1.0 {
		t.Fatal("browser key not shadowed")
	}
}

func TestShadowEvaluationFailureNeverAffectsTheApp(t *testing.T) {
	e := shadowEdge(t)
	c, _ := shadowClient(t, e, withShadowRandom(func() float64 { panic("random source failed") }))
	if v, d := c.BoolVariationDetail("checkout-v2", Context{"region": "DE"}, true); v || d.Reason != ReasonDefault {
		t.Fatalf("%v %v", v, d.Reason)
	}
}

/* ---------------- helpers ---------------- */

func TestParseShadowHeader(t *testing.T) {
	if id, ok := parseShadowHeader(shadowSession + "." + shadowDraft); !ok || id != (shadowID{shadowSession, shadowDraft}) {
		t.Fatal(id)
	}
	if id, ok := parseShadowHeader(" " + strings.ToUpper(shadowSession+"."+shadowDraft) + " "); !ok || id != (shadowID{shadowSession, shadowDraft}) {
		t.Fatal(id)
	}
	for _, bad := range []string{"", "x.y", shadowSession, shadowSession + "." + shadowDraft + "x", "not-a-uuid-not-a-uuid-not-a-uuid-xxx." + shadowDraft} {
		if _, ok := parseShadowHeader(bad); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func parse(t *testing.T, text string) engine.Value {
	t.Helper()
	v, err := engine.ParseJSON([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func keysOf(m map[string]bool) string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	if len(out) > 1 {
		panic("test expects at most one key")
	}
	return strings.Join(out, ",")
}

func TestChangedFlags(t *testing.T) {
	live := parse(t, liveText)
	if got := keysOf(changedFlags(live, live)); got != "" {
		t.Fatal(got)
	}
	reord := parse(t, canonicalJSON(live)) // same content, keys sorted
	if got := keysOf(changedFlags(live, reord)); got != "" {
		t.Fatal(got)
	}
	if got := keysOf(changedFlags(live, parse(t, draftText))); got != "checkout-v2" {
		t.Fatal(got)
	}
	seg := parse(t, strings.Replace(liveText, "@staff.test", "@example.test", 1))
	if got := keysOf(changedFlags(live, seg)); got != "checkout-v2" { // it references `staff`
		t.Fatal(got)
	}
	added := parse(t, shadowBundle(3, shadowFlags("false", `"relevance-v3"`, `"brand_new":{"type":"boolean","enabled":true,"default":true,"off":false,"rules":[]}`)))
	if got := keysOf(changedFlags(live, added)); got != "brand_new" {
		t.Fatal(got)
	}
}

func TestChangedFlagsNestedRemovedAndCyclicSegments(t *testing.T) {
	flag := func(op, value string) string {
		return fmt.Sprintf(`{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"r","match":"all","conditions":[{"attribute":"","op":%q,"value":%q}],"serve":{"type":"fixed","value":true}}]}`, op, value)
	}
	g := `{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[]}`
	doc := func(flags, segments string) engine.Value {
		return parse(t, `{"schema":1,"project":"p","environment":"e","revision":1,"flags":`+flags+`,"segments":`+segments+`}`)
	}
	nested := func(v int) engine.Value {
		return doc(`{"f":`+flag("segment", "a")+`,"g":`+g+`}`, fmt.Sprintf(`{"a":{"match":"all","conditions":[{"attribute":"","op":"segment","value":"b"}]},"b":{"match":"all","conditions":[{"attribute":"x","op":"eq","value":%d}]}}`, v))
	}
	if got := keysOf(changedFlags(nested(1), nested(2))); got != "f" {
		t.Fatal(got)
	}
	if got := keysOf(changedFlags(nested(1), nested(1))); got != "" {
		t.Fatal(got)
	}
	flags := `{"f":` + flag("not_segment", "a") + `,"g":` + g + `}`
	segA := `"a":{"match":"any","conditions":[{"attribute":"","op":"segment","value":"c"}]}`
	withC := doc(flags, `{`+segA+`,"c":{"match":"all","conditions":[]}}`)
	withoutC := doc(flags, `{`+segA+`}`)
	if got := keysOf(changedFlags(withC, withoutC)); got != "f" {
		t.Fatal(got)
	}
	cyc := func(extra string) engine.Value {
		return doc(`{"f":`+flag("segment", "a")+`,"g":`+g+`}`, `{"a":{"match":"all","conditions":[{"attribute":"","op":"segment","value":"b"}]},"b":{"match":"all","conditions":[{"attribute":"","op":"segment","value":"a"}`+extra+`]}}`)
	}
	if got := keysOf(changedFlags(cyc(""), cyc(`,{"attribute":"x","op":"eq","value":1}`))); got != "f" { // a cycle terminates
		t.Fatal(got)
	}
}

func TestShadowFlipsIgnoreObjectKeyOrder(t *testing.T) {
	c := newShadowCounters(shadowSession, shadowDraft)
	c.add("cfg", parse(t, `{"a":1,"b":2}`), parse(t, `{"b":2,"a":1}`), -1, false, false)
	c.add("cfg", parse(t, `{"a":1,"b":{"e":1,"c":2}}`), parse(t, `{"b":{"c":2,"e":1},"a":1}`), -1, false, false)
	if got := asJSON(c.drain("").Flags[0]); got != `{"flag":"cfg","samples":2,"flips":0,"pairs":[],"rules":{"default":2}}` {
		t.Fatal(got)
	}
	if reprValue(parse(t, `{"b":2,"a":1}`)) != `{"a":1,"b":2}` {
		t.Fatal(reprValue(parse(t, `{"b":2,"a":1}`)))
	}
}

func TestShadowValues(t *testing.T) {
	for in, want := range map[string]string{
		`true`: `true`, `"blue"`: `"blue"`, `{"a":1}`: `{"a":1}`, `null`: `null`,
		`1.0`: `1`, `1e21`: `1e+21`, `0.1`: `0.1`,
		// Same hash as the JavaScript SDK (murmur3 of the JSON text, NFC, as 8 hex digits).
		`"` + strings.Repeat("x", 200) + `"`:       "#6685751d",
		`{"k":"` + strings.Repeat("é", 120) + `"}`: "#c3e3b467",
		// 100 UTF-16 code units: kept.
		`"` + strings.Repeat("é", 98) + `"`: `"` + strings.Repeat("é", 98) + `"`,
		// Keys sorted by UTF-16 code units, as JavaScript sorts them.
		`{"￿":1,"😀":2}`: `{"😀":2,"` + "￿" + `":1}`,
	} {
		if got := reprValue(parse(t, in)); got != want {
			t.Errorf("reprValue(%s) = %s, want %s", in, got, want)
		}
	}
	if reprValue(engine.Undefined) != "null" {
		t.Fatal("undefined")
	}
}

func TestShadowCountersAreBounded(t *testing.T) {
	c := newShadowCounters(shadowSession, shadowDraft)
	for i := 0; i < maxShadowFlags+20; i++ {
		c.add(fmt.Sprintf("f%d", i), engine.FromGo(false), engine.FromGo(true), 0, false, false)
	}
	if c.size() != maxShadowFlags {
		t.Fatal(c.size())
	}
	p := newShadowCounters(shadowSession, shadowDraft)
	for i := 0; i < 50; i++ {
		p.add("color", engine.FromGo("a"), engine.FromGo(fmt.Sprintf("b%d", i)), i, false, false)
	}
	rep := p.drain("")
	if strings.Contains(asJSON(rep), `"version"`) {
		t.Fatal("empty version sent")
	}
	r := rep.Flags[0]
	total := 0
	for _, x := range r.Pairs {
		total += x.Count
	}
	if r.Samples != 50 || r.Flips != 50 || len(r.Pairs) != maxShadowPairs || total != 50 || len(r.Rules) != 50 {
		t.Fatalf("%+v", r)
	}
	if last := r.Pairs[len(r.Pairs)-1]; last != (shadowPair{"*", "*", 50 - (maxShadowPairs - 1)}) {
		t.Fatalf("%+v", last)
	}
	if p.drain("") != nil {
		t.Fatal("not drained")
	}
}

func TestShadowCountersStayWithinWhatTheEdgeAccepts(t *testing.T) {
	c := newShadowCounters(shadowSession, shadowDraft)
	c.add(strings.Repeat("x", 64), engine.FromGo(false), engine.FromGo(true), 0, false, false) // the edge refuses the whole report
	c.add("", engine.FromGo(false), engine.FromGo(true), 0, false, false)
	if c.size() != 0 {
		t.Fatal(c.size())
	}
	c.add("big", engine.FromGo(false), engine.FromGo(true), 0, false, false)
	c.flags["big"].samples = maxShadowCount
	c.add("big", engine.FromGo(false), engine.FromGo(true), 0, false, false)
	if f := c.drain("v").Flags[0]; f.Samples != maxShadowCount || f.Flips != 1 {
		t.Fatalf("%+v", f)
	}
	c.add("r", engine.FromGo(false), engine.FromGo(false), 10_000, false, false) // out of range: "default"
	if got := asJSON(c.drain("").Flags[0].Rules); got != `{"default":1}` {
		t.Fatal(got)
	}
}

func TestServiceVersionIsTrimmedAndBounded(t *testing.T) {
	var cfg config
	WithServiceVersion("  " + strings.Repeat("9", 50) + " ")(&cfg)
	if cfg.serviceVersion != strings.Repeat("9", 40) {
		t.Fatal(cfg.serviceVersion)
	}
	WithServiceVersion(strings.Repeat("😀", 30))(&cfg)
	if utf16Len(cfg.serviceVersion) != 40 {
		t.Fatal(utf16Len(cfg.serviceVersion))
	}
}
