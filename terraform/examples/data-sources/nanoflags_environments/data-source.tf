data "nanoflags_environments" "web" {
  project = "web"
}

# Turn a flag on in every environment.
resource "nanoflags_flag_environment" "banner" {
  for_each    = toset(data.nanoflags_environments.web.keys)
  project     = "web"
  flag        = "maintenance-banner"
  environment = each.key
  enabled     = true
}
