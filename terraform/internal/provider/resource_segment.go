package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/nanoflags/terraform-provider-nanoflags/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &segmentResource{}
	_ resource.ResourceWithImportState    = &segmentResource{}
	_ resource.ResourceWithValidateConfig = &segmentResource{}
)

// NewSegmentResource returns nanoflags_segment.
func NewSegmentResource() resource.Resource { return &segmentResource{} }

type segmentResource struct{ c *client.Client }

type segmentModel struct {
	ID          types.String     `tfsdk:"id"`
	Project     types.String     `tfsdk:"project"`
	Key         types.String     `tfsdk:"key"`
	Name        types.String     `tfsdk:"name"`
	Description types.String     `tfsdk:"description"`
	Match       types.String     `tfsdk:"match"`
	Conditions  []conditionModel `tfsdk:"condition"`
	CreatedAt   types.String     `tfsdk:"created_at"`
	UpdatedAt   types.String     `tfsdk:"updated_at"`
}

func (r *segmentResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_segment"
}

func (r *segmentResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A reusable audience, referenced from rules with the `segment` / `not_segment` operators. Segments are " +
			"project-wide: they are part of every environment's draft and reach SDKs with the next publish. Deleting a segment makes " +
			"rules that still reference it match nobody.\n\nScopes: `segments:read`, `segments:write`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				MarkdownDescription: "Segment id (UUID).",
				Computed:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project": schema.StringAttribute{MarkdownDescription: "Project key or id.", Required: true, PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"key": schema.StringAttribute{
				MarkdownDescription: "Segment key, e.g. `beta-users`. Immutable.",
				Required:            true,
				Validators:          []validator.String{keyValidator("Segment")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "Display name. Defaults to the key.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"description": schema.StringAttribute{MarkdownDescription: "Description.", Optional: true, Computed: true, Default: stringdefault.StaticString("")},
			"match": schema.StringAttribute{
				MarkdownDescription: "`all` (default) or `any` of the conditions.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("all"),
				Validators:          []validator.String{stringvalidator.OneOf("all", "any")},
			},
			"created_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time.", PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"updated_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Last change."},
		},
		Blocks: map[string]schema.Block{"condition": conditionBlock()},
	}
}

func (r *segmentResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *segmentResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m segmentModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	validateConditions(m.Conditions, path.Root("condition"), &resp.Diagnostics)
}

func segmentToModel(s *client.Segment, m *segmentModel) {
	m.ID = types.StringValue(s.ID)
	m.Key = types.StringValue(s.Key)
	m.Name = types.StringValue(s.Name)
	m.Description = types.StringValue(s.Description)
	m.Match = types.StringValue(s.Match)
	m.Conditions = conditionsFromAPI(s.Conditions, m.Conditions)
	if len(m.Conditions) == 0 {
		m.Conditions = nil
	}
	m.CreatedAt = types.StringValue(s.CreatedAt)
	m.UpdatedAt = types.StringValue(s.UpdatedAt)
}

func (r *segmentResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan segmentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	desc := plan.Description.ValueString()
	body := client.SegmentCreate{Key: plan.Key.ValueString(), Description: &desc, Match: plan.Match.ValueString(), Conditions: conditionsToAPI(plan.Conditions)}
	if !plan.Name.IsNull() && !plan.Name.IsUnknown() {
		body.Name = plan.Name.ValueString()
	}
	s, err := r.c.CreateSegment(ctx, plan.Project.ValueString(), body)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not create segment", err)
		return
	}
	segmentToModel(s, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *segmentResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state segmentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	s, err := r.c.GetSegment(ctx, state.Project.ValueString(), state.Key.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read segment", err)
		return
	}
	segmentToModel(s, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *segmentResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan segmentModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	desc, match := plan.Description.ValueString(), plan.Match.ValueString()
	conds := conditionsToAPI(plan.Conditions)
	body := client.SegmentUpdate{Description: &desc, Match: &match, Conditions: &conds}
	if !plan.Name.IsNull() && !plan.Name.IsUnknown() {
		n := plan.Name.ValueString()
		body.Name = &n
	}
	s, err := r.c.UpdateSegment(ctx, plan.Project.ValueString(), plan.Key.ValueString(), body)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not update segment", err)
		return
	}
	segmentToModel(s, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *segmentResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state segmentModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.c.DeleteSegment(ctx, state.Project.ValueString(), state.Key.ValueString()); err != nil && !client.IsNotFound(err) {
		addAPIError(&resp.Diagnostics, "Could not delete segment", err)
	}
}

// ImportState takes "<project>/<segment key>".
func (r *segmentResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, ok := splitID(req.ID, 2)
	if !ok {
		resp.Diagnostics.AddError("Invalid import ID", "Use <project key>/<segment key>, e.g. web/beta-users.")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("key"), parts[1])...)
}
