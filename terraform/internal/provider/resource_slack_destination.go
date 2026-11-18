package provider

import (
	"context"
	"regexp"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = &slackResource{}
	_ resource.ResourceWithImportState = &slackResource{}
)

var webhookRE = regexp.MustCompile(`^https://hooks\.slack(-gov)?\.com/.+`)

var slackEvents = []string{"approval.requested", "approval.decided", "publish.completed", "schedule.executed", "schedule.failed",
	"scenario_check.failed", "flag.killed", "promotion.recorded", "webhook.failing", "stale_flags.digest"}

// NewSlackDestinationResource returns nanoflags_slack_destination.
func NewSlackDestinationResource() resource.Resource { return &slackResource{} }

type slackResource struct{ c *client.Client }

type slackModel struct {
	ID           types.String `tfsdk:"id"`
	Name         types.String `tfsdk:"name"`
	WebhookURL   types.String `tfsdk:"webhook_url"`
	Events       types.Set    `tfsdk:"events"`
	Environments types.Set    `tfsdk:"environments"`
	Locale       types.String `tfsdk:"locale"`
	Project      types.String `tfsdk:"project"`
	URLHint      types.String `tfsdk:"url_hint"`
	Enabled      types.Bool   `tfsdk:"enabled"`
	Status       types.String `tfsdk:"status"`
}

// replaceIfKnownBefore replaces the resource when a write-only value changes, but not right after an import (when the
// API could not return the value, so the state holds null).
func replaceIfKnownBefore() planmodifier.String {
	return stringplanmodifier.RequiresReplaceIf(func(_ context.Context, req planmodifier.StringRequest, resp *stringplanmodifier.RequiresReplaceIfFuncResponse) {
		resp.RequiresReplace = !req.StateValue.IsNull()
	}, "Replaces the destination when the webhook URL changes.", "Replaces the destination when the webhook URL changes.")
}

func (r *slackResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_slack_destination"
}

func (r *slackResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		MarkdownDescription: "A chat channel (Incoming Webhook) that receives NanoFlags events such as approval requests and publishes. " +
			"The Management API has no update for destinations, so every change replaces it. The webhook URL is stored as a secret and is " +
			"never returned; only `url_hint` is. Team plan and above, at most 20 per organization, admin role.\n\nScope: `integrations:write`.",
		Attributes: map[string]schema.Attribute{
			"id":   schema.StringAttribute{Computed: true, MarkdownDescription: "Destination id (UUID).", PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "1–80 characters, e.g. the channel name.", Validators: []validator.String{stringvalidator.LengthBetween(1, 80)}, PlanModifiers: replace},
			"webhook_url": schema.StringAttribute{
				Required:            true,
				Sensitive:           true,
				MarkdownDescription: "Incoming Webhook URL (`https://hooks.slack.com/services/…` or `https://hooks.slack-gov.com/…`). Write-only: never read back.",
				Validators:          []validator.String{stringvalidator.RegexMatches(webhookRE, "must be an Incoming Webhook URL on hooks.slack.com or hooks.slack-gov.com")},
				PlanModifiers:       []planmodifier.String{replaceIfKnownBefore()},
			},
			"events": schema.SetAttribute{
				Required:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Events to deliver (1–20): `" + strings.Join(slackEvents, "`, `") + "`.",
				Validators:          []validator.Set{setvalidator.SizeBetween(1, 20), setvalidator.ValueStringsAre(stringvalidator.OneOf(slackEvents...))},
				PlanModifiers:       []planmodifier.Set{setplanmodifier.RequiresReplace()},
			},
			"environments": schema.SetAttribute{
				Optional:            true,
				Computed:            true,
				ElementType:         types.StringType,
				MarkdownDescription: "Environment keys that environment-bound events are limited to (at most 20). Empty or omitted: every environment.",
				Validators:          []validator.Set{setvalidator.SizeAtMost(20)},
				PlanModifiers:       []planmodifier.Set{setplanmodifier.RequiresReplace(), setplanmodifier.UseStateForUnknown()},
			},
			"locale": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Message language: `en` or `ar`. Omitted: the organization's default.",
				Validators:          []validator.String{stringvalidator.OneOf("en", "ar")},
				PlanModifiers:       replace,
			},
			"project": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Project key. Set: only that project's events. Omitted: organization-wide (organization tokens only).",
				PlanModifiers:       replace,
			},
			"url_hint": schema.StringAttribute{Computed: true, MarkdownDescription: "Host and last 4 characters of the URL.", PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"enabled":  schema.BoolAttribute{Computed: true, MarkdownDescription: "Whether deliveries are on."},
			"status":   schema.StringAttribute{Computed: true, MarkdownDescription: "`ok`, or `failing` after 3 consecutive failed deliveries."},
		},
	}
}

func (r *slackResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.c = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *slackResource) toModel(ctx context.Context, d *client.SlackDestination, m *slackModel) {
	m.ID = types.StringValue(d.ID)
	m.Name = types.StringValue(d.Name)
	m.Events, _ = types.SetValueFrom(ctx, types.StringType, d.Events)
	envs := d.Environments
	if envs == nil {
		envs = []string{}
	}
	m.Environments, _ = types.SetValueFrom(ctx, types.StringType, envs)
	m.Locale = strPtrValue(d.Locale)
	if d.ProjectKey != nil {
		if m.Project.IsNull() || (m.Project.ValueString() != *d.ProjectKey && (d.ProjectID == nil || m.Project.ValueString() != *d.ProjectID)) {
			m.Project = types.StringValue(*d.ProjectKey)
		}
	} else {
		m.Project = types.StringNull()
	}
	m.URLHint = types.StringValue(d.URLHint)
	m.Enabled = types.BoolValue(d.Enabled)
	m.Status = types.StringValue(d.Status)
}

func (r *slackResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan slackModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := client.SlackDestinationCreate{Name: plan.Name.ValueString(), WebhookURL: plan.WebhookURL.ValueString(), Locale: plan.Locale.ValueString(), Project: plan.Project.ValueString()}
	resp.Diagnostics.Append(plan.Events.ElementsAs(ctx, &body.Events, false)...)
	if !plan.Environments.IsNull() && !plan.Environments.IsUnknown() {
		resp.Diagnostics.Append(plan.Environments.ElementsAs(ctx, &body.Environments, false)...)
	}
	if body.Project != "" {
		body.Scope = "project"
	} else {
		body.Scope = "organization"
	}
	if resp.Diagnostics.HasError() {
		return
	}
	d, err := r.c.CreateSlackDestination(ctx, body)
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not add the destination", err)
		return
	}
	r.toModel(ctx, d, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *slackResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state slackModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	list, err := r.c.ListSlackDestinations(ctx, state.Project.ValueString())
	if err != nil {
		addAPIError(&resp.Diagnostics, "Could not list destinations", err)
		return
	}
	for i := range list {
		if list[i].ID == state.ID.ValueString() {
			r.toModel(ctx, &list[i], &state)
			resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
			return
		}
	}
	resp.State.RemoveResource(ctx)
}

// Update is never called with a change (every argument replaces), but the framework requires it.
func (r *slackResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan slackModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *slackResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state slackModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.c.DeleteSlackDestination(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		addAPIError(&resp.Diagnostics, "Could not remove the destination", err)
	}
}

// ImportState takes the destination id. webhook_url cannot be imported (the API never returns it).
func (r *slackResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
