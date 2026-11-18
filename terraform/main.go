// Command terraform-provider-nanoflags is the Terraform provider for NanoFlags.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/motazalmaroai/terraform-provider-nanoflags/internal/provider"
)

// version is set by GoReleaser at release time.
var version = "dev"

//go:generate go run github.com/hashicorp/terraform-plugin-docs/cmd/tfplugindocs generate --provider-name nanoflags

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run the provider with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/nanoflags/nanoflags",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err.Error())
	}
}
