package nanoflags

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The published r3 serves "relevance-v3"; session A pins a draft serving "session-a" ("session-a-vip"
// for plan=vip), session B "session-b".
func rankingFlag(label string) string {
	return fmt.Sprintf(`"search-ranking":{"type":"string","enabled":true,"default":%q,"off":"off","rules":[{"id":"vip","match":"all","conditions":[{"attribute":"plan","op":"eq","value":"vip"}],"serve":{"type":"fixed","value":%q}}]}`, label, label+"-vip")
}

func sessionJSON(id, label, context string, expiresIn time.Duration) func() (int, string) {
	return func() (int, string) {
		exp := time.Now().Add(expiresIn).UTC().Format("2006-01-02T15:04:05.000Z")
		return 200, fmt.Sprintf(`{"id":%q,"checksum":"s-%s","source":"draft","revision":null,"context":%s,"expires_at":%q,"bundle":%s}`, id, id, context, exp, bundleText(0, rankingFlag(label)))
	}
}

func sessionEdge(t *testing.T) *fakeEdge {
	e := newFakeEdge(t)
	e.set(3, bundleText(3, rankingFlag("relevance-v3")))
	e.sessions = map[string]func() (int, string){
		"nf_ts_aaaaaaaa": sessionJSON("8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11", "session-a", `{"plan":"vip","key":"synthetic-user"}`, time.Minute),
		"nf_ts_bbbbbbbb": sessionJSON("9e4d2b63-1e70-4d4f-8e76-1f9f1f7b2c22", "session-b", `{}`, time.Minute),
	}
	return e
}

func sessionClient(t *testing.T, e *fakeEdge, extra ...Option) (*Client, *recorder) {
	c := must(t)(New(testKey, e.options(append([]Option{WithService("checkout-api"), WithLive(false), WithStreaming(false)}, extra...)...)...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	return c, r
}

func TestSessionEvaluatesPinnedBundleWithMergedContext(t *testing.T) {
	e := sessionEdge(t)
	c, _ := sessionClient(t, e)
	s := c.Session(context.Background(), "nf_ts_aaaaaaaa")
	if !s.Active() || s.ID() != "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11" || s.Revision() != 0 || !s.ExpiresAt().After(time.Now()) {
		t.Fatalf("session %+v active=%v rev=%d", s.state, s.Active(), s.Revision())
	}
	if v := s.StringVariation("search-ranking", nil, "fb"); v != "session-a-vip" { // plan=vip from the session context
		t.Fatalf("got %q", v)
	}
	if v := s.StringVariation("search-ranking", Context{"plan": "free"}, "fb"); v != "session-a" { // the call context wins
		t.Fatalf("got %q", v)
	}
	if _, d := s.StringVariationDetail("search-ranking", nil, "fb"); d.Reason != ReasonRuleMatch || d.RuleID != "vip" || d.Revision != 0 {
		t.Fatalf("detail %+v", d)
	}
	if v := s.BoolVariation("search-ranking", nil, true); !v { // typed accessors keep their type check
		t.Fatal("type mismatch must return the fallback")
	}
	if v := c.StringVariation("search-ranking", Context{"plan": "vip"}, "fb"); v != "relevance-v3-vip" || c.Revision() != 3 {
		t.Fatalf("the client itself must be untouched: %q r%d", v, c.Revision())
	}
	e.mu.Lock()
	h := e.sessionReq[0]
	e.mu.Unlock()
	if h.Get("X-NanoFlags-Session") != "nf_ts_aaaaaaaa" || h.Get("X-NanoFlags-Service") != "checkout-api" || h.Get("Authorization") != "Bearer "+testKey {
		t.Fatalf("request headers %v", h)
	}
}

func TestSessionLookupIsCachedAndCoalesced(t *testing.T) {
	e := sessionEdge(t)
	c, _ := sessionClient(t, e)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !c.Session(context.Background(), "nf_ts_aaaaaaaa").Active() {
				t.Error("inactive")
			}
		}()
	}
	wg.Wait()
	c.Session(context.Background(), "nf_ts_aaaaaaaa")
	if n := e.count("/v1/session"); n != 1 {
		t.Fatalf("%d lookups, want 1", n)
	}
	c.Session(context.Background(), "nf_ts_aaaaaaaa", SessionService("other-service")) // permission is per service
	e.mu.Lock()
	last := e.sessionReq[len(e.sessionReq)-1]
	e.mu.Unlock()
	if e.count("/v1/session") != 2 || last.Get("X-NanoFlags-Service") != "other-service" {
		t.Fatalf("per-service lookup missing: %v", last)
	}
}

func TestUnknownAndMalformedSessionsFallBack(t *testing.T) {
	e := sessionEdge(t)
	c, r := sessionClient(t, e)
	s := c.Session(context.Background(), "nf_ts_unknown0")
	if s.Active() || s.ID() != "" || !s.ExpiresAt().IsZero() || s.Revision() != 3 || s.StringVariation("search-ranking", nil, "fb") != "relevance-v3" {
		t.Fatal("an unknown session must evaluate like the client")
	}
	c.Session(context.Background(), "nf_ts_unknown0") // a miss is remembered
	for _, tok := range []string{"", "has space", "line\nbreak", strings.Repeat("x", 513)} {
		if c.Session(context.Background(), tok).Active() {
			t.Fatalf("%q active", tok)
		}
	}
	if n := e.count("/v1/session"); n != 1 {
		t.Fatalf("%d lookups, want 1", n)
	}
	if len(r.errs) != 0 {
		t.Fatalf("errors %v", r.errs)
	}
}

func TestSessionFailuresAreReportedNotReturned(t *testing.T) {
	e := sessionEdge(t)
	c, r := sessionClient(t, e)
	e.mu.Lock()
	e.sessions["nf_ts_11111111"] = func() (int, string) { return 500, "boom" }
	e.sessions["nf_ts_22222222"] = func() (int, string) {
		return 200, `{"id":"x","bundle":{"nope":true},"expires_at":"2999-01-01T00:00:00Z"}`
	}
	e.sessions["nf_ts_33333333"] = sessionJSON("old", "old", `{}`, -time.Second)
	e.sessions["nf_ts_44444444"] = func() (int, string) {
		return 200, `{"id":"x","context":{},"expires_at":"2999-01-01T00:00:00Z","bundle":{"schema":1,"revision":1,"flags":{},"segments":{},"engine":99}}`
	}
	e.mu.Unlock()
	for _, tok := range []string{"nf_ts_11111111", "nf_ts_22222222", "nf_ts_33333333", "nf_ts_44444444"} {
		s := c.Session(context.Background(), tok)
		if s.Active() || s.StringVariation("search-ranking", nil, "fb") != "relevance-v3" {
			t.Fatalf("%s must fall back", tok)
		}
	}
	eventually(t, "errors", func() bool { r.mu.Lock(); defer r.mu.Unlock(); return len(r.errs) == 3 })
	r.mu.Lock()
	var codes []ErrorCode
	for _, err := range r.errs {
		codes = append(codes, err.(*Error).Code)
	}
	r.mu.Unlock()
	if fmt.Sprint(codes) != fmt.Sprint([]ErrorCode{ErrSession, ErrSession, ErrEngine}) {
		t.Fatalf("codes %v", codes) // an expired session is not an error
	}
}

func TestSessionExpiresMidFlight(t *testing.T) {
	e := sessionEdge(t)
	e.sessions["nf_ts_shortlived"] = sessionJSON("short", "short", `{}`, 300*time.Millisecond)
	c, _ := sessionClient(t, e)
	s := c.Session(context.Background(), "nf_ts_shortlived")
	if !s.Active() || s.StringVariation("search-ranking", nil, "fb") != "short" {
		t.Fatal("expected the session")
	}
	eventually(t, "expiry", func() bool { return !s.Active() })
	if s.Revision() != 3 || s.StringVariation("search-ranking", nil, "fb") != "relevance-v3" || s.ID() != "short" {
		t.Fatal("an expired session evaluates like the client")
	}
	e.mu.Lock()
	delete(e.sessions, "nf_ts_shortlived")
	e.mu.Unlock()
	if c.Session(context.Background(), "nf_ts_shortlived").Active() || e.count("/v1/session") != 2 {
		t.Fatal("the cache entry must end with the session")
	}
}

func TestSessionEventsCarryTheSessionID(t *testing.T) {
	e := sessionEdge(t)
	c, _ := sessionClient(t, e, WithEvents(EventsOptions{SampleRate: 1, FlushInterval: time.Hour}))
	c.Session(context.Background(), "nf_ts_aaaaaaaa").StringVariation("search-ranking", nil, "fb")
	c.StringVariation("search-ranking", Context{"plan": "vip"}, "fb")
	c.Session(context.Background(), "nf_ts_unknown0").StringVariation("search-ranking", nil, "fb")
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	evs := e.events[len(e.events)-1]["events"].([]any)
	if len(evs) != 3 {
		t.Fatalf("%d events", len(evs))
	}
	first := evs[0].(map[string]any)
	if first["sessionId"] != "8d3c1a52-0d6f-4c3e-9d65-0e8f0e6a1b11" || first["value"] != "session-a-vip" || first["revision"] != 0.0 {
		t.Fatalf("event %v", first)
	}
	if ctx := first["context"].(map[string]any); len(ctx) != 1 || ctx["plan"] != "string" { // merged context, names and types only
		t.Fatalf("context %v", ctx)
	}
	for _, ev := range evs[1:] {
		if _, ok := ev.(map[string]any)["sessionId"]; ok {
			t.Fatalf("normal evaluations carry no session id: %v", ev)
		}
	}
}

func TestPublishedRevisionDoesNotChangeAnActiveSession(t *testing.T) {
	e := sessionEdge(t)
	c, _ := sessionClient(t, e)
	s := c.Session(context.Background(), "nf_ts_bbbbbbbb")
	e.set(4, bundleText(4, rankingFlag("relevance-v4")))
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.StringVariation("search-ranking", nil, "fb") != "relevance-v4" || s.StringVariation("search-ranking", nil, "fb") != "session-b" {
		t.Fatal("sessions are pinned")
	}
}

func TestWithSessionScope(t *testing.T) {
	bg := context.Background()
	if CurrentSession(bg) != "" || len(SessionHeaders(bg)) != 0 {
		t.Fatal("no session outside a scope")
	}
	a := WithSession(bg, " nf_ts_aaaaaaaa ")
	if CurrentSession(a) != "nf_ts_aaaaaaaa" || SessionHeaders(a).Get(SessionHeader) != "nf_ts_aaaaaaaa" {
		t.Fatal("scope")
	}
	if CurrentSession(WithSession(bg, "bad token")) != "" || CurrentSession(WithSession(a, "")) != "" {
		t.Fatal("malformed or absent tokens leave the session")
	}
	if CurrentSession(WithSession(a, "nf_ts_bbbbbbbb")) != "nf_ts_bbbbbbbb" || CurrentSession(a) != "nf_ts_aaaaaaaa" {
		t.Fatal("nesting")
	}
}

func TestMiddlewareIsolatesConcurrentRequests(t *testing.T) {
	e := sessionEdge(t)
	c, _ := sessionClient(t, e)
	var downstream sync.Map
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstream.Store(r.URL.Path, r.Header.Get(SessionHeader))
	}))
	defer echo.Close()
	out := &http.Client{Transport: &SessionTransport{}}
	app := SessionMiddleware(c)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f := c.FlagsFor(r.Context())
		time.Sleep(time.Millisecond)
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, echo.URL+r.URL.Path, nil)
		if res, err := out.Do(req); err == nil {
			res.Body.Close()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"value": f.StringVariation("search-ranking", nil, "fb"), "active": f.Active(), "token": CurrentSession(r.Context()),
			"same": c.FlagsFor(r.Context()) == f, "headers": SessionHeaders(r.Context()).Get(SessionHeader),
		})
	}))
	srv := httptest.NewServer(app)
	defer srv.Close()

	tokens := []string{"nf_ts_aaaaaaaa", "nf_ts_bbbbbbbb", "", "nf_ts_unknown0"}
	want := []string{"session-a-vip", "session-b", "relevance-v3", "relevance-v3"}
	var wg sync.WaitGroup
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tok := tokens[i%4]
			req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/r%d", srv.URL, i), nil)
			if tok != "" {
				req.Header.Set("X-NanoFlags-Session", tok)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer res.Body.Close()
			var got map[string]any
			_ = json.NewDecoder(res.Body).Decode(&got)
			if got["value"] != want[i%4] || got["token"] != tok || got["headers"] != tok || got["same"] != (tok != "") || got["active"] != (i%4 < 2) {
				t.Errorf("request %d (%q): %v", i, tok, got)
			}
			if d, _ := downstream.Load(fmt.Sprintf("/r%d", i)); d != tok { // an unknown session is still propagated
				t.Errorf("downstream %d got %q, want %q", i, d, tok)
			}
		}(i)
	}
	wg.Wait()
	if n := e.count("/v1/session"); n != 3 {
		t.Fatalf("%d lookups, want 3", n)
	}
	if c.FlagsFor(context.Background()).Active() {
		t.Fatal("no session outside a request")
	}
}

func TestMiddlewareServesWhenTheLookupFails(t *testing.T) {
	e := sessionEdge(t)
	c, _ := sessionClient(t, e)
	e.mu.Lock()
	e.sessions["nf_ts_aaaaaaaa"] = func() (int, string) { return 503, `{"error":"origin_unavailable"}` }
	e.mu.Unlock()
	var got string
	h := SessionMiddleware(c)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = c.FlagsFor(r.Context()).StringVariation("search-ranking", nil, "fb")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(SessionHeader, "nf_ts_aaaaaaaa")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if got != "relevance-v3" {
		t.Fatalf("got %q", got)
	}
}

func TestSessionWaitHonoursContextAndClose(t *testing.T) {
	e := sessionEdge(t)
	block := make(chan struct{})
	e.sessions["nf_ts_slowslow"] = func() (int, string) { <-block; return sessionJSON("slow", "slow", `{}`, time.Minute)() }
	c, _ := sessionClient(t, e)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if c.Session(ctx, "nf_ts_slowslow").Active() {
		t.Fatal("a cancelled wait yields an inactive evaluator")
	}
	close(block)
	eventually(t, "lookup", func() bool { return c.Session(context.Background(), "nf_ts_slowslow").Active() })
	_ = c.Close()
	if c.Session(context.Background(), "nf_ts_aaaaaaaa").Active() {
		t.Fatal("a closed client resolves no sessions")
	}
}
