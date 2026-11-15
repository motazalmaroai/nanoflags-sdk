package io.nanoflags.server.engine;

/** Why an evaluation produced its value. {@link #wire()} is the engine's spelling ("rule_match", …). */
public enum Reason {
    RULE_MATCH("rule_match"),
    DEFAULT("default"),
    OFF("off"),
    FLAG_NOT_FOUND("flag_not_found"),
    ERROR("error");

    private final String wire;

    Reason(String wire) { this.wire = wire; }

    /** The engine's spelling of the reason. */
    public String wire() { return wire; }

    @Override public String toString() { return wire; }
}
