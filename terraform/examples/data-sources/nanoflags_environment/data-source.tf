data "nanoflags_environment" "production" {
  project = "web"
  key     = "production"
}

output "production_needs_approval" {
  value = data.nanoflags_environment.production.require_approval
}
