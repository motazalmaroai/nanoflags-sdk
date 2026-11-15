package io.nanoflags.server;

/** The state of the configuration in use. */
public enum Status {
    /** No configuration is loaded; every evaluation returns its fallback. */
    NOT_READY("not-ready"),
    /** The configuration is known to be current. */
    READY("ready"),
    /**
     * A configuration is in use but is not known to be current (edge unreachable, restored from the store,
     * environment deleted, …).
     */
    STALE("stale");

    private final String wire;

    Status(String wire) { this.wire = wire; }

    @Override public String toString() { return wire; }
}
