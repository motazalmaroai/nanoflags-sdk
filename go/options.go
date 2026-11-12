package nanoflags

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// ErrorCode classifies the errors the client reports through OnError and WaitForReady.
type ErrorCode string

const (
	ErrNetwork            ErrorCode = "network"
	ErrUnauthorized       ErrorCode = "unauthorized"
	ErrHTTP               ErrorCode = "http"
	ErrInvalidBundle      ErrorCode = "invalid_bundle"
	ErrStore              ErrorCode = "store"
	ErrConfig             ErrorCode = "config"
	ErrSignature          ErrorCode = "signature"
	ErrEngine             ErrorCode = "engine"
	ErrEnvironmentDeleted ErrorCode = "environment_deleted"
)

// Error is a client error. A failed update never changes the configuration in use.
type Error struct {
	Code       ErrorCode
	Message    string
	HTTPStatus int   // set for unauthorized and http errors
	Err        error // underlying cause, if any
}

func (e *Error) Error() string { return "nanoflags: " + e.Message }
func (e *Error) Unwrap() error { return e.Err }

// Is matches another *Error by code, so errors.Is(err, &nanoflags.Error{Code: nanoflags.ErrSignature}) works.
func (e *Error) Is(target error) bool {
	var t *Error
	return errors.As(target, &t) && t.Code == e.Code && t.Message == ""
}

func newError(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ErrNotReady is returned by WaitForReady when the first load finished without a configuration
// and no more specific error is known.
var ErrNotReady = errors.New("nanoflags: no configuration is loaded")

// Store persists the last good configuration so that a restarting process can evaluate flags
// before (or without) reaching the edge. The client stores an opaque JSON document.
type Store interface {
	Load(ctx context.Context) ([]byte, error) // (nil, nil) when nothing is stored
	Save(ctx context.Context, data []byte) error
}

// FileStore keeps the last good configuration in a file (written atomically, mode 0600).
// A persisted bundle is verified again when it is loaded, like any other bundle.
func FileStore(path string) Store { return fileStore(path) }

type fileStore string

func (f fileStore) Load(context.Context) ([]byte, error) {
	data, err := os.ReadFile(string(f))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (f fileStore) Save(_ context.Context, data []byte) error {
	dir := filepath.Dir(string(f))
	tmp, err := os.CreateTemp(dir, ".nanoflags-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), string(f))
}

type config struct {
	baseURL            string
	service            string
	httpClient         *http.Client
	pollInterval       time.Duration
	livePollInterval   time.Duration
	streaming          bool
	live               bool
	bootstrap          *engine.Bundle
	bootstrapErr       error
	store              Store
	verify             *VerifyOptions
	verifySet          bool
	eventsEnabled      bool
	sampleRate         float64
	flushInterval      time.Duration
	reportInterval     time.Duration
	redact             func(Context) map[string]any
	logger             *slog.Logger
	random             func() float64
	requestTimeout     time.Duration
	liveConnectTimeout time.Duration
}

// Option configures a Client.
type Option func(*config)

// WithBaseURL sets the edge (default OfficialEdgeURL). Signature verification is on by default
// only for the official edge; configure it with WithVerification for a self-hosted one.
func WithBaseURL(u string) Option {
	return func(c *config) { c.baseURL = strings.TrimRight(u, "/") }
}

// WithService names this service in "which revision is each service running" reports.
func WithService(name string) Option { return func(c *config) { c.service = name } }

// WithHTTPClient sets the HTTP client for every request and the WebSocket handshake
// (default: a client with the default transport, which honours HTTPS_PROXY).
func WithHTTPClient(h *http.Client) Option { return func(c *config) { c.httpClient = h } }

// WithPollInterval sets the polling interval (default 30s; 0 disables polling).
func WithPollInterval(d time.Duration) Option { return func(c *config) { c.pollInterval = d } }

// WithLivePollInterval sets the safety-poll interval while the live socket is healthy (default 5m).
func WithLivePollInterval(d time.Duration) Option {
	return func(c *config) { c.livePollInterval = d }
}

// WithLive enables or disables the live WebSocket (default true). Without it, updates arrive
// over server-sent events and polling.
func WithLive(on bool) Option { return func(c *config) { c.live = on } }

// WithStreaming enables or disables push updates altogether (live WebSocket and SSE; default
// true). Without them the client only polls.
func WithStreaming(on bool) Option { return func(c *config) { c.streaming = on } }

// WithBootstrap starts the client with a bundle obtained elsewhere (embedded at build time, for
// example). It is used until the edge delivers something newer.
func WithBootstrap(b *engine.Bundle) Option { return func(c *config) { c.bootstrap = b } }

// WithBootstrapJSON is WithBootstrap for bundle JSON text. Invalid text is reported through
// OnError and ignored.
func WithBootstrapJSON(data []byte) Option {
	return func(c *config) {
		b, err := engine.ParseBundle(data)
		if err != nil {
			c.bootstrapErr = err
			return
		}
		c.bootstrap = b
	}
}

// WithStore persists the last good configuration (see FileStore).
func WithStore(s Store) Option { return func(c *config) { c.store = s } }

// WithVerification configures signature verification (see VerifyOptions).
func WithVerification(v VerifyOptions) Option {
	return func(c *config) { c.verify, c.verifySet = &v, true }
}

// WithoutVerification turns signature verification off, also on the official edge.
func WithoutVerification() Option { return func(c *config) { c.verify, c.verifySet = nil, true } }

// EventsOptions configures sampled evaluation telemetry and the periodic service report.
type EventsOptions struct {
	// Disabled turns telemetry off entirely (no service report either).
	Disabled bool
	// SampleRate is the fraction of evaluations reported, 0–1. Default 0.1; use a negative value for 0.
	SampleRate float64
	// FlushInterval is how often queued events are sent (default 10s).
	FlushInterval time.Duration
	// ReportInterval is how often the service report goes out while no events are queued (default 60s).
	ReportInterval time.Duration
	// Redact decides what part of the context leaves the process. Default: no values, only the
	// names of the attributes the flag's rules use, mapped to the value's type (e.g. {"region": "string"}).
	Redact func(Context) map[string]any
}

// WithEvents configures telemetry.
func WithEvents(e EventsOptions) Option {
	return func(c *config) {
		c.eventsEnabled = !e.Disabled
		if e.SampleRate != 0 {
			c.sampleRate = e.SampleRate
		}
		if e.FlushInterval > 0 {
			c.flushInterval = e.FlushInterval
		}
		if e.ReportInterval > 0 {
			c.reportInterval = e.ReportInterval
		}
		c.redact = e.Redact
	}
}

// WithLogger sets a logger for background activity (default: discard).
func WithLogger(l *slog.Logger) Option { return func(c *config) { c.logger = l } }

func withRandom(r func() float64) Option { return func(c *config) { c.random = r } }
