module github.com/motazalmaroai/nanoflags-sdk/go/ofprovider

go 1.24.0

require (
	github.com/motazalmaroai/nanoflags-sdk/go v0.1.0
	github.com/open-feature/go-sdk v1.17.1
)

require (
	github.com/coder/websocket v1.8.13 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	go.uber.org/mock v0.6.0 // indirect
	golang.org/x/text v0.31.0 // indirect
)

// Builds against the SDK next to it in this repository. Replace directives only apply to the main
// module, so applications that require this module resolve the SDK by its tag (go/vX.Y.Z).
replace github.com/motazalmaroai/nanoflags-sdk/go => ../
