package io.nanoflags.server;

/** How updates reach the client. */
public enum Transport {
    /** Pushed over the {@code /v1/live} WebSocket. */
    LIVE("live"),
    /** Announced over server-sent events ({@code /v1/stream}), then fetched. */
    STREAM("stream"),
    /** Polled ({@code /v1/bundle} with ETag). */
    POLL("poll");

    private final String wire;

    Transport(String wire) { this.wire = wire; }

    @Override public String toString() { return wire; }
}
