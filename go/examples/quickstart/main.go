// Command quickstart evaluates a few flags of the public NanoFlags demo.
//
//	NANOFLAGS_SDK_KEY=nf_srv_… go run ./examples/quickstart
//
// Use your server key (`nf_srv_…`) from the dashboard; the public demo's browser key (shown on
// https://nanoflags.io) works too and evaluates the demo flags demo-new-checkout and demo-accent.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	nanoflags "github.com/motazalmaroai/nanoflags-sdk/go"
)

func main() {
	client, err := nanoflags.New(os.Getenv("NANOFLAGS_SDK_KEY"), nanoflags.WithService("quickstart"))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.WaitForReady(ctx); err != nil {
		log.Printf("no configuration yet (%v); evaluations return their fallbacks", err)
	}

	user := nanoflags.Context{"key": "user-42", "plan": "pro", "country": "SA"}
	checkout, detail := client.BoolVariationDetail("demo-new-checkout", user, false)
	accent := client.StringVariation("demo-accent", user, "blue")
	fmt.Printf("revision %d (%s)\n", client.Revision(), client.Status())
	fmt.Printf("demo-new-checkout = %v (reason %s)\n", checkout, detail.Reason)
	fmt.Printf("demo-accent       = %q\n", accent)
	for _, step := range detail.Trace {
		fmt.Printf("  %-10s %s — %s\n", step.Kind, step.Title, step.Detail)
	}
	fmt.Printf("all flags: %v\n", client.AllFlags(user))
}
