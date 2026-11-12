package nanoflags

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

const keysRefetchInterval = time.Minute

// verifier holds the effective verification settings and the key cache.
type verifier struct {
	c       *Client
	base    []publicKey
	require bool
	refetch bool

	mu        sync.Mutex
	fetched   []publicKey
	fetchedAt time.Time
}

func newVerifier(cfg *config, c *Client) (*verifier, []error) {
	official := cfg.baseURL == OfficialEdgeURL
	var errs []error
	if cfg.verifySet && cfg.verify == nil {
		return nil, nil
	}
	if !cfg.verifySet {
		if !official {
			return nil, nil
		}
		return &verifier{c: c, base: importKeys(OfficialSigningKeys), require: true, refetch: true}, nil
	}
	o := cfg.verify
	v := &verifier{c: c, require: official}
	if o.Require != nil {
		v.require = *o.Require
	}
	switch {
	case len(o.PublicKeys) > 0:
		for _, k := range o.PublicKeys {
			if !isPublicEd25519(k) {
				errs = append(errs, newError(ErrConfig, "VerifyOptions.PublicKeys must contain public Ed25519 JWKs only; other entries (including private keys) were ignored"))
				break
			}
		}
		v.base, v.refetch = importKeys(o.PublicKeys), o.FetchKeys
	case o.FetchKeys || !official:
		v.refetch = true
	default:
		v.base, v.refetch = importKeys(OfficialSigningKeys), true
	}
	return v, errs
}

// keysFor returns the keys to verify a signature by kid with: the pinned or embedded keys plus
// those fetched from /v1/keys. With refetch, a key id that none of them has (rotation) loads
// /v1/keys once — again at most once a minute.
func (v *verifier) keysFor(ctx context.Context, kid string) ([]publicKey, error) {
	if !v.refetch {
		return v.base, nil
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	all := func() []publicKey { return append(append([]publicKey(nil), v.base...), v.fetched...) }
	known := all()
	if len(known) > 0 {
		if kid == "" {
			return known, nil
		}
		for _, k := range known {
			if k.kid == kid {
				return known, nil
			}
		}
	}
	if !v.fetchedAt.IsZero() && time.Since(v.fetchedAt) < keysRefetchInterval {
		return known, nil
	}
	keys, err := v.fetch(ctx)
	if err != nil {
		// Without any key the bundle cannot be checked. With the embedded keys the failed reload
		// counts as this minute's reload, so a bad key id cannot make every poll ask for keys.
		if len(v.base) == 0 {
			return nil, err
		}
		v.fetchedAt = time.Now()
		return known, nil
	}
	v.fetched, v.fetchedAt = keys, time.Now()
	return all(), nil
}

func (v *verifier) fetch(ctx context.Context) ([]publicKey, error) {
	ctx, cancel := context.WithTimeout(ctx, v.c.cfg.requestTimeout)
	defer cancel()
	// Public endpoint: the SDK key is deliberately not sent.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.c.cfg.baseURL+"/v1/keys", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "nanoflags-go/"+SDKVersion)
	res, err := v.c.cfg.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("signing keys request failed with HTTP %d", res.StatusCode)
	}
	var body struct {
		Keys []JWK `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("invalid signing keys response: %w", err)
	}
	keys := importKeys(body.Keys)
	if len(keys) == 0 {
		return nil, fmt.Errorf("the edge returned no usable signing keys")
	}
	return keys, nil
}
