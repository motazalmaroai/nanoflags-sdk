package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/nanoflags/terraform-provider-nanoflags/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = &publishResource{}
	_ resource.ResourceWithModifyPlan  = &publishResource{}
	_ resource.ResourceWithImportState = &publishResource{}
)

// NewEnvironmentPublishResource returns nanoflags_environment_publish.
func NewEnvironmentPublishResource() resource.Resource { return &publishResource{} }

type publishResource struct{ c *client.Client }

type publishModel struct {
	ID          types.String `tfsdk:"id"`
	Project     types.String `tfsdk:"project"`
	Environment types.String `tfsdk:"environment"`
	Note        types.String `tfsdk:"note"`
	Change      types.String `tfsdk:"change"`
	Triggers    types.Map    `tfsdk:"triggers"`
	Revision    types.Int64  `tfsdk:"revision"`
	Checksum    types.String `tfsdk:"checksum"`
}

func (r *publishResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environment_publish"
}

func (r *publishResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Publishes an environment's draft as its next revision, under the same rules as the dashboard: " +
			"environments that require approvals or scenario checks refuse a publish that does not meet them (pass the reviewed " +
			"`change`). Distribution to SDKs starts immediately.\n\nA publish happens on create, whenever `triggers` change, and " +
			"whenever the plan finds unpublished draft changes. Put the configuration you publish in `triggers` (see the example) so " +
			"edits made in the same apply are published by it. Destroying this resource does not unpublish anything.\n\nScope: `publish` (and `flags:read`).",
		Attributes: map[string]schema.Attribute{
			"id":          schema.StringAttribute{Computed: true, MarkdownDescription: "`<project>/<environment>`.", PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"project":     schema.StringAttribute{Required: true, MarkdownDescription: "Project key or id.", PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"environment": schema.StringAttribute{Required: true, MarkdownDescription: "Environment key or id.", PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"note": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Publish note shown in the revision history (at most 500 characters).",
				Validators:          []validator.String{stringvalidator.LengthAtMost(500)},
			},
			"change": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Id of the reviewed change to publish. Required in environments that only accept reviewed changes.",
				Validators:          []validator.String{stringvalidator.RegexMatches(uuidRE, "must be a change id (UUID)")},
			},
			"triggers": schema.MapAttribute{
				Optional:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Arbitrary values; any change publishes again. Typically `sha1(jsonencode(...))` of the flag configurations of this environment.",
			},
			"revision": schema.Int64Attribute{Computed: true, MarkdownDescription: "The environment's published revision."},
			"checksum": schema.StringAttribute{Computed: true, MarkdownDescription: "Checksum of the published revision."},
		},
	}
}

func (r *publishResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = clientFrom(req.ProviderData, &resp.Diagnostics)
}

// ModifyPlan schedules a publish when the environment's draft has unpublished changes.
func (r *publishResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() || r.c == nil {
		return
	}
	var plan publishModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() || plan.Project.IsUnknown() || plan.Environment.IsUnknown() {
		return
	}
	d, err := r.c.GetDraft(ctx, plan.Project.ValueString(), plan.Environment.ValueString())
	if err != nil {
		if !client.IsNotFound(err) {
			resp.Diagnostics.AddWarning("Could not check the draft", err.Error())
		}
		return
	}
	if d.Dirty {
		plan.Revision = types.Int64Unknown()
		plan.Checksum = types.StringUnknown()
		resp.Diagnostics.Append(resp.Plan.Set(ctx, &plan)...)
	}
}

func (r *publishResource) publish(ctx context.Context, m *publishModel) error {
	project, env := m.Project.ValueString(), m.Environment.ValueString()
	m.ID = types.StringValue(project + "/" + env)
	d, err := r.c.GetDraft(ctx, project, env)
	if err != nil {
		return err
	}
	if !d.Dirty {
		m.Revision = types.Int64Value(d.PublishedRevision)
		m.Checksum = strPtrValue(d.PublishedChecksum)
		return nil
	}
	res, err := r.c.Publish(ctx, project, env, client.PublishRequest{ExpectedRevision: d.PublishedRevision, Note: m.Note.ValueString(), Change: m.Change.ValueString()})
	if client.HasCode(err, "NO_CHANGES") {
		return r.readInto(ctx, m)
	}
	if err != nil {
		return err
	}
	m.Revision = types.Int64Value(res.Revision)
	m.Checksum = types.StringValue(res.Checksum)
	return nil
}

func (r *publishResource) readInto(ctx context.Context, m *publishModel) error {
	e, err := r.c.GetEnvironment(ctx, m.Project.ValueString(), m.Environment.ValueString())
	if err != nil {
		return err
	}
	m.ID = types.StringValue(m.Project.ValueString() + "/" + m.Environment.ValueString())
	m.Revision = types.Int64Value(e.PublishedRevision)
	m.Checksum = strPtrValue(e.PublishedChecksum)
	return nil
}

func publishDiag(err error) (string, string) {
	detail := err.Error()
	switch {
	case client.HasCode(err, "CHANGE_REQUIRED"), client.HasCode(err, "APPROVAL_REQUIRED"):
		detail += "\n\nThis environment only publishes reviewed changes: create and approve a change, then pass its id as `change`, or publish from the dashboard."
	case client.HasCode(err, "SCENARIOS_REQUIRED"):
		detail += "\n\nThis environment requires passing scenario checks before publishing."
	case client.HasCode(err, "DESTINATION_CHANGED"):
		detail += "\n\nSomeone published this environment meanwhile; run terraform apply again."
	}
	return "Could not publish", detail
}

func (r *publishResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan publishModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.publish(ctx, &plan); err != nil {
		resp.Diagnostics.AddError(publishDiag(err))
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *publishResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state publishModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	err := r.readInto(ctx, &state)
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read environment", err)
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *publishResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan publishModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.publish(ctx, &plan); err != nil {
		resp.Diagnostics.AddError(publishDiag(err))
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete does nothing: published revisions stay published.
func (r *publishResource) Delete(context.Context, resource.DeleteRequest, *resource.DeleteResponse) {}

// ImportState takes "<project>/<environment>".
func (r *publishResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, ok := splitID(req.ID, 2)
	if !ok {
		resp.Diagnostics.AddError("Invalid import ID", fmt.Sprintf("Use <project key>/<environment key>, got %q.", req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("environment"), parts[1])...)
}
