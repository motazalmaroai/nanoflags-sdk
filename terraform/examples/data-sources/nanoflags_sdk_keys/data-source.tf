data "nanoflags_sdk_keys" "production" {
  project     = "web"
  environment = "production"
}

output "production_key_prefixes" {
  value = [for k in data.nanoflags_sdk_keys.production.keys : "${k.name} (${k.kind}): ${k.prefix}…"]
}
