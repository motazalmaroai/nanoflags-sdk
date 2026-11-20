package nanoflags

// Shadow evaluation of drafts (migration 0179, RUNTIME.md "Shadow evaluation of drafts").
//
// While a change waits for approval in an environment whose admin turned shadow evaluation on,
// the edge announces a signed shadow bundle (X-NanoFlags-Shadow on /v1/bundle, the bundle itself
// on /v1/shadow). For a sample of the evaluations of the flags the draft changes, the client
// evaluates the draft as well and counts, per flag, how often the value would change. Only those
// counters leave the process, with the next /v1/events report:
//
//	{sessionId, checksum, version?, flags: [{flag, samples, flips, pairs: [{live, shadow, count}], rules: {"<i>" | "default": n}}]}
//
// No context, attribute, key or identifier is ever part of it. Values are the flag's own
// configured values, as JSON text with object keys sorted, at most 100 characters (longer ones
// are replaced by a hash); a side that used the app's own fallback (flag missing there,
// evaluation error, wrong type) is reported as "<fallback>", never as the value. The shadow
// bundle is NEVER applied: the app always gets the live value, and the client refuses any bundle
// that carries a "shadow" member as configuration.
//
// Same wire format and rules as the JavaScript SDK (packages/sdk/src/shadow.ts).

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

const (
	maxShadowFlags      = 100
	maxShadowPairs      = 10
	maxShadowRules      = 50
	maxShadowValueChars = 100
	// The edge accepts counts up to 10^7 and flag keys of 1–63 characters in a report.
	maxShadowCount   = 10_000_000
	maxShadowFlagKey = 63
	// Shadow counters go out with the events report at most this often (and always on Flush and Close).
	shadowFlushInterval = time.Minute
	// A failed shadow fetch is not retried for the same announcement before this.
	shadowRetryInterval = time.Minute
	// shadowFallback is reported instead of a value that did not come from a bundle: the
	// application's own fallback (flag missing on that side, evaluation error, or a value of the
	// wrong type). The fallback is the app's data and never leaves the SDK.
	shadowFallback = "<fallback>"
)

// ShadowOptions configures shadow evaluation of drafts. While a change waits for approval in an
// environment where an admin turned it on, the client evaluates the change's draft (a signed
// shadow bundle, verified and never applied) next to the live configuration for a sample of the
// evaluations of the flags the draft changes, and reports only aggregate counters with its
// telemetry: never a context, attribute or identifier. It needs events enabled.
type ShadowOptions struct {
	// Disabled never fetches nor evaluates shadow bundles.
	Disabled bool
	// SampleRate is the fraction of evaluations of changed flags that are also evaluated with the
	// draft, 0–1. Default 0.1; use a negative value for 0.
	SampleRate float64
}

// WithShadow configures shadow evaluation of drafts (default: on, sample rate 0.1, while events
// are enabled). WithShadow(ShadowOptions{Disabled: true}) turns it off.
func WithShadow(o ShadowOptions) Option {
	return func(c *config) {
		c.shadowDisabled = o.Disabled
		if o.SampleRate != 0 {
			c.shadowSampleRate = o.SampleRate
		}
	}
}

// WithServiceVersion labels reports with your service's own version (e.g. "3.1.0", at most 40
// characters). It is shown next to the service name on the change page's "Production impact
// (shadow)" panel, so a difference that only one release has stands out.
func WithServiceVersion(v string) Option {
	return func(c *config) { c.serviceVersion = truncateUTF16(strings.TrimSpace(v), 40) }
}

func withShadowRandom(r func() float64) Option { return func(c *config) { c.shadowRandom = r } }

var (
	shadowUUID     = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	shadowChecksum = regexp.MustCompile(`^[0-9a-f]{32}$`)
	shadowHeaderRe = regexp.MustCompile(`(?i)^([0-9a-f-]{36})\.([0-9a-f]{32})$`)
)

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func truncateUTF16(s string, n int) string {
	if utf16Len(s) <= n {
		return s
	}
	used := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if used+w > n {
			return s[:i]
		}
		used += w
	}
	return s
}

type shadowID struct{ sessionID, checksum string }

// parseShadowHeader parses `X-NanoFlags-Shadow: <sessionId>.<checksum>` (lower-cased).
func parseShadowHeader(v string) (shadowID, bool) {
	m := shadowHeaderRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil || !shadowUUID.MatchString(m[1]) {
		return shadowID{}, false
	}
	return shadowID{strings.ToLower(m[1]), strings.ToLower(m[2])}, true
}

type shadowMarker struct {
	sessionID, checksum, environmentID string
}

// shadowMarkerOf returns the `shadow` member of a shadow bundle (inside the signed bytes).
func shadowMarkerOf(v engine.Value) (shadowMarker, bool) {
	sid, ok1 := v.Field("sessionId").Str()
	cs, ok2 := v.Field("checksum").Str()
	env, ok3 := v.Field("environmentId").Str()
	if !v.IsObject() || !ok1 || !shadowUUID.MatchString(sid) || !ok2 || !shadowChecksum.MatchString(cs) || !ok3 || !v.Field("baseRevision").IsNumber() {
		return shadowMarker{}, false
	}
	return shadowMarker{sid, cs, env}, true
}

// isShadowBundle: the bundle shape (object segments) plus a valid `shadow` marker.
func isShadowBundle(v engine.Value) bool {
	_, ok := shadowMarkerOf(v.Field("shadow"))
	return ok && engine.IsBundle(v) && v.Field("segments").IsObject()
}

// isConfig reports whether v may be used as configuration. A shadow bundle (any bundle with a
// `shadow` member) never is, on any path: poll, push, restore, bootstrap, test sessions.
func isConfig(v engine.Value) bool { return engine.IsBundle(v) && v.Field("shadow").IsUndefined() }

// lessUTF16 orders strings by UTF-16 code units, as JavaScript's default sort does.
func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// canonicalJSON is JSON text with object keys sorted, so two configurations compare equal
// whatever their key order (undefined members are left out; undefined itself is "null").
func canonicalJSON(v engine.Value) string {
	var sb strings.Builder
	writeCanonical(&sb, v)
	return sb.String()
}

func writeCanonical(sb *strings.Builder, v engine.Value) {
	switch {
	case v.IsObject():
		keys := v.Keys()
		sort.SliceStable(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		sb.WriteByte('{')
		first := true
		for _, k := range keys {
			x := v.Field(k)
			if x.IsUndefined() {
				continue
			}
			if !first {
				sb.WriteByte(',')
			}
			first = false
			kj, _ := engine.FromGo(k).JSON()
			sb.WriteString(kj)
			sb.WriteByte(':')
			writeCanonical(sb, x)
		}
		sb.WriteByte('}')
	case v.IsArray():
		sb.WriteByte('[')
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeCanonical(sb, v.Index(i))
		}
		sb.WriteByte(']')
	default:
		if s, ok := v.JSON(); ok {
			sb.WriteString(s)
		} else {
			sb.WriteString("null")
		}
	}
}

// conditionRefs lists the segment keys a list of conditions references directly.
func conditionRefs(conds engine.Value) []string {
	var out []string
	for i := 0; conds.IsArray() && i < conds.Len(); i++ {
		c := conds.Index(i)
		op, _ := c.Field("op").Str()
		if s, ok := c.Field("value").Str(); ok && (op == "segment" || op == "not_segment") {
			out = append(out, s)
		}
	}
	return out
}

func segmentRefs(flag engine.Value) []string {
	var out []string
	rules := flag.Field("rules")
	for i := 0; rules.IsArray() && i < rules.Len(); i++ {
		out = append(out, conditionRefs(rules.Index(i).Field("conditions"))...)
	}
	return out
}

func hasKey(v engine.Value, k string) bool { return v.IsObject() && !v.Field(k).IsUndefined() }

// changedSegments: segments whose evaluation can differ between the live and the shadow bundle
// (definition new, edited or removed in the draft, or a condition referencing such a segment,
// transitively; iterated to a fixpoint). Same rule as the database and the JavaScript SDK.
func changedSegments(live, shadow engine.Value) map[string]bool {
	ls, ss := live.Field("segments"), shadow.Field("segments")
	changed := map[string]bool{}
	for _, k := range ss.Keys() {
		if !hasKey(ls, k) || canonicalJSON(ls.Field(k)) != canonicalJSON(ss.Field(k)) {
			changed[k] = true
		}
	}
	for _, k := range ls.Keys() {
		if !hasKey(ss, k) {
			changed[k] = true
		}
	}
	for grew := true; grew; {
		grew = false
		for _, k := range ss.Keys() {
			if changed[k] {
				continue
			}
			for _, x := range conditionRefs(ss.Field(k).Field("conditions")) {
				if changed[x] {
					changed[k], grew = true, true
					break
				}
			}
		}
	}
	return changed
}

// changedFlags lists the keys of the shadow bundle's flags that the draft changes: a different
// configuration, or a referenced segment (directly or through other segments) that differs.
func changedFlags(live, shadow engine.Value) map[string]bool {
	segs := changedSegments(live, shadow)
	lf, sf := live.Field("flags"), shadow.Field("flags")
	out := map[string]bool{}
	for _, k := range sf.Keys() {
		s := sf.Field(k)
		if !hasKey(lf, k) || canonicalJSON(lf.Field(k)) != canonicalJSON(s) {
			out[k] = true
			continue
		}
		for _, x := range segmentRefs(s) {
			if segs[x] {
				out[k] = true
				break
			}
		}
	}
	return out
}

// reprValue is a value as it is reported: canonical JSON text, at most 100 characters (longer
// values become "#<murmur3 hex>").
func reprValue(v engine.Value) string {
	text := canonicalJSON(v)
	if utf16Len(text) <= maxShadowValueChars {
		return text
	}
	return fmt.Sprintf("#%08x", engine.Murmur3(text, 0))
}

type shadowPair struct {
	Live   string `json:"live"`
	Shadow string `json:"shadow"`
	Count  int    `json:"count"`
}

type shadowFlagReport struct {
	Flag    string         `json:"flag"`
	Samples int            `json:"samples"`
	Flips   int            `json:"flips"`
	Pairs   []shadowPair   `json:"pairs"`
	Rules   map[string]int `json:"rules"`
}

type shadowReport struct {
	SessionID string             `json:"sessionId"`
	Checksum  string             `json:"checksum"`
	Version   string             `json:"version,omitempty"`
	Flags     []shadowFlagReport `json:"flags"`
}

type flagCounter struct {
	samples, flips int
	pairs          []*shadowPair
	pairIndex      map[string]*shadowPair
	rules          map[string]int
}

// shadowCounters are the in-memory counters of one shadow session. Bounded: 100 flags × (10
// value pairs + 50 rule counters). Safe for concurrent use.
type shadowCounters struct {
	sessionID, checksum string
	mu                  sync.Mutex
	order               []string
	flags               map[string]*flagCounter
}

func newShadowCounters(sessionID, checksum string) *shadowCounters {
	return &shadowCounters{sessionID: sessionID, checksum: checksum, flags: map[string]*flagCounter{}}
}

func (c *shadowCounters) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.flags)
}

// add counts one sampled evaluation: the value the app got, what the draft would give, and which
// draft rule matched (-1: none). A side whose value is the app's fallback is reported as
// "<fallback>", never as the value. Whether the value changes is decided on canonical JSON.
func (c *shadowCounters) add(flag string, live, shadow engine.Value, ruleIndex int, liveFallback, shadowFallbackSide bool) {
	if flag == "" || utf16Len(flag) > maxShadowFlagKey {
		return // the edge would refuse the whole report
	}
	same := canonicalJSON(live) == canonicalJSON(shadow)
	var a, b string
	if !same {
		a, b = reprValue(live), reprValue(shadow)
		if liveFallback {
			a = shadowFallback
		}
		if shadowFallbackSide {
			b = shadowFallback
		}
	}
	rk := "default"
	if ruleIndex >= 0 && ruleIndex < 10_000 {
		rk = strconv.Itoa(ruleIndex)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	f := c.flags[flag]
	if f == nil {
		if len(c.flags) >= maxShadowFlags {
			return
		}
		f = &flagCounter{pairIndex: map[string]*shadowPair{}, rules: map[string]int{}}
		c.flags[flag] = f
		c.order = append(c.order, flag)
	}
	if f.samples >= maxShadowCount {
		return
	}
	f.samples++
	if _, ok := f.rules[rk]; ok || len(f.rules) < maxShadowRules {
		f.rules[rk]++
	}
	if same {
		return
	}
	f.flips++
	key := a + "\x00" + b
	if _, ok := f.pairIndex[key]; !ok && len(f.pairIndex) >= maxShadowPairs-1 {
		key = "*\x00*"
		a, b = "*", "*"
	}
	p := f.pairIndex[key]
	if p == nil {
		p = &shadowPair{Live: a, Shadow: b}
		f.pairIndex[key] = p
		f.pairs = append(f.pairs, p)
	}
	p.Count++
}

// drain returns the report of everything counted so far (nil when nothing was) and starts afresh.
func (c *shadowCounters) drain(version string) *shadowReport {
	c.mu.Lock()
	order, flags := c.order, c.flags
	c.order, c.flags = nil, map[string]*flagCounter{}
	c.mu.Unlock()
	if len(order) == 0 {
		return nil
	}
	r := &shadowReport{SessionID: c.sessionID, Checksum: c.checksum, Version: version, Flags: make([]shadowFlagReport, 0, len(order))}
	for _, k := range order {
		f := flags[k]
		fr := shadowFlagReport{Flag: k, Samples: f.samples, Flips: f.flips, Pairs: make([]shadowPair, 0, len(f.pairs)), Rules: f.rules}
		for _, p := range f.pairs {
			fr.Pairs = append(fr.Pairs, *p)
		}
		r.Flags = append(r.Flags, fr)
	}
	return r
}

/* ---------------- client wiring ---------------- */

// shadowState is the verified shadow bundle in use. Replaced as a whole.
type shadowState struct {
	bundle   *engine.Bundle
	marker   shadowMarker
	counters *shadowCounters
	// changed caches changedFlags for one live bundle (recomputed when the live bundle changes).
	changed atomic.Pointer[changedCache]
}

type changedCache struct {
	live  *engine.Bundle
	flags map[string]bool
}

type shadowFetchEntry struct {
	id string
	at time.Time
}

type shadowRuntime struct {
	enabled bool
	rate    float64
	random  func() float64
	version string

	state     atomic.Pointer[shadowState]
	mu        sync.Mutex // guards the fields below
	flushedAt time.Time
	fetch     *shadowFetchEntry
	keys      *verifier // verification off for this edge: /v1/keys, for shadow bundles only
}

func (c *Client) shadowEnabled() bool { return c.shadow.enabled && !c.closed.Load() }

// takeShadowReport returns the counters to send with this events request, if any: at most once a
// minute, or now when forced (Flush, Close, a new or withdrawn shadow session).
func (c *Client) takeShadowReport(force bool, counters *shadowCounters) *shadowReport {
	sh := &c.shadow
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if counters == nil {
		st := sh.state.Load()
		if st == nil || st.counters.size() == 0 || (!force && time.Since(sh.flushedAt) < shadowFlushInterval) {
			return nil
		}
		counters = st.counters
	}
	sh.flushedAt = time.Now()
	return counters.drain(sh.version)
}

func (c *Client) flushShadow(counters *shadowCounters) {
	if counters == nil || counters.size() == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.requestTimeout)
	defer cancel()
	_ = c.events.send(ctx, true, counters)
}

// dropShadow: no session any more (the announcement stopped, or /v1/shadow is 404). Pending
// counters go out first.
func (c *Client) dropShadow() {
	if old := c.shadow.state.Swap(nil); old != nil {
		c.flushShadow(old.counters)
	}
}

// noteShadow handles X-NanoFlags-Shadow of a fresh /v1/bundle answer: fetch the announced shadow
// bundle, or drop the one in use. Runs on the goroutine that synced (serialised with bundle requests).
func (c *Client) noteShadow(header string) {
	if !c.shadowEnabled() {
		return
	}
	defer func() { _ = recover() }() // shadow evaluation never affects the app
	want, ok := parseShadowHeader(header)
	if !ok {
		c.dropShadow()
		return
	}
	if st := c.shadow.state.Load(); st != nil && st.marker.sessionID == want.sessionID && st.marker.checksum == want.checksum {
		return
	}
	id := want.sessionID + "." + want.checksum
	c.shadow.mu.Lock()
	f := c.shadow.fetch
	c.shadow.mu.Unlock()
	if f != nil && f.id == id && time.Since(f.at) < shadowRetryInterval {
		return
	}
	c.fetchShadow(want)
	c.shadow.mu.Lock()
	c.shadow.fetch = &shadowFetchEntry{id: id, at: time.Now()}
	c.shadow.mu.Unlock()
}

// shadowKeys returns the keys a shadow bundle is checked with: the configured ones, or
// (verification off for this edge) those of /v1/keys.
func (c *Client) shadowKeys(ctx context.Context, kid string) ([]publicKey, error) {
	if c.verifier != nil {
		return c.verifier.keysFor(ctx, kid)
	}
	c.shadow.mu.Lock()
	if c.shadow.keys == nil {
		c.shadow.keys = &verifier{c: c, refetch: true}
	}
	v := c.shadow.keys
	c.shadow.mu.Unlock()
	return v.keysFor(ctx, kid)
}

// fetchShadow loads and verifies a shadow bundle. Only a bundle signed for this session, with a
// matching marker inside, is used.
func (c *Client) fetchShadow(want shadowID) {
	reject := func(why string) {
		c.emitError(newError(ErrShadow, "the shadow bundle of session %s was ignored: %s Nothing changes for the app (shadow bundles are never applied).", want.sessionID, why))
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.cfg.requestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodGet, "/v1/shadow", nil)
	if err != nil {
		return
	}
	req.Header.Set("Cache-Control", "no-store")
	res, err := c.cfg.httpClient.Do(req)
	if err != nil {
		return
	}
	defer res.Body.Close()
	if c.ctx.Err() != nil {
		return
	}
	if res.StatusCode == http.StatusNotFound {
		c.dropShadow()
		return
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return
	}
	text, err := io.ReadAll(io.LimitReader(res.Body, maxBundleBytes+1))
	if err != nil || len(text) > maxBundleBytes {
		return
	}
	body, err := engine.ParseJSON(text)
	if err != nil {
		return
	}
	// Already replaced by a newer session: the next bundle answer announces that one.
	if sid, _ := body.Field("sessionId").Str(); sid != want.sessionID {
		return
	}
	if cs, _ := body.Field("checksum").Str(); cs != want.checksum {
		return
	}
	raw := rawMember(text, "bundle")
	signature, kid, envID := res.Header.Get("X-NanoFlags-Signature"), res.Header.Get("X-NanoFlags-Key-Id"), res.Header.Get("X-NanoFlags-Environment-Id")
	if signature == "" || envID == "" || raw == nil {
		reject("it is not signed.")
		return
	}
	c.mu.Lock()
	pinned := c.pinnedEnvironment
	c.mu.Unlock()
	if pinned != "" && pinned != envID {
		reject("it was signed for a different environment.")
		return
	}
	keys, err := c.shadowKeys(ctx, kid)
	ok := err == nil && verifyShadowText(keys, signature, kid, envID, want.sessionID, want.checksum, raw)
	if c.ctx.Err() != nil {
		return
	}
	if !ok {
		reject("its signature does not verify.")
		return
	}
	parsed, err := engine.ParseJSON(raw)
	if err != nil || !isShadowBundle(parsed) {
		reject("it is not a shadow bundle.")
		return
	}
	m, _ := shadowMarkerOf(parsed.Field("shadow"))
	if m.sessionID != want.sessionID || m.checksum != want.checksum || m.environmentID != envID {
		reject("its shadow marker does not match.")
		return
	}
	bundle, err := engine.NewBundle(parsed)
	if err != nil || !bundle.SupportsEngine() {
		return
	}
	next := &shadowState{bundle: bundle, marker: m, counters: newShadowCounters(want.sessionID, want.checksum)}
	if old := c.shadow.state.Swap(next); old != nil {
		c.flushShadow(old.counters)
	}
}

// shadowEvaluate runs after a live evaluation: for a sample of the flags the draft changes, it
// evaluates the draft too and counts. It never changes what the app gets.
func (c *Client) shadowEvaluate(key string, ctx Context, fallback engine.Value, accepts acceptor, live *engine.Result, b *engine.Bundle) {
	st := c.shadow.state.Load()
	if st == nil || c.shadow.rate <= 0 || b == nil {
		return
	}
	defer func() { _ = recover() }() // shadow evaluation never affects the app
	cache := st.changed.Load()
	if cache == nil || cache.live != b {
		cache = &changedCache{live: b, flags: changedFlags(b.Value(), st.bundle.Value())}
		st.changed.Store(cache)
	}
	if !cache.flags[key] || c.shadow.random() >= c.shadow.rate {
		return
	}
	r := st.bundle.Evaluate(key, engine.MapContext(ctx), fallback)
	// A side that used the app's own fallback is reported as "<fallback>": that value is the
	// app's, not a bundle's (flag missing on that side, evaluation error, or a value of the wrong
	// type, which evalIn already turned into "error").
	liveFallback := live.Reason == engine.ReasonFlagNotFound || live.Reason == engine.ReasonError
	shadowFallbackSide := r.Reason == engine.ReasonFlagNotFound || r.Reason == engine.ReasonError || (accepts != nil && !accepts(r.Value))
	value := r.Value
	if shadowFallbackSide {
		value = fallback
	}
	rule := -1
	if r.Reason == engine.ReasonRuleMatch {
		rule = r.RuleIndex
	}
	st.counters.add(key, live.Value, value, rule, liveFallback, shadowFallbackSide)
}
