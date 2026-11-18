# Publishes the development draft whenever the configuration managed here changes.
resource "nanoflags_environment_publish" "development" {
  project     = "web"
  environment = "development"
  note        = "Published by Terraform"

  triggers = {
    flags = sha1(jsonencode([
      nanoflags_flag_environment.new_checkout_development,
      nanoflags_segment.pro_customers,
    ]))
  }
}
