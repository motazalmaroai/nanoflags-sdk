// Package client is a small typed client for the NanoFlags Management API (`/api/v1`, `nf_api_…` tokens).
//
// It covers the endpoints the Terraform provider uses. Every request sends `Authorization: Bearer <token>`;
// POST requests carry an `Idempotency-Key` that is reused on retries, so a retried create never creates twice.
// Rate-limited (429) and unavailable (502/503/504) answers are retried with backoff, honouring `Retry-After`.
package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the NanoFlags edge; the Management API lives under /api/v1.
const DefaultBaseURL = "https://edge.nanoflags.io"

// Client talks to the Management API.
type Client struct {
	apiURL     string
	token      string
	userAgent  string
	HTTPClient *http.Client
	// MaxRetries is how many times a 429/502/503/504 answer or a network error is retried (default 4).
	MaxRetries int
	// Backoff is the first retry delay; it doubles on each retry (default 1s). Retry-After wins when present.
	Backoff time.Duration
}

// New returns a client. baseURL is the edge root (https://edge.nanoflags.io); a trailing /api/v1 is accepted too.
func New(baseURL, token, userAgent string) *Client {
	b := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if b == "" {
		b = DefaultBaseURL
	}
	if !strings.HasSuffix(b, "/api/v1") {
		b += "/api/v1"
	}
	return &Client{
		apiURL:     b,
		token:      token,
		userAgent:  userAgent,
		HTTPClient: &http.Client{Timeout: 60 * time.Second},
		MaxRetries: 4,
		Backoff:    time.Second,
	}
}

// APIURL is the Management API root this client calls (…/api/v1).
func (c *Client) APIURL() string { return c.apiURL }

// Error is an answer of the API outside 2xx: `{"error":{"code","message"}}`.
type Error struct {
	Status  int
	Code    string
	Message string
	Method  string
	Path    string
}

func (e *Error) Error() string {
	return fmt.Sprintf("NanoFlags API %s %s: HTTP %d %s: %s", e.Method, e.Path, e.Status, e.Code, e.Message)
}

// IsNotFound reports whether err is a 404 answer.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// HasCode reports whether err is an API error with the given stable code (e.g. NO_CHANGES).
func HasCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

func newIdempotencyKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "tf-" + hex.EncodeToString(b)
}

func esc(s string) string { return url.PathEscape(s) }

// Do sends one request and decodes a JSON answer into out (when out is not nil).
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
	}
	u := c.apiURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	idem := ""
	if method == http.MethodPost {
		idem = newIdempotencyKey()
	}
	delay := c.Backoff
	for attempt := 0; ; attempt++ {
		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, rdr)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Accept", "application/json")
		if c.userAgent != "" {
			req.Header.Set("User-Agent", c.userAgent)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if idem != "" {
			req.Header.Set("Idempotency-Key", idem)
		}
		res, err := c.HTTPClient.Do(req)
		if err != nil {
			if attempt < c.MaxRetries && ctx.Err() == nil {
				if werr := sleep(ctx, delay); werr != nil {
					return werr
				}
				delay *= 2
				continue
			}
			return fmt.Errorf("could not reach %s: %w", c.apiURL, err)
		}
		data, rerr := io.ReadAll(io.LimitReader(res.Body, 32<<20))
		res.Body.Close()
		if rerr != nil {
			return fmt.Errorf("reading %s %s: %w", method, path, rerr)
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			if out == nil || len(bytes.TrimSpace(data)) == 0 {
				return nil
			}
			if err := json.Unmarshal(data, out); err != nil {
				return fmt.Errorf("decoding %s %s: %w", method, path, err)
			}
			return nil
		}
		retryable := res.StatusCode == http.StatusTooManyRequests || res.StatusCode == http.StatusBadGateway ||
			res.StatusCode == http.StatusServiceUnavailable || res.StatusCode == http.StatusGatewayTimeout
		if retryable && attempt < c.MaxRetries {
			wait := delay
			if ra, err := strconv.Atoi(strings.TrimSpace(res.Header.Get("Retry-After"))); err == nil && ra >= 0 {
				wait = time.Duration(ra) * time.Second
				if wait > 60*time.Second {
					wait = 60 * time.Second
				}
			}
			if werr := sleep(ctx, wait); werr != nil {
				return werr
			}
			delay *= 2
			continue
		}
		apiErr := &Error{Status: res.StatusCode, Code: fmt.Sprintf("HTTP_%d", res.StatusCode), Message: http.StatusText(res.StatusCode), Method: method, Path: path}
		var env struct {
			Error *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &env) == nil && env.Error != nil {
			if env.Error.Code != "" {
				apiErr.Code = env.Error.Code
			}
			if env.Error.Message != "" {
				apiErr.Message = env.Error.Message
			}
		}
		return apiErr
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type page[T any] struct {
	Data       []T     `json:"data"`
	NextCursor *string `json:"nextCursor"`
}

func listAll[T any](ctx context.Context, c *Client, path string, query url.Values) ([]T, error) {
	if query == nil {
		query = url.Values{}
	}
	var all []T
	for i := 0; i < 10000; i++ {
		var p page[T]
		if err := c.Do(ctx, http.MethodGet, path, query, nil, &p); err != nil {
			return nil, err
		}
		all = append(all, p.Data...)
		if p.NextCursor == nil || *p.NextCursor == "" {
			return all, nil
		}
		query.Set("cursor", *p.NextCursor)
	}
	return all, nil
}

// --- token and projects -----------------------------------------------------------------------------------------

// GetToken returns the calling token (GET /token; any valid token).
func (c *Client) GetToken(ctx context.Context) (*Token, error) {
	var t Token
	return &t, c.Do(ctx, http.MethodGet, "/token", nil, nil, &t)
}

// ListProjects returns every project the token can see (GET /projects).
func (c *Client) ListProjects(ctx context.Context) ([]Project, error) {
	return listAll[Project](ctx, c, "/projects", url.Values{"limit": {"100"}})
}

// GetProject reads a project by key or id (GET /projects/{project}).
func (c *Client) GetProject(ctx context.Context, project string) (*Project, error) {
	var p Project
	return &p, c.Do(ctx, http.MethodGet, "/projects/"+esc(project), nil, nil, &p)
}

// ListEnvironments returns the project's environments in dashboard order.
func (c *Client) ListEnvironments(ctx context.Context, project string) ([]Environment, error) {
	return listAll[Environment](ctx, c, "/projects/"+esc(project)+"/environments", nil)
}

// GetEnvironment reads an environment by key or id.
func (c *Client) GetEnvironment(ctx context.Context, project, env string) (*Environment, error) {
	var e Environment
	return &e, c.Do(ctx, http.MethodGet, "/projects/"+esc(project)+"/environments/"+esc(env), nil, nil, &e)
}

// --- flags (scope flags:read / flags:write) -----------------------------------------------------------------------

// ListFlags returns the project's flags; archived is "false" (default), "true" or "all".
func (c *Client) ListFlags(ctx context.Context, project, archived string) ([]Flag, error) {
	q := url.Values{"limit": {"100"}}
	if archived != "" {
		q.Set("archived", archived)
	}
	return listAll[Flag](ctx, c, "/projects/"+esc(project)+"/flags", q)
}

func (c *Client) flagPath(project, flag string) string {
	return "/projects/" + esc(project) + "/flags/" + esc(flag)
}

// GetFlag reads a flag (archived flags included).
func (c *Client) GetFlag(ctx context.Context, project, flag string) (*Flag, error) {
	var f Flag
	return &f, c.Do(ctx, http.MethodGet, c.flagPath(project, flag), nil, nil, &f)
}

// CreateFlag creates a flag; every environment's draft starts with initialValue. Nothing is published.
func (c *Client) CreateFlag(ctx context.Context, project string, body FlagCreate) (*Flag, error) {
	var f Flag
	return &f, c.Do(ctx, http.MethodPost, "/projects/"+esc(project)+"/flags", nil, body, &f)
}

// UpdateFlag edits flag details (key and type are immutable).
func (c *Client) UpdateFlag(ctx context.Context, project, flag string, body FlagUpdate) (*Flag, error) {
	var f Flag
	return &f, c.Do(ctx, http.MethodPatch, c.flagPath(project, flag), nil, body, &f)
}

// ArchiveFlag archives a flag (removes it from every draft).
func (c *Client) ArchiveFlag(ctx context.Context, project, flag string) (*Flag, error) {
	var f Flag
	return &f, c.Do(ctx, http.MethodPost, c.flagPath(project, flag)+"/archive", nil, nil, &f)
}

// UnarchiveFlag restores an archived flag.
func (c *Client) UnarchiveFlag(ctx context.Context, project, flag string) (*Flag, error) {
	var f Flag
	return &f, c.Do(ctx, http.MethodPost, c.flagPath(project, flag)+"/unarchive", nil, nil, &f)
}

// GetFlagConfig reads a flag's draft and published configuration in one environment.
func (c *Client) GetFlagConfig(ctx context.Context, project, flag, env string) (*FlagConfig, error) {
	var fc FlagConfig
	return &fc, c.Do(ctx, http.MethodGet, c.flagPath(project, flag)+"/environments/"+esc(env), nil, nil, &fc)
}

// UpdateFlagConfig edits the flag's draft in one environment (publishing is a separate step).
func (c *Client) UpdateFlagConfig(ctx context.Context, project, flag, env string, body ConfigUpdate) (*FlagConfig, error) {
	var fc FlagConfig
	return &fc, c.Do(ctx, http.MethodPatch, c.flagPath(project, flag)+"/environments/"+esc(env), nil, body, &fc)
}

// --- segments (scope segments:read / segments:write) ----------------------------------------------------------------

func (c *Client) segPath(project, seg string) string {
	return "/projects/" + esc(project) + "/segments/" + esc(seg)
}

// ListSegments returns the project's segments.
func (c *Client) ListSegments(ctx context.Context, project string) ([]Segment, error) {
	return listAll[Segment](ctx, c, "/projects/"+esc(project)+"/segments", url.Values{"limit": {"100"}})
}

// GetSegment reads a segment.
func (c *Client) GetSegment(ctx context.Context, project, seg string) (*Segment, error) {
	var s Segment
	return &s, c.Do(ctx, http.MethodGet, c.segPath(project, seg), nil, nil, &s)
}

// CreateSegment creates a project-wide segment (part of every environment's draft).
func (c *Client) CreateSegment(ctx context.Context, project string, body SegmentCreate) (*Segment, error) {
	var s Segment
	return &s, c.Do(ctx, http.MethodPost, "/projects/"+esc(project)+"/segments", nil, body, &s)
}

// UpdateSegment edits a segment.
func (c *Client) UpdateSegment(ctx context.Context, project, seg string, body SegmentUpdate) (*Segment, error) {
	var s Segment
	return &s, c.Do(ctx, http.MethodPatch, c.segPath(project, seg), nil, body, &s)
}

// DeleteSegment deletes a segment; rules that still reference it stop matching it.
func (c *Client) DeleteSegment(ctx context.Context, project, seg string) error {
	return c.Do(ctx, http.MethodDelete, c.segPath(project, seg), nil, nil, nil)
}

// --- drafts and publishing (scope flags:read / publish) -----------------------------------------------------------

// GetDraft reads an environment's draft (checksum, dirty).
func (c *Client) GetDraft(ctx context.Context, project, env string) (*Draft, error) {
	var d Draft
	return &d, c.Do(ctx, http.MethodGet, "/projects/"+esc(project)+"/environments/"+esc(env)+"/draft", nil, nil, &d)
}

// Publish publishes an environment's draft as the next revision.
func (c *Client) Publish(ctx context.Context, project, env string, body PublishRequest) (*PublishResult, error) {
	var r PublishResult
	return &r, c.Do(ctx, http.MethodPost, "/projects/"+esc(project)+"/environments/"+esc(env)+"/publish", nil, body, &r)
}

// --- SDK keys (scope keys:read; metadata only) ----------------------------------------------------------------------

// ListSdkKeys lists SDK key metadata (never key material). env may be empty for every environment.
func (c *Client) ListSdkKeys(ctx context.Context, project, env string, includeRevoked bool) ([]SdkKey, error) {
	q := url.Values{}
	if env != "" {
		q.Set("environment", env)
	}
	if includeRevoked {
		q.Set("revoked", "true")
	}
	return listAll[SdkKey](ctx, c, "/projects/"+esc(project)+"/keys", q)
}

// --- Slack destinations (scope integrations:write) -----------------------------------------------------------------

// ListSlackDestinations lists destinations; project narrows to that project's plus organization-wide ones.
func (c *Client) ListSlackDestinations(ctx context.Context, project string) ([]SlackDestination, error) {
	q := url.Values{}
	if project != "" {
		q.Set("project", project)
	}
	return listAll[SlackDestination](ctx, c, "/integrations/slack/destinations", q)
}

// CreateSlackDestination connects an Incoming Webhook. The URL is stored as a secret and never returned.
func (c *Client) CreateSlackDestination(ctx context.Context, body SlackDestinationCreate) (*SlackDestination, error) {
	var d SlackDestination
	return &d, c.Do(ctx, http.MethodPost, "/integrations/slack/destinations", nil, body, &d)
}

// DeleteSlackDestination removes a destination.
func (c *Client) DeleteSlackDestination(ctx context.Context, id string) error {
	return c.Do(ctx, http.MethodDelete, "/integrations/slack/destinations/"+esc(id), nil, nil, nil)
}
