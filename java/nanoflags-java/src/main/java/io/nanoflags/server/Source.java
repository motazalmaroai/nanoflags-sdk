package io.nanoflags.server;

/** Where an adopted configuration came from. */
public enum Source {
    NETWORK("network"),
    STORE("store"),
    BOOTSTRAP("bootstrap");

    private final String wire;

    Source(String wire) { this.wire = wire; }

    @Override public String toString() { return wire; }
}
