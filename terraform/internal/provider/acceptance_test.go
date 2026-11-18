package provider

import (
	"fmt"
	"os"
	"testing"
	"time"

	tfresource "github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// Acceptance tests run against a real NanoFlags organization and only when TF_ACC=1:
//
//	TF_ACC=1 NANOFLAGS_API_TOKEN=nf_api_… NANOFLAGS_ACC_PROJECT=<project key> NANOFLAGS_ACC_ENVIRONMENT=<env key> \
//	  go test ./internal/provider -run TestAcc -v
//
// Use a throwaway project: flags cannot be deleted, so each run leaves an archived flag (tfacc-<timestamp>) behind.
// The environment must not require approvals. Scopes: flags:read, flags:write, segments:read, segments:write, publish.
func accPreCheck(t *testing.T) (project, env string) {
	t.Helper()
	project, env = os.Getenv("NANOFLAGS_ACC_PROJECT"), os.Getenv("NANOFLAGS_ACC_ENVIRONMENT")
	if os.Getenv("TF_ACC") == "" {
		t.Skip("acceptance tests need TF_ACC=1")
	}
	if os.Getenv("NANOFLAGS_API_TOKEN") == "" || project == "" || env == "" {
		t.Fatal("set NANOFLAGS_API_TOKEN, NANOFLAGS_ACC_PROJECT and NANOFLAGS_ACC_ENVIRONMENT for acceptance tests")
	}
	return project, env
}

func TestAccFlagTargetingPublish(t *testing.T) {
	project, env := accPreCheck(t)
	suffix := time.Now().UTC().Format("20060102150405")
	cfg := func(pct int) string {
		return fmt.Sprintf(`
resource "nanoflags_segment" "acc" {
  project = %[1]q
  key     = "tfacc-seg-%[3]s"
  condition {
    attribute = "plan"
    op        = "in"
    value     = jsonencode(["pro"])
  }
}

resource "nanoflags_flag" "acc" {
  project     = %[1]q
  key         = "tfacc-%[3]s"
  description = "Terraform acceptance test"
}

resource "nanoflags_flag_environment" "acc" {
  project     = %[1]q
  flag        = nanoflags_flag.acc.key
  environment = %[2]q
  enabled     = true
  rule {
    id = "seg"
    condition {
      op    = "segment"
      value = jsonencode(nanoflags_segment.acc.key)
    }
    rollout {
      percentage = %[4]d
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
    }
  }
}

resource "nanoflags_environment_publish" "acc" {
  project     = %[1]q
  environment = %[2]q
  note        = "terraform acceptance test"
  triggers    = { c = sha1(jsonencode(nanoflags_flag_environment.acc)) }
}
`, project, env, suffix, pct)
	}
	tfresource.Test(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{
			{Config: cfg(10), Check: tfresource.TestCheckResourceAttr("nanoflags_flag_environment.acc", "rule.0.rollout.percentage", "10")},
			{ResourceName: "nanoflags_flag.acc", ImportState: true, ImportStateId: project + "/tfacc-" + suffix, ImportStateVerify: true, ImportStateVerifyIdentifierAttribute: "id"},
			{Config: cfg(20), Check: tfresource.TestCheckResourceAttr("nanoflags_flag_environment.acc", "rule.0.rollout.percentage", "20")},
		},
	})
}

func TestAccDataSources(t *testing.T) {
	project, env := accPreCheck(t)
	tfresource.Test(t, tfresource.TestCase{
		ProtoV6ProviderFactories: protoV6,
		Steps: []tfresource.TestStep{{
			Config: fmt.Sprintf(`
data "nanoflags_project" "p" { key = %[1]q }
data "nanoflags_environment" "e" {
  project = %[1]q
  key     = %[2]q
}
data "nanoflags_environments" "all" { project = %[1]q }
`, project, env),
			Check: tfresource.ComposeAggregateTestCheckFunc(
				tfresource.TestCheckResourceAttrSet("data.nanoflags_project.p", "id"),
				tfresource.TestCheckResourceAttr("data.nanoflags_environment.e", "key", env),
				tfresource.TestCheckResourceAttrSet("data.nanoflags_environments.all", "keys.0"),
			),
		}},
	})
}
