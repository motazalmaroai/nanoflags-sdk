resource "nanoflags_segment" "pro_customers" {
  project     = "web"
  key         = "pro-customers"
  name        = "Pro customers"
  description = "Paying customers on Pro or Team"
  match       = "all"

  condition {
    attribute = "plan"
    op        = "in"
    value     = jsonencode(["pro", "team"])
  }
  condition {
    attribute = "country"
    op        = "not_in"
    value     = jsonencode(["XX"])
  }
}
