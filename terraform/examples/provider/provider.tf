terraform {
  required_providers {
    nanoflags = {
      source  = "nanoflags/nanoflags"
      version = "~> 0.1"
    }
  }
}

# The token is read from NANOFLAGS_API_TOKEN when api_token is omitted (recommended).
provider "nanoflags" {
  # api_token = var.nanoflags_api_token
  # base_url  = "https://edge.nanoflags.io"
}
