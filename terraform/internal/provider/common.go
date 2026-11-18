package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/client"
)

// keyRE is the key format of flags and segments (immutable after creation).
var keyRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// Operators of targeting conditions, as the evaluation engine accepts them.
var conditionOps = []string{"eq", "neq", "in", "not_in", "contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "exists", "not_exists", "segment", "not_segment"}

var flagTypes = []string{"boolean", "string", "number", "json"}
var flagPurposes = []string{"release", "experiment", "operational", "permission"}

func keyValidator(what string) validator.String {
	return stringvalidator.RegexMatches(keyRE, what+" keys are 1–63 characters: lowercase letters, digits, '-' and '_', starting with a letter or digit.")
}

// clientFrom extracts the API client handed over by the provider's Configure.
func clientFrom(data any, diags *diag.Diagnostics) *client.Client {
	if data == nil {
		return nil
	}
	c, ok := data.(*client.Client)
	if !ok {
		diags.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", data))
		return nil
	}
	return c
}

func addAPIError(diags *diag.Diagnostics, summary string, err error) {
	detail := err.Error()
	switch {
	case client.HasCode(err, "PLAN_REQUIRED"):
		detail += "\n\nThe organization's plan does not include this feature."
	case strings.Contains(detail, "HTTP 401"):
		detail += "\n\nCheck api_token / NANOFLAGS_API_TOKEN: the token may be unknown, revoked or expired."
	case strings.Contains(detail, "HTTP 403"):
		detail += "\n\nThe token's scopes or its creator's role do not allow this. See the provider documentation for the scopes each resource needs."
	}
	diags.AddError(summary, detail)
}

// --- JSON-valued attributes -------------------------------------------------------------------------------------

type jsonValidator struct{}

func (jsonValidator) Description(context.Context) string {
	return "value must be valid JSON (use jsonencode())"
}
func (v jsonValidator) MarkdownDescription(ctx context.Context) string { return v.Description(ctx) }
func (jsonValidator) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	if !json.Valid([]byte(req.ConfigValue.ValueString())) {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid JSON", fmt.Sprintf("%q is not valid JSON. Wrap values in jsonencode(), e.g. jsonencode(true) or jsonencode(\"blue\").", req.ConfigValue.ValueString()))
	}
}

func decodeJSON(s string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return normalizeNumbers(v), nil
}

// normalizeNumbers turns json.Number into float64 so 1 and 1.0 compare equal.
func normalizeNumbers(v any) any {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return t.String()
		}
		return f
	case map[string]any:
		for k, x := range t {
			t[k] = normalizeNumbers(x)
		}
	case []any:
		for i, x := range t {
			t[i] = normalizeNumbers(x)
		}
	}
	return v
}

// jsonEqual reports whether two JSON documents are semantically equal.
func jsonEqual(a, b string) bool {
	va, err1 := decodeJSON(a)
	vb, err2 := decodeJSON(b)
	if err1 != nil || err2 != nil {
		return a == b
	}
	return reflect.DeepEqual(va, vb)
}

// compactJSON renders raw JSON compactly (Terraform's jsonencode() style); "" for empty input.
func compactJSON(raw []byte) string {
	if len(bytes.TrimSpace(raw)) == 0 {
		return ""
	}
	v, err := decodeJSON(string(raw))
	if err != nil {
		return string(raw)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return string(raw)
	}
	return string(b)
}

// jsonFromAPI returns the prior value when it is semantically equal to what the API returned (so formatting in the
// configuration never shows up as a diff), and otherwise the API value in compact form.
func jsonFromAPI(prior types.String, raw []byte) types.String {
	if len(bytes.TrimSpace(raw)) == 0 {
		return types.StringNull()
	}
	if !prior.IsNull() && !prior.IsUnknown() && jsonEqual(prior.ValueString(), string(raw)) {
		return prior
	}
	return types.StringValue(compactJSON(raw))
}

// nullableJSONFromAPI is jsonFromAPI where a JSON null from the API means "not set".
func nullableJSONFromAPI(prior types.String, raw []byte) types.String {
	if t := bytes.TrimSpace(raw); len(t) == 0 || string(t) == "null" {
		return types.StringNull()
	}
	return jsonFromAPI(prior, raw)
}

func rawJSON(s types.String) json.RawMessage {
	if s.IsNull() || s.IsUnknown() {
		return nil
	}
	return json.RawMessage(s.ValueString())
}

func strPtrValue(p *string) types.String {
	if p == nil {
		return types.StringNull()
	}
	return types.StringValue(*p)
}

func splitID(id string, n int) ([]string, bool) {
	parts := strings.Split(id, "/")
	if len(parts) != n {
		return nil, false
	}
	for _, p := range parts {
		if p == "" {
			return nil, false
		}
	}
	return parts, true
}

// jsonKind returns the JSON kind of a value: boolean, string, number, null, array or object.
func jsonKind(s string) string {
	v, err := decodeJSON(s)
	if err != nil {
		return "invalid"
	}
	switch v.(type) {
	case bool:
		return "boolean"
	case string:
		return "string"
	case float64:
		return "number"
	case nil:
		return "null"
	case []any:
		return "array"
	default:
		return "object"
	}
}

// valueFitsType reports whether a JSON value can be served by a flag of the given type.
func valueFitsType(flagType, value string) bool {
	k := jsonKind(value)
	switch flagType {
	case "boolean", "string", "number":
		return k == flagType
	case "json":
		return k != "invalid"
	}
	return true
}
