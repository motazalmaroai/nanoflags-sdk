package nanoflags

import (
	"strings"
	"time"
)

// rollbackGrace: right after a revision arrived over the live socket, the HTTP path may still
// answer the previous one for a moment, and vice versa. Within this window an older answer from
// the other transport is refused silently; outside it (or on the same transport) it is refused
// and reported (ErrRollback).
const rollbackGrace = 2 * time.Minute

type adoptionSource int

const (
	adoptedLive adoptionSource = iota
	adoptedHTTP
	adoptedStore
)

// verifiedFloor is the newest revision this client adopted after verifying its signature.
type verifiedFloor struct {
	revision int64
	seq      int64
	at       time.Time
	source   adoptionSource
}

// normalizeBaseURL maps spellings of the official edge address (trailing slashes, an upper-case
// host, the default port, a trailing dot) to OfficialEdgeURL. Anything else is only stripped of
// trailing slashes.
func normalizeBaseURL(raw string) string {
	trimmed := strings.TrimRight(raw, "/")
	const prefix = "https://"
	if len(trimmed) < len(prefix) || !strings.EqualFold(trimmed[:len(prefix)], prefix) {
		return trimmed
	}
	// Anything but a bare host (user info, path, query, fragment) is not the official edge.
	hostport := trimmed[len(prefix):]
	if strings.ContainsAny(hostport, "/@?#\\ ") {
		return trimmed
	}
	host := strings.ToLower(hostport)
	if h, ok := strings.CutSuffix(host, ":443"); ok {
		host = h
	}
	host = strings.TrimSuffix(host, ".")
	if host == strings.TrimPrefix(OfficialEdgeURL, prefix) {
		return OfficialEdgeURL
	}
	return trimmed
}

// verifiedSeqNow is the number of verified adoptions so far: an answer requested at sequence n is
// "older news" if a later one was adopted in the meantime.
func (c *Client) verifiedSeqNow() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.verifiedSeq
}

// noteVerified records that a revision was adopted after its signature verified.
func (c *Client) noteVerified(info *signatureInfo, source adoptionSource) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.verifiedSeq++
	if c.floor == nil || info.Revision >= c.floor.revision {
		c.floor = &verifiedFloor{revision: info.Revision, seq: c.verifiedSeq, at: time.Now(), source: source}
	}
}

// belowFloor reports whether revision is older than the newest verified one.
func (c *Client) belowFloor(revision int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.verifier != nil && c.floor != nil && revision < c.floor.revision
}

// rollbackError is called with a revision older than the newest verified one. It returns the
// error to report, or nil when the older answer is explained by ordering (the newer one was
// adopted after this answer was requested, or arrived a moment ago over the other transport).
// Either way the caller does not adopt it.
func (c *Client) rollbackError(revision, requestedAtSeq int64, source adoptionSource) *Error {
	c.mu.Lock()
	n := c.floor
	c.mu.Unlock()
	if n == nil || revision >= n.revision {
		return nil
	}
	if n.source != adoptedStore && (n.seq > requestedAtSeq || (n.source != source && time.Since(n.at) < rollbackGrace)) {
		return nil
	}
	return newError(ErrRollback, "bundle r%d was rejected: it is older than r%d, which this client already verified for this environment (a replayed or stale response). The configuration in use is unchanged.", revision, n.revision)
}
