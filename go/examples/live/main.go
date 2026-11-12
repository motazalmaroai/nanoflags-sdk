// Command live connects to the public NanoFlags demo, prints every configuration change as it
// is pushed over the live WebSocket and, with -toggle N, flips the demo flag N times through
// POST /v1/demo/toggle and reports the time from each toggle's response to the SDK's update.
//
//	export NANOFLAGS_SDK_KEY=nf_pub_…      # the public demo's browser key, shown on https://nanoflags.io
//	go run ./examples/live                 # watch
//	go run ./examples/live -toggle 3       # watch and toggle demo-new-checkout three times
//
// The demo endpoint is rate-limited; keep -toggle small and the gap between toggles generous.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"time"

	nanoflags "github.com/motazalmaroai/nanoflags-sdk/go"
)

func main() {
	toggles := flag.Int("toggle", 0, "toggle demo-new-checkout this many times")
	gap := flag.Duration("gap", 8*time.Second, "pause between toggles")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	client, err := nanoflags.New(os.Getenv("NANOFLAGS_SDK_KEY"), nanoflags.WithService("go-live-example"))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	updates := make(chan nanoflags.ChangeEvent, 16)
	client.OnChange(func(e nanoflags.ChangeEvent) { updates <- e })
	client.OnError(func(err error) { log.Printf("error: %v", err) })

	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := client.WaitForReady(wctx); err != nil {
		log.Fatalf("not ready: %v", err)
	}
	<-updates // the initial load
	user := nanoflags.Context{"key": "visitor-1"}
	fmt.Printf("ready: r%d status=%s; demo-new-checkout=%v demo-accent=%q\n", client.Revision(), client.Status(),
		client.BoolVariation("demo-new-checkout", user, false), client.StringVariation("demo-accent", user, "blue"))
	// Give the socket a moment to open so the first toggle exercises the push path.
	for i := 0; i < 50 && client.Transport() != nanoflags.TransportLive; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Printf("transport: %s\n", client.Transport())

	if *toggles == 0 {
		for {
			select {
			case <-ctx.Done():
				return
			case e := <-updates:
				printUpdate(client, e, user)
			}
		}
	}

	var lat []time.Duration
	for i := 0; i < *toggles && ctx.Err() == nil; i++ {
		next := !client.BoolVariation("demo-new-checkout", user, false)
		returned, rev, err := toggle(ctx, "demo-new-checkout", next)
		if err != nil {
			log.Printf("toggle %d: %v", i+1, err)
			break
		}
		if rev == 0 {
			fmt.Printf("toggle %d: unchanged\n", i+1)
			continue
		}
		timeout := time.After(20 * time.Second)
	wait:
		for {
			select {
			case e := <-updates:
				if e.Revision < rev {
					continue
				}
				d := time.Since(returned)
				lat = append(lat, d)
				printUpdate(client, e, user)
				fmt.Printf("  toggle %d → r%d: publish response → SDK update %d ms\n", i+1, rev, d.Milliseconds())
				break wait
			case <-timeout:
				fmt.Printf("toggle %d: no update within 20 s\n", i+1)
				break wait
			}
		}
		if i < *toggles-1 {
			time.Sleep(*gap)
		}
	}
	if len(lat) > 0 {
		slices.Sort(lat)
		fmt.Printf("updates: %d, median %d ms, worst %d ms\n", len(lat), lat[len(lat)/2].Milliseconds(), lat[len(lat)-1].Milliseconds())
	}
}

func printUpdate(c *nanoflags.Client, e nanoflags.ChangeEvent, user nanoflags.Context) {
	commit := "n/a"
	if e.HasLatency {
		commit = fmt.Sprintf("%d ms", e.Latency.Milliseconds())
	}
	fmt.Printf("update: r%d (from r%d) via %s, commit → update %s; demo-new-checkout=%v demo-accent=%q\n", e.Revision, e.PreviousRevision, e.Transport, commit,
		c.BoolVariation("demo-new-checkout", user, false), c.StringVariation("demo-accent", user, "blue"))
}

// toggle calls the public demo's toggle endpoint and returns when its response arrived and the
// revision it published (0 when the value was unchanged).
func toggle(ctx context.Context, flagKey string, value any) (time.Time, int64, error) {
	body, _ := json.Marshal(map[string]any{"flag": flagKey, "value": value})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, nanoflags.OfficialEdgeURL+"/v1/demo/toggle", bytes.NewReader(body))
	if err != nil {
		return time.Time{}, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return time.Time{}, 0, err
	}
	defer res.Body.Close()
	returned := time.Now()
	var out struct {
		Status       string `json:"status"`
		Revision     int64  `json:"revision"`
		RetryAfterMs int64  `json:"retryAfterMs"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != http.StatusOK {
		return returned, 0, fmt.Errorf("HTTP %d (retry after %d ms)", res.StatusCode, out.RetryAfterMs)
	}
	if out.Status != "published" {
		return returned, 0, nil
	}
	return returned, out.Revision, nil
}
