// Package nanoflags is the NanoFlags server SDK for Go.
//
// Flags are evaluated locally, in microseconds and without I/O, against an in-memory copy of the
// environment's configuration. The client keeps that copy current in the background: the edge
// pushes every published revision over a WebSocket (GET /v1/live) with the signed bundle in the
// message, server-sent events and polling take over when no socket can be opened, and a slow
// safety poll runs while the socket is healthy.
//
//	client, err := nanoflags.New(os.Getenv("NANOFLAGS_SDK_KEY"))
//	if err != nil { ... }
//	defer client.Close()
//	_ = client.WaitForReady(ctx)
//
//	if client.BoolVariation("new-checkout", nanoflags.Context{"key": user.ID, "plan": user.Plan}, false) { ... }
//
// Trust: on the official edge every bundle's Ed25519 signature is verified against the embedded
// production keys (OfficialSigningKeys, key ids from GET /v1/keys after a rotation) before it is
// used, and unsigned bundles are refused. A bundle that does not verify, or that needs a newer
// evaluation engine than SupportedEngineVersion, never replaces the configuration in use.
//
// Failure behaviour: evaluations never fail. Without a configuration they return the fallback;
// when the edge is unreachable the last good configuration (optionally persisted with WithStore,
// or supplied with WithBootstrap) stays in use and Status reports StatusStale. When the edge
// closes the live socket with CloseEnvironmentDeleted (4004) the client stops reconnecting and
// keeps evaluating its last configuration.
//
// Results are identical to every other NanoFlags SDK, the dashboard and the edge: package engine
// is a byte-for-byte port of the TypeScript engine, checked against the shared parity fixtures.
//
// The OpenFeature provider lives in the ofprovider module.
package nanoflags
