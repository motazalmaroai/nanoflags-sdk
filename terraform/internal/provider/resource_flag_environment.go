package provider

import (
	"context"
	"fmt"
	"math"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &flagEnvironmentResource{}
	_ resource.ResourceWithImportState    = &flagEnvironmentResource{}
	_ resource.ResourceWithValidateConfig = &flagEnvironmentResource{}
)

// NewFlagEnvironmentResource returns nanoflags_flag_environment.
func NewFlagEnvironmentResource() resource.Resource { return &flagEnvironmentResource{} }

type flagEnvironmentResource struct{ c *client.Client }

type rolloutModel struct {
	Percentage types.Float64 `tfsdk:"percentage"`
	Value      types.String  `tfsdk:"value"`
	Otherwise  types.String  `tfsdk:"otherwise"`
	BucketBy   types.String  `tfsdk:"bucket_by"`
	Seed       types.String  `tfsdk:"seed"`
}

type ruleModel struct {
	ID          types.String     `tfsdk:"id"`
	Description types.String     `tfsdk:"description"`
	Match       types.String     `tfsdk:"match"`
	Conditions  []conditionModel `tfsdk:"condition"`
	Value       types.String     `tfsdk:"value"`
	Rollout     *rolloutModel    `tfsdk:"rollout"`
}

type flagEnvironmentModel struct {
	ID           types.String `tfsdk:"id"`
	Project      types.String `tfsdk:"project"`
	Flag         types.String `tfsdk:"flag"`
	Environment  types.String `tfsdk:"environment"`
	Enabled      types.Bool   `tfsdk:"enabled"`
	DefaultValue types.String `tfsdk:"default_value"`
	OffValue     types.String `tfsdk:"off_value"`
	Rules        []ruleModel  `tfsdk:"rule"`
}

func (r *flagEnvironmentResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_flag_environment"
}

func (r *flagEnvironmentResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		MarkdownDescription: "A flag's configuration in one environment: on/off, the default and off values, and targeting rules " +
			"(fixed values or percentage rollouts).\n\nThis edits the environment's **draft**, exactly like the dashboard. " +
			"Nothing reaches SDKs until the draft is published, with `nanoflags_environment_publish` or through the dashboard's " +
			"review flow in environments that require approvals. The resource owns the whole rule list: rules not declared here are " +
			"removed from the draft. Destroying the resource leaves the draft as it is (the API has no way to remove a flag from one environment).\n\n" +
			"Scopes: `flags:read`, `flags:write`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				MarkdownDescription: "`<project>/<flag>/<environment>`.",
				Computed:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project":     schema.StringAttribute{MarkdownDescription: "Project key or id.", Required: true, PlanModifiers: replace},
			"flag":        schema.StringAttribute{MarkdownDescription: "Flag key.", Required: true, PlanModifiers: replace, Validators: []validator.String{keyValidator("Flag")}},
			"environment": schema.StringAttribute{MarkdownDescription: "Environment key or id, e.g. `production`.", Required: true, PlanModifiers: replace},
			"enabled": schema.BoolAttribute{
				MarkdownDescription: "Whether the flag is on. When off, every evaluation gets `off_value`. Kept as it is when omitted.",
				Optional:            true,
				Computed:            true,
				PlanModifiers:       []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"default_value": schema.StringAttribute{
				MarkdownDescription: "JSON-encoded value served when the flag is on and no rule matches, e.g. `jsonencode(true)`. Kept as it is when omitted.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{jsonValidator{}},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"off_value": schema.StringAttribute{
				MarkdownDescription: "JSON-encoded value served while the flag is off. Kept as it is when omitted.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{jsonValidator{}},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
		Blocks: map[string]schema.Block{
			"rule": schema.ListNestedBlock{
				MarkdownDescription: "Targeting rule, evaluated in order; the first match serves. Set exactly one of `value` (a fixed value) or a `rollout` block.",
				NestedObject: schema.NestedBlockObject{
					Attributes: map[string]schema.Attribute{
						"id": schema.StringAttribute{
							MarkdownDescription: "Stable rule id, unique within the flag, e.g. `beta-users`. Evaluation reasons and insights refer to it.",
							Required:            true,
							Validators:          []validator.String{stringvalidator.LengthBetween(1, 64)},
						},
						"description": schema.StringAttribute{MarkdownDescription: "What the rule is for.", Optional: true},
						"match": schema.StringAttribute{
							MarkdownDescription: "`all` (default): every condition must hold; `any`: one is enough. A rule without conditions matches everyone.",
							Optional:            true,
							Computed:            true,
							Default:             stringdefault.StaticString("all"),
							Validators:          []validator.String{stringvalidator.OneOf("all", "any")},
						},
						"value": schema.StringAttribute{
							MarkdownDescription: "JSON-encoded fixed value served to matching contexts.",
							Optional:            true,
							Validators:          []validator.String{jsonValidator{}},
						},
					},
					Blocks: map[string]schema.Block{
						"condition": conditionBlock(),
						"rollout": schema.SingleNestedBlock{
							MarkdownDescription: "Percentage rollout: matching contexts inside the allocation get `value`, the others `otherwise`. Bucketing is deterministic.",
							Attributes: map[string]schema.Attribute{
								"percentage": schema.Float64Attribute{
									MarkdownDescription: "0–100, up to two decimals.",
									Optional:            true,
									Validators:          []validator.Float64{float64validator.Between(0, 100)},
								},
								"value":     schema.StringAttribute{MarkdownDescription: "JSON-encoded value inside the allocation.", Optional: true, Validators: []validator.String{jsonValidator{}}},
								"otherwise": schema.StringAttribute{MarkdownDescription: "JSON-encoded value for matching contexts outside the allocation.", Optional: true, Validators: []validator.String{jsonValidator{}}},
								"bucket_by": schema.StringAttribute{MarkdownDescription: "Context attribute used for bucketing. Default: `key`.", Optional: true},
								"seed":      schema.StringAttribute{MarkdownDescription: "Bucketing seed. Default: the flag key, so allocations are independent per flag.", Optional: true},
							},
						},
					},
				},
			},
		},
	}
}

func (r *flagEnvironmentResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *flagEnvironmentResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m flagEnvironmentModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	seen := map[string]bool{}
	for i, rule := range m.Rules {
		p := path.Root("rule").AtListIndex(i)
		if !rule.ID.IsUnknown() && !rule.ID.IsNull() {
			if seen[rule.ID.ValueString()] {
				resp.Diagnostics.AddAttributeError(p.AtName("id"), "Duplicate rule id", fmt.Sprintf("Rule id %q is used twice.", rule.ID.ValueString()))
			}
			seen[rule.ID.ValueString()] = true
		}
		hasValue := !rule.Value.IsNull()
		hasRollout := rule.Rollout != nil
		if hasValue == hasRollout {
			resp.Diagnostics.AddAttributeError(p, "Rule needs exactly one serve", "Set either value (a fixed value) or a rollout block, not both.")
		}
		if ro := rule.Rollout; ro != nil {
			rp := p.AtName("rollout")
			if ro.Percentage.IsNull() {
				resp.Diagnostics.AddAttributeError(rp.AtName("percentage"), "Missing percentage", "A rollout needs percentage (0–100).")
			} else if !ro.Percentage.IsUnknown() {
				v := ro.Percentage.ValueFloat64()
				if math.Abs(v*100-math.Round(v*100)) > 1e-9 {
					resp.Diagnostics.AddAttributeError(rp.AtName("percentage"), "Too many decimals", "percentage takes at most two decimals, e.g. 12.5 or 0.25.")
				}
			}
			if ro.Value.IsNull() {
				resp.Diagnostics.AddAttributeError(rp.AtName("value"), "Missing value", "A rollout needs value (served inside the allocation).")
			}
			if ro.Otherwise.IsNull() {
				resp.Diagnostics.AddAttributeError(rp.AtName("otherwise"), "Missing otherwise", "A rollout needs otherwise (served outside the allocation).")
			}
		}
		validateConditions(rule.Conditions, p.AtName("condition"), &resp.Diagnostics)
	}
}

func rulesToAPI(rules []ruleModel) []client.Rule {
	out := make([]client.Rule, 0, len(rules))
	for _, r := range rules {
		cr := client.Rule{ID: r.ID.ValueString(), Description: r.Description.ValueString(), Match: r.Match.ValueString(), Conditions: conditionsToAPI(r.Conditions)}
		if cr.Match == "" {
			cr.Match = "all"
		}
		if r.Rollout != nil {
			pct := r.Rollout.Percentage.ValueFloat64()
			cr.Serve = client.Serve{Type: "rollout", Percentage: &pct, Value: rawJSON(r.Rollout.Value), Otherwise: rawJSON(r.Rollout.Otherwise),
				BucketBy: r.Rollout.BucketBy.ValueString(), Seed: r.Rollout.Seed.ValueString()}
		} else {
			cr.Serve = client.Serve{Type: "fixed", Value: rawJSON(r.Value)}
		}
		out = append(out, cr)
	}
	return out
}

func optString(s string) types.String {
	if s == "" {
		return types.StringNull()
	}
	return types.StringValue(s)
}

func rulesFromAPI(api []client.Rule, prior []ruleModel) []ruleModel {
	if len(api) == 0 {
		return nil
	}
	out := make([]ruleModel, 0, len(api))
	for i, r := range api {
		var p ruleModel
		if i < len(prior) && prior[i].ID.ValueString() == r.ID {
			p = prior[i]
		}
		m := ruleModel{ID: types.StringValue(r.ID), Description: optString(r.Description), Match: types.StringValue(r.Match), Value: types.StringNull()}
		if r.Match == "" {
			m.Match = types.StringValue("all")
		}
		if r.Description == "" && !p.Description.IsNull() && p.Description.ValueString() == "" {
			m.Description = p.Description
		}
		m.Conditions = conditionsFromAPI(r.Conditions, p.Conditions)
		if len(m.Conditions) == 0 {
			m.Conditions = nil
		}
		if r.Serve.Type == "rollout" {
			pr := p.Rollout
			if pr == nil {
				pr = &rolloutModel{Value: types.StringNull(), Otherwise: types.StringNull()}
			}
			ro := &rolloutModel{Percentage: types.Float64Null(), Value: jsonFromAPI(pr.Value, r.Serve.Value), Otherwise: jsonFromAPI(pr.Otherwise, r.Serve.Otherwise),
				BucketBy: optString(r.Serve.BucketBy), Seed: optString(r.Serve.Seed)}
			if r.Serve.Percentage != nil {
				ro.Percentage = types.Float64Value(*r.Serve.Percentage)
			}
			m.Rollout = ro
		} else {
			m.Value = jsonFromAPI(p.Value, r.Serve.Value)
			if m.Value.IsNull() {
				m.Value = types.StringValue("null")
			}
		}
		out = append(out, m)
	}
	return out
}

func (r *flagEnvironmentResource) apply(ctx context.Context, plan *flagEnvironmentModel) (*client.FlagConfig, error) {
	rules := rulesToAPI(plan.Rules)
	body := client.ConfigUpdate{Rules: &rules, Default: rawJSON(plan.DefaultValue), Off: rawJSON(plan.OffValue)}
	if !plan.Enabled.IsNull() && !plan.Enabled.IsUnknown() {
		v := plan.Enabled.ValueBool()
		body.Enabled = &v
	}
	return r.c.UpdateFlagConfig(ctx, plan.Project.ValueString(), plan.Flag.ValueString(), plan.Environment.ValueString(), body)
}

func configToModel(fc *client.FlagConfig, m *flagEnvironmentModel) {
	m.ID = types.StringValue(m.Project.ValueString() + "/" + m.Flag.ValueString() + "/" + m.Environment.ValueString())
	m.Enabled = types.BoolValue(fc.Draft.Enabled)
	m.DefaultValue = jsonFromAPI(m.DefaultValue, fc.Draft.Default)
	m.OffValue = jsonFromAPI(m.OffValue, fc.Draft.Off)
	m.Rules = rulesFromAPI(fc.Draft.Rules, m.Rules)
}

func (r *flagEnvironmentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan flagEnvironmentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	fc, err := r.apply(ctx, &plan)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not edit the flag's draft", err)
		return
	}
	configToModel(fc, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *flagEnvironmentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state flagEnvironmentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	fc, err := r.c.GetFlagConfig(ctx, state.Project.ValueString(), state.Flag.ValueString(), state.Environment.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read the flag's configuration", err)
		return
	}
	configToModel(fc, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *flagEnvironmentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan flagEnvironmentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	fc, err := r.apply(ctx, &plan)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not edit the flag's draft", err)
		return
	}
	configToModel(fc, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete only forgets the resource: a flag cannot be removed from a single environment.
func (r *flagEnvironmentResource) Delete(_ context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	resp.Diagnostics.AddWarning("Draft left unchanged",
		"nanoflags_flag_environment was removed from the state only. The flag's draft in this environment keeps its last configuration; archive the flag with nanoflags_flag to remove it everywhere.")
}

// ImportState takes "<project>/<flag>/<environment>".
func (r *flagEnvironmentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, ok := splitID(req.ID, 3)
	if !ok {
		resp.Diagnostics.AddError("Invalid import ID", "Use <project key>/<flag key>/<environment key>, e.g. web/new-checkout/production.")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("flag"), parts[1])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("environment"), parts[2])...)
}
