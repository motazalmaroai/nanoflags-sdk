package client_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/client"
	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/fakeapi"
)

func newClient(t *testing.T) (*client.Client, *fakeapi.Server) {
	t.Helper()
	f := fakeapi.New()
	t.Cleanup(f.Close)
	c := client.New(f.URL, fakeapi.Token, "test")
	c.Backoff = time.Millisecond
	return c, f
}

func TestBaseURL(t *testing.T) {
	for in, want := range map[string]string{
		"":                                 "https://edge.nanoflags.io/api/v1",
		"https://edge.nanoflags.io/":       "https://edge.nanoflags.io/api/v1",
		"https://edge.nanoflags.io/api/v1": "https://edge.nanoflags.io/api/v1",
		"http://localhost:8787/api/v1/":    "http://localhost:8787/api/v1",
	} {
		if got := client.New(in, "t", "ua").APIURL(); got != want {
			t.Errorf("New(%q).APIURL() = %q, want %q", in, got, want)
		}
	}
}

func TestHeadersAndErrors(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		if r.URL.Path != "/api/v1/projects/web/flags/missing" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"Flag not found."}}`))
	}))
	defer srv.Close()
	c := client.New(srv.URL, "nf_api_x", "terraform-provider-nanoflags/test")
	_, err := c.GetFlag(context.Background(), "web", "missing")
	if !client.IsNotFound(err) || !client.HasCode(err, "NOT_FOUND") || !strings.Contains(err.Error(), "Flag not found.") {
		t.Fatalf("unexpected error %v", err)
	}
	if seen.Get("Authorization") != "Bearer nf_api_x" || seen.Get("User-Agent") != "terraform-provider-nanoflags/test" || seen.Get("Accept") != "application/json" {
		t.Fatalf("headers %v", seen)
	}
}

func TestRetriesKeepIdempotencyKey(t *testing.T) {
	var keys []string
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if calls < 3 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "1", "key": "k", "type": "boolean"})
	}))
	defer srv.Close()
	c := client.New(srv.URL, "t", "ua")
	c.Backoff = time.Millisecond
	f, err := c.CreateFlag(context.Background(), "web", client.FlagCreate{"key": "k"})
	if err != nil || f.Key != "k" {
		t.Fatalf("create: %v %+v", err, f)
	}
	if calls != 3 || keys[0] == "" || keys[0] != keys[1] || keys[1] != keys[2] {
		t.Fatalf("calls=%d keys=%v", calls, keys)
	}
}

func TestGiveUpAfterMaxRetries(t *testing.T) {
	c, f := newClient(t)
	c.MaxRetries = 1
	f.FailNext = 5
	_, err := c.GetProject(context.Background(), "web")
	var apiErr *client.Error
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("want 503, got %v (%T)", err, apiErr)
	}
}

func TestFlagLifecycleAgainstFake(t *testing.T) {
	ctx := context.Background()
	c, _ := newClient(t)
	if _, err := c.GetToken(ctx); err != nil {
		t.Fatal(err)
	}
	ps, err := c.ListProjects(ctx)
	if err != nil || len(ps) != 1 || ps[0].Key != "web" {
		t.Fatalf("projects %v %v", ps, err)
	}
	envs, err := c.ListEnvironments(ctx, "web")
	if err != nil || len(envs) != 2 {
		t.Fatalf("envs %v %v", envs, err)
	}
	f, err := c.CreateFlag(ctx, "web", client.FlagCreate{"key": "new-checkout", "name": "New checkout", "clientExposed": true})
	if err != nil || f.Name != "New checkout" || !f.ClientExposed || string(f.InitialValue) != "false" {
		t.Fatalf("create %+v %v", f, err)
	}
	if _, err := c.CreateFlag(ctx, "web", client.FlagCreate{"key": "new-checkout"}); !client.HasCode(err, "CONFLICT") {
		t.Fatalf("want conflict, got %v", err)
	}
	f, err = c.UpdateFlag(ctx, "web", "new-checkout", client.FlagUpdate{"description": "d", "reviewDate": nil})
	if err != nil || f.Description != "d" {
		t.Fatalf("update %v", err)
	}
	pct := 25.0
	rules := []client.Rule{{ID: "beta", Match: "all", Conditions: []client.Condition{{Attribute: "plan", Op: "in", Value: json.RawMessage(`["pro"]`)}},
		Serve: client.Serve{Type: "rollout", Percentage: &pct, Value: json.RawMessage(`true`), Otherwise: json.RawMessage(`false`)}}}
	on := true
	fc, err := c.UpdateFlagConfig(ctx, "web", "new-checkout", "development", client.ConfigUpdate{Enabled: &on, Rules: &rules})
	if err != nil || !fc.Draft.Enabled || len(fc.Draft.Rules) != 1 || *fc.Draft.Rules[0].Serve.Percentage != 25 {
		t.Fatalf("config %+v %v", fc, err)
	}
	d, err := c.GetDraft(ctx, "web", "development")
	if err != nil || !d.Dirty {
		t.Fatalf("draft %+v %v", d, err)
	}
	res, err := c.Publish(ctx, "web", "development", client.PublishRequest{ExpectedRevision: d.PublishedRevision, Note: "t"})
	if err != nil || res.Revision != 1 {
		t.Fatalf("publish %+v %v", res, err)
	}
	if _, err := c.Publish(ctx, "web", "development", client.PublishRequest{ExpectedRevision: 1}); !client.HasCode(err, "NO_CHANGES") {
		t.Fatalf("want NO_CHANGES, got %v", err)
	}
	if f, err = c.ArchiveFlag(ctx, "web", "new-checkout"); err != nil || f.ArchivedAt == nil {
		t.Fatalf("archive %v", err)
	}
	all, _ := c.ListFlags(ctx, "web", "all")
	active, _ := c.ListFlags(ctx, "web", "")
	if len(all) != 1 || len(active) != 0 {
		t.Fatalf("list all=%d active=%d", len(all), len(active))
	}
	keys, err := c.ListSdkKeys(ctx, "web", "development", false)
	if err != nil || len(keys) != 1 {
		t.Fatalf("keys %v %v", keys, err)
	}
}
