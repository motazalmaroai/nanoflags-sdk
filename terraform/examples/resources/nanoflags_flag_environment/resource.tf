resource "nanoflags_flag_environment" "new_checkout_production" {
  project       = "web"
  flag          = nanoflags_flag.new_checkout.key
  environment   = "production"
  enabled       = true
  default_value = jsonencode(false)
  off_value     = jsonencode(false)

  # Internal users always get the new checkout.
  rule {
    id          = "staff"
    description = "Company accounts"
    condition {
      attribute = "email"
      op        = "ends_with"
      value     = jsonencode("@example.com")
    }
    value = jsonencode(true)
  }

  # 25% of Pro customers, bucketed per account.
  rule {
    id = "pro-rollout"
    condition {
      op    = "segment"
      value = jsonencode(nanoflags_segment.pro_customers.key)
    }
    rollout {
      percentage = 25
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
      bucket_by  = "accountId"
    }
  }
}
