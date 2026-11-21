package provider

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	tfresource "github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/nanoflags/terraform-provider-nanoflags/internal/fakeapi"
)

var protoV6 = map[string]func() (tfprotov6.ProviderServer, error){
	"nanoflags": providerserver.NewProtocol6WithError(New("test")()),
}

// needTerraform skips tests that drive the Terraform CLI when no binary is available (CI installs one).
func needTerraform(t *testing.T) {
	t.Helper()
	if os.Getenv("TF_ACC_TERRAFORM_PATH") != "" {
		return
	}
	if _, err := exec.LookPath("terraform"); err != nil {
		t.Skip("terraform CLI not found: install it or set TF_ACC_TERRAFORM_PATH to run the provider tests against the fake API")
	}
}

func fake(t *testing.T) *fakeapi.Server {
	t.Helper()
	f := fakeapi.New()
	t.Cleanup(f.Close)
	return f
}

func providerBlock(f *fakeapi.Server) string {
	return fmt.Sprintf("provider \"nanoflags\" {\n  base_url  = %q\n  api_token = %q\n}\n", f.URL, fakeapi.Token)
}

func TestSchemasAreValid(t *testing.T) {
	ctx := context.Background()
	p := New("test")()
	var presp provider.SchemaResponse
	p.Schema(ctx, provider.SchemaRequest{}, &presp)
	if presp.Diagnostics.HasError() {
		t.Fatal(presp.Diagnostics)
	}
	for _, f := range p.Resources(ctx) {
		r := f()
		var md resource.MetadataResponse
		r.Metadata(ctx, resource.MetadataRequest{ProviderTypeName: "nanoflags"}, &md)
		var sr resource.SchemaResponse
		r.Schema(ctx, resource.SchemaRequest{}, &sr)
		if d := sr.Schema.ValidateImplementation(ctx); d.HasError() || sr.Diagnostics.HasError() {
			t.Errorf("%s: %v %v", md.TypeName, d, sr.Diagnostics)
		}
	}
	for _, f := range p.DataSources(ctx) {
		d := f()
		var md datasource.MetadataResponse
		d.Metadata(ctx, datasource.MetadataRequest{ProviderTypeName: "nanoflags"}, &md)
		var sr datasource.SchemaResponse
		d.Schema(ctx, datasource.SchemaRequest{}, &sr)
		if diags := sr.Schema.ValidateImplementation(ctx); diags.HasError() {
			t.Errorf("%s: %v", md.TypeName, diags)
		}
	}
}

func TestJSONHelpers(t *testing.T) {
	cases := []struct {
		a, b string
		eq   bool
	}{
		{`{"a":1,"b":[true]}`, `{ "b": [true], "a": 1.0 }`, true},
		{`"x"`, `"y"`, false},
		{`null`, `null`, true},
		{`[1,2]`, `[2,1]`, false},
	}
	for _, c := range cases {
		if jsonEqual(c.a, c.b) != c.eq {
			t.Errorf("jsonEqual(%s, %s) != %v", c.a, c.b, c.eq)
		}
	}
	if got := compactJSON([]byte(`{ "b": 1, "a": [ "x" ] }`)); got != `{"a":["x"],"b":1}` {
		t.Errorf("compactJSON = %s", got)
	}
	for typ, ok := range map[string]map[string]bool{
		"boolean": {"true": true, `"true"`: false},
		"string":  {`"blue"`: true, "1": false},
		"number":  {"1.5": true, "false": false},
		"json":    {`{"a":1}`: true, "[]": true},
	} {
		for v, want := range ok {
			if valueFitsType(typ, v) != want {
				t.Errorf("valueFitsType(%s, %s) != %v", typ, v, want)
			}
		}
	}
}

func TestProviderRejectsBadToken(t *testing.T) {
	needTerraform(t)
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{{
			Config: `
provider "nanoflags" {
  api_token = "nf_srv_not_a_management_token"
}
data "nanoflags_project" "web" { key = "web" }
`,
			ExpectError: regexp.MustCompile(`Invalid API token`),
		}},
	})
}

func TestFlagResourceLifecycle(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{
			{
				Config: providerBlock(f) + `
resource "nanoflags_flag" "checkout" {
  project        = "web"
  key            = "new-checkout"
  name           = "New checkout"
  description    = "Rebuilt checkout flow"
  client_exposed = true
  review_date    = "2027-03-01"
}
resource "nanoflags_flag" "accent" {
  project       = "web"
  key           = "accent-color"
  type          = "string"
  initial_value = jsonencode("blue")
  purpose       = "experiment"
}
`,
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttr("nanoflags_flag.checkout", "type", "boolean"),
					tfresource.TestCheckResourceAttr("nanoflags_flag.checkout", "initial_value", "false"),
					tfresource.TestCheckResourceAttr("nanoflags_flag.checkout", "client_exposed", "true"),
					tfresource.TestCheckResourceAttr("nanoflags_flag.checkout", "archived", "false"),
					tfresource.TestCheckResourceAttrSet("nanoflags_flag.checkout", "id"),
					tfresource.TestCheckResourceAttr("nanoflags_flag.accent", "initial_value", `"blue"`),
					tfresource.TestCheckResourceAttr("nanoflags_flag.accent", "name", "accent-color"),
					func(*terraform.State) error {
						if fl := f.Flag("web", "new-checkout"); fl == nil || fl["description"] != "Rebuilt checkout flow" {
							return fmt.Errorf("flag not stored: %v", fl)
						}
						return nil
					},
				),
			},
			{
				ResourceName:                         "nanoflags_flag.checkout",
				ImportState:                          true,
				ImportStateId:                        "web/new-checkout",
				ImportStateVerify:                    true,
				ImportStateVerifyIdentifierAttribute: "id",
			},
			{
				Config: providerBlock(f) + `
resource "nanoflags_flag" "checkout" {
  project        = "web"
  key            = "new-checkout"
  name           = "New checkout"
  description    = "Rolled out"
  client_exposed = false
  archived       = true
}
resource "nanoflags_flag" "accent" {
  project       = "web"
  key           = "accent-color"
  type          = "string"
  initial_value = jsonencode("blue")
  purpose       = "experiment"
}
`,
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttr("nanoflags_flag.checkout", "description", "Rolled out"),
					tfresource.TestCheckResourceAttr("nanoflags_flag.checkout", "archived", "true"),
					tfresource.TestCheckResourceAttrSet("nanoflags_flag.checkout", "archived_at"),
					tfresource.TestCheckNoResourceAttr("nanoflags_flag.checkout", "review_date"),
				),
			},
		},
		CheckDestroy: func(*terraform.State) error {
			if fl := f.Flag("web", "accent-color"); fl == nil || fl["archivedAt"] == nil {
				return fmt.Errorf("destroy should archive the flag, got %v", fl)
			}
			return nil
		},
	})
}

func TestFlagResourceDetectsDrift(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	cfg := providerBlock(f) + `
resource "nanoflags_flag" "x" {
  project = "web"
  key     = "drift"
}
`
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{
			{Config: cfg},
			{
				PreConfig:          func() { f.SetFlagField("web", "drift", "clientExposed", true) },
				Config:             cfg,
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{Config: cfg, Check: func(*terraform.State) error {
				if f.Flag("web", "drift")["clientExposed"] != false {
					return fmt.Errorf("drift not corrected")
				}
				return nil
			}},
		},
	})
}

func TestPlanTimeValidation(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	cases := map[string]struct{ cfg, err string }{
		"bad key": {`resource "nanoflags_flag" "x" {
  project = "web"
  key     = "Bad Key"
}`, `Flag keys are 1`},
		"string flag needs initial value": {`resource "nanoflags_flag" "x" {
  project = "web"
  key     = "s"
  type    = "string"
}`, `initial_value required`},
		"initial value type": {`resource "nanoflags_flag" "x" {
  project       = "web"
  key           = "n"
  type          = "number"
  initial_value = jsonencode("ten")
}`, `does not match the flag type`},
		"not json": {`resource "nanoflags_flag" "x" {
  project       = "web"
  key           = "n"
  initial_value = "yes"
}`, `Invalid JSON`},
		"rule with two serves": {`resource "nanoflags_flag_environment" "x" {
  project     = "web"
  flag        = "f"
  environment = "development"
  rule {
    id    = "r"
    value = jsonencode(true)
    rollout {
      percentage = 10
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
    }
  }
}`, `Rule needs exactly one serve`},
		"duplicate rule ids": {`resource "nanoflags_flag_environment" "x" {
  project     = "web"
  flag        = "f"
  environment = "development"
  rule {
    id    = "r"
    value = jsonencode(true)
  }
  rule {
    id    = "r"
    value = jsonencode(false)
  }
}`, `Duplicate rule id`},
		"rollout percentage": {`resource "nanoflags_flag_environment" "x" {
  project     = "web"
  flag        = "f"
  environment = "development"
  rule {
    id = "r"
    rollout {
      percentage = 12.345
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
    }
  }
}`, `Too many decimals`},
		"in needs a list": {`resource "nanoflags_segment" "x" {
  project = "web"
  key     = "pro"
  condition {
    attribute = "plan"
    op        = "in"
    value     = jsonencode("pro")
  }
}`, `List required`},
		"webhook host": {`resource "nanoflags_slack_destination" "x" {
  name        = "#releases"
  webhook_url = "https://example.com/hook"
  events      = ["publish.completed"]
}`, `Incoming Webhook URL`},
		"unknown event": {`resource "nanoflags_slack_destination" "x" {
  name        = "#releases"
  webhook_url = "https://hooks.slack.com/services/T/B/x"
  events      = ["flag.created"]
}`, `value must be one of`},
		"unknown operator": {`resource "nanoflags_segment" "x" {
  project = "web"
  key     = "pro"
  condition {
    attribute = "plan"
    op        = "matches"
    value     = jsonencode("pro")
  }
}`, `value must be one of`},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			tfresource.UnitTest(t, tfresource.TestCase{
				ProtoV6ProviderFactories: protoV6,
				Steps:                    []tfresource.TestStep{{Config: providerBlock(f) + c.cfg, PlanOnly: true, ExpectError: regexp.MustCompile(c.err)}},
			})
		})
	}
}

func TestFlagTypeIsImmutable(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{
			{Config: providerBlock(f) + `
resource "nanoflags_flag" "x" {
  project = "web"
  key     = "t"
}`},
			{Config: providerBlock(f) + `
resource "nanoflags_flag" "x" {
  project       = "web"
  key           = "t"
  type          = "string"
  initial_value = jsonencode("a")
}`, ExpectError: regexp.MustCompile(`Flag type is immutable`)},
		},
	})
}

const targetingConfig = `
resource "nanoflags_segment" "pro" {
  project     = "web"
  key         = "pro-customers"
  name        = "Pro customers"
  description = "Paying customers on Pro or Team"
  condition {
    attribute = "plan"
    op        = "in"
    value     = jsonencode(["pro", "team"])
  }
}

resource "nanoflags_flag" "checkout" {
  project = "web"
  key     = "new-checkout"
}

resource "nanoflags_flag_environment" "dev" {
  project       = "web"
  flag          = nanoflags_flag.checkout.key
  environment   = "development"
  enabled       = true
  default_value = jsonencode(false)

  rule {
    id          = "pro"
    description = "Pro customers first"
    condition {
      op    = "segment"
      value = jsonencode(nanoflags_segment.pro.key)
    }
    value = jsonencode(true)
  }

  rule {
    id    = "gradual"
    match = "any"
    condition {
      attribute = "country"
      op        = "eq"
      value     = jsonencode("SA")
    }
    condition {
      attribute = "beta"
      op        = "exists"
    }
    rollout {
      percentage = %s
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
      bucket_by  = "accountId"
    }
  }
}

resource "nanoflags_environment_publish" "dev" {
  project     = "web"
  environment = "development"
  note        = "terraform"
  triggers = {
    config = sha1(jsonencode([nanoflags_flag_environment.dev, nanoflags_segment.pro]))
  }
}
`

func TestTargetingAndPublish(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{
			{
				Config: providerBlock(f) + fmt.Sprintf(targetingConfig, "25"),
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "enabled", "true"),
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "off_value", "false"),
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "rule.#", "2"),
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "rule.0.match", "all"),
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "rule.0.condition.0.attribute", ""),
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "rule.1.rollout.percentage", "25"),
					tfresource.TestCheckResourceAttr("nanoflags_segment.pro", "condition.0.value", `["pro","team"]`),
					tfresource.TestCheckResourceAttr("nanoflags_environment_publish.dev", "revision", "1"),
					func(*terraform.State) error {
						if r := f.PublishedRevision("web", "development"); r != 1 {
							return fmt.Errorf("published revision %d", r)
						}
						if r := f.PublishedRevision("web", "production"); r != 0 {
							return fmt.Errorf("production must stay unpublished, got %d", r)
						}
						if !regexp.MustCompile(`"bucketBy":"accountId"`).MatchString(f.Config("web", "new-checkout", "development")) {
							return fmt.Errorf("rollout not stored: %s", f.Config("web", "new-checkout", "development"))
						}
						return nil
					},
				),
			},
			{
				ResourceName:                         "nanoflags_flag_environment.dev",
				ImportState:                          true,
				ImportStateId:                        "web/new-checkout/development",
				ImportStateVerify:                    true,
				ImportStateVerifyIdentifierAttribute: "id",
			},
			{
				ResourceName:                         "nanoflags_segment.pro",
				ImportState:                          true,
				ImportStateId:                        "web/pro-customers",
				ImportStateVerify:                    true,
				ImportStateVerifyIdentifierAttribute: "id",
			},
			{
				Config: providerBlock(f) + fmt.Sprintf(targetingConfig, "50"),
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttr("nanoflags_flag_environment.dev", "rule.1.rollout.percentage", "50"),
					tfresource.TestCheckResourceAttr("nanoflags_environment_publish.dev", "revision", "2"),
				),
			},
			{
				// Draft edited outside Terraform (a segment added in the dashboard): the plan publishes it.
				PreConfig: func() { f.AddSegment("web", "added-in-dashboard") },
				Config:    providerBlock(f) + fmt.Sprintf(targetingConfig, "50"),
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttr("nanoflags_environment_publish.dev", "revision", "3"),
				),
			},
		},
		CheckDestroy: func(*terraform.State) error {
			if f.Segment("web", "pro-customers") != nil || f.Segment("web", "added-in-dashboard") == nil {
				return fmt.Errorf("segment not deleted")
			}
			return nil
		},
	})
}

func TestDataSources(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{{
			Config: providerBlock(f) + `
resource "nanoflags_flag" "x" {
  project = "web"
  key     = "ds-flag"
  name    = "Data source flag"
}
data "nanoflags_project" "web" { key = "web" }
data "nanoflags_environments" "all" { project = data.nanoflags_project.web.key }
data "nanoflags_environment" "prod" {
  project = "web"
  key     = "production"
}
data "nanoflags_flag" "x" {
  project = "web"
  key     = nanoflags_flag.x.key
}
data "nanoflags_sdk_keys" "dev" {
  project     = "web"
  environment = "development"
}
`,
			Check: tfresource.ComposeAggregateTestCheckFunc(
				tfresource.TestCheckResourceAttr("data.nanoflags_project.web", "name", "Web app"),
				tfresource.TestCheckResourceAttr("data.nanoflags_project.web", "default_environment", "development"),
				tfresource.TestCheckResourceAttr("data.nanoflags_environments.all", "keys.#", "2"),
				tfresource.TestCheckResourceAttr("data.nanoflags_environments.all", "keys.1", "production"),
				tfresource.TestCheckResourceAttr("data.nanoflags_environment.prod", "is_protected", "true"),
				tfresource.TestCheckResourceAttr("data.nanoflags_environment.prod", "published_revision", "0"),
				tfresource.TestCheckResourceAttr("data.nanoflags_flag.x", "name", "Data source flag"),
				tfresource.TestCheckResourceAttr("data.nanoflags_flag.x", "type", "boolean"),
				tfresource.TestCheckResourceAttr("data.nanoflags_sdk_keys.dev", "keys.#", "1"),
				tfresource.TestCheckResourceAttr("data.nanoflags_sdk_keys.dev", "keys.0.kind", "server"),
			),
		}},
	})
}

func TestSlackDestination(t *testing.T) {
	needTerraform(t)
	f := fake(t)
	tfresource.UnitTest(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{
			{
				Config: providerBlock(f) + `
resource "nanoflags_slack_destination" "releases" {
  name        = "#releases"
  webhook_url = "https://hooks.slack.com/services/T000/B000/XXXXabcd"
  events      = ["publish.completed", "approval.requested"]
  project     = "web"
}`,
				Check: tfresource.ComposeAggregateTestCheckFunc(
					tfresource.TestCheckResourceAttr("nanoflags_slack_destination.releases", "url_hint", "hooks.slack.com/…abcd"),
					tfresource.TestCheckResourceAttr("nanoflags_slack_destination.releases", "events.#", "2"),
					tfresource.TestCheckResourceAttr("nanoflags_slack_destination.releases", "environments.#", "0"),
					tfresource.TestCheckResourceAttr("nanoflags_slack_destination.releases", "status", "ok"),
				),
			},
			{
				ResourceName:            "nanoflags_slack_destination.releases",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"webhook_url"},
			},
		},
		CheckDestroy: func(*terraform.State) error {
			if n := f.SlackCount(); n != 0 {
				return fmt.Errorf("%d destinations left", n)
			}
			return nil
		},
	})
}
