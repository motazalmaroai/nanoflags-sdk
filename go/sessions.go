package nanoflags

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// SessionHeader is the header that carries a test-session token between services.
const SessionHeader = "x-nanoflags-session"

const (
	maxSessions     = 1000
	sessionMissTTL  = 15 * time.Second
	sessionErrorTTL = 3 * time.Second
	maxSessionToken = 512
)

// IsSessionToken reports whether v can be a test-session token. A token is opaque; it only has to
// be safe to put in a header (1 to 512 printable ASCII characters, no spaces).
func IsSessionToken(v string) bool {
	if len(v) == 0 || len(v) > maxSessionToken {
		return false
	}
	for i := 0; i < len(v); i++ {
		if v[i] < 0x21 || v[i] > 0x7e {
			return false
		}
	}
	return true
}

// sessionState is one resolved, unexpired test session.
type sessionState struct {
	id        string
	snap      *snapshot // the session's pinned bundle (attribute cache for telemetry included)
	context   Context   // the session's synthetic context
	expiresAt time.Time
}

type sessionEntry struct {
	done    chan struct{} // closed once state/until are set
	state   *sessionState
	until   time.Time // zero while the lookup is in flight
	created time.Time
}

// sessionCache is the per-client cache of session lookups, keyed by service and token.
type sessionCache struct {
	mu      sync.Mutex
	entries map[string]*sessionEntry
}

// SessionOption configures one test-session lookup.
type SessionOption func(*sessionOptions)

type sessionOptions struct{ service string }

// SessionService sends name as X-NanoFlags-Service for the lookup (default: the client's
// WithService). A session may be limited to certain services.
func SessionService(name string) SessionOption { return func(o *sessionOptions) { o.service = name } }

// SessionEvaluator evaluates flags for one test session. While Active, flags are evaluated
// against the session's pinned bundle with the session's context overlaid by the call's context
// (the call wins), and sampled events carry the session id. When the session is unknown, not
// permitted for this service, or expired, it evaluates exactly like the client (Active is false).
// It never fails. A nil *SessionEvaluator is not valid; the SDK never returns one.
type SessionEvaluator struct {
	c     *Client
	state *sessionState
}

func (s *SessionEvaluator) live() *sessionState {
	if s.state != nil && time.Now().Before(s.state.expiresAt) {
		return s.state
	}
	return nil
}

// Active reports whether the session is known and has not expired. It is re-evaluated on every call.
func (s *SessionEvaluator) Active() bool { return s.live() != nil }

// ID is the session id, or "" when the session could not be resolved.
func (s *SessionEvaluator) ID() string {
	if s.state == nil {
		return ""
	}
	return s.state.id
}

// ExpiresAt is the session's expiry time, or the zero time when the session could not be resolved.
func (s *SessionEvaluator) ExpiresAt() time.Time {
	if s.state == nil {
		return time.Time{}
	}
	return s.state.expiresAt
}

// Revision is the revision evaluations currently run against: the pinned one while Active,
// otherwise the client's (-1 when none is loaded).
func (s *SessionEvaluator) Revision() int64 {
	if st := s.live(); st != nil {
		return st.snap.bundle.Revision()
	}
	return s.c.Revision()
}

func (s *SessionEvaluator) eval(key string, ctx Context, fallback engine.Value, accepts acceptor) engine.Result {
	return s.c.evalIn(s.live(), key, ctx, fallback, accepts, true)
}

// BoolVariation is Client.BoolVariation within the session.
func (s *SessionEvaluator) BoolVariation(key string, ctx Context, fallback bool) bool {
	v, _ := s.eval(key, ctx, engine.FromGo(fallback), acceptBool).Value.Bool()
	return v
}

// BoolVariationDetail is Client.BoolVariationDetail within the session.
func (s *SessionEvaluator) BoolVariationDetail(key string, ctx Context, fallback bool) (bool, Detail) {
	r := s.eval(key, ctx, engine.FromGo(fallback), acceptBool)
	v, _ := r.Value.Bool()
	return v, toDetail(r, fallback)
}

// StringVariation is Client.StringVariation within the session.
func (s *SessionEvaluator) StringVariation(key string, ctx Context, fallback string) string {
	v, _ := s.eval(key, ctx, engine.FromGo(fallback), acceptString).Value.Str()
	return v
}

// StringVariationDetail is Client.StringVariationDetail within the session.
func (s *SessionEvaluator) StringVariationDetail(key string, ctx Context, fallback string) (string, Detail) {
	r := s.eval(key, ctx, engine.FromGo(fallback), acceptString)
	v, _ := r.Value.Str()
	return v, toDetail(r, fallback)
}

// Float64Variation is Client.Float64Variation within the session.
func (s *SessionEvaluator) Float64Variation(key string, ctx Context, fallback float64) float64 {
	if v, ok := s.eval(key, ctx, engine.FromGo(fallback), acceptNumber).Value.Number(); ok {
		return v
	}
	return fallback
}

// Float64VariationDetail is Client.Float64VariationDetail within the session.
func (s *SessionEvaluator) Float64VariationDetail(key string, ctx Context, fallback float64) (float64, Detail) {
	r := s.eval(key, ctx, engine.FromGo(fallback), acceptNumber)
	v, ok := r.Value.Number()
	if !ok {
		v = fallback
	}
	return v, toDetail(r, fallback)
}

// JSONVariation is Client.JSONVariation within the session.
func (s *SessionEvaluator) JSONVariation(key string, ctx Context, fallback any) any {
	return toDetail(s.eval(key, ctx, engine.FromGo(fallback), acceptJSON), fallback).Value
}

// JSONVariationDetail is Client.JSONVariationDetail within the session.
func (s *SessionEvaluator) JSONVariationDetail(key string, ctx Context, fallback any) (any, Detail) {
	d := toDetail(s.eval(key, ctx, engine.FromGo(fallback), acceptJSON), fallback)
	return d.Value, d
}

// Evaluate is Client.Evaluate within the session.
func (s *SessionEvaluator) Evaluate(key string, ctx Context, fallback any) Detail {
	return toDetail(s.eval(key, ctx, engine.FromGo(fallback), nil), fallback)
}

// Session resolves a test session (GET /v1/session, once per token and service until the session
// expires; concurrent callers share one request) and returns an evaluator scoped to it. Pass the
// incoming x-nanoflags-session header value. It never fails: an absent, malformed, unknown,
// expired or not permitted token, a failed lookup (reported through OnError, code ErrSession), or
// ctx ending first yields an evaluator whose Active is false and that behaves like the client.
// Unknown tokens are remembered for 15 s, failed lookups for 3 s.
func (c *Client) Session(ctx context.Context, token string, opts ...SessionOption) *SessionEvaluator {
	return &SessionEvaluator{c: c, state: c.resolveSession(ctx, token, opts)}
}

func (c *Client) resolveSession(ctx context.Context, token string, opts []SessionOption) *sessionState {
	if !IsSessionToken(token) || c.closed.Load() || c.cfg.baseURL == "" {
		return nil
	}
	o := sessionOptions{}
	if c.cfg.service != "unknown" {
		o.service = c.cfg.service
	}
	for _, fn := range opts {
		fn(&o)
	}
	key := o.service + "\n" + token
	now := time.Now()
	sc := &c.sessions
	sc.mu.Lock()
	if sc.entries == nil {
		sc.entries = map[string]*sessionEntry{}
	}
	e := sc.entries[key]
	if e != nil && !e.until.IsZero() && !now.Before(e.until) {
		delete(sc.entries, key)
		e = nil
	}
	if e == nil {
		if c.closed.Load() { // re-checked under mu: Close clears the cache before it waits for lookups
			sc.mu.Unlock()
			return nil
		}
		if len(sc.entries) >= maxSessions {
			sc.evict(now)
		}
		e = &sessionEntry{done: make(chan struct{}), created: now}
		sc.entries[key] = e
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			state, failed := c.fetchSession(token, o.service)
			until := time.Now().Add(sessionMissTTL)
			if state != nil {
				until = state.expiresAt
			} else if failed {
				until = time.Now().Add(sessionErrorTTL)
			}
			sc.mu.Lock()
			e.state, e.until = state, until
			sc.mu.Unlock()
			close(e.done)
		}()
	}
	sc.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-e.done:
		sc.mu.Lock()
		defer sc.mu.Unlock()
		return e.state
	case <-ctx.Done():
		return nil
	}
}

// evict drops expired entries, then the oldest settled ones, until there is room. Callers hold mu.
func (sc *sessionCache) evict(now time.Time) {
	for k, v := range sc.entries {
		if !v.until.IsZero() && !now.Before(v.until) {
			delete(sc.entries, k)
		}
	}
	for len(sc.entries) >= maxSessions {
		oldestKey, oldest := "", time.Time{}
		for k, v := range sc.entries {
			if oldestKey == "" || v.created.Before(oldest) {
				oldestKey, oldest = k, v.created
			}
		}
		delete(sc.entries, oldestKey)
	}
}

func (sc *sessionCache) clear() {
	sc.mu.Lock()
	sc.entries = nil
	sc.mu.Unlock()
}

// fetchSession asks the edge. It returns nil for "no such session" (unknown, expired, revoked,
// service not permitted) and on any failure; failed tells the two apart.
func (c *Client) fetchSession(token, service string) (state *sessionState, failed bool) {
	state, err := c.fetchSessionOnce(token, service)
	if err == nil {
		return state, false
	}
	if c.ctx.Err() == nil {
		ne, ok := err.(*Error)
		if !ok {
			ne = &Error{Code: ErrSession, Message: "could not load the test session: " + err.Error(), Err: err}
		}
		c.emitError(ne)
	}
	return nil, true
}

func (c *Client) fetchSessionOnce(token, service string) (*sessionState, error) {
	ctx, cancel := context.WithTimeout(c.ctx, c.cfg.requestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodGet, "/v1/session", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-NanoFlags-Session", token)
	req.Header.Set("Cache-Control", "no-store")
	if service != "" {
		req.Header.Set("X-NanoFlags-Service", service)
	}
	res, err := c.cfg.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return nil, nil
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return nil, &Error{Code: ErrUnauthorized, Message: fmt.Sprintf("session request failed with HTTP %d", res.StatusCode), HTTPStatus: res.StatusCode}
	case res.StatusCode < 200 || res.StatusCode > 299:
		return nil, &Error{Code: ErrSession, Message: fmt.Sprintf("session request failed with HTTP %d", res.StatusCode), HTTPStatus: res.StatusCode}
	}
	text, err := io.ReadAll(io.LimitReader(res.Body, maxBundleBytes+1))
	if err != nil {
		return nil, err
	}
	invalid := newError(ErrSession, "the edge returned an invalid session")
	if len(text) > maxBundleBytes {
		return nil, invalid
	}
	body, err := engine.ParseJSON(text)
	if err != nil || !body.IsObject() {
		return nil, invalid
	}
	id, okID := body.Field("id").Str()
	exp, okExp := body.Field("expires_at").Str()
	var expiresAt time.Time
	if okExp {
		expiresAt, err = time.Parse(time.RFC3339Nano, strings.TrimSpace(exp))
		okExp = err == nil
	}
	if !okID || !okExp || !isConfig(body.Field("bundle")) {
		return nil, invalid
	}
	bundle, _ := engine.NewBundle(body.Field("bundle"))
	if !bundle.SupportsEngine() {
		return nil, engineError(bundle)
	}
	if !time.Now().Before(expiresAt) {
		return nil, nil
	}
	sctx := Context{}
	if raw := body.Field("context"); raw.IsObject() {
		for _, k := range raw.Keys() {
			sctx[k] = raw.Field(k).Go()
		}
	}
	return &sessionState{id: id, snap: &snapshot{bundle: bundle}, context: sctx, expiresAt: expiresAt}, nil
}

/* ---------------- request scope (context.Context) ---------------- */

type sessionScopeKey struct{}

// sessionScope is the test session of one request: its token and the evaluators resolved for it.
type sessionScope struct {
	token string
	mu    sync.Mutex
	evals map[*Client]*SessionEvaluator
}

// WithSession returns a copy of parent that carries token as the current test session. An empty
// or malformed token returns a context outside any session (also when parent was inside one).
func WithSession(parent context.Context, token string) context.Context {
	if parent == nil {
		parent = context.Background()
	}
	token = strings.TrimSpace(token)
	if !IsSessionToken(token) {
		if scopeOf(parent) == nil {
			return parent
		}
		return context.WithValue(parent, sessionScopeKey{}, (*sessionScope)(nil))
	}
	return context.WithValue(parent, sessionScopeKey{}, &sessionScope{token: token})
}

func scopeOf(ctx context.Context) *sessionScope {
	if ctx == nil {
		return nil
	}
	s, _ := ctx.Value(sessionScopeKey{}).(*sessionScope)
	return s
}

// CurrentSession returns the token of the test session ctx belongs to, or "".
func CurrentSession(ctx context.Context) string {
	if s := scopeOf(ctx); s != nil {
		return s.token
	}
	return ""
}

// SessionHeaders returns the headers to add to a downstream call so that the next service joins
// the same session: {x-nanoflags-session: token} inside a session, otherwise an empty header.
func SessionHeaders(ctx context.Context) http.Header {
	h := http.Header{}
	if t := CurrentSession(ctx); t != "" {
		h.Set(SessionHeader, t)
	}
	return h
}

// FlagsFor returns the evaluator for the request ctx belongs to: session-scoped inside WithSession
// or SessionMiddleware, otherwise equivalent to the client. The session is resolved once per
// request and client (the first call may wait for the edge; after SessionMiddleware it does not).
// It never fails.
func (c *Client) FlagsFor(ctx context.Context, opts ...SessionOption) *SessionEvaluator {
	scope := scopeOf(ctx)
	if scope == nil {
		return &SessionEvaluator{c: c}
	}
	scope.mu.Lock()
	hit := scope.evals[c]
	scope.mu.Unlock()
	if hit != nil {
		return hit
	}
	ev := c.Session(ctx, scope.token, opts...)
	scope.mu.Lock()
	defer scope.mu.Unlock()
	if hit := scope.evals[c]; hit != nil {
		return hit
	}
	if scope.evals == nil {
		scope.evals = map[*Client]*SessionEvaluator{}
	}
	scope.evals[c] = ev
	return ev
}

// SessionMiddleware returns net/http middleware that reads x-nanoflags-session, resolves the
// session once, and serves the rest of the request inside it: c.FlagsFor(r.Context()) is the
// request's evaluator and SessionHeaders(r.Context()) propagates the session downstream. A request
// without a valid token is served unchanged. An unknown session is still propagated: the next
// service decides for itself.
//
//	mux := http.NewServeMux()
//	http.ListenAndServe(":8080", nanoflags.SessionMiddleware(client)(mux))
func SessionMiddleware(c *Client, opts ...SessionOption) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := WithSession(r.Context(), r.Header.Get(SessionHeader))
			if scopeOf(ctx) != nil {
				c.FlagsFor(ctx, opts...)
			}
			if ctx != r.Context() {
				r = r.WithContext(ctx)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SessionTransport is an http.RoundTripper that adds x-nanoflags-session to every outgoing request
// whose context belongs to a test session (see WithSession and SessionMiddleware), so downstream
// services join it. A header already set on the request is kept. Base defaults to
// http.DefaultTransport.
//
//	downstream := &http.Client{Transport: &nanoflags.SessionTransport{}}
type SessionTransport struct {
	Base http.RoundTripper
}

// RoundTrip implements http.RoundTripper.
func (t *SessionTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	token := CurrentSession(req.Context())
	if token == "" || req.Header.Get(SessionHeader) != "" {
		return base.RoundTrip(req)
	}
	r := req.Clone(req.Context()) // a RoundTripper must not modify the caller's request
	r.Header.Set(SessionHeader, token)
	return base.RoundTrip(r)
}
