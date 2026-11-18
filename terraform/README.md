# Terraform provider for NanoFlags

Manage NanoFlags feature flags, per-environment targeting, segments and publishing as code, through the
[NanoFlags Management API](https://nanoflags.io/docs/api-reference).

```hcl
terraform {
  required_providers {
    nanoflags = { source = "nanoflags/nanoflags", version = "~> 0.1" }
  }
}

provider "nanoflags" {} # reads NANOFLAGS_API_TOKEN

resource "nanoflags_flag" "checkout" {
  project = "web"
  key     = "new-checkout"
}

resource "nanoflags_flag_environment" "checkout_dev" {
  project     = "web"
  flag        = nanoflags_flag.checkout.key
  environment = "development"
  enabled     = true
  rule {
    id = "gradual"
    rollout {
      percentage = 25
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
    }
  }
}

resource "nanoflags_environment_publish" "dev" {
  project     = "web"
  environment = "development"
  triggers    = { config = sha1(jsonencode(nanoflags_flag_environment.checkout_dev)) }
}
```

## What it manages

| Management API | Terraform |
| --- | --- |
| Flags: create, read, update details, archive / unarchive (no delete) | resource `nanoflags_flag` (destroy archives), data source `nanoflags_flag` |
| Flag configuration per environment (draft): enabled, default, off, rules | resource `nanoflags_flag_environment` |
| Segments: create, read, update, delete | resource `nanoflags_segment` |
| Publish an environment's draft | resource `nanoflags_environment_publish` |
| Chat notification destinations (Incoming Webhooks): list, add, remove | resource `nanoflags_slack_destination` |
| Projects, environments (read only) | data sources `nanoflags_project`, `nanoflags_environment`, `nanoflags_environments` |
| SDK key metadata (read only, never key material) | data source `nanoflags_sdk_keys` |

Projects, environments and SDK keys are created in the dashboard: the Management API does not create them. Changes,
approvals, scheduled publishes, the kill switch and imports are workflow operations and are not modelled as resources.

Documentation for every resource and data source is in [`docs/`](docs) (the Terraform Registry format), examples in
[`examples/`](examples).

## Development

Requires Go (see `go.mod`) and, for the provider tests, the `terraform` CLI on `PATH`.

```sh
go vet ./...
go test ./...                     # client tests + provider tests against an in-memory fake API (no credentials)
go generate ./...                 # regenerate docs/ from the schemas, templates/ and examples/

# Acceptance tests against a real organization (leave an archived tfacc-* flag behind per run):
TF_ACC=1 NANOFLAGS_API_TOKEN=nf_api_… NANOFLAGS_ACC_PROJECT=sandbox NANOFLAGS_ACC_ENVIRONMENT=development \
  go test ./internal/provider -run TestAcc -v
```

Try a local build with a `dev_overrides` block in `~/.terraformrc` pointing `nanoflags/nanoflags` at the directory of
`go build -o <dir>/terraform-provider-nanoflags .`.

Releases: see [PUBLISHING.md](PUBLISHING.md).

## License

Apache-2.0
