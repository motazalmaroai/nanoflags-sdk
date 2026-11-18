package provider

import (
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

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
					MarkdownDescription: "Operator: `eq`, `neq`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `exists`, `not_exists`, `segment`, `not_segment`.",
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
		default:
			if c.Value.IsNull() {
				diags.AddAttributeError(p.AtName("value"), "Value required", op+" needs a value.")
			}
		}
		if op != "segment" && op != "not_segment" && (c.Attribute.IsNull() || c.Attribute.ValueString() == "") {
			diags.AddAttributeError(p.AtName("attribute"), "Attribute required", op+" needs the context attribute to compare.")
		}
	}
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
