package nanoflags

import (
	"context"
	"crypto/ed25519"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testKey = "nf_srv_test-key-not-a-real-key"

// fakeEdge is a small in-memory NanoFlags edge: it signs bundles like the publisher does and
// serves them over polling, the live socket and SSE.
type fakeEdge struct {
	t    *testing.T
	srv  *httptest.Server
	priv ed25519.PrivateKey
	pub  JWK
	env  string

	mu         sync.Mutex
	rev        int64
	text       string // the stored bundle text, served byte-for-byte
	checksum   string
	kid        string
	signed     bool
	stale      bool
	corrupt    bool // serve a signature that does not verify
	committed  int64
	liveStatus int // non-zero: refuse /v1/live with this HTTP status
	sockets    map[*websocket.Conn]bool
	sse        []chan string
	events     []map[string]any
	requests   map[string]int
	extraKeys  []JWK
}

func newFakeEdge(t *testing.T) *fakeEdge {
	t.Helper()
	pubKey, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	e := &fakeEdge{t: t, priv: priv, env: "11111111-2222-3333-4444-555555555555", kid: "t1", signed: true,
		sockets: map[*websocket.Conn]bool{}, requests: map[string]int{},
		pub: JWK{Kty: "OKP", Crv: "Ed25519", X: base64.RawURLEncoding.EncodeToString(pubKey), Kid: "t1"}}
	e.srv = httptest.NewServer(http.HandlerFunc(e.serve))
	t.Cleanup(func() {
		e.closeSockets(websocket.StatusGoingAway)
		e.mu.Lock()
		for _, ch := range e.sse {
			close(ch)
		}
		e.sse = nil
		e.mu.Unlock()
		e.srv.CloseClientConnections()
		e.srv.Close()
	})
	return e
}

// bundleText builds a bundle the way the publisher stores it (key order is the database's).
func bundleText(rev int64, flags string, extra ...string) string {
	x := ""
	for _, s := range extra {
		x += "," + s
	}
	return fmt.Sprintf(`{"flags":{%s},"schema":1,"project":"p","revision":%d,"segments":{},"environment":"production","engine":1%s}`, flags, rev, x)
}

const boolFlag = `"checkout":{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"beta","match":"all","conditions":[{"attribute":"plan","op":"eq","value":"beta"}],"serve":{"type":"fixed","value":true}}]}`

func (e *fakeEdge) set(rev int64, text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rev, e.text = rev, text
	sum := md5.Sum([]byte(text))
	e.checksum = hex.EncodeToString(sum[:])
	e.committed = time.Now().Add(-40 * time.Millisecond).UnixMilli()
}

func (e *fakeEdge) signature() string {
	sig := ed25519.Sign(e.priv, canonicalString(e.env, e.rev, e.checksum, []byte(e.text)))
	if e.corrupt {
		sig[0] ^= 0xff
	}
	return base64.RawURLEncoding.EncodeToString(sig)
}

// publish stores a new revision and pushes it to every socket (and announces it over SSE).
func (e *fakeEdge) publish(rev int64, text string) {
	e.set(rev, text)
	msg := e.message("rev")
	e.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(e.sockets))
	for c := range e.sockets {
		conns = append(conns, c)
	}
	for _, ch := range e.sse {
		ch <- fmt.Sprintf(`{"revision":%d,"checksum":%q}`, e.rev, e.checksum)
	}
	e.mu.Unlock()
	for _, c := range conns {
		_ = c.Write(context.Background(), websocket.MessageText, msg)
	}
}

func (e *fakeEdge) message(t string) []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	m := map[string]any{"t": t, "revision": e.rev, "checksum": e.checksum, "kid": e.kid, "environmentId": e.env, "bundle": e.text, "committedAt": e.committed, "sentAt": time.Now().UnixMilli()}
	if e.signed {
		m["signature"] = e.signature()
	}
	if e.rev == 0 {
		m["bundle"] = nil
	}
	b, _ := json.Marshal(m)
	return b
}

func (e *fakeEdge) closeSockets(code websocket.StatusCode) {
	e.mu.Lock()
	conns := e.sockets
	e.sockets = map[*websocket.Conn]bool{}
	e.mu.Unlock()
	for c := range conns {
		_ = c.Close(code, "test")
	}
}

func (e *fakeEdge) count(path string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.requests[path]
}

func (e *fakeEdge) serve(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	e.requests[r.URL.Path]++
	e.mu.Unlock()
	if r.URL.Path == "/v1/keys" {
		e.mu.Lock()
		keys := append([]JWK{e.pub}, e.extraKeys...)
		e.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+testKey {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"code":"unauthorized","message":"unknown key"}}`)
		return
	}
	switch r.URL.Path {
	case "/v1/bundle":
		e.mu.Lock()
		etag := fmt.Sprintf(`"%s-server"`, e.checksum)
		h := w.Header()
		h.Set("ETag", etag)
		h.Set("X-NanoFlags-Environment-Id", e.env)
		h.Set("X-NanoFlags-Signed", fmt.Sprint(e.signed))
		if e.signed {
			h.Set("X-NanoFlags-Signature", e.signature())
			h.Set("X-NanoFlags-Key-Id", e.kid)
		}
		if e.stale {
			h.Set("X-NanoFlags-Stale", "true")
		}
		body := fmt.Sprintf(`{"revision":%d,"checksum":%q,"bundle":%s}`, e.rev, e.checksum, e.text)
		e.mu.Unlock()
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = io.WriteString(w, body)
	case "/v1/live":
		e.mu.Lock()
		status := e.liveStatus
		e.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{LiveProtocol}})
		if err != nil {
			return
		}
		e.mu.Lock()
		e.sockets[c] = true
		e.mu.Unlock()
		_ = c.Write(r.Context(), websocket.MessageText, e.message("hello"))
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				e.mu.Lock()
				delete(e.sockets, c)
				e.mu.Unlock()
				return
			}
			if string(data) == "ping" {
				_ = c.Write(context.Background(), websocket.MessageText, []byte("pong"))
			}
		}
	case "/v1/stream":
		ch := make(chan string, 8)
		e.mu.Lock()
		e.sse = append(e.sse, ch)
		e.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case data, ok := <-ch:
				if !ok {
					return
				}
				_, _ = fmt.Fprintf(w, "event: revision\ndata: %s\n\n", data)
				w.(http.Flusher).Flush()
			}
		}
	case "/v1/events":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		e.mu.Lock()
		e.events = append(e.events, body)
		e.mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"accepted":0,"capped":false}`)
	default:
		http.NotFound(w, r)
	}
}

// options for a client of this edge: pinned test key, no telemetry, fast polling.
func (e *fakeEdge) options(extra ...Option) []Option {
	return append([]Option{
		WithBaseURL(e.srv.URL),
		WithVerification(VerifyOptions{PublicKeys: []JWK{e.pub}, Require: ptr(true)}),
		WithEvents(EventsOptions{Disabled: true}),
		WithPollInterval(time.Hour),
	}, extra...)
}

func ptr[T any](v T) *T { return &v }

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type recorder struct {
	mu      sync.Mutex
	changes []ChangeEvent
	errs    []error
}

func record(c *Client) *recorder {
	r := &recorder{}
	c.OnChange(func(e ChangeEvent) { r.mu.Lock(); r.changes = append(r.changes, e); r.mu.Unlock() })
	c.OnError(func(err error) { r.mu.Lock(); r.errs = append(r.errs, err); r.mu.Unlock() })
	return r
}

func (r *recorder) changeCount() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.changes) }
func (r *recorder) last() ChangeEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.changes[len(r.changes)-1]
}

func (r *recorder) hasError(code ErrorCode) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.errs {
		var ne *Error
		if ok := asError(e, &ne); ok && ne.Code == code {
			return true
		}
	}
	return false
}

func asError(err error, target **Error) bool {
	e, ok := err.(*Error)
	if ok {
		*target = e
	}
	return ok
}

func waitReady(t *testing.T, c *Client) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.WaitForReady(ctx)
}

func must(t *testing.T) func(*Client, error) *Client {
	return func(c *Client, err error) *Client {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		return c
	}
}
