package nanoflags

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"testing"
	"time"
)

func newRollbackClient(t *testing.T, e *fakeEdge, extra ...Option) *Client {
	t.Helper()
	opts := append([]Option{WithLive(false), WithStreaming(false)}, extra...)
	c := must(t)(New(testKey, e.options(opts...)...))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	return c
}

func refreshCode(t *testing.T, c *Client) ErrorCode {
	t.Helper()
	err := c.Refresh(context.Background())
	var ne *Error
	if errors.As(err, &ne) {
		return ne.Code
	}
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	return ""
}

func TestRollbackFetchIsRefused(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	c := newRollbackClient(t, e)
	r := record(c)
	// A replayed (genuinely signed) answer for r4.
	e.set(4, bundleText(4, boolFlag))
	if code := refreshCode(t, c); code != ErrRollback {
		t.Fatalf("code %q", code)
	}
	if c.Revision() != 5 || c.Status() != StatusStale {
		t.Fatalf("r%d %s", c.Revision(), c.Status())
	}
	eventually(t, "rollback error", func() bool { return r.hasError(ErrRollback) })
	// The edge answers the current revision again: ready; newer revisions are adopted as usual.
	e.set(5, bundleText(5, boolFlag))
	if code := refreshCode(t, c); code != "" || c.Status() != StatusReady {
		t.Fatalf("%q %s", code, c.Status())
	}
	e.set(6, bundleText(6, boolFlag))
	if code := refreshCode(t, c); code != "" || c.Revision() != 6 {
		t.Fatalf("%q r%d", code, c.Revision())
	}
}

func TestRollbackStrippedSignatureDoesNotHelp(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	c := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithVerification(VerifyOptions{PublicKeys: []JWK{e.pub}}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false), WithPollInterval(time.Hour)))
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.signed = false
	e.mu.Unlock()
	e.set(4, bundleText(4, boolFlag))
	if code := refreshCode(t, c); code != ErrRollback || c.Revision() != 5 {
		t.Fatalf("%q r%d", code, c.Revision())
	}
	// An unsigned newer answer is still accepted without Require, as before.
	e.set(6, bundleText(6, boolFlag))
	if code := refreshCode(t, c); code != "" || c.Revision() != 6 || c.Status() != StatusReady {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
}

func TestRollbackStaleMarkedCopyKeepsOldBehaviour(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	c := newRollbackClient(t, e)
	e.mu.Lock()
	e.stale = true
	e.mu.Unlock()
	e.set(4, bundleText(4, boolFlag))
	if code := refreshCode(t, c); code != "" || c.Revision() != 5 || c.Status() != StatusStale {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
}

func TestRollbackRestoredRevisionIsANewHigherOne(t *testing.T) {
	e := newFakeEdge(t)
	e.set(7, bundleText(7, boolFlag))
	c := newRollbackClient(t, e)
	e.set(8, bundleText(8, boolFlag)) // "restore r5" publishes the old content as r8
	if code := refreshCode(t, c); code != "" || c.Revision() != 8 || c.Status() != StatusReady {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
}

func TestRollbackUnverifiedSourcesNeverSetAFloor(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	boot, err := New(testKey, e.options(WithLive(false), WithStreaming(false), WithBootstrapJSON([]byte(bundleText(9, boolFlag))))...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = boot.Close() })
	if err := waitReady(t, boot); err != nil {
		t.Fatal(err)
	}
	_ = boot.Refresh(context.Background())
	if boot.Revision() != 5 {
		t.Fatalf("bootstrap blocked the update: r%d", boot.Revision())
	}
	// Verification off: nothing to anchor a revision on.
	off := must(t)(New(testKey, WithBaseURL(e.srv.URL), WithoutVerification(), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false), WithPollInterval(time.Hour)))
	if err := waitReady(t, off); err != nil {
		t.Fatal(err)
	}
	e.set(4, bundleText(4, boolFlag))
	if code := refreshCode(t, off); code != "" || off.Revision() != 4 {
		t.Fatalf("%q r%d", code, off.Revision())
	}
}

func TestRollbackStoreFloor(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	path := filepath.Join(t.TempDir(), "flags.json")
	first := newRollbackClient(t, e, WithStore(FileStore(path)))
	_ = first.Close()

	// After a restart an older answer than the stored verified revision is refused.
	e.set(4, bundleText(4, boolFlag))
	c := must(t)(New(testKey, e.options(WithStore(FileStore(path)), WithLive(false), WithStreaming(false))...))
	r := record(c)
	_ = waitReady(t, c)
	eventually(t, "rollback after restart", func() bool { return r.hasError(ErrRollback) })
	if c.Revision() != 5 || c.Status() != StatusStale {
		t.Fatalf("r%d %s", c.Revision(), c.Status())
	}

	// A stored copy older than the edge's revision is the normal case: replaced, no error.
	e.set(6, bundleText(6, boolFlag))
	c2 := must(t)(New(testKey, e.options(WithStore(FileStore(path)), WithLive(false), WithStreaming(false))...))
	r2 := record(c2)
	_ = waitReady(t, c2)
	eventually(t, "r6", func() bool { return c2.Revision() == 6 && c2.Status() == StatusReady })
	if r2.hasError(ErrRollback) {
		t.Fatal("unexpected rollback error")
	}
}

func TestRollbackLivePush(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	e.publish(6, bundleText(6, boolFlag))
	eventually(t, "r6", func() bool { return c.Revision() == 6 })
	// A (genuinely signed) older revision pushed over the same transport is a rollback.
	e.publish(4, bundleText(4, boolFlag))
	eventually(t, "rollback error", func() bool { return r.hasError(ErrRollback) })
	if c.Revision() != 6 || c.Status() != StatusStale {
		t.Fatalf("r%d %s", c.Revision(), c.Status())
	}
	// The same revision again confirms the configuration in use.
	e.publish(6, bundleText(6, boolFlag))
	eventually(t, "ready again", func() bool { return c.Status() == StatusReady })
}

func TestRollbackHTTPTrailingLivePushIsDroppedSilently(t *testing.T) {
	e := newFakeEdge(t)
	e.set(5, bundleText(5, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	e.publish(6, bundleText(6, boolFlag))
	eventually(t, "r6", func() bool { return c.Revision() == 6 })
	// The HTTP path still answers r5 for a moment: no error, no status change.
	e.set(5, bundleText(5, boolFlag))
	if code := refreshCode(t, c); code != "" || c.Revision() != 6 || c.Status() != StatusReady {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
	if r.hasError(ErrRollback) {
		t.Fatal("reported a rollback for an ordering race")
	}
}

func TestRejectedUpdateMakesTheClientStaleUntilItVerifies(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, bundleText(3, boolFlag))
	c := newRollbackClient(t, e)
	e.mu.Lock()
	e.corrupt = true
	e.mu.Unlock()
	e.set(4, bundleText(4, boolFlag))
	if code := refreshCode(t, c); code != ErrSignature || c.Revision() != 3 || c.Status() != StatusStale {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
	e.mu.Lock()
	e.corrupt = false
	e.mu.Unlock()
	if code := refreshCode(t, c); code != "" || c.Revision() != 4 || c.Status() != StatusReady {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
}

func TestUnsignedAnswerWithRequireLeavesStatusUnchanged(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, bundleText(3, boolFlag))
	c := newRollbackClient(t, e)
	e.mu.Lock()
	e.signed = false
	e.mu.Unlock()
	e.set(4, bundleText(4, boolFlag))
	if code := refreshCode(t, c); code != ErrSignature || c.Revision() != 3 || c.Status() != StatusReady {
		t.Fatalf("%q r%d %s", code, c.Revision(), c.Status())
	}
}

func TestInvalidSignedPushMakesTheClientStale(t *testing.T) {
	e := newFakeEdge(t)
	e.set(3, bundleText(3, boolFlag))
	c := must(t)(New(testKey, e.options()...))
	r := record(c)
	if err := waitReady(t, c); err != nil {
		t.Fatal(err)
	}
	eventually(t, "live", func() bool { return c.Transport() == TransportLive })
	e.mu.Lock()
	e.corrupt = true
	e.mu.Unlock()
	e.publish(4, bundleText(4, boolFlag))
	eventually(t, "stale", func() bool { return c.Status() == StatusStale && r.hasError(ErrSignature) })
	if c.Revision() != 3 {
		t.Fatalf("r%d", c.Revision())
	}
}

func TestOfficialEdgeAddressSpellings(t *testing.T) {
	official := []string{"https://edge.nanoflags.io", "https://edge.nanoflags.io/", "https://edge.nanoflags.io///", "https://EDGE.nanoflags.io:443", "https://edge.nanoflags.io./", "HTTPS://Edge.NanoFlags.io"}
	for _, u := range official {
		if got := normalizeBaseURL(u); got != OfficialEdgeURL {
			t.Errorf("%q normalised to %q", u, got)
		}
		// Default verification with require, and no network needed to see it.
		c := must(t)(New(testKey, WithBaseURL(u), WithHTTPClient(&http.Client{Transport: offline{}}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false), WithPollInterval(time.Hour)))
		if c.verifier == nil || !c.verifier.require || c.cfg.baseURL != OfficialEdgeURL {
			t.Errorf("%q: verification not on by default", u)
		}
	}
	other := []string{"http://edge.nanoflags.io", "https://edge.nanoflags.io:8443", "https://edge.nanoflags.io/v1", "https://user@edge.nanoflags.io", "https://user:pw@edge.nanoflags.io", "https://edge.nanoflags.io?x=1", "https://edge.nanoflags.io#f", "https://edge.nanoflags.io.example.com", "https://xedge.nanoflags.io"}
	for _, u := range other {
		if got := normalizeBaseURL(u); got == OfficialEdgeURL {
			t.Errorf("%q must not count as the official edge", u)
		}
		c := must(t)(New(testKey, WithBaseURL(u), WithHTTPClient(&http.Client{Transport: offline{}}), WithEvents(EventsOptions{Disabled: true}), WithLive(false), WithStreaming(false), WithPollInterval(time.Hour)))
		if c.verifier != nil {
			t.Errorf("%q: verification on by default", u)
		}
	}
}
