package provider

import (
	"context"
	"fmt"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/client"
)

var (
	_ resource.ResourceWithConfigure      = &flagResource{}
	_ resource.ResourceWithImportState    = &flagResource{}
	_ resource.ResourceWithValidateConfig = &flagResource{}
	_ resource.ResourceWithModifyPlan     = &flagResource{}
)

var dateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// NewFlagResource returns nanoflags_flag.
func NewFlagResource() resource.Resource { return &flagResource{} }

type flagResource struct{ c *client.Client }

type flagModel struct {
	ID            types.String `tfsdk:"id"`
	Project       types.String `tfsdk:"project"`
	Key           types.String `tfsdk:"key"`
	Type          types.String `tfsdk:"type"`
	Name          types.String `tfsdk:"name"`
	Description   types.String `tfsdk:"description"`
	Purpose       types.String `tfsdk:"purpose"`
	Permanent     types.Bool   `tfsdk:"permanent"`
	ClientExposed types.Bool   `tfsdk:"client_exposed"`
	InitialValue  types.String `tfsdk:"initial_value"`
	JSONSchema    types.String `tfsdk:"json_schema"`
	ReviewDate    types.String `tfsdk:"review_date"`
	OwnerID       types.String `tfsdk:"owner_id"`
	Archived      types.Bool   `tfsdk:"archived"`
	ArchivedAt    types.String `tfsdk:"archived_at"`
	CreatedAt     types.String `tfsdk:"created_at"`
}

func (r *flagResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_flag"
}

func (r *flagResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A feature flag: its key, type and details. Per-environment targeting lives in `nanoflags_flag_environment`.\n\n" +
			"Creating a flag puts it in every environment's draft with `initial_value`; nothing is published. The Management API has no hard " +
			"delete: **destroying this resource archives the flag** (it leaves published revisions on the next publish). Because keys are " +
			"permanent, an archived key cannot be created again; import it and set `archived = false` instead.\n\nScopes: `flags:read`, `flags:write`.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				MarkdownDescription: "Flag id (UUID).",
				Computed:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"project": schema.StringAttribute{
				MarkdownDescription: "Project key or id.",
				Required:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"key": schema.StringAttribute{
				MarkdownDescription: "Flag key used in code, e.g. `new-checkout`. Immutable: changing it creates a new flag and archives the old one.",
				Required:            true,
				Validators:          []validator.String{keyValidator("Flag")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"type": schema.StringAttribute{
				MarkdownDescription: "Value type: `boolean` (default), `string`, `number` or `json`. Immutable.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("boolean"),
				Validators:          []validator.String{stringvalidator.OneOf(flagTypes...)},
			},
			"name": schema.StringAttribute{
				MarkdownDescription: "Display name, 1–120 characters. Defaults to the key.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{stringvalidator.LengthBetween(1, 120)},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"description": schema.StringAttribute{
				MarkdownDescription: "Description, at most 2000 characters.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString(""),
				Validators:          []validator.String{stringvalidator.LengthAtMost(2000)},
			},
			"purpose": schema.StringAttribute{
				MarkdownDescription: "`release` (default), `experiment`, `operational` or `permission`.",
				Optional:            true,
				Computed:            true,
				Default:             stringdefault.StaticString("release"),
				Validators:          []validator.String{stringvalidator.OneOf(flagPurposes...)},
			},
			"permanent": schema.BoolAttribute{
				MarkdownDescription: "Long-lived flag that is meant to stay in code (excluded from stale-flag cleanup). Default `false`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
			},
			"client_exposed": schema.BoolAttribute{
				MarkdownDescription: "Serve this flag to browser and mobile (`nf_pub_…`) keys. Default `false`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
			},
			"initial_value": schema.StringAttribute{
				MarkdownDescription: "JSON-encoded value every environment's draft starts with, e.g. `jsonencode(false)`. Required for " +
					"`string`, `number` and `json` flags; `false` for boolean flags. Only used at creation: change per-environment " +
					"values with `nanoflags_flag_environment`.",
				Optional:      true,
				Computed:      true,
				Validators:    []validator.String{jsonValidator{}},
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"json_schema": schema.StringAttribute{
				MarkdownDescription: "JSON-encoded JSON Schema (an object) that the values of a `json` flag must satisfy.",
				Optional:            true,
				Validators:          []validator.String{jsonValidator{}},
			},
			"review_date": schema.StringAttribute{
				MarkdownDescription: "Date (`YYYY-MM-DD`) by which the flag should be reviewed or removed.",
				Optional:            true,
				Validators:          []validator.String{stringvalidator.RegexMatches(dateRE, "must be a date in the form YYYY-MM-DD")},
			},
			"owner_id": schema.StringAttribute{
				MarkdownDescription: "Owner (member id, UUID). Defaults to the token's creator.",
				Optional:            true,
				Computed:            true,
				Validators:          []validator.String{stringvalidator.RegexMatches(uuidRE, "must be a UUID")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"archived": schema.BoolAttribute{
				MarkdownDescription: "Archive the flag (removed from every draft). Default `false`.",
				Optional:            true,
				Computed:            true,
				Default:             booldefault.StaticBool(false),
			},
			"archived_at": schema.StringAttribute{
				MarkdownDescription: "When the flag was archived.",
				Computed:            true,
			},
			"created_at": schema.StringAttribute{
				MarkdownDescription: "Creation time.",
				Computed:            true,
				PlanModifiers:       []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *flagResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *flagResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m flagModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	typ := "boolean"
	if m.Type.IsUnknown() {
		return
	}
	if !m.Type.IsNull() {
		typ = m.Type.ValueString()
	}
	if m.InitialValue.IsNull() && typ != "boolean" {
		resp.Diagnostics.AddAttributeError(path.Root("initial_value"), "initial_value required",
			fmt.Sprintf("A %s flag needs initial_value, e.g. %s.", typ, map[string]string{"string": `jsonencode("blue")`, "number": "jsonencode(10)", "json": `jsonencode({ limit = 10 })`}[typ]))
	}
	if !m.InitialValue.IsNull() && !m.InitialValue.IsUnknown() && !valueFitsType(typ, m.InitialValue.ValueString()) {
		resp.Diagnostics.AddAttributeError(path.Root("initial_value"), "initial_value does not match the flag type",
			fmt.Sprintf("A %s flag cannot start with %s.", typ, m.InitialValue.ValueString()))
	}
	if !m.JSONSchema.IsNull() && !m.JSONSchema.IsUnknown() {
		if typ != "json" {
			resp.Diagnostics.AddAttributeError(path.Root("json_schema"), "json_schema needs a json flag", "Only flags of type json have a JSON Schema.")
		} else if jsonKind(m.JSONSchema.ValueString()) != "object" {
			resp.Diagnostics.AddAttributeError(path.Root("json_schema"), "Invalid JSON Schema", "json_schema must be a JSON object.")
		}
	}
}

// ModifyPlan refuses changes to the immutable type and initial value at plan time instead of failing at apply.
func (r *flagResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.State.Raw.IsNull() || req.Plan.Raw.IsNull() {
		return
	}
	var state, plan flagModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if plan.Key.Equal(state.Key) && plan.Project.Equal(state.Project) {
		if !plan.Type.IsUnknown() && !plan.Type.Equal(state.Type) {
			resp.Diagnostics.AddAttributeError(path.Root("type"), "Flag type is immutable",
				fmt.Sprintf("%q is a %s flag and cannot become %s. Create a flag with a new key instead.", state.Key.ValueString(), state.Type.ValueString(), plan.Type.ValueString()))
		}
		if !plan.InitialValue.IsUnknown() && !plan.InitialValue.IsNull() && !state.InitialValue.IsNull() && !jsonEqual(plan.InitialValue.ValueString(), state.InitialValue.ValueString()) {
			resp.Diagnostics.AddAttributeError(path.Root("initial_value"), "initial_value only applies at creation",
				"Change the value served in an environment with nanoflags_flag_environment (default_value / off_value) instead.")
		}
	}
}

func (r *flagResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan flagModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := client.FlagCreate{
		"key":           plan.Key.ValueString(),
		"type":          plan.Type.ValueString(),
		"description":   plan.Description.ValueString(),
		"purpose":       plan.Purpose.ValueString(),
		"permanent":     plan.Permanent.ValueBool(),
		"clientExposed": plan.ClientExposed.ValueBool(),
	}
	if !plan.Name.IsNull() && !plan.Name.IsUnknown() {
		body["name"] = plan.Name.ValueString()
	}
	if v := rawJSON(plan.InitialValue); v != nil {
		body["initialValue"] = v
	}
	if v := rawJSON(plan.JSONSchema); v != nil {
		body["jsonSchema"] = v
	}
	if !plan.ReviewDate.IsNull() && !plan.ReviewDate.IsUnknown() {
		body["reviewDate"] = plan.ReviewDate.ValueString()
	}
	if !plan.OwnerID.IsNull() && !plan.OwnerID.IsUnknown() {
		body["ownerId"] = plan.OwnerID.ValueString()
	}
	f, err := r.c.CreateFlag(ctx, plan.Project.ValueString(), body)
	if err != nil {
		if client.HasCode(err, "CONFLICT") {
			resp.Diagnostics.AddError("Flag key already exists",
				fmt.Sprintf("%s\n\nFlag keys are permanent, archived ones included. Import it: terraform import <address> %s/%s", err, plan.Project.ValueString(), plan.Key.ValueString()))
			return
		}
		addAPIError(&resp.Diagnostics, "Could not create flag", err)
		return
	}
	if plan.Archived.ValueBool() {
		if f, err = r.c.ArchiveFlag(ctx, plan.Project.ValueString(), f.Key); err != nil {
			addAPIError(&resp.Diagnostics, "Flag created but could not be archived", err)
		}
	}
	flagToModel(f, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func flagToModel(f *client.Flag, m *flagModel) {
	m.ID = types.StringValue(f.ID)
	m.Key = types.StringValue(f.Key)
	m.Type = types.StringValue(f.Type)
	m.Name = types.StringValue(f.Name)
	m.Description = types.StringValue(f.Description)
	m.Purpose = types.StringValue(f.Purpose)
	m.Permanent = types.BoolValue(f.Permanent)
	m.ClientExposed = types.BoolValue(f.ClientExposed)
	m.InitialValue = jsonFromAPI(m.InitialValue, f.InitialValue)
	m.JSONSchema = nullableJSONFromAPI(m.JSONSchema, f.JSONSchema)
	m.ReviewDate = strPtrValue(f.ReviewDate)
	m.OwnerID = strPtrValue(f.OwnerID)
	m.Archived = types.BoolValue(f.ArchivedAt != nil)
	m.ArchivedAt = strPtrValue(f.ArchivedAt)
	m.CreatedAt = types.StringValue(f.CreatedAt)
}

func (r *flagResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state flagModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	f, err := r.c.GetFlag(ctx, state.Project.ValueString(), state.Key.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read flag", err)
		return
	}
	flagToModel(f, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *flagResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state flagModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	project, key := plan.Project.ValueString(), state.Key.ValueString()
	body := client.FlagUpdate{}
	if !plan.Name.IsUnknown() && !plan.Name.IsNull() && !plan.Name.Equal(state.Name) {
		body["name"] = plan.Name.ValueString()
	}
	if !plan.Description.Equal(state.Description) {
		body["description"] = plan.Description.ValueString()
	}
	if !plan.Purpose.Equal(state.Purpose) {
		body["purpose"] = plan.Purpose.ValueString()
	}
	if !plan.Permanent.Equal(state.Permanent) {
		body["permanent"] = plan.Permanent.ValueBool()
	}
	if !plan.ClientExposed.Equal(state.ClientExposed) {
		body["clientExposed"] = plan.ClientExposed.ValueBool()
	}
	if !plan.JSONSchema.Equal(state.JSONSchema) {
		if v := rawJSON(plan.JSONSchema); v != nil {
			body["jsonSchema"] = v
		} else {
			body["jsonSchema"] = nil
		}
	}
	if !plan.ReviewDate.Equal(state.ReviewDate) {
		if plan.ReviewDate.IsNull() {
			body["reviewDate"] = nil
		} else {
			body["reviewDate"] = plan.ReviewDate.ValueString()
		}
	}
	if !plan.OwnerID.IsUnknown() && !plan.OwnerID.IsNull() && !plan.OwnerID.Equal(state.OwnerID) {
		body["ownerId"] = plan.OwnerID.ValueString()
	}
	var f *client.Flag
	var err error
	if len(body) > 0 {
		if f, err = r.c.UpdateFlag(ctx, project, key, body); err != nil {
			addAPIError(&resp.Diagnostics, "Could not update flag", err)
			return
		}
	}
	if plan.Archived.ValueBool() != state.Archived.ValueBool() {
		if plan.Archived.ValueBool() {
			f, err = r.c.ArchiveFlag(ctx, project, key)
		} else {
			f, err = r.c.UnarchiveFlag(ctx, project, key)
		}
		if err != nil {
			addAPIError(&resp.Diagnostics, "Could not change the flag's archived state", err)
			return
		}
	}
	if f == nil {
		if f, err = r.c.GetFlag(ctx, project, key); err != nil {
			addAPIError(&resp.Diagnostics, "Could not read flag", err)
			return
		}
	}
	plan.InitialValue = state.InitialValue
	flagToModel(f, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// Delete archives the flag: the Management API has no hard delete.
func (r *flagResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state flagModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() || state.Archived.ValueBool() {
		return
	}
	_, err := r.c.ArchiveFlag(ctx, state.Project.ValueString(), state.Key.ValueString())
	if err != nil && !client.IsNotFound(err) {
		addAPIError(&resp.Diagnostics, "Could not archive flag", err)
	}
}

// ImportState takes "<project>/<flag key>".
func (r *flagResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	parts, ok := splitID(req.ID, 2)
	if !ok {
		resp.Diagnostics.AddError("Invalid import ID", "Use <project key>/<flag key>, e.g. web/new-checkout.")
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project"), parts[0])...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("key"), parts[1])...)
}
