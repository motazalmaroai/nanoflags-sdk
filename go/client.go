package nanoflags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// SDKVersion is the version of this SDK, reported to the edge as "go/<version>".
const SDKVersion = "0.1.0"

// SupportedEngineVersion is the newest bundle format (`bundle.engine`) this SDK evaluates.
// Newer bundles are refused; the configuration in use stays.
const SupportedEngineVersion = engine.Version

// CloseEnvironmentDeleted is the WebSocket close code with which the edge tells SDKs that the
// environment was deleted. The client stops reconnecting and keeps its last configuration.
const CloseEnvironmentDeleted = 4004

// Status is the state of the configuration in use.
type Status int32

const (
	// StatusNotReady: no configuration is loaded; every evaluation returns its fallback.
	StatusNotReady Status = iota
	// StatusReady: the configuration is known to be current.
	StatusReady
	// StatusStale: a configuration is in use but is not known to be current (edge unreachable,
	// restored from the store, environment deleted, ...).
	StatusStale
)

func (s Status) String() string {
	switch s {
	case StatusReady:
		return "ready"
	case StatusStale:
		return "stale"
	}
	return "not-ready"
}

// Transport says how updates reach the client right now.
type Transport string

const (
	TransportLive   Transport = "live"   // pushed over the /v1/live WebSocket
	TransportStream Transport = "stream" // announced over server-sent events, then fetched
	TransportPoll   Transport = "poll"   // polled
)

// Source says where an adopted configuration came from.
type Source string

const (
	SourceNetwork   Source = "network"
	SourceStore     Source = "store"
	SourceBootstrap Source = "bootstrap"
)

// ChangeEvent describes a newly adopted configuration.
type ChangeEvent struct {
	Revision int64
	// PreviousRevision is -1 when no configuration was loaded before.
	PreviousRevision int64
	Checksum         string
	Source           Source
	Transport        Transport
	// Latency is the time from the commit of the revision in the database to this event, for
	// revisions pushed over the live socket that carry their commit time (HasLatency). It
	// compares the database's clock with this machine's.
	Latency    time.Duration
	HasLatency bool
}

// Context holds the attributes of the evaluated entity. "key" is the stable identity used for
// percentage rollouts. Values may be strings, booleans, numbers, nil, slices and maps.
type Context map[string]any

// Reason says why an evaluation produced its value.
type Reason = engine.Reason

const (
	ReasonRuleMatch    = engine.ReasonRuleMatch
	ReasonDefault      = engine.ReasonDefault
	ReasonOff          = engine.ReasonOff
	ReasonFlagNotFound = engine.ReasonFlagNotFound
	ReasonError        = engine.ReasonError
)

// TraceStep is one line of the explanation of an evaluation.
type TraceStep = engine.TraceStep

// Detail is the full result of an evaluation.
type Detail struct {
	FlagKey string
	Value   any
	Reason  Reason
	// RuleIndex is the zero-based index of the matching rule, or -1.
	RuleIndex int
	RuleID    string
	// InRollout and Bucket (0–99.99) are set for percentage rollouts.
	InRollout *bool
	Bucket    *float64
	Revision  int64
	Trace     []TraceStep
	// Error explains reason "error" (evaluation error or type mismatch).
	Error string
	raw   engine.Value
}

// ValueIsUndefined reports whether the configuration served no value at all (a malformed flag).
func (d Detail) ValueIsUndefined() bool { return d.raw.IsUndefined() }

// TypeName names the type of the served value: "boolean", "string", "number", "array",
// "object", "null" or "undefined".
func (d Detail) TypeName() string { return d.raw.TypeName() }

// JSON returns the served value as JSON text, with object keys in configuration order.
func (d Detail) JSON() json.RawMessage {
	b, _ := d.raw.MarshalJSON()
	return b
}

type snapshot struct {
	bundle   *engine.Bundle
	etag     string
	checksum string
	sig      *signatureInfo
	raw      []byte // the signed bundle text (nil when unsigned or re-serialisation verified)
	attrs    sync.Map
}

// Client evaluates flags locally against an in-memory configuration that it keeps current in
// the background. Evaluations never perform I/O and never fail: on any problem they return the
// fallback. A Client is safe for concurrent use; create one per SDK key and share it.
type Client struct {
	cfg      config
	sdkKey   string
	id       string
	browser  bool
	verifier *verifier
	log      *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	snap      atomic.Pointer[snapshot]
	status    atomic.Int32
	liveOpen  atomic.Bool
	streaming atomic.Bool
	closed    atomic.Bool

	readyOnce sync.Once
	readyCh   chan struct{}

	syncMu  sync.Mutex // serialises bundle requests (single flight)
	adoptMu sync.Mutex // serialises compare-and-adopt decisions (never held during I/O)
	mu      sync.Mutex // guards the fields below
	// failures counts consecutive failed requests (backoff).
	failures           int
	lastErr            error
	pinnedEnvironment  string
	liveRevision       int64
	environmentDeleted bool
	streamCancel       context.CancelFunc
	liveConn           *websocket.Conn
	streamTriggered    bool
	lastSyncAt         time.Time

	kick    chan struct{}
	resched chan struct{}

	listeners listeners
	events    *eventQueue
}

// New creates a client for sdkKey (`nf_srv_…` on servers) and starts loading the configuration
// in the background. It returns an error only for an invalid configuration; use WaitForReady to
// wait for the first load. Close the client when done.
func New(sdkKey string, opts ...Option) (*Client, error) {
	cfg := config{
		baseURL:            OfficialEdgeURL,
		service:            "unknown",
		pollInterval:       30 * time.Second,
		livePollInterval:   5 * time.Minute,
		streaming:          true,
		live:               true,
		eventsEnabled:      true,
		sampleRate:         0.1,
		flushInterval:      10 * time.Second,
		reportInterval:     60 * time.Second,
		requestTimeout:     10 * time.Second,
		liveConnectTimeout: 10 * time.Second,
		random:             rand.Float64,
	}
	for _, o := range opts {
		o(&cfg)
	}
	if strings.TrimSpace(sdkKey) == "" {
		return nil, newError(ErrConfig, "an SDK key is required")
	}
	if !strings.HasPrefix(cfg.baseURL, "https://") && !strings.HasPrefix(cfg.baseURL, "http://") {
		return nil, newError(ErrConfig, "the base URL must be an http(s) URL, got %q", cfg.baseURL)
	}
	if cfg.httpClient == nil {
		cfg.httpClient = &http.Client{}
	}
	if cfg.logger == nil {
		cfg.logger = slog.New(discardHandler{})
	}
	cfg.sampleRate = math.Min(1, math.Max(0, cfg.sampleRate))
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		cfg:     cfg,
		sdkKey:  sdkKey,
		id:      fmt.Sprintf("%08x", engine.Murmur3(cfg.baseURL+"|"+sdkKey, 0)),
		browser: strings.HasPrefix(sdkKey, "nf_pub_"),
		log:     cfg.logger,
		ctx:     ctx,
		cancel:  cancel,
		readyCh: make(chan struct{}),
		kick:    make(chan struct{}, 1),
		resched: make(chan struct{}, 1),
	}
	c.listeners.init(ctx, &c.wg)
	var cfgErrs []error
	c.verifier, cfgErrs = newVerifier(&cfg, c)
	c.events = newEventQueue(c)
	for _, e := range cfgErrs {
		c.emitError(e)
	}
	if cfg.bootstrapErr != nil {
		c.emitError(&Error{Code: ErrInvalidBundle, Message: "the bootstrap bundle is invalid and was ignored", Err: cfg.bootstrapErr})
	} else if b := cfg.bootstrap; b != nil {
		if !b.SupportsEngine() {
			c.emitError(engineError(b))
		} else {
			c.adopt(&snapshot{bundle: b}, StatusReady, SourceBootstrap, TransportPoll, nil)
		}
	}
	c.wg.Add(1)
	go c.run()
	return c, nil
}

// WaitForReady blocks until the first load attempt has finished (or a configuration was
// adopted, for example from WithBootstrap). It returns nil when a configuration is in use,
// otherwise the error that prevented loading one (or ErrNotReady); ctx.Err() when ctx ends first.
func (c *Client) WaitForReady(ctx context.Context) error {
	select {
	case <-c.readyCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	if c.snap.Load() != nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastErr != nil {
		return c.lastErr
	}
	return ErrNotReady
}

// Ready returns a channel that is closed once WaitForReady would return.
func (c *Client) Ready() <-chan struct{} { return c.readyCh }

func (c *Client) markReady() { c.readyOnce.Do(func() { close(c.readyCh) }) }

// Status reports the state of the configuration in use.
func (c *Client) Status() Status { return Status(c.status.Load()) }

// Revision is the revision in use, or -1 when no configuration is loaded.
func (c *Client) Revision() int64 {
	if s := c.snap.Load(); s != nil {
		return s.bundle.Revision()
	}
	return -1
}

// Transport reports how updates reach the client right now.
func (c *Client) Transport() Transport {
	switch {
	case c.liveOpen.Load():
		return TransportLive
	case c.streaming.Load():
		return TransportStream
	}
	return TransportPoll
}

// Bundle returns the configuration in use (nil when none is loaded). Bundles are immutable.
func (c *Client) Bundle() *engine.Bundle {
	if s := c.snap.Load(); s != nil {
		return s.bundle
	}
	return nil
}

// OnChange registers fn for every newly adopted configuration and returns a function that
// unregisters it. Callbacks run one at a time, in order, on a goroutine of the client.
func (c *Client) OnChange(fn func(ChangeEvent)) (unsubscribe func()) {
	return c.listeners.addChange(fn)
}

// OnError registers fn for background errors (failed requests, rejected signatures, ...).
// A failed update never changes the configuration in use.
func (c *Client) OnError(fn func(error)) (unsubscribe func()) { return c.listeners.addError(fn) }

// OnStatus registers fn for status changes.
func (c *Client) OnStatus(fn func(Status)) (unsubscribe func()) { return c.listeners.addStatus(fn) }

// Refresh revalidates the configuration now and returns when the request has finished.
func (c *Client) Refresh(ctx context.Context) error {
	if c.closed.Load() {
		return newError(ErrConfig, "the client is closed")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(c.ctx, cancel) // Close cancels a refresh in progress
	defer stop()
	return c.syncNow(ctx, false)
}

// Flush sends queued telemetry now.
func (c *Client) Flush(ctx context.Context) error { return c.events.flush(ctx) }

// Close stops every background activity (after a best-effort final telemetry flush) and waits
// for it to end. Evaluations keep working on the last configuration. Close is idempotent.
func (c *Client) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	flushCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = c.events.flush(flushCtx)
	cancel()
	c.cancel()
	c.stopStream()
	c.markReady()
	c.wg.Wait()
	return nil
}

/* ---------------- adoption ---------------- */

func (c *Client) setStatus(s Status) {
	if Status(c.status.Swap(int32(s))) != s {
		c.listeners.emitStatus(s)
	}
}

// adopt swaps the configuration in use atomically. Callers hold adoptMu or are the constructor.
func (c *Client) adopt(next *snapshot, status Status, source Source, transport Transport, latency *time.Duration) {
	prev := c.snap.Swap(next)
	c.setStatus(status)
	c.markReady()
	if prev != nil && prev.bundle.Revision() == next.bundle.Revision() && prev.checksum == next.checksum {
		return
	}
	ev := ChangeEvent{Revision: next.bundle.Revision(), PreviousRevision: -1, Checksum: next.checksum, Source: source, Transport: transport}
	if prev != nil {
		ev.PreviousRevision = prev.bundle.Revision()
	}
	if latency != nil {
		ev.Latency, ev.HasLatency = *latency, true
	}
	c.listeners.emitChange(ev)
}

func engineError(b *engine.Bundle) *Error {
	e, ok := b.Engine().JSON()
	if !ok {
		e = "undefined"
	}
	return newError(ErrEngine, "bundle r%d needs evaluation engine %s; this SDK supports up to %d. Upgrade the NanoFlags Go SDK. The configuration in use is unchanged.", b.Revision(), e, engine.Version)
}

func (c *Client) emitError(err error) {
	c.log.Debug("nanoflags", "error", err)
	c.listeners.emitError(err)
}

/* ---------------- background loop ---------------- */

func (c *Client) run() {
	defer c.wg.Done()
	c.restore()
	_ = c.syncNow(c.ctx, false)
	c.markReady()
	if c.ctx.Err() != nil {
		return
	}
	c.events.start()
	c.startRealtime()
	var timer *time.Timer
	var timerC <-chan time.Time
	reset := func() {
		if timer != nil {
			timer.Stop()
		}
		if c.cfg.pollInterval <= 0 {
			return
		}
		timer = time.NewTimer(c.nextDelay())
		timerC = timer.C
	}
	reset()
	for {
		select {
		case <-c.ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case <-timerC:
			_ = c.syncNow(c.ctx, false)
			reset()
		case <-c.kick:
			_ = c.syncNow(c.ctx, true)
			reset()
		case <-c.resched:
			reset()
		}
	}
}

func (c *Client) reschedule() {
	select {
	case c.resched <- struct{}{}:
	default:
	}
}

func (c *Client) trigger() {
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

func (c *Client) nextDelay() time.Duration {
	c.mu.Lock()
	failures := c.failures
	c.mu.Unlock()
	interval := c.cfg.pollInterval
	if c.liveOpen.Load() && c.cfg.livePollInterval > interval {
		interval = c.cfg.livePollInterval
	}
	base := interval
	if failures > 0 {
		// After failures, catch up quickly: 1s, 2s, 4s … capped at the poll interval.
		backoff := time.Second << min(failures-1, 10)
		base = min(c.cfg.pollInterval, backoff)
	}
	d := time.Duration(float64(base) * (0.8 + 0.4*rand.Float64()))
	return max(250*time.Millisecond, d)
}

/* ---------------- polling: GET /v1/bundle ---------------- */

const maxBundleBytes = 16 << 20

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.sdkKey)
	req.Header.Set("User-Agent", "nanoflags-go/"+SDKVersion)
	return req, nil
}

// syncNow performs one conditional bundle request and adopts what it returns.
func (c *Client) syncNow(ctx context.Context, fromStream bool) error {
	c.syncMu.Lock()
	defer c.syncMu.Unlock()
	if c.ctx.Err() != nil {
		return c.ctx.Err()
	}
	c.mu.Lock()
	c.lastSyncAt = time.Now()
	transport := TransportPoll
	if c.streamTriggered || fromStream {
		transport = TransportStream
	}
	c.streamTriggered = false
	c.mu.Unlock()
	err := c.syncOnce(ctx, transport)
	if err == nil {
		c.mu.Lock()
		c.failures, c.lastErr = 0, nil
		c.mu.Unlock()
		return nil
	}
	if c.ctx.Err() != nil {
		return err
	}
	var ne *Error
	if !errors.As(err, &ne) {
		ne = &Error{Code: ErrNetwork, Message: "could not reach the NanoFlags edge: " + err.Error(), Err: err}
	}
	c.mu.Lock()
	c.lastErr = ne
	if ne.Code != ErrEngine {
		c.failures++
	}
	c.mu.Unlock()
	switch ne.Code {
	case ErrEngine, ErrSignature:
		// A rejected update changes nothing: same configuration, same status.
	default:
		if ne.Code == ErrUnauthorized {
			c.dropLive()
		}
		if c.snap.Load() != nil {
			c.setStatus(StatusStale)
		}
	}
	c.emitError(ne)
	return ne
}

func (c *Client) syncOnce(ctx context.Context, transport Transport) error {
	ctx, cancel := context.WithTimeout(ctx, c.cfg.requestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodGet, "/v1/bundle", nil)
	if err != nil {
		return err
	}
	cur := c.snap.Load()
	if cur != nil && cur.etag != "" {
		req.Header.Set("If-None-Match", cur.etag)
	}
	res, err := c.cfg.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	servedStale := res.Header.Get("X-NanoFlags-Stale") == "true"
	switch {
	case res.StatusCode == http.StatusNotModified:
		if cur != nil {
			c.setStatus(statusFor(servedStale))
		}
		return nil
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return &Error{Code: ErrUnauthorized, Message: "the SDK key was rejected (unknown or revoked)", HTTPStatus: res.StatusCode}
	case res.StatusCode < 200 || res.StatusCode > 299:
		return &Error{Code: ErrHTTP, Message: fmt.Sprintf("bundle request failed with HTTP %d", res.StatusCode), HTTPStatus: res.StatusCode}
	}
	text, err := io.ReadAll(io.LimitReader(res.Body, maxBundleBytes+1))
	if err != nil {
		return err
	}
	if len(text) > maxBundleBytes {
		return newError(ErrInvalidBundle, "the edge returned a bundle larger than %d bytes", maxBundleBytes)
	}
	body, err := engine.ParseJSON(text)
	if err != nil || !engine.IsBundle(body.Field("bundle")) {
		return newError(ErrInvalidBundle, "the edge returned an invalid bundle")
	}
	bundle, _ := engine.NewBundle(body.Field("bundle"))
	checksum, _ := body.Field("checksum").Str()
	next := &snapshot{bundle: bundle, etag: res.Header.Get("ETag"), checksum: checksum}
	if err := c.checkSignature(ctx, res.Header, text, body, next); err != nil {
		return err
	}
	if !bundle.SupportsEngine() {
		return engineError(bundle)
	}
	c.adoptMu.Lock()
	defer c.adoptMu.Unlock()
	cur = c.snap.Load()
	// The edge is serving its last-known-good copy: never go backwards because of it.
	if servedStale && cur != nil && cur.bundle.Revision() >= bundle.Revision() {
		c.setStatus(StatusStale)
		return nil
	}
	// A revision that was pushed while this request was under way wins.
	c.mu.Lock()
	liveRevision := c.liveRevision
	c.mu.Unlock()
	if cur != nil && bundle.Revision() < liveRevision && cur.bundle.Revision() >= liveRevision {
		return nil
	}
	c.adopt(next, statusFor(servedStale), SourceNetwork, transport, nil)
	c.persist(next)
	return nil
}

func statusFor(stale bool) Status {
	if stale {
		return StatusStale
	}
	return StatusReady
}

// checkSignature verifies the response's signature (when verification is on) and records it on next.
func (c *Client) checkSignature(ctx context.Context, h http.Header, text []byte, body engine.Value, next *snapshot) error {
	v := c.verifier
	if v == nil {
		return nil
	}
	rev := next.bundle.Revision()
	reject := func(why string) error {
		return newError(ErrSignature, "bundle r%d was rejected: %s The configuration in use is unchanged.", rev, why)
	}
	if h.Get("X-NanoFlags-Signed") != "true" {
		if v.require {
			return reject("it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.")
		}
		return nil
	}
	signature, envID, kid := h.Get("X-NanoFlags-Signature"), h.Get("X-NanoFlags-Environment-Id"), h.Get("X-NanoFlags-Key-Id")
	checksum, ok := body.Field("checksum").Str()
	if signature == "" || envID == "" || !ok {
		return reject("the signature headers are incomplete.")
	}
	revision := rev
	if r, ok := body.Field("revision").Number(); ok {
		revision = int64(r)
		if r != float64(rev) {
			return reject("the signed revision does not match the bundle.")
		}
	}
	c.mu.Lock()
	pinned := c.pinnedEnvironment
	c.mu.Unlock()
	if pinned != "" && pinned != envID {
		return reject("it was signed for a different environment.")
	}
	info := signatureInfo{Signature: signature, Kid: kid, EnvironmentID: envID, Revision: revision, Checksum: checksum}
	keys, err := v.keysFor(ctx, kid)
	if err != nil {
		return reject(fmt.Sprintf("the signing keys could not be loaded (%v).", err))
	}
	// The edge embeds the stored bundle text byte-for-byte; re-serialisation is the fallback.
	raw := rawMember(text, "bundle")
	verified := raw != nil && verifyBundleText(keys, info, raw)
	if !verified {
		if again, ok := next.bundle.Value().JSON(); ok && string(raw) != again && verifyBundleText(keys, info, []byte(again)) {
			verified, raw = true, []byte(again)
		}
	}
	if !verified {
		return reject("its signature does not verify.")
	}
	c.mu.Lock()
	c.pinnedEnvironment = envID
	c.mu.Unlock()
	next.sig, next.raw = &info, raw
	return nil
}

/* ---------------- persistence ---------------- */

type persisted struct {
	V        int             `json:"v"`
	ID       string          `json:"id"`
	ETag     string          `json:"etag,omitempty"`
	Checksum string          `json:"checksum,omitempty"`
	SavedAt  string          `json:"savedAt"`
	Bundle   json.RawMessage `json:"bundle"`
	Sig      *signatureInfo  `json:"sig,omitempty"`
}

func (c *Client) persist(s *snapshot) {
	if c.cfg.store == nil {
		return
	}
	raw := s.raw
	if raw == nil {
		text, _ := s.bundle.Value().JSON()
		raw = []byte(text)
	}
	data, err := json.Marshal(persisted{V: 1, ID: c.id, ETag: s.etag, Checksum: s.checksum, SavedAt: time.Now().UTC().Format(time.RFC3339Nano), Bundle: raw, Sig: s.sig})
	if err == nil {
		ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
		err = c.cfg.store.Save(ctx, data)
		cancel()
	}
	if err != nil {
		c.emitError(&Error{Code: ErrStore, Message: "could not persist the bundle", Err: err})
	}
}

func (c *Client) restore() {
	if c.cfg.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	data, err := c.cfg.store.Load(ctx)
	if err != nil {
		c.emitError(&Error{Code: ErrStore, Message: "could not read the persisted bundle", Err: err})
		return
	}
	if len(data) == 0 {
		return
	}
	var p persisted
	if json.Unmarshal(data, &p) != nil || p.V != 1 || p.ID != c.id {
		return
	}
	// json.RawMessage keeps the exact bytes that were signed.
	bundle, err := engine.ParseBundle(p.Bundle)
	if err != nil {
		return
	}
	if !bundle.SupportsEngine() {
		c.emitError(engineError(bundle))
		return
	}
	if cur := c.snap.Load(); cur != nil && cur.bundle.Revision() >= bundle.Revision() {
		return
	}
	next := &snapshot{bundle: bundle, etag: p.ETag, checksum: p.Checksum}
	if v := c.verifier; v != nil {
		// The store is outside the trust boundary: a signed copy must verify again, and with
		// Require an unsigned copy is not used at all.
		if s := p.Sig; s != nil && s.Revision == bundle.Revision() {
			keys, err := v.keysFor(ctx, s.Kid)
			if err != nil || !verifyBundleText(keys, *s, p.Bundle) {
				c.emitError(newError(ErrSignature, "the persisted bundle failed signature verification and was ignored"))
				return
			}
			next.sig, next.raw = s, []byte(p.Bundle)
			c.mu.Lock()
			if c.pinnedEnvironment == "" {
				c.pinnedEnvironment = s.EnvironmentID
			}
			c.mu.Unlock()
		} else if v.require {
			return
		}
	}
	c.adoptMu.Lock()
	defer c.adoptMu.Unlock()
	if cur := c.snap.Load(); cur != nil && cur.bundle.Revision() >= bundle.Revision() {
		return
	}
	// A restored bundle is usable but not known to be current: stale until the edge confirms it.
	c.adopt(next, StatusStale, SourceStore, TransportPoll, nil)
}

/* ---------------- evaluation ---------------- */

type acceptor func(engine.Value) bool

func acceptBool(v engine.Value) bool   { return v.IsBool() }
func acceptString(v engine.Value) bool { return v.IsString() }
func acceptNumber(v engine.Value) bool { _, ok := v.Number(); return ok }
func acceptJSON(v engine.Value) bool   { return !v.IsUndefined() }

func (c *Client) eval(key string, ctx Context, fallback engine.Value, accepts acceptor, record bool) engine.Result {
	s := c.snap.Load()
	var b *engine.Bundle
	if s != nil {
		b = s.bundle
	}
	res := b.Evaluate(key, engine.MapContext(ctx), fallback)
	if accepts != nil && res.Reason != engine.ReasonFlagNotFound && res.Reason != engine.ReasonError && !accepts(res.Value) {
		msg := fmt.Sprintf("Flag %q has a %s value, which does not match the requested type.", key, res.Value.TypeName())
		res = engine.Result{FlagKey: key, Value: fallback, Reason: engine.ReasonError, RuleIndex: -1, Revision: res.Revision, Err: msg,
			Trace: append(res.Trace, engine.TraceStep{Kind: "result", Title: "Returned the fallback", Detail: msg})}
	}
	if record {
		c.events.record(&res, ctx, s)
	}
	return res
}

func toDetail(r engine.Result, fallback any) Detail {
	d := Detail{FlagKey: r.FlagKey, Reason: r.Reason, RuleIndex: r.RuleIndex, InRollout: r.InRollout, Bucket: r.Bucket, Trace: r.Trace, Error: r.Err, raw: r.Value}
	if n, ok := r.Revision.Number(); ok {
		d.Revision = int64(n)
	}
	if r.RuleIndex >= 0 {
		if s, ok := r.RuleID.Str(); ok {
			d.RuleID = s
		} else if j, ok := r.RuleID.JSON(); ok {
			d.RuleID = j
		}
	}
	if r.Reason == engine.ReasonFlagNotFound || r.Reason == engine.ReasonError {
		d.Value = fallback
	} else {
		d.Value = r.Value.Go()
	}
	return d
}

// BoolVariation returns the boolean value of flag key for ctx, or fallback when the flag is
// missing, the configuration is not loaded, or the flag serves another type.
func (c *Client) BoolVariation(key string, ctx Context, fallback bool) bool {
	v, _ := c.eval(key, ctx, engine.FromGo(fallback), acceptBool, true).Value.Bool()
	return v
}

// BoolVariationDetail is BoolVariation with the full evaluation result.
func (c *Client) BoolVariationDetail(key string, ctx Context, fallback bool) (bool, Detail) {
	r := c.eval(key, ctx, engine.FromGo(fallback), acceptBool, true)
	v, _ := r.Value.Bool()
	return v, toDetail(r, fallback)
}

// StringVariation returns the string value of flag key for ctx, or fallback.
func (c *Client) StringVariation(key string, ctx Context, fallback string) string {
	v, _ := c.eval(key, ctx, engine.FromGo(fallback), acceptString, true).Value.Str()
	return v
}

// StringVariationDetail is StringVariation with the full evaluation result.
func (c *Client) StringVariationDetail(key string, ctx Context, fallback string) (string, Detail) {
	r := c.eval(key, ctx, engine.FromGo(fallback), acceptString, true)
	v, _ := r.Value.Str()
	return v, toDetail(r, fallback)
}

// Float64Variation returns the numeric value of flag key for ctx, or fallback.
func (c *Client) Float64Variation(key string, ctx Context, fallback float64) float64 {
	r := c.eval(key, ctx, engine.FromGo(fallback), acceptNumber, true)
	if v, ok := r.Value.Number(); ok {
		return v
	}
	return fallback
}

// Float64VariationDetail is Float64Variation with the full evaluation result.
func (c *Client) Float64VariationDetail(key string, ctx Context, fallback float64) (float64, Detail) {
	r := c.eval(key, ctx, engine.FromGo(fallback), acceptNumber, true)
	v, ok := r.Value.Number()
	if !ok {
		v = fallback
	}
	return v, toDetail(r, fallback)
}

// JSONVariation returns the value of a JSON flag as plain Go data (nil, bool, float64, string,
// []any, map[string]any), or fallback. Any served value is accepted except none at all.
func (c *Client) JSONVariation(key string, ctx Context, fallback any) any {
	return toDetail(c.eval(key, ctx, engine.FromGo(fallback), acceptJSON, true), fallback).Value
}

// JSONVariationDetail is JSONVariation with the full evaluation result (Detail.JSON gives the
// exact JSON text).
func (c *Client) JSONVariationDetail(key string, ctx Context, fallback any) (any, Detail) {
	d := toDetail(c.eval(key, ctx, engine.FromGo(fallback), acceptJSON, true), fallback)
	return d.Value, d
}

// Evaluate returns the full engine result without any type check.
func (c *Client) Evaluate(key string, ctx Context, fallback any) Detail {
	return toDetail(c.eval(key, ctx, engine.FromGo(fallback), nil, true), fallback)
}

// AllFlags evaluates every flag of the configuration in use for ctx and returns their values
// (nil for a flag that serves nothing). It records no telemetry. Empty without a configuration.
func (c *Client) AllFlags(ctx Context) map[string]any {
	out := map[string]any{}
	for k, d := range c.AllFlagsDetail(ctx) {
		out[k] = d.Value
	}
	return out
}

// AllFlagsDetail is AllFlags with the full evaluation result of every flag.
func (c *Client) AllFlagsDetail(ctx Context) map[string]Detail {
	out := map[string]Detail{}
	s := c.snap.Load()
	if s == nil {
		return out
	}
	for _, k := range s.bundle.FlagKeys() {
		r := s.bundle.Evaluate(k, engine.MapContext(ctx), engine.Null)
		if r.Reason == engine.ReasonFlagNotFound {
			continue // keys whose entry is not a flag at all
		}
		out[k] = toDetail(r, nil)
	}
	return out
}

/* ---------------- listeners ---------------- */

type listeners struct {
	mu     sync.Mutex
	next   int
	change map[int]func(ChangeEvent)
	errs   map[int]func(error)
	status map[int]func(Status)
	queue  []func()
	signal chan struct{}
}

func (l *listeners) init(ctx context.Context, wg *sync.WaitGroup) {
	l.change, l.errs, l.status = map[int]func(ChangeEvent){}, map[int]func(error){}, map[int]func(Status){}
	l.signal = make(chan struct{}, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case <-l.signal:
			}
			for {
				l.mu.Lock()
				if len(l.queue) == 0 {
					l.mu.Unlock()
					break
				}
				fn := l.queue[0]
				l.queue = l.queue[1:]
				l.mu.Unlock()
				func() {
					defer func() { _ = recover() }() // a listener must never break the client
					fn()
				}()
			}
		}
	}()
}

func (l *listeners) add(register func(id int)) func() {
	l.mu.Lock()
	id := l.next
	l.next++
	register(id)
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		delete(l.change, id)
		delete(l.errs, id)
		delete(l.status, id)
		l.mu.Unlock()
	}
}

func (l *listeners) addChange(fn func(ChangeEvent)) func() {
	return l.add(func(id int) { l.change[id] = fn })
}
func (l *listeners) addError(fn func(error)) func() { return l.add(func(id int) { l.errs[id] = fn }) }
func (l *listeners) addStatus(fn func(Status)) func() {
	return l.add(func(id int) { l.status[id] = fn })
}

func (l *listeners) enqueue(fn func()) {
	l.mu.Lock()
	l.queue = append(l.queue, fn)
	l.mu.Unlock()
	select {
	case l.signal <- struct{}{}:
	default:
	}
}

func sortedIDs[T any](m map[int]T) []T {
	out := make([]T, 0, len(m))
	for i := 0; len(out) < len(m); i++ {
		if fn, ok := m[i]; ok {
			out = append(out, fn)
		}
	}
	return out
}

func (l *listeners) emitChange(e ChangeEvent) {
	l.mu.Lock()
	fns := sortedIDs(l.change)
	l.mu.Unlock()
	if len(fns) > 0 {
		l.enqueue(func() {
			for _, fn := range fns {
				fn(e)
			}
		})
	}
}

func (l *listeners) emitError(err error) {
	l.mu.Lock()
	fns := sortedIDs(l.errs)
	l.mu.Unlock()
	if len(fns) > 0 {
		l.enqueue(func() {
			for _, fn := range fns {
				fn(err)
			}
		})
	}
}

func (l *listeners) emitStatus(s Status) {
	l.mu.Lock()
	fns := sortedIDs(l.status)
	l.mu.Unlock()
	if len(fns) > 0 {
		l.enqueue(func() {
			for _, fn := range fns {
				fn(s)
			}
		})
	}
}

type discardHandler struct{}

func (discardHandler) Enabled(context.Context, slog.Level) bool  { return false }
func (discardHandler) Handle(context.Context, slog.Record) error { return nil }
func (d discardHandler) WithAttrs([]slog.Attr) slog.Handler      { return d }
func (d discardHandler) WithGroup(string) slog.Handler           { return d }
