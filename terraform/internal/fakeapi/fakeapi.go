// Package fakeapi is an in-memory stand-in for the NanoFlags Management API, used by the unit tests of the client
// and of the provider. It follows the documented request and answer shapes (see the API reference) closely enough
// to exercise create, read, update, delete, import and publish flows without credentials or network access.
package fakeapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Token is the bearer token the fake accepts.
const Token = "nf_api_0123456789abcdef0123456789abcdef0123456789abcdef"

var keyRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

type config struct {
	Enabled   bool              `json:"enabled"`
	Rules     []json.RawMessage `json:"rules"`
	Default   json.RawMessage   `json:"default"`
	Off       json.RawMessage   `json:"off"`
	UpdatedAt string            `json:"updatedAt"`
	UpdatedBy *string           `json:"updatedBy"`
}

type env struct {
	ID                string  `json:"id"`
	Key               string  `json:"key"`
	Name              string  `json:"name"`
	Sort              int     `json:"sort"`
	IsProtected       bool    `json:"isProtected"`
	RequireApproval   bool    `json:"requireApproval"`
	RequiredApprovers int     `json:"requiredApprovers"`
	RequireScenarios  bool    `json:"requireScenarios"`
	PublishedRevision int     `json:"publishedRevision"`
	PublishedChecksum *string `json:"publishedChecksum"`
	PublishedAt       *string `json:"publishedAt"`
	CreatedAt         string  `json:"createdAt"`

	published map[string]any // flag key -> published config
}

type project struct {
	ID                 string `json:"id"`
	Key                string `json:"key"`
	Name               string `json:"name"`
	Timezone           string `json:"timezone"`
	DefaultEnvironment string `json:"defaultEnvironment"`
	CreatedAt          string `json:"createdAt"`

	envs     []*env
	flags    map[string]map[string]any // key -> flag JSON object
	configs  map[string]map[string]*config
	segments map[string]map[string]any
	keys     []map[string]any
}

// Server is a running fake API.
type Server struct {
	*httptest.Server
	mu       sync.Mutex
	projects []*project
	slack    []map[string]any
	seq      int
	// Requests records "METHOD /path" for every request received.
	Requests []string
	// FailNext makes the next n requests answer with FailStatus (for retry tests).
	FailNext   int
	FailStatus int
}

// New starts a fake with one project "web" (environments development and production) and one SDK key.
func New() *Server {
	s := &Server{FailStatus: http.StatusServiceUnavailable}
	s.AddProject("web", "Web app", []string{"development", "production"})
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

func (s *Server) id() string {
	s.seq++
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", s.seq)
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// AddProject adds a project with the given environment keys (the last one protected).
func (s *Server) AddProject(key, name string, envs []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := &project{ID: s.id(), Key: key, Name: name, Timezone: "UTC", CreatedAt: now(),
		flags: map[string]map[string]any{}, configs: map[string]map[string]*config{}, segments: map[string]map[string]any{}}
	for i, k := range envs {
		p.envs = append(p.envs, &env{ID: s.id(), Key: k, Name: strings.ToUpper(k[:1]) + k[1:], Sort: i, IsProtected: i == len(envs)-1 && len(envs) > 1, CreatedAt: now(), published: map[string]any{}})
	}
	if len(envs) > 0 {
		p.DefaultEnvironment = envs[0]
		p.keys = append(p.keys, map[string]any{"id": s.id(), "name": "Server key", "kind": "server", "prefix": "nf_srv_ab12", "environment": envs[0], "environmentId": p.envs[0].ID, "createdAt": now(), "createdBy": nil, "lastUsedAt": nil, "revokedAt": nil})
	}
	s.projects = append(s.projects, p)
}

// Flag returns a copy of the stored flag JSON (nil when missing).
func (s *Server) Flag(project, key string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.project(project)
	if p == nil || p.flags[key] == nil {
		return nil
	}
	out := map[string]any{}
	for k, v := range p.flags[key] {
		out[k] = v
	}
	return out
}

// Config returns the stored draft of a flag in an environment as JSON.
func (s *Server) Config(project, flag, envKey string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.project(project)
	if p == nil || p.configs[flag] == nil || p.configs[flag][envKey] == nil {
		return ""
	}
	b, _ := json.Marshal(p.configs[flag][envKey])
	return string(b)
}

// Segment reports whether a segment exists.
func (s *Server) Segment(project, key string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.project(project)
	if p == nil {
		return nil
	}
	return p.segments[key]
}

// PublishedRevision returns an environment's published revision.
func (s *Server) PublishedRevision(project, envKey string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.project(project); p != nil {
		if e := p.env(envKey); e != nil {
			return e.PublishedRevision
		}
	}
	return -1
}

// SlackCount returns the number of Slack destinations.
func (s *Server) SlackCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.slack)
}

func (s *Server) project(ref string) *project {
	for _, p := range s.projects {
		if p.Key == ref || p.ID == strings.ToLower(ref) {
			return p
		}
	}
	return nil
}

func (p *project) env(ref string) *env {
	for _, e := range p.envs {
		if e.Key == ref || e.ID == strings.ToLower(ref) {
			return e
		}
	}
	return nil
}

func (p *project) flag(ref string) map[string]any {
	if f, ok := p.flags[ref]; ok {
		return f
	}
	for _, f := range p.flags {
		if f["id"] == strings.ToLower(ref) {
			return f
		}
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": msg}})
}

func (p *project) draftChecksum(e *env) (string, map[string]any) {
	bundle := map[string]any{}
	flags := map[string]any{}
	for k, f := range p.flags {
		if f["archivedAt"] != nil {
			continue
		}
		c := p.configs[k][e.Key]
		flags[k] = map[string]any{"type": f["type"], "enabled": c.Enabled, "rules": c.Rules, "default": c.Default, "off": c.Off, "clientExposed": f["clientExposed"]}
	}
	segs := map[string]any{}
	for k, sg := range p.segments {
		segs[k] = map[string]any{"match": sg["match"], "conditions": sg["conditions"]}
	}
	bundle["flags"] = flags
	bundle["segments"] = segs
	b, _ := json.Marshal(bundle)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), bundle
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Requests = append(s.Requests, r.Method+" "+r.URL.Path)
	if s.FailNext > 0 {
		s.FailNext--
		w.Header().Set("Retry-After", "0")
		fail(w, s.FailStatus, "UNAVAILABLE", "try again")
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+Token {
		fail(w, 401, "UNAUTHORIZED", "Missing, unknown, revoked or expired token.")
		return
	}
	if r.Method == http.MethodPost && r.Header.Get("Idempotency-Key") == "" {
		fail(w, 400, "IDEMPOTENCY_KEY_MISSING", "the fake expects an Idempotency-Key on POST")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	var body map[string]any
	if r.Body != nil && (r.Method == http.MethodPost || r.Method == http.MethodPatch) {
		dec := json.NewDecoder(r.Body)
		dec.UseNumber()
		if err := dec.Decode(&body); err != nil && err.Error() != "EOF" {
			fail(w, 400, "INVALID_REQUEST", "body is not JSON")
			return
		}
	}
	if body == nil {
		body = map[string]any{}
	}

	switch {
	case len(parts) == 1 && parts[0] == "token" && r.Method == http.MethodGet:
		writeJSON(w, 200, map[string]any{"id": "tok", "name": "fake", "prefix": Token[:14], "orgId": "org", "projectId": nil, "projectKey": nil,
			"scopes":    []string{"flags:read", "flags:write", "segments:read", "segments:write", "publish", "keys:read", "integrations:write"},
			"expiresAt": "2099-01-01T00:00:00Z", "createdAt": now(), "createdBy": "u", "createdByName": "Fake", "lastUsedAt": nil, "revokedAt": nil, "status": "active"})
		return
	case len(parts) >= 3 && parts[0] == "integrations" && parts[1] == "slack" && parts[2] == "destinations":
		s.slackRoutes(w, r, parts[3:], body)
		return
	case len(parts) == 1 && parts[0] == "projects" && r.Method == http.MethodGet:
		data := []any{}
		for _, p := range s.projects {
			data = append(data, p)
		}
		writeJSON(w, 200, map[string]any{"data": data, "nextCursor": nil})
		return
	case len(parts) >= 2 && parts[0] == "projects":
		p := s.project(parts[1])
		if p == nil {
			fail(w, 404, "NOT_FOUND", "Project not found.")
			return
		}
		s.projectRoutes(w, r, p, parts[2:], body)
		return
	}
	fail(w, 404, "not_found", "no such route")
}

func (s *Server) projectRoutes(w http.ResponseWriter, r *http.Request, p *project, rest []string, body map[string]any) {
	m := r.Method
	switch {
	case len(rest) == 0 && m == http.MethodGet:
		writeJSON(w, 200, p)
	case len(rest) == 1 && rest[0] == "environments" && m == http.MethodGet:
		writeJSON(w, 200, map[string]any{"data": p.envs, "nextCursor": nil})
	case len(rest) >= 2 && rest[0] == "environments":
		e := p.env(rest[1])
		if e == nil {
			fail(w, 404, "NOT_FOUND", "Environment not found.")
			return
		}
		switch {
		case len(rest) == 2 && m == http.MethodGet:
			writeJSON(w, 200, e)
		case len(rest) == 3 && rest[2] == "draft" && m == http.MethodGet:
			sum, bundle := p.draftChecksum(e)
			writeJSON(w, 200, map[string]any{"environment": e.Key, "checksum": sum, "publishedRevision": e.PublishedRevision, "publishedChecksum": e.PublishedChecksum,
				"dirty": e.PublishedChecksum == nil || *e.PublishedChecksum != sum, "bundle": bundle})
		case len(rest) == 3 && rest[2] == "publish" && m == http.MethodPost:
			exp, ok := body["expectedRevision"].(json.Number)
			if !ok {
				fail(w, 400, "INVALID_REQUEST", "expectedRevision is required")
				return
			}
			if n, _ := exp.Int64(); int(n) != e.PublishedRevision {
				fail(w, 409, "DESTINATION_CHANGED", "Another publish happened.")
				return
			}
			if e.RequireApproval && body["change"] == nil {
				fail(w, 422, "CHANGE_REQUIRED", "This environment only accepts reviewed changes.")
				return
			}
			sum, bundle := p.draftChecksum(e)
			if e.PublishedChecksum != nil && *e.PublishedChecksum == sum {
				fail(w, 409, "NO_CHANGES", "Nothing to publish.")
				return
			}
			e.PublishedRevision++
			e.PublishedChecksum = &sum
			t := now()
			e.PublishedAt = &t
			e.published = bundle["flags"].(map[string]any)
			writeJSON(w, 200, map[string]any{"environment": e.Key, "environmentId": e.ID, "revision": e.PublishedRevision, "checksum": sum, "committedAt": time.Now().UnixMilli()})
		default:
			fail(w, 404, "not_found", "no such route")
		}
	case len(rest) == 1 && rest[0] == "keys" && m == http.MethodGet:
		out := []any{}
		for _, k := range p.keys {
			if ev := r.URL.Query().Get("environment"); ev != "" && k["environment"] != ev {
				continue
			}
			out = append(out, k)
		}
		writeJSON(w, 200, map[string]any{"data": out, "nextCursor": nil})
	case len(rest) >= 1 && rest[0] == "flags":
		s.flagRoutes(w, r, p, rest[1:], body)
	case len(rest) >= 1 && rest[0] == "segments":
		s.segmentRoutes(w, r, p, rest[1:], body)
	default:
		fail(w, 404, "not_found", "no such route")
	}
}

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func (s *Server) flagRoutes(w http.ResponseWriter, r *http.Request, p *project, rest []string, body map[string]any) {
	m := r.Method
	if len(rest) == 0 {
		switch m {
		case http.MethodGet:
			arch := r.URL.Query().Get("archived")
			keys := make([]string, 0, len(p.flags))
			for k := range p.flags {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			out := []any{}
			for _, k := range keys {
				f := p.flags[k]
				isArch := f["archivedAt"] != nil
				if arch == "all" || (arch == "true") == isArch {
					out = append(out, f)
				}
			}
			writeJSON(w, 200, map[string]any{"data": out, "nextCursor": nil})
		case http.MethodPost:
			key, _ := body["key"].(string)
			if !keyRE.MatchString(key) {
				fail(w, 400, "INVALID_REQUEST", "key must match ^[a-z0-9][a-z0-9_-]{0,62}$")
				return
			}
			if p.flags[key] != nil {
				fail(w, 409, "CONFLICT", "A flag with this key exists.")
				return
			}
			typ := "boolean"
			if t, ok := body["type"].(string); ok {
				typ = t
			}
			initial := body["initialValue"]
			if _, ok := body["initialValue"]; !ok {
				if typ != "boolean" {
					fail(w, 422, "INVALID_VALUE", "initialValue is required for "+typ+" flags")
					return
				}
				initial = false
			}
			name := key
			if n, ok := body["name"].(string); ok && strings.TrimSpace(n) != "" {
				name = n
			}
			f := map[string]any{"id": s.id(), "key": key, "name": name, "description": "", "type": typ, "purpose": "release", "permanent": false,
				"clientExposed": false, "initialValue": initial, "jsonSchema": nil, "ownerId": "00000000-0000-4000-8000-0000000000aa", "reviewDate": nil, "archivedAt": nil, "createdAt": now()}
			for _, k := range []string{"description", "purpose", "permanent", "clientExposed", "jsonSchema", "reviewDate", "ownerId"} {
				if v, ok := body[k]; ok {
					f[k] = v
				}
			}
			p.flags[key] = f
			p.configs[key] = map[string]*config{}
			for _, e := range p.envs {
				p.configs[key][e.Key] = &config{Enabled: false, Rules: []json.RawMessage{}, Default: raw(initial), Off: raw(initial), UpdatedAt: now()}
			}
			writeJSON(w, 201, f)
		default:
			fail(w, 404, "not_found", "no such route")
		}
		return
	}
	f := p.flag(rest[0])
	if f == nil {
		fail(w, 404, "NOT_FOUND", "Flag not found.")
		return
	}
	key := f["key"].(string)
	switch {
	case len(rest) == 1 && m == http.MethodGet:
		writeJSON(w, 200, f)
	case len(rest) == 1 && m == http.MethodPatch:
		if len(body) == 0 {
			fail(w, 400, "INVALID_REQUEST", "nothing to update")
			return
		}
		for k, v := range body {
			switch k {
			case "name":
				if n, _ := v.(string); strings.TrimSpace(n) == "" {
					v = key
				}
				f[k] = v
			case "description", "purpose", "permanent", "clientExposed", "jsonSchema", "reviewDate", "ownerId":
				f[k] = v
			default:
				fail(w, 400, "INVALID_REQUEST", k+" cannot be changed")
				return
			}
		}
		writeJSON(w, 200, f)
	case len(rest) == 2 && rest[1] == "archive" && m == http.MethodPost:
		if f["archivedAt"] == nil {
			f["archivedAt"] = now()
		}
		writeJSON(w, 200, f)
	case len(rest) == 2 && rest[1] == "unarchive" && m == http.MethodPost:
		f["archivedAt"] = nil
		writeJSON(w, 200, f)
	case len(rest) == 3 && rest[1] == "environments":
		e := p.env(rest[2])
		if e == nil {
			fail(w, 404, "NOT_FOUND", "Environment not found.")
			return
		}
		c := p.configs[key][e.Key]
		if m == http.MethodPatch {
			if len(body) == 0 {
				fail(w, 400, "INVALID_REQUEST", "nothing to update")
				return
			}
			for k, v := range body {
				switch k {
				case "enabled":
					b, ok := v.(bool)
					if !ok {
						fail(w, 400, "INVALID_REQUEST", "enabled must be a boolean")
						return
					}
					c.Enabled = b
				case "rules":
					arr, ok := v.([]any)
					if !ok {
						fail(w, 400, "INVALID_REQUEST", "rules must be an array")
						return
					}
					c.Rules = []json.RawMessage{}
					for _, x := range arr {
						c.Rules = append(c.Rules, raw(x))
					}
				case "default":
					c.Default = raw(v)
				case "off":
					c.Off = raw(v)
				default:
					fail(w, 400, "INVALID_REQUEST", k+" is not a config field")
					return
				}
			}
			c.UpdatedAt = now()
		} else if m != http.MethodGet {
			fail(w, 404, "not_found", "no such route")
			return
		}
		writeJSON(w, 200, map[string]any{"flag": key, "environment": e.Key, "environmentId": e.ID, "draft": c, "publishedRevision": e.PublishedRevision, "published": e.published[key]})
	default:
		fail(w, 404, "not_found", "no such route")
	}
}

func (s *Server) segmentRoutes(w http.ResponseWriter, r *http.Request, p *project, rest []string, body map[string]any) {
	m := r.Method
	if len(rest) == 0 {
		switch m {
		case http.MethodGet:
			out := []any{}
			for _, sg := range p.segments {
				out = append(out, sg)
			}
			writeJSON(w, 200, map[string]any{"data": out, "nextCursor": nil})
		case http.MethodPost:
			key, _ := body["key"].(string)
			if !keyRE.MatchString(key) {
				fail(w, 400, "INVALID_REQUEST", "invalid key")
				return
			}
			if p.segments[key] != nil {
				fail(w, 409, "CONFLICT", "A segment with this key exists.")
				return
			}
			sg := map[string]any{"id": s.id(), "key": key, "name": key, "description": "", "match": "all", "conditions": []any{}, "createdAt": now(), "updatedAt": now()}
			for _, k := range []string{"name", "description", "match", "conditions"} {
				if v, ok := body[k]; ok && v != nil {
					sg[k] = v
				}
			}
			p.segments[key] = sg
			writeJSON(w, 201, sg)
		default:
			fail(w, 404, "not_found", "no such route")
		}
		return
	}
	sg := p.segments[rest[0]]
	if sg == nil {
		fail(w, 404, "NOT_FOUND", "Segment not found.")
		return
	}
	switch m {
	case http.MethodGet:
		writeJSON(w, 200, sg)
	case http.MethodPatch:
		for k, v := range body {
			sg[k] = v
		}
		sg["updatedAt"] = now()
		writeJSON(w, 200, sg)
	case http.MethodDelete:
		delete(p.segments, rest[0])
		writeJSON(w, 200, map[string]any{"deleted": true, "key": rest[0]})
	default:
		fail(w, 404, "not_found", "no such route")
	}
}

func (s *Server) slackRoutes(w http.ResponseWriter, r *http.Request, rest []string, body map[string]any) {
	switch {
	case len(rest) == 0 && r.Method == http.MethodGet:
		out := []any{}
		for _, d := range s.slack {
			out = append(out, d)
		}
		writeJSON(w, 200, map[string]any{"data": out, "nextCursor": nil})
	case len(rest) == 0 && r.Method == http.MethodPost:
		url, _ := body["webhookUrl"].(string)
		if !strings.HasPrefix(url, "https://hooks.slack.com/services/") {
			fail(w, 400, "INVALID_REQUEST", "webhookUrl must be an Incoming Webhook URL")
			return
		}
		d := map[string]any{"id": s.id(), "orgId": "org", "projectId": nil, "projectKey": nil, "projectName": nil, "name": body["name"], "transport": "incoming_webhook",
			"urlHint": "hooks.slack.com/…" + url[len(url)-4:], "environments": []any{}, "events": body["events"], "locale": nil, "enabled": true, "status": "ok",
			"consecutiveFailures": 0, "createdAt": now(), "updatedAt": now()}
		if pk, ok := body["project"].(string); ok && body["scope"] != "organization" {
			if p := s.project(pk); p != nil {
				d["projectId"], d["projectKey"], d["projectName"] = p.ID, p.Key, p.Name
			} else {
				fail(w, 404, "NOT_FOUND", "Project not found.")
				return
			}
		}
		if v, ok := body["environments"]; ok {
			d["environments"] = v
		}
		if v, ok := body["locale"]; ok {
			d["locale"] = v
		}
		s.slack = append(s.slack, d)
		writeJSON(w, 201, d)
	case len(rest) == 1 && r.Method == http.MethodDelete:
		for i, d := range s.slack {
			if d["id"] == rest[0] {
				s.slack = append(s.slack[:i], s.slack[i+1:]...)
				writeJSON(w, 200, map[string]any{"deleted": true, "id": rest[0]})
				return
			}
		}
		fail(w, 404, "NOT_FOUND", "Destination not found.")
	default:
		fail(w, 404, "not_found", "no such route")
	}
}

// Copy helper kept for tests that want to mutate a flag behind Terraform's back.
func (s *Server) SetFlagField(project, key, field string, v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.project(project); p != nil && p.flags[key] != nil {
		p.flags[key][field] = v
	}
}

// AddSegment creates a segment behind Terraform's back (a draft change made in the dashboard).
func (s *Server) AddSegment(project, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.project(project); p != nil {
		p.segments[key] = map[string]any{"id": s.id(), "key": key, "name": key, "description": "", "match": "all", "conditions": []any{}, "createdAt": now(), "updatedAt": now()}
	}
}
