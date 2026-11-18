//go:build tools

// Package tools pins the documentation generator: `go generate ./...` regenerates docs/ from the schemas,
// examples/ and templates/.
package tools

import (
	_ "github.com/hashicorp/terraform-plugin-docs/cmd/tfplugindocs"
)
