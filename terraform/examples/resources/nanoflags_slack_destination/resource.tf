variable "releases_webhook_url" {
  type      = string
  sensitive = true
}

resource "nanoflags_slack_destination" "releases" {
  name         = "#releases"
  webhook_url  = var.releases_webhook_url
  project      = "web"
  events       = ["publish.completed", "approval.requested", "flag.killed"]
  environments = ["production"]
}
