data "nanoflags_project" "web" {
  key = "web"
}

output "default_environment" {
  value = data.nanoflags_project.web.default_environment
}
