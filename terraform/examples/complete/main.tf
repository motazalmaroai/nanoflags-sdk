# A complete setup: a segment, a flag, its targeting in development and production, and a publish of development.
# Production requires reviewed changes in many organizations; publish it from the dashboard after review.

terraform {
  required_providers {
    nanoflags = {
      source  = "registry.nanoflags.io/nanoflags/nanoflags"
      version = "~> 0.1"
    }
  }
}

provider "nanoflags" {} # NANOFLAGS_API_TOKEN

variable "project" {
  type    = string
  default = "web"
}

resource "nanoflags_segment" "beta" {
  project = var.project
  key     = "beta-testers"
  name    = "Beta testers"
  condition {
    attribute = "beta"
    op        = "eq"
    value     = jsonencode(true)
  }
}

resource "nanoflags_flag" "search" {
  project        = var.project
  key            = "instant-search"
  name           = "Instant search"
  client_exposed = true
}

resource "nanoflags_flag_environment" "search_dev" {
  project       = var.project
  flag          = nanoflags_flag.search.key
  environment   = "development"
  enabled       = true
  default_value = jsonencode(true)
}

resource "nanoflags_flag_environment" "search_prod" {
  project       = var.project
  flag          = nanoflags_flag.search.key
  environment   = "production"
  enabled       = true
  default_value = jsonencode(false)

  rule {
    id = "beta"
    condition {
      op    = "segment"
      value = jsonencode(nanoflags_segment.beta.key)
    }
    value = jsonencode(true)
  }

  rule {
    id = "gradual"
    rollout {
      percentage = 10
      value      = jsonencode(true)
      otherwise  = jsonencode(false)
    }
  }
}

resource "nanoflags_environment_publish" "dev" {
  project     = var.project
  environment = "development"
  note        = "terraform apply"
  triggers = {
    config = sha1(jsonencode([nanoflags_flag_environment.search_dev, nanoflags_segment.beta]))
  }
}
