// Package provider implements the NanoFlags Terraform provider on terraform-plugin-framework.
package provider

import (
	"context"
	"os"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/nanoflags/terraform-provider-nanoflags/internal/client"
)

// apiTokenRE is the shape of a Management API token (the same check as the NanoFlags CLI).
var apiTokenRE = regexp.MustCompile(`^nf_api_[0-9a-f]{48}$`)

// New returns the provider factory.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &nanoflagsProvider{version: version} }
}

type nanoflagsProvider struct {
	version string
}

type providerModel struct {
	APIToken types.String `tfsdk:"api_token"`
	BaseURL  types.String `tfsdk:"base_url"`
}

func (p *nanoflagsProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "nanoflags"
	resp.Version = p.version
}

func (p *nanoflagsProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manage NanoFlags flags, per-environment targeting, segments and publishing through the " +
			"NanoFlags Management API. Authenticate with a Management API token (`nf_api_…`) created by an organization " +
			"owner or admin under **Settings → API tokens**.",
		Attributes: map[string]schema.Attribute{
			"api_token": schema.StringAttribute{
				MarkdownDescription: "Management API token (`nf_api_…`). Defaults to the `NANOFLAGS_API_TOKEN` environment variable. " +
					"Scopes needed: `flags:read`/`flags:write` for flags and their environment configuration, `segments:read`/`segments:write` " +
					"for segments, `publish` for `nanoflags_environment_publish`, `keys:read` for `nanoflags_sdk_keys`, `integrations:write` " +
					"for `nanoflags_slack_destination`.",
				Optional:  true,
				Sensitive: true,
			},
			"base_url": schema.StringAttribute{
				MarkdownDescription: "NanoFlags edge URL. Defaults to the `NANOFLAGS_BASE_URL` environment variable, then `" + client.DefaultBaseURL + "`. The Management API is served under `/api/v1`.",
				Optional:            true,
			},
		},
	}
}

func (p *nanoflagsProvider) ValidateConfig(ctx context.Context, req provider.ValidateConfigRequest, resp *provider.ValidateConfigResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if !cfg.APIToken.IsNull() && !cfg.APIToken.IsUnknown() && !apiTokenRE.MatchString(cfg.APIToken.ValueString()) {
		resp.Diagnostics.AddAttributeError(path.Root("api_token"), "Invalid API token",
			"The Management API token must look like nf_api_<48 hex characters>. SDK keys (nf_srv_, nf_pub_) and CI or admin keys cannot use the Management API.")
	}
	if !cfg.BaseURL.IsNull() && !cfg.BaseURL.IsUnknown() {
		u := cfg.BaseURL.ValueString()
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			resp.Diagnostics.AddAttributeError(path.Root("base_url"), "Invalid base URL", "base_url must start with https:// (or http:// for a local edge).")
		}
	}
}

func (p *nanoflagsProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if cfg.APIToken.IsUnknown() || cfg.BaseURL.IsUnknown() {
		resp.Diagnostics.AddWarning("Provider configuration not known yet",
			"api_token or base_url depends on values known only after apply; NanoFlags resources cannot be planned until then.")
		return
	}
	token := strings.TrimSpace(os.Getenv("NANOFLAGS_API_TOKEN"))
	if !cfg.APIToken.IsNull() {
		token = cfg.APIToken.ValueString()
	}
	base := strings.TrimSpace(os.Getenv("NANOFLAGS_BASE_URL"))
	if !cfg.BaseURL.IsNull() {
		base = cfg.BaseURL.ValueString()
	}
	if token == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_token"), "Missing NanoFlags API token",
			"Set api_token in the provider block or the NANOFLAGS_API_TOKEN environment variable to a Management API token (nf_api_…). Create one in the dashboard under Settings → API tokens.")
		return
	}
	if !apiTokenRE.MatchString(token) {
		resp.Diagnostics.AddAttributeError(path.Root("api_token"), "Invalid API token",
			"The Management API token must look like nf_api_<48 hex characters>. SDK keys (nf_srv_, nf_pub_) and CI or admin keys cannot use the Management API.")
		return
	}
	c := client.New(base, token, "terraform-provider-nanoflags/"+p.version)
	resp.DataSourceData = c
	resp.ResourceData = c
}

func (p *nanoflagsProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewFlagResource,
		NewFlagEnvironmentResource,
		NewSegmentResource,
		NewEnvironmentPublishResource,
		NewSlackDestinationResource,
	}
}

func (p *nanoflagsProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewProjectDataSource,
		NewEnvironmentDataSource,
		NewEnvironmentsDataSource,
		NewFlagDataSource,
		NewSdkKeysDataSource,
	}
}
