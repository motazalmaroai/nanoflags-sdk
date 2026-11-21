package provider

import (
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"regexp"
	"strings"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/client"
)

type conditionModel struct {
	Attribute types.String `tfsdk:"attribute"`
	Op        types.String `tfsdk:"op"`
	Value     types.String `tfsdk:"value"`
}

func conditionBlock() schema.ListNestedBlock {
	return schema.ListNestedBlock{
		MarkdownDescription: "A targeting condition. All or any conditions must hold, depending on `match`.",
		NestedObject: schema.NestedBlockObject{
			Attributes: map[string]schema.Attribute{
				"attribute": schema.StringAttribute{
					MarkdownDescription: "Context attribute, e.g. `plan` or `key`. Ignored (leave empty) for the `segment` and `not_segment` operators.",
					Optional:            true,
					Computed:            true,
					Default:             stringdefault.StaticString(""),
				},
				"op": schema.StringAttribute{
					MarkdownDescription: "Operator: `eq`, `neq`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte` (numbers), `semver_eq`, `semver_neq`, `semver_gt`, `semver_gte`, `semver_lt`, `semver_lte` (semantic versions such as `4.10.0`), `before`, `after` (dates: `2026-12-31`, `2026-12-31T09:00:00Z` or a Unix timestamp), `exists`, `not_exists`, `segment`, `not_segment`. SDK releases from before the version and date operators evaluate those conditions as not matching.",
					Required:            true,
					Validators:          []validator.String{stringvalidator.OneOf(conditionOps...)},
				},
				"value": schema.StringAttribute{
					MarkdownDescription: "JSON-encoded comparison value, e.g. `jsonencode([\"pro\", \"team\"])` for `in`, or `jsonencode(\"beta-users\")` (a segment key) for `segment`. Omit for `exists` / `not_exists`.",
					Optional:            true,
					Validators:          []validator.String{jsonValidator{}},
				},
			},
		},
	}
}

func validateConditions(conds []conditionModel, base path.Path, diags *diag.Diagnostics) {
	for i, c := range conds {
		p := base.AtListIndex(i)
		if c.Op.IsUnknown() || c.Value.IsUnknown() || c.Attribute.IsUnknown() {
			continue
		}
		op := c.Op.ValueString()
		switch op {
		case "exists", "not_exists":
			if !c.Value.IsNull() {
				diags.AddAttributeError(p.AtName("value"), "Unexpected value", op+" takes no value.")
			}
		case "segment", "not_segment":
			if c.Value.IsNull() || jsonKind(c.Value.ValueString()) != "string" {
				diags.AddAttributeError(p.AtName("value"), "Segment key required", op+" needs value = jsonencode(\"<segment key>\").")
			}
		case "in", "not_in":
			if c.Value.IsNull() || jsonKind(c.Value.ValueString()) != "array" {
				diags.AddAttributeError(p.AtName("value"), "List required", op+" needs a JSON array, e.g. jsonencode([\"a\", \"b\"]).")
			}
		case "semver_eq", "semver_neq", "semver_gt", "semver_gte", "semver_lt", "semver_lte":
			if c.Value.IsNull() || jsonKind(c.Value.ValueString()) != "string" {
				diags.AddAttributeError(p.AtName("value"), "Version required", op+" needs a version string, e.g. jsonencode(\"4.10.0\").")
			}
		case "before", "after":
			if k := jsonKind(c.Value.ValueString()); c.Value.IsNull() || (k != "string" && k != "number") {
				diags.AddAttributeError(p.AtName("value"), "Date required", op+" needs a date string, e.g. jsonencode(\"2026-12-31T09:00:00Z\"), or a Unix timestamp number.")
			}
		default:
			if c.Value.IsNull() {
				diags.AddAttributeError(p.AtName("value"), "Value required", op+" needs a value.")
			}
		}
		if (op == "gt" || op == "gte" || op == "lt" || op == "lte") && !c.Value.IsNull() && looksLikeVersion(c.Value.ValueString(), c.Attribute.ValueString()) {
			diags.AddAttributeWarning(p.AtName("op"), "Numeric comparison of a version",
				op+" compares numbers (\"4.10\" is 4.1, \"4.10.0\" is not a number). To compare versions use semver_"+op+".")
		}
		if op != "segment" && op != "not_segment" && (c.Attribute.IsNull() || c.Attribute.ValueString() == "") {
			diags.AddAttributeError(p.AtName("attribute"), "Attribute required", op+" needs the context attribute to compare.")
		}
	}
}

var (
	versionValue = regexp.MustCompile(`^"[vV]?[0-9]+(\.[0-9]+){0,2}([-+][0-9A-Za-z.+-]*)?"$`)
	plainNumber  = regexp.MustCompile(`^"?-?[0-9]+(\.[0-9]+)?"?$`)
	lowerUpper   = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	acronymWord  = regexp.MustCompile(`([A-Z]+)([A-Z][a-z])`)
	nonWord      = regexp.MustCompile(`[^A-Za-z0-9]+`)
)

// attributeWords splits an attribute name at camelCase humps and separators, lower-cased (attributeWords in the
// evaluation engine): appVersion → app, version; OSVersion → os, version; os_ver → os, ver.
func attributeWords(name string) []string {
	s := acronymWord.ReplaceAllString(lowerUpper.ReplaceAllString(name, "$1 $2"), "$1 $2")
	var out []string
	for _, w := range nonWord.Split(s, -1) {
		if w != "" {
			out = append(out, strings.ToLower(w))
		}
	}
	return out
}

// versionLikeAttribute: a word "version" or "ver", but not a version code (versionCode is Android's integer).
// Words merely containing "ver" (conversions, server) do not count. Same rule as the evaluation engine.
func versionLikeAttribute(name string) bool {
	found := false
	for _, w := range attributeWords(name) {
		if w == "code" {
			return false
		}
		found = found || w == "version" || w == "ver"
	}
	return found
}

// looksLikeVersion reports whether a numeric condition probably means a version comparison: its JSON value is a
// version string that is not a plain number ("4.10.0", "v4"), or the attribute is named like a version. Same rule as
// numericVersionWarning in the evaluation engine. A warning only: the condition stays valid and numeric.
func looksLikeVersion(jsonValue, attribute string) bool {
	if versionValue.MatchString(jsonValue) && !plainNumber.MatchString(jsonValue) {
		return true
	}
	return versionLikeAttribute(attribute)
}

func conditionsToAPI(conds []conditionModel) []client.Condition {
	out := make([]client.Condition, 0, len(conds))
	for _, c := range conds {
		out = append(out, client.Condition{Attribute: c.Attribute.ValueString(), Op: c.Op.ValueString(), Value: rawJSON(c.Value)})
	}
	return out
}

func conditionsFromAPI(api []client.Condition, prior []conditionModel) []conditionModel {
	out := make([]conditionModel, 0, len(api))
	for i, c := range api {
		var pv types.String = types.StringNull()
		if i < len(prior) {
			pv = prior[i].Value
		}
		out = append(out, conditionModel{Attribute: types.StringValue(c.Attribute), Op: types.StringValue(c.Op), Value: nullableJSONFromAPI(pv, c.Value)})
	}
	return out
}
