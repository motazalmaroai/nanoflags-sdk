// Package ofprovider is the OpenFeature provider for NanoFlags
// (https://openfeature.dev, github.com/open-feature/go-sdk).
//
// It evaluates locally with a nanoflags.Client — no network call per evaluation — and turns the
// client's status and updates into provider events:
//
//	client, _ := nanoflags.New(os.Getenv("NANOFLAGS_SDK_KEY"))
//	_ = openfeature.SetProviderAndWait(ofprovider.New(client))
//	of := openfeature.NewDefaultClient()
//	on, _ := of.BooleanValue(ctx, "new-checkout", false, openfeature.NewEvaluationContext("user-42", nil))
//
// Mapping: the OpenFeature targeting key becomes the NanoFlags `key` (the bucketing identity) and
// wins over an attribute called "key"; reason off → DISABLED, default → DEFAULT, a fixed-value
// rule → TARGETING_MATCH, a percentage rollout → SPLIT; the variant is the matching rule's id;
// flag metadata carries the revision. Missing flags are FLAG_NOT_FOUND (PROVIDER_NOT_READY while
// nothing is loaded), served values of another type TYPE_MISMATCH.
package ofprovider

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/open-feature/go-sdk/openfeature"

	nanoflags "github.com/motazalmaroai/nanoflags-sdk/go"
	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// Option configures the provider.
type Option func(*Provider)

// WithCloseClient closes the NanoFlags client when the provider shuts down (default: the client
// is yours and stays open).
func WithCloseClient() Option { return func(p *Provider) { p.closeClient = true } }

// WithInitTimeout bounds how long Init waits for the first configuration (default 10s).
func WithInitTimeout(d time.Duration) Option { return func(p *Provider) { p.initTimeout = d } }

// Provider implements openfeature.FeatureProvider, StateHandler, ContextAwareStateHandler and
// EventHandler.
type Provider struct {
	client      *nanoflags.Client
	closeClient bool
	initTimeout time.Duration

	events chan openfeature.Event
	once   sync.Once
	done   chan struct{}

	mu   sync.Mutex
	last *engine.Bundle
	stop []func()
}

var (
	_ openfeature.FeatureProvider          = (*Provider)(nil)
	_ openfeature.ContextAwareStateHandler = (*Provider)(nil)
	_ openfeature.EventHandler             = (*Provider)(nil)
)

// New returns a provider that evaluates with client.
func New(client *nanoflags.Client, opts ...Option) *Provider {
	p := &Provider{client: client, initTimeout: 10 * time.Second, events: make(chan openfeature.Event, 64), done: make(chan struct{})}
	for _, o := range opts {
		o(p)
	}
	return p
}

// Metadata names the provider.
func (p *Provider) Metadata() openfeature.Metadata { return openfeature.Metadata{Name: "nanoflags"} }

// Hooks returns no provider hooks.
func (p *Provider) Hooks() []openfeature.Hook { return nil }

// EventChannel delivers PROVIDER_READY, PROVIDER_STALE, PROVIDER_ERROR and
// PROVIDER_CONFIGURATION_CHANGED (with the keys of the flags that changed).
func (p *Provider) EventChannel() <-chan openfeature.Event { return p.events }

// Init waits for the first configuration (see WithInitTimeout).
func (p *Provider) Init(evalCtx openfeature.EvaluationContext) error {
	return p.InitWithContext(context.Background(), evalCtx)
}

// InitWithContext waits for the first configuration, or until ctx ends.
func (p *Provider) InitWithContext(ctx context.Context, _ openfeature.EvaluationContext) error {
	p.mu.Lock()
	p.last = p.client.Bundle()
	p.stop = append(p.stop,
		p.client.OnStatus(func(s nanoflags.Status) {
			switch s {
			case nanoflags.StatusReady:
				p.emit(openfeature.ProviderReady, "The configuration is current.", nil)
			case nanoflags.StatusStale:
				p.emit(openfeature.ProviderStale, "The configuration in use is not known to be current.", nil)
			}
		}),
		p.client.OnChange(func(e nanoflags.ChangeEvent) {
			p.mu.Lock()
			prev := p.last
			p.last = p.client.Bundle()
			changed := changedFlags(prev, p.last)
			p.mu.Unlock()
			if prev != nil {
				p.emit(openfeature.ProviderConfigChange, fmt.Sprintf("Revision %d is now in use.", e.Revision), changed)
			}
		}),
		p.client.OnError(func(err error) {
			if p.client.Status() == nanoflags.StatusNotReady {
				p.emit(openfeature.ProviderError, err.Error(), nil)
			}
		}),
	)
	p.mu.Unlock()
	if p.initTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.initTimeout)
		defer cancel()
	}
	return p.client.WaitForReady(ctx)
}

// Shutdown stops event delivery (and closes the client with WithCloseClient).
func (p *Provider) Shutdown() { _ = p.ShutdownWithContext(context.Background()) }

// ShutdownWithContext is Shutdown.
func (p *Provider) ShutdownWithContext(context.Context) error {
	p.once.Do(func() {
		close(p.done)
		p.mu.Lock()
		for _, s := range p.stop {
			s()
		}
		p.stop = nil
		p.mu.Unlock()
		if p.closeClient {
			_ = p.client.Close()
		}
	})
	return nil
}

func (p *Provider) emit(t openfeature.EventType, msg string, flags []string) {
	select {
	case <-p.done:
		return
	default:
	}
	ev := openfeature.Event{ProviderName: "nanoflags", EventType: t, ProviderEventDetails: openfeature.ProviderEventDetails{Message: msg, FlagChanges: flags}}
	select {
	case p.events <- ev:
	case <-p.done:
	}
}

// changedFlags lists the flags whose configuration differs between two bundles.
func changedFlags(a, b *engine.Bundle) []string {
	if b == nil {
		return nil
	}
	flagsA, flagsB := a.Value().Field("flags"), b.Value().Field("flags")
	var out []string
	seen := map[string]bool{}
	for _, k := range append(flagsB.Keys(), flagsA.Keys()...) {
		if seen[k] {
			continue
		}
		seen[k] = true
		x, _ := flagsA.Field(k).JSON()
		y, _ := flagsB.Field(k).JSON()
		if x != y {
			out = append(out, k)
		}
	}
	return out
}

// toContext maps an OpenFeature context onto a NanoFlags context.
func toContext(flat openfeature.FlattenedContext) nanoflags.Context {
	out := make(nanoflags.Context, len(flat))
	for k, v := range flat {
		if k != openfeature.TargetingKey {
			out[k] = v
		}
	}
	if tk, ok := flat[openfeature.TargetingKey].(string); ok && tk != "" {
		out["key"] = tk
	}
	return out
}

type kind int

const (
	kindBool kind = iota
	kindString
	kindFloat
	kindInt
	kindObject
)

var kindNames = map[kind]string{kindBool: "boolean", kindString: "string", kindFloat: "number", kindInt: "integer", kindObject: "object"}

func accepts(k kind, d nanoflags.Detail) bool {
	switch k {
	case kindBool:
		_, ok := d.Value.(bool)
		return ok
	case kindString:
		_, ok := d.Value.(string)
		return ok
	case kindFloat:
		f, ok := d.Value.(float64)
		return ok && !math.IsInf(f, 0) && !math.IsNaN(f)
	case kindInt:
		f, ok := d.Value.(float64)
		return ok && f == math.Trunc(f) && math.Abs(f) <= 1<<53
	}
	return !d.ValueIsUndefined()
}

// resolve evaluates without a type check and maps the result.
func (p *Provider) resolve(flag string, flat openfeature.FlattenedContext, k kind) (nanoflags.Detail, openfeature.ProviderResolutionDetail) {
	d := p.client.Evaluate(flag, toContext(flat), nil)
	meta := openfeature.FlagMetadata{"revision": d.Revision}
	fail := func(e openfeature.ResolutionError) (nanoflags.Detail, openfeature.ProviderResolutionDetail) {
		return d, openfeature.ProviderResolutionDetail{ResolutionError: e, Reason: openfeature.ErrorReason, FlagMetadata: meta}
	}
	switch d.Reason {
	case nanoflags.ReasonFlagNotFound:
		if p.client.Bundle() == nil {
			return fail(openfeature.NewProviderNotReadyResolutionError("NanoFlags has no configuration loaded yet."))
		}
		return fail(openfeature.NewFlagNotFoundResolutionError(fmt.Sprintf("Flag %q is not in the loaded configuration (r%d).", flag, d.Revision)))
	case nanoflags.ReasonError:
		return fail(openfeature.NewGeneralResolutionError(d.Error))
	}
	if !accepts(k, d) {
		return fail(openfeature.NewTypeMismatchResolutionError(fmt.Sprintf("Flag %q has a %s value; a %s was requested.", flag, d.TypeName(), kindNames[k])))
	}
	reason := openfeature.TargetingMatchReason
	switch {
	case d.Reason == nanoflags.ReasonOff:
		reason = openfeature.DisabledReason
	case d.Reason == nanoflags.ReasonDefault:
		reason = openfeature.DefaultReason
	case d.InRollout != nil:
		reason = openfeature.SplitReason
	}
	if d.RuleIndex >= 0 {
		meta["ruleIndex"] = d.RuleIndex
	}
	return d, openfeature.ProviderResolutionDetail{Reason: reason, Variant: d.RuleID, FlagMetadata: meta}
}

// BooleanEvaluation resolves a boolean flag.
func (p *Provider) BooleanEvaluation(_ context.Context, flag string, def bool, flat openfeature.FlattenedContext) openfeature.BoolResolutionDetail {
	d, r := p.resolve(flag, flat, kindBool)
	if r.Error() != nil {
		return openfeature.BoolResolutionDetail{Value: def, ProviderResolutionDetail: r}
	}
	return openfeature.BoolResolutionDetail{Value: d.Value.(bool), ProviderResolutionDetail: r}
}

// StringEvaluation resolves a string flag.
func (p *Provider) StringEvaluation(_ context.Context, flag string, def string, flat openfeature.FlattenedContext) openfeature.StringResolutionDetail {
	d, r := p.resolve(flag, flat, kindString)
	if r.Error() != nil {
		return openfeature.StringResolutionDetail{Value: def, ProviderResolutionDetail: r}
	}
	return openfeature.StringResolutionDetail{Value: d.Value.(string), ProviderResolutionDetail: r}
}

// FloatEvaluation resolves a number flag.
func (p *Provider) FloatEvaluation(_ context.Context, flag string, def float64, flat openfeature.FlattenedContext) openfeature.FloatResolutionDetail {
	d, r := p.resolve(flag, flat, kindFloat)
	if r.Error() != nil {
		return openfeature.FloatResolutionDetail{Value: def, ProviderResolutionDetail: r}
	}
	return openfeature.FloatResolutionDetail{Value: d.Value.(float64), ProviderResolutionDetail: r}
}

// IntEvaluation resolves a number flag that serves whole numbers.
func (p *Provider) IntEvaluation(_ context.Context, flag string, def int64, flat openfeature.FlattenedContext) openfeature.IntResolutionDetail {
	d, r := p.resolve(flag, flat, kindInt)
	if r.Error() != nil {
		return openfeature.IntResolutionDetail{Value: def, ProviderResolutionDetail: r}
	}
	return openfeature.IntResolutionDetail{Value: int64(d.Value.(float64)), ProviderResolutionDetail: r}
}

// ObjectEvaluation resolves a JSON flag (plain Go data: nil, bool, float64, string, []any, map[string]any).
func (p *Provider) ObjectEvaluation(_ context.Context, flag string, def any, flat openfeature.FlattenedContext) openfeature.InterfaceResolutionDetail {
	d, r := p.resolve(flag, flat, kindObject)
	if r.Error() != nil {
		return openfeature.InterfaceResolutionDetail{Value: def, ProviderResolutionDetail: r}
	}
	return openfeature.InterfaceResolutionDetail{Value: d.Value, ProviderResolutionDetail: r}
}
