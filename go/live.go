package nanoflags

import (
	"bufio"
	"context"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/motazalmaroai/nanoflags-sdk/go/engine"
)

// LiveProtocol is the WebSocket subprotocol of GET /v1/live.
const LiveProtocol = "nanoflags.v1"

const (
	livePing         = 30 * time.Second
	livePongTimeout  = 10 * time.Second
	liveMaxBackoff   = 5 * time.Minute
	liveRotate       = 50 * time.Minute // the edge drops sockets older than 2 h; replace earlier
	liveReadLimit    = 8 << 20
	liveStableWindow = 30 * time.Second
)

func jitter(d time.Duration, lo, hi float64) time.Duration {
	return time.Duration(float64(d) * (lo + (hi-lo)*rand.Float64()))
}

func (c *Client) startRealtime() {
	if !c.cfg.streaming {
		return
	}
	if c.cfg.live {
		c.wg.Add(1)
		go c.liveLoop()
		return
	}
	c.startStream()
}

func (c *Client) liveURL() string {
	return "ws" + strings.TrimPrefix(c.cfg.baseURL, "http") + "/v1/live"
}

func (c *Client) isDeleted() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.environmentDeleted
}

// liveLoop keeps one live socket open, reconnecting with jittered exponential backoff
// (1 s · 2ⁿ capped at 5 min, × 0.5–1.5). While no socket can be opened, SSE + polling take over.
func (c *Client) liveLoop() {
	defer c.wg.Done()
	attempt := 0
	for c.ctx.Err() == nil {
		opened, openFor, rotating, deleted := c.runSocket()
		if c.ctx.Err() != nil {
			return
		}
		if deleted {
			// Keep evaluating the last configuration; it can no longer be updated. No socket, no
			// stream; the regular poll stays (it reports the key as rejected, and recovers if the
			// environment turns out to exist after all).
			c.mu.Lock()
			c.environmentDeleted = true
			c.mu.Unlock()
			c.stopStream()
			if c.snap.Load() != nil {
				c.setStatus(StatusStale)
			}
			c.emitError(newError(ErrEnvironmentDeleted, "the environment of this SDK key was deleted. The last configuration stays in use; it will not be updated"))
			c.reschedule()
			return
		}
		if rotating {
			continue // planned replacement: no fallback, no backoff
		}
		if opened && openFor > liveStableWindow {
			attempt = 1
		} else {
			attempt++
		}
		if !opened {
			c.startStream()
		} else {
			c.reschedule() // back to the normal poll interval
		}
		wait := jitter(min(liveMaxBackoff, time.Second<<min(attempt-1, 10)), 0.5, 1.5)
		select {
		case <-c.ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// dropLive closes the current socket (for a rejected key); the loop reconnects with backoff.
func (c *Client) dropLive() {
	c.mu.Lock()
	conn := c.liveConn
	c.mu.Unlock()
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	}
}

// runSocket connects once and serves the socket until it ends.
func (c *Client) runSocket() (opened bool, openFor time.Duration, rotating bool, deleted bool) {
	dialCtx, cancel := context.WithTimeout(c.ctx, c.cfg.liveConnectTimeout)
	h := http.Header{}
	h.Set("Authorization", "Bearer "+c.sdkKey) // never in the URL
	h.Set("User-Agent", "nanoflags-go/"+SDKVersion)
	conn, res, err := websocket.Dial(dialCtx, c.liveURL(), &websocket.DialOptions{
		HTTPClient:      c.cfg.httpClient,
		HTTPHeader:      h,
		Subprotocols:    []string{LiveProtocol},
		CompressionMode: websocket.CompressionDisabled,
	})
	cancel()
	if res != nil && res.Body != nil {
		res.Body.Close()
	}
	if err != nil {
		c.log.Debug("nanoflags: live socket unavailable", "error", err)
		return false, 0, false, false
	}
	conn.SetReadLimit(liveReadLimit)
	openedAt := time.Now()
	c.mu.Lock()
	c.liveConn = conn
	c.mu.Unlock()
	c.liveOpen.Store(true)
	c.stopStream() // SSE is not used while the socket is healthy
	c.reschedule() // the poll becomes a safety net

	sockCtx, stop := context.WithCancel(c.ctx)
	got := make(chan struct{}, 1)
	rotateAt := time.NewTimer(jitter(liveRotate, 0.9, 1.1))
	done := make(chan struct{})
	rotated := false
	go func() { // ping, pong timeout, rotation
		defer close(done)
		for {
			select {
			case <-sockCtx.Done():
				return
			case <-rotateAt.C:
				rotated = true
				_ = conn.Close(websocket.StatusNormalClosure, "rotate")
				return
			case <-time.After(jitter(livePing, 0.9, 1.1)):
			}
			select {
			case <-got: // drain a stale signal
			default:
			}
			wctx, wcancel := context.WithTimeout(sockCtx, livePongTimeout)
			err := conn.Write(wctx, websocket.MessageText, []byte("ping"))
			wcancel()
			if err != nil {
				_ = conn.CloseNow()
				return
			}
			// The edge answers `pong` without waking anything up; silence means a dead connection.
			select {
			case <-sockCtx.Done():
				return
			case <-got:
			case <-time.After(livePongTimeout):
				_ = conn.CloseNow()
				return
			}
		}
	}()

	var readErr error
	for {
		typ, data, err := conn.Read(sockCtx)
		if err != nil {
			readErr = err
			break
		}
		select {
		case got <- struct{}{}:
		default:
		}
		if typ != websocket.MessageText || string(data) == "pong" {
			continue
		}
		c.applyPush(data)
	}
	stop()
	<-done
	rotateAt.Stop()
	_ = conn.CloseNow()
	c.mu.Lock()
	c.liveConn = nil
	c.mu.Unlock()
	c.liveOpen.Store(false)
	return true, time.Since(openedAt), rotated && c.ctx.Err() == nil, websocket.CloseStatus(readErr) == CloseEnvironmentDeleted
}

// applyPush applies one `rev` / `hello` message. A message that cannot be trusted changes nothing.
func (c *Client) applyPush(data []byte) {
	m, err := engine.ParseJSON(data)
	if err != nil || !m.IsObject() {
		return
	}
	if t, _ := m.Field("t").Str(); t != "rev" && t != "hello" {
		return
	}
	revF, ok := m.Field("revision").Number()
	text, isStr := m.Field("bundle").Str()
	// Revision 0 / no bundle: the environment has nothing published yet.
	if !ok || revF != float64(int64(revF)) || revF < 1 || !isStr {
		return
	}
	revision := int64(revF)
	if cur := c.snap.Load(); cur != nil && revision < cur.bundle.Revision() {
		return // never backwards
	}
	checksum, hasChecksum := m.Field("checksum").Str()
	var info *signatureInfo
	if v := c.verifier; v != nil {
		reject := func(why string) {
			c.emitError(newError(ErrSignature, "pushed bundle r%d was rejected: %s The configuration in use is unchanged.", revision, why))
			c.trigger() // the regular (verified) request path says what is really current
		}
		sig, _ := m.Field("signature").Str()
		envID, _ := m.Field("environmentId").Str()
		if sig == "" || envID == "" || !hasChecksum {
			reject("it carries no complete signature.")
			return
		}
		c.mu.Lock()
		pinned := c.pinnedEnvironment
		c.mu.Unlock()
		if pinned != "" && pinned != envID {
			reject("it was signed for a different environment.")
			return
		}
		kid, _ := m.Field("kid").Str()
		info = &signatureInfo{Signature: sig, Kid: kid, EnvironmentID: envID, Revision: revision, Checksum: checksum}
		keys, err := v.keysFor(c.ctx, kid)
		if err != nil || !verifyBundleText(keys, *info, []byte(text)) {
			reject("its signature does not verify.")
			return
		}
	}
	bundle, err := engine.ParseBundle([]byte(text))
	if err != nil || bundle.Revision() != revision {
		c.emitError(newError(ErrInvalidBundle, "the edge pushed an invalid bundle; it was ignored"))
		return
	}
	if !bundle.SupportsEngine() {
		c.emitError(engineError(bundle))
		return
	}
	c.adoptMu.Lock()
	defer c.adoptMu.Unlock()
	cur := c.snap.Load()
	if cur != nil && revision < cur.bundle.Revision() {
		return
	}
	c.mu.Lock()
	c.failures = 0
	c.mu.Unlock()
	if cur != nil && revision == cur.bundle.Revision() {
		// Already in use: the push only confirms that it is current.
		if cur.checksum == "" || cur.checksum == checksum {
			c.setStatus(StatusReady)
		}
		return
	}
	c.mu.Lock()
	if info != nil {
		c.pinnedEnvironment = info.EnvironmentID
	}
	c.liveRevision = revision
	c.mu.Unlock()
	next := &snapshot{bundle: bundle, checksum: checksum, sig: info, raw: []byte(text)}
	if hasChecksum {
		// What /v1/bundle would send as ETag for this revision, so the safety poll gets a 304.
		kind := "server"
		if c.browser {
			kind = "client"
		}
		next.etag = `"` + checksum + "-" + kind + `"`
	}
	var latency *time.Duration
	if at, ok := m.Field("committedAt").Number(); ok {
		d := time.Since(time.UnixMilli(int64(at)))
		latency = &d
	}
	c.adopt(next, StatusReady, SourceNetwork, TransportLive, latency)
	c.persist(next)
}

/* ---------------- SSE fallback: GET /v1/stream ---------------- */

func (c *Client) startStream() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.cfg.streaming || c.streamCancel != nil || c.environmentDeleted || c.ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	c.streamCancel = cancel
	c.streaming.Store(true)
	c.wg.Add(1)
	go c.streamLoop(ctx)
}

func (c *Client) stopStream() {
	c.mu.Lock()
	cancel := c.streamCancel
	c.streamCancel = nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	c.streaming.Store(false)
}

// streamLoop reads server-sent events. The stream only says "revision N exists"; the bundle is
// always fetched conditionally.
func (c *Client) streamLoop(ctx context.Context) {
	defer c.wg.Done()
	attempt := 0
	for ctx.Err() == nil {
		started := time.Now()
		stop := c.readStream(ctx)
		if ctx.Err() != nil {
			return
		}
		if stop {
			c.mu.Lock()
			c.streamCancel = nil
			c.mu.Unlock()
			c.streaming.Store(false)
			return
		}
		if time.Since(started) > 30*time.Second {
			attempt = 0
		} else {
			attempt++
		}
		wait := jitter(min(30*time.Second, time.Second<<min(attempt, 5)), 0.5, 1.5)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (c *Client) readStream(ctx context.Context) (stop bool) {
	req, err := c.newRequest(ctx, http.MethodGet, "/v1/stream", nil)
	if err != nil {
		return true
	}
	req.Header.Set("Accept", "text/event-stream")
	res, err := c.cfg.httpClient.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return true // polling keeps reporting the error
	}
	if res.StatusCode != http.StatusOK {
		return false
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 4096), 64<<10)
	event, data := "message", []string{}
	for sc.Scan() {
		line := strings.TrimSuffix(sc.Text(), "\r")
		if line == "" {
			if len(data) > 0 {
				if event == "revision" {
					c.onRevision(strings.Join(data, "\n"))
				} else if event == "revoked" {
					c.trigger()
					return true
				}
			}
			event, data = "message", data[:0]
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		}
	}
	return false
}

func (c *Client) onRevision(data string) {
	m, err := engine.ParseJSON([]byte(data))
	if err != nil {
		return
	}
	rev, _ := m.Field("revision").Number()
	checksum, _ := m.Field("checksum").Str()
	cur := c.snap.Load()
	if cur == nil || int64(rev) != cur.bundle.Revision() || checksum != cur.checksum || c.Status() != StatusReady {
		c.mu.Lock()
		c.streamTriggered = true
		c.mu.Unlock()
		c.trigger()
	}
}
