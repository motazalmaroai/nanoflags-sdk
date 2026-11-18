package client

import "encoding/json"

// Token is GET /token.
type Token struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	OrgID      string   `json:"orgId"`
	ProjectID  *string  `json:"projectId"`
	ProjectKey *string  `json:"projectKey"`
	Scopes     []string `json:"scopes"`
	ExpiresAt  string   `json:"expiresAt"`
	Status     string   `json:"status"`
}

// Project is a NanoFlags project.
type Project struct {
	ID                 string `json:"id"`
	Key                string `json:"key"`
	Name               string `json:"name"`
	Timezone           string `json:"timezone"`
	DefaultEnvironment string `json:"defaultEnvironment"`
	CreatedAt          string `json:"createdAt"`
}

// Environment is one environment of a project.
type Environment struct {
	ID                string  `json:"id"`
	Key               string  `json:"key"`
	Name              string  `json:"name"`
	Sort              int64   `json:"sort"`
	IsProtected       bool    `json:"isProtected"`
	RequireApproval   bool    `json:"requireApproval"`
	RequiredApprovers int64   `json:"requiredApprovers"`
	RequireScenarios  bool    `json:"requireScenarios"`
	PublishedRevision int64   `json:"publishedRevision"`
	PublishedChecksum *string `json:"publishedChecksum"`
	PublishedAt       *string `json:"publishedAt"`
	CreatedAt         string  `json:"createdAt"`
}

// Flag is a flag's details (not its per-environment configuration).
type Flag struct {
	ID            string          `json:"id"`
	Key           string          `json:"key"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Type          string          `json:"type"`
	Purpose       string          `json:"purpose"`
	Permanent     bool            `json:"permanent"`
	ClientExposed bool            `json:"clientExposed"`
	InitialValue  json.RawMessage `json:"initialValue"`
	JSONSchema    json.RawMessage `json:"jsonSchema"`
	OwnerID       *string         `json:"ownerId"`
	ReviewDate    *string         `json:"reviewDate"`
	ArchivedAt    *string         `json:"archivedAt"`
	CreatedAt     string          `json:"createdAt"`
}

// FlagCreate is the body of POST /projects/{p}/flags. Only the keys present are sent.
type FlagCreate map[string]any

// FlagUpdate is the body of PATCH /projects/{p}/flags/{f}. Only the keys present are sent; a nil value sends null.
type FlagUpdate map[string]any

// Condition is one targeting condition of a rule or a segment.
type Condition struct {
	Attribute string          `json:"attribute"`
	Op        string          `json:"op"`
	Value     json.RawMessage `json:"value,omitempty"`
}

// Serve is `{type:"fixed", value}` or `{type:"rollout", percentage, value, otherwise, bucketBy?, seed?}`.
type Serve struct {
	Type       string          `json:"type"`
	Value      json.RawMessage `json:"value,omitempty"`
	Percentage *float64        `json:"percentage,omitempty"`
	Otherwise  json.RawMessage `json:"otherwise,omitempty"`
	BucketBy   string          `json:"bucketBy,omitempty"`
	Seed       string          `json:"seed,omitempty"`
}

// Rule is one targeting rule; rules are evaluated in order.
type Rule struct {
	ID          string      `json:"id"`
	Description string      `json:"description,omitempty"`
	Match       string      `json:"match,omitempty"`
	Conditions  []Condition `json:"conditions"`
	Serve       Serve       `json:"serve"`
}

// ConfigDraft is a flag's draft in one environment.
type ConfigDraft struct {
	Enabled   bool            `json:"enabled"`
	Rules     []Rule          `json:"rules"`
	Default   json.RawMessage `json:"default"`
	Off       json.RawMessage `json:"off"`
	UpdatedAt string          `json:"updatedAt"`
	UpdatedBy *string         `json:"updatedBy"`
}

// FlagConfig is GET /projects/{p}/flags/{f}/environments/{e}.
type FlagConfig struct {
	Flag              string          `json:"flag"`
	Environment       string          `json:"environment"`
	EnvironmentID     string          `json:"environmentId"`
	Draft             ConfigDraft     `json:"draft"`
	PublishedRevision int64           `json:"publishedRevision"`
	Published         json.RawMessage `json:"published"`
}

// ConfigUpdate is the body of PATCH …/environments/{e}; fields left nil keep their draft value.
type ConfigUpdate struct {
	Enabled *bool           `json:"enabled,omitempty"`
	Rules   *[]Rule         `json:"rules,omitempty"`
	Default json.RawMessage `json:"default,omitempty"`
	Off     json.RawMessage `json:"off,omitempty"`
}

// Segment is a project-wide reusable audience.
type Segment struct {
	ID          string      `json:"id"`
	Key         string      `json:"key"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Match       string      `json:"match"`
	Conditions  []Condition `json:"conditions"`
	CreatedAt   string      `json:"createdAt"`
	UpdatedAt   string      `json:"updatedAt"`
}

// SegmentCreate is the body of POST /projects/{p}/segments.
type SegmentCreate struct {
	Key         string      `json:"key"`
	Name        string      `json:"name,omitempty"`
	Description *string     `json:"description,omitempty"`
	Match       string      `json:"match,omitempty"`
	Conditions  []Condition `json:"conditions"`
}

// SegmentUpdate is the body of PATCH /projects/{p}/segments/{s}.
type SegmentUpdate struct {
	Name        *string      `json:"name,omitempty"`
	Description *string      `json:"description,omitempty"`
	Match       *string      `json:"match,omitempty"`
	Conditions  *[]Condition `json:"conditions,omitempty"`
}

// Draft is GET /projects/{p}/environments/{e}/draft.
type Draft struct {
	Environment       string          `json:"environment"`
	Checksum          string          `json:"checksum"`
	PublishedRevision int64           `json:"publishedRevision"`
	PublishedChecksum *string         `json:"publishedChecksum"`
	Dirty             bool            `json:"dirty"`
	Bundle            json.RawMessage `json:"bundle"`
}

// PublishRequest is the body of POST …/publish.
type PublishRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Change           string `json:"change,omitempty"`
	Note             string `json:"note,omitempty"`
}

// PublishResult is the answer of POST …/publish.
type PublishResult struct {
	Environment   string `json:"environment"`
	EnvironmentID string `json:"environmentId"`
	Revision      int64  `json:"revision"`
	Checksum      string `json:"checksum"`
	CommittedAt   int64  `json:"committedAt"`
}

// SdkKey is SDK key metadata; key material is never returned by the API.
type SdkKey struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Kind          string  `json:"kind"`
	Prefix        string  `json:"prefix"`
	Environment   string  `json:"environment"`
	EnvironmentID string  `json:"environmentId"`
	CreatedAt     string  `json:"createdAt"`
	CreatedBy     *string `json:"createdBy"`
	LastUsedAt    *string `json:"lastUsedAt"`
	RevokedAt     *string `json:"revokedAt"`
}

// SlackDestination is a channel (Incoming Webhook) that receives NanoFlags events.
type SlackDestination struct {
	ID           string   `json:"id"`
	OrgID        string   `json:"orgId"`
	ProjectID    *string  `json:"projectId"`
	ProjectKey   *string  `json:"projectKey"`
	Name         string   `json:"name"`
	Transport    string   `json:"transport"`
	URLHint      string   `json:"urlHint"`
	Environments []string `json:"environments"`
	Events       []string `json:"events"`
	Locale       *string  `json:"locale"`
	Enabled      bool     `json:"enabled"`
	Status       string   `json:"status"`
	CreatedAt    string   `json:"createdAt"`
}

// SlackDestinationCreate is the body of POST /integrations/slack/destinations.
type SlackDestinationCreate struct {
	Name         string   `json:"name"`
	WebhookURL   string   `json:"webhookUrl"`
	Events       []string `json:"events"`
	Environments []string `json:"environments,omitempty"`
	Locale       string   `json:"locale,omitempty"`
	Project      string   `json:"project,omitempty"`
	Scope        string   `json:"scope,omitempty"`
}
