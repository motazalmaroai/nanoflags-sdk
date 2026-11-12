package nanoflags

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

const (
	maxQueue           = 500
	maxBatch           = 50
	maxEventValueChars = 1024
)

type event struct {
	FlagKey   string          `json:"flagKey"`
	Value     json.RawMessage `json:"value"`
	Reason    string          `json:"reason"`
	RuleIndex *int            `json:"ruleIndex,omitempty"`
	Revision  int64           `json:"revision"`
	Context   map[string]any  `json:"context"`
	At        string          `json:"at"`
}

// eventQueue samples evaluations and sends them, with the periodic service report ("this
// service runs revision N"), to POST /v1/events. Off the hot path: evaluation only appends to
// a bounded slice; telemetry is never retried and never affects evaluation.
type eventQueue struct {
	c          *Client
	mu         sync.Mutex
	queue      []event
	lastReport time.Time
}

func newEventQueue(c *Client) *eventQueue { return &eventQueue{c: c} }

func (q *eventQueue) enabled() bool { return q.c.cfg.eventsEnabled }

func (q *eventQueue) start() {
	if !q.enabled() || q.c.cfg.flushInterval <= 0 {
		return
	}
	q.c.wg.Add(1)
	go func() {
		defer q.c.wg.Done()
		t := time.NewTicker(q.c.cfg.flushInterval)
		defer t.Stop()
		for {
			select {
			case <-q.c.ctx.Done():
				return
			case <-t.C:
				q.mu.Lock()
				idle := len(q.queue) == 0 && time.Since(q.lastReport) < q.c.cfg.reportInterval
				q.mu.Unlock()
				if !idle {
					_ = q.flush(q.c.ctx)
				}
			}
		}
	}()
}

func (q *eventQueue) record(r *engine.Result, ctx Context, s *snapshot) {
	cfg := &q.c.cfg
	if !q.enabled() || q.c.closed.Load() || cfg.sampleRate <= 0 || cfg.random() >= cfg.sampleRate {
		return
	}
	defer func() { _ = recover() }() // telemetry must never affect evaluation
	q.mu.Lock()
	full := len(q.queue) >= maxQueue
	q.mu.Unlock()
	if full {
		return
	}
	e := event{FlagKey: r.FlagKey, Reason: string(r.Reason), At: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	if n, ok := r.Revision.Number(); ok {
		e.Revision = int64(n)
	}
	if r.RuleIndex >= 0 {
		i := r.RuleIndex
		e.RuleIndex = &i
	}
	e.Value = eventValue(r.Value)
	if cfg.redact != nil {
		e.Context = cfg.redact(ctx)
	} else {
		e.Context = defaultRedact(s, r.FlagKey, ctx)
	}
	if e.Context == nil {
		e.Context = map[string]any{}
	}
	q.mu.Lock()
	if len(q.queue) < maxQueue {
		q.queue = append(q.queue, e)
	}
	q.mu.Unlock()
}

func eventValue(v engine.Value) json.RawMessage {
	if s, ok := v.Str(); ok {
		if u := utf16.Encode([]rune(s)); len(u) > maxEventValueChars {
			s = string(utf16.Decode(u[:maxEventValueChars]))
		}
		b, _ := json.Marshal(s)
		return b
	}
	text, ok := v.JSON()
	if !ok || ((v.IsObject() || v.IsArray()) && len(utf16.Encode([]rune(text))) > maxEventValueChars) {
		return json.RawMessage("null")
	}
	return json.RawMessage(text)
}

// defaultRedact sends no attribute values: only the names of the attributes the flag's rules
// use that were present, mapped to the value's type.
func defaultRedact(s *snapshot, flagKey string, ctx Context) map[string]any {
	out := map[string]any{}
	if s == nil || len(ctx) == 0 {
		return out
	}
	var names []string
	if cached, ok := s.attrs.Load(flagKey); ok {
		names = cached.([]string)
	} else {
		names = engine.AttributesUsedBy(s.bundle.Value(), flagKey)
		s.attrs.Store(flagKey, names)
	}
	for _, n := range names {
		if x, ok := ctx[n]; ok {
			out[n] = engine.FromGo(x).TypeName()
		}
	}
	return out
}

func (q *eventQueue) flush(ctx context.Context) error {
	if !q.enabled() {
		return nil
	}
	q.mu.Lock()
	n := min(len(q.queue), maxBatch)
	batch := append([]event{}, q.queue[:n]...)
	q.queue = q.queue[n:]
	q.lastReport = time.Now()
	q.mu.Unlock()
	for i := range batch {
		if u := utf16.Encode([]rune(batch[i].FlagKey)); len(u) > 63 {
			batch[i].FlagKey = string(utf16.Decode(u[:63]))
		}
	}
	rev := q.c.Revision()
	if rev < 0 {
		rev = 0
	}
	body, err := json.Marshal(map[string]any{"service": q.c.cfg.service, "sdk": "go/" + SDKVersion, "revision": rev, "events": batch})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, q.c.cfg.requestTimeout)
	defer cancel()
	req, err := q.c.newRequest(ctx, http.MethodPost, "/v1/events", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := q.c.cfg.httpClient.Do(req)
	if err != nil {
		return err // dropped by design: telemetry is never retried
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if res.StatusCode >= 300 {
		return &Error{Code: ErrHTTP, Message: "events request failed", HTTPStatus: res.StatusCode}
	}
	return nil
}
