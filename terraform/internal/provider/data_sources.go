package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/nanoflags/terraform-provider-nanoflags/internal/client"
)

type baseDataSource struct{ c *client.Client }

func (d *baseDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.c = clientFrom(req.ProviderData, &resp.Diagnostics)
}

// --- nanoflags_project ---------------------------------------------------------------------------------------------

// NewProjectDataSource returns nanoflags_project.
func NewProjectDataSource() datasource.DataSource { return &projectDataSource{} }

type projectDataSource struct{ baseDataSource }

type projectDSModel struct {
	ID                 types.String `tfsdk:"id"`
	Key                types.String `tfsdk:"key"`
	Name               types.String `tfsdk:"name"`
	Timezone           types.String `tfsdk:"timezone"`
	DefaultEnvironment types.String `tfsdk:"default_environment"`
	CreatedAt          types.String `tfsdk:"created_at"`
}

func (d *projectDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (d *projectDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Reads a project. Projects are created in the dashboard; the Management API reads them. Any valid token.",
		Attributes: map[string]schema.Attribute{
			"key":                 schema.StringAttribute{Required: true, MarkdownDescription: "Project key or id."},
			"id":                  schema.StringAttribute{Computed: true, MarkdownDescription: "Project id (UUID)."},
			"name":                schema.StringAttribute{Computed: true, MarkdownDescription: "Display name."},
			"timezone":            schema.StringAttribute{Computed: true, MarkdownDescription: "Project time zone (IANA)."},
			"default_environment": schema.StringAttribute{Computed: true, MarkdownDescription: "Key of the default environment."},
			"created_at":          schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time."},
		},
	}
}

func (d *projectDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m projectDSModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	p, err := d.c.GetProject(ctx, m.Key.ValueString())
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read project", err)
		return
	}
	m = projectDSModel{ID: types.StringValue(p.ID), Key: types.StringValue(p.Key), Name: types.StringValue(p.Name), Timezone: types.StringValue(p.Timezone),
		DefaultEnvironment: types.StringValue(p.DefaultEnvironment), CreatedAt: types.StringValue(p.CreatedAt)}
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// --- nanoflags_environment / nanoflags_environments ------------------------------------------------------------------

type environmentDSModel struct {
	ID                types.String `tfsdk:"id"`
	Key               types.String `tfsdk:"key"`
	Name              types.String `tfsdk:"name"`
	Sort              types.Int64  `tfsdk:"sort"`
	IsProtected       types.Bool   `tfsdk:"is_protected"`
	RequireApproval   types.Bool   `tfsdk:"require_approval"`
	RequiredApprovers types.Int64  `tfsdk:"required_approvers"`
	RequireScenarios  types.Bool   `tfsdk:"require_scenarios"`
	PublishedRevision types.Int64  `tfsdk:"published_revision"`
	PublishedChecksum types.String `tfsdk:"published_checksum"`
	PublishedAt       types.String `tfsdk:"published_at"`
}

func environmentToDS(e *client.Environment) environmentDSModel {
	return environmentDSModel{ID: types.StringValue(e.ID), Key: types.StringValue(e.Key), Name: types.StringValue(e.Name), Sort: types.Int64Value(e.Sort),
		IsProtected: types.BoolValue(e.IsProtected), RequireApproval: types.BoolValue(e.RequireApproval), RequiredApprovers: types.Int64Value(e.RequiredApprovers),
		RequireScenarios: types.BoolValue(e.RequireScenarios), PublishedRevision: types.Int64Value(e.PublishedRevision),
		PublishedChecksum: strPtrValue(e.PublishedChecksum), PublishedAt: strPtrValue(e.PublishedAt)}
}

func environmentAttrs(keyRequired bool) map[string]schema.Attribute {
	return map[string]schema.Attribute{
		"key":                schema.StringAttribute{Required: keyRequired, Computed: !keyRequired, MarkdownDescription: "Environment key (or id when looking one up)."},
		"id":                 schema.StringAttribute{Computed: true, MarkdownDescription: "Environment id (UUID)."},
		"name":               schema.StringAttribute{Computed: true, MarkdownDescription: "Display name."},
		"sort":               schema.Int64Attribute{Computed: true, MarkdownDescription: "Position in the dashboard."},
		"is_protected":       schema.BoolAttribute{Computed: true, MarkdownDescription: "Protected environment."},
		"require_approval":   schema.BoolAttribute{Computed: true, MarkdownDescription: "Publishing needs an approved change."},
		"required_approvers": schema.Int64Attribute{Computed: true, MarkdownDescription: "Independent approvals needed."},
		"require_scenarios":  schema.BoolAttribute{Computed: true, MarkdownDescription: "Publishing needs passing scenario checks."},
		"published_revision": schema.Int64Attribute{Computed: true, MarkdownDescription: "Published revision (0 when nothing was published)."},
		"published_checksum": schema.StringAttribute{Computed: true, MarkdownDescription: "Checksum of the published revision."},
		"published_at":       schema.StringAttribute{Computed: true, MarkdownDescription: "Time of the last publish."},
	}
}

// NewEnvironmentDataSource returns nanoflags_environment.
func NewEnvironmentDataSource() datasource.DataSource { return &environmentDataSource{} }

type environmentDataSource struct{ baseDataSource }

type environmentOneModel struct {
	Project types.String `tfsdk:"project"`
	environmentDSModel
}

func (d *environmentDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environment"
}

func (d *environmentDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	attrs := environmentAttrs(true)
	attrs["project"] = schema.StringAttribute{Required: true, MarkdownDescription: "Project key or id."}
	resp.Schema = schema.Schema{MarkdownDescription: "Reads one environment of a project, including its publishing policy and published revision. Environments are created in the dashboard. Any valid token.", Attributes: attrs}
}

func (d *environmentDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m environmentOneModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	e, err := d.c.GetEnvironment(ctx, m.Project.ValueString(), m.Key.ValueString())
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read environment", err)
		return
	}
	m.environmentDSModel = environmentToDS(e)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// NewEnvironmentsDataSource returns nanoflags_environments.
func NewEnvironmentsDataSource() datasource.DataSource { return &environmentsDataSource{} }

type environmentsDataSource struct{ baseDataSource }

type environmentsModel struct {
	Project      types.String         `tfsdk:"project"`
	Keys         types.List           `tfsdk:"keys"`
	Environments []environmentDSModel `tfsdk:"environments"`
}

func (d *environmentsDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_environments"
}

func (d *environmentsDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Lists a project's environments in dashboard order, e.g. to configure a flag in every environment with `for_each`. Any valid token.",
		Attributes: map[string]schema.Attribute{
			"project":      schema.StringAttribute{Required: true, MarkdownDescription: "Project key or id."},
			"keys":         schema.ListAttribute{Computed: true, ElementType: types.StringType, MarkdownDescription: "Environment keys in order."},
			"environments": schema.ListNestedAttribute{Computed: true, MarkdownDescription: "The environments.", NestedObject: schema.NestedAttributeObject{Attributes: environmentAttrs(false)}},
		},
	}
}

func (d *environmentsDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m environmentsModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	list, err := d.c.ListEnvironments(ctx, m.Project.ValueString())
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not list environments", err)
		return
	}
	keys := make([]attr.Value, 0, len(list))
	m.Environments = make([]environmentDSModel, 0, len(list))
	for i := range list {
		keys = append(keys, types.StringValue(list[i].Key))
		m.Environments = append(m.Environments, environmentToDS(&list[i]))
	}
	m.Keys = types.ListValueMust(types.StringType, keys)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// --- nanoflags_flag -----------------------------------------------------------------------------------------------

// NewFlagDataSource returns nanoflags_flag.
func NewFlagDataSource() datasource.DataSource { return &flagDataSource{} }

type flagDataSource struct{ baseDataSource }

func (d *flagDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_flag"
}

func (d *flagDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	c := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, MarkdownDescription: desc}
	}
	resp.Schema = schema.Schema{
		MarkdownDescription: "Reads a flag's details (archived flags included). Scope: `flags:read`.",
		Attributes: map[string]schema.Attribute{
			"project":        schema.StringAttribute{Required: true, MarkdownDescription: "Project key or id."},
			"key":            schema.StringAttribute{Required: true, MarkdownDescription: "Flag key."},
			"id":             c("Flag id (UUID)."),
			"type":           c("`boolean`, `string`, `number` or `json`."),
			"name":           c("Display name."),
			"description":    c("Description."),
			"purpose":        c("`release`, `experiment`, `operational` or `permission`."),
			"permanent":      schema.BoolAttribute{Computed: true, MarkdownDescription: "Meant to stay in code."},
			"client_exposed": schema.BoolAttribute{Computed: true, MarkdownDescription: "Served to browser and mobile keys."},
			"initial_value":  c("JSON-encoded initial value."),
			"json_schema":    c("JSON-encoded JSON Schema of a json flag."),
			"review_date":    c("Review date."),
			"owner_id":       c("Owner member id."),
			"archived":       schema.BoolAttribute{Computed: true, MarkdownDescription: "Whether the flag is archived."},
			"archived_at":    c("Archive time."),
			"created_at":     c("Creation time."),
		},
	}
}

func (d *flagDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m flagModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	f, err := d.c.GetFlag(ctx, m.Project.ValueString(), m.Key.ValueString())
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not read flag", err)
		return
	}
	flagToModel(f, &m)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

// --- nanoflags_sdk_keys -------------------------------------------------------------------------------------------

// NewSdkKeysDataSource returns nanoflags_sdk_keys.
func NewSdkKeysDataSource() datasource.DataSource { return &sdkKeysDataSource{} }

type sdkKeysDataSource struct{ baseDataSource }

type sdkKeyModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Kind        types.String `tfsdk:"kind"`
	Prefix      types.String `tfsdk:"prefix"`
	Environment types.String `tfsdk:"environment"`
	CreatedAt   types.String `tfsdk:"created_at"`
	LastUsedAt  types.String `tfsdk:"last_used_at"`
	RevokedAt   types.String `tfsdk:"revoked_at"`
}

type sdkKeysModel struct {
	Project        types.String  `tfsdk:"project"`
	Environment    types.String  `tfsdk:"environment"`
	IncludeRevoked types.Bool    `tfsdk:"include_revoked"`
	Keys           []sdkKeyModel `tfsdk:"keys"`
}

func (d *sdkKeysDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_sdk_keys"
}

func (d *sdkKeysDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	c := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, MarkdownDescription: desc}
	}
	resp.Schema = schema.Schema{
		MarkdownDescription: "Lists SDK key **metadata** (name, kind, prefix, usage). The Management API never returns key material, and SDK keys " +
			"are created and revoked in the dashboard, so there is no SDK key resource. Admin role, scope `keys:read`.",
		Attributes: map[string]schema.Attribute{
			"project":         schema.StringAttribute{Required: true, MarkdownDescription: "Project key or id."},
			"environment":     schema.StringAttribute{Optional: true, MarkdownDescription: "Environment key or id. Omitted: every environment."},
			"include_revoked": schema.BoolAttribute{Optional: true, MarkdownDescription: "Include revoked keys. Default `false`."},
			"keys": schema.ListNestedAttribute{Computed: true, MarkdownDescription: "The keys.", NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
				"id": c("Key id."), "name": c("Name."), "kind": c("`client`, `server`, `ci` or `admin`."), "prefix": c("First characters of the key, safe to display."),
				"environment": c("Environment key."), "created_at": c("Creation time."), "last_used_at": c("Last use."), "revoked_at": c("Revocation time."),
			}}},
		},
	}
}

func (d *sdkKeysDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m sdkKeysModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	list, err := d.c.ListSdkKeys(ctx, m.Project.ValueString(), m.Environment.ValueString(), m.IncludeRevoked.ValueBool())
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not list SDK keys", err)
		return
	}
	m.Keys = make([]sdkKeyModel, 0, len(list))
	for _, k := range list {
		m.Keys = append(m.Keys, sdkKeyModel{ID: types.StringValue(k.ID), Name: types.StringValue(k.Name), Kind: types.StringValue(k.Kind), Prefix: types.StringValue(k.Prefix),
			Environment: types.StringValue(k.Environment), CreatedAt: types.StringValue(k.CreatedAt), LastUsedAt: strPtrValue(k.LastUsedAt), RevokedAt: strPtrValue(k.RevokedAt)})
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}
