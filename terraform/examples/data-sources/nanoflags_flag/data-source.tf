data "nanoflags_flag" "checkout" {
  project = "web"
  key     = "new-checkout"
}

output "checkout_flag_type" {
  value = data.nanoflags_flag.checkout.type
}
