# A boolean release flag, served to browser and mobile keys.
resource "nanoflags_flag" "new_checkout" {
  project        = "web"
  key            = "new-checkout"
  name           = "New checkout"
  description    = "Rebuilt checkout flow"
  client_exposed = true
  review_date    = "2027-03-01"
}

# A string flag: initial_value is required and must match the type.
resource "nanoflags_flag" "accent_color" {
  project       = "web"
  key           = "accent-color"
  type          = "string"
  purpose       = "experiment"
  initial_value = jsonencode("blue")
}

# A json flag whose values must satisfy a JSON Schema.
resource "nanoflags_flag" "upload_limits" {
  project       = "web"
  key           = "upload-limits"
  type          = "json"
  purpose       = "operational"
  permanent     = true
  initial_value = jsonencode({ max_mb = 10 })
  json_schema = jsonencode({
    type       = "object"
    required   = ["max_mb"]
    properties = { max_mb = { type = "number", minimum = 1 } }
  })
}
