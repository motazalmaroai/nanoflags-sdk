package io.nanoflags.server;

/** Classifies the errors the client reports through {@link NanoFlagsClient#onError} and {@link NanoFlagsClient#lastError()}. */
public enum ErrorCode {
    NETWORK("network"),
    UNAUTHORIZED("unauthorized"),
    HTTP("http"),
    INVALID_BUNDLE("invalid_bundle"),
    STORE("store"),
    CONFIG("config"),
    SIGNATURE("signature"),
    ENGINE("engine"),
    ENVIRONMENT_DELETED("environment_deleted"),
    NOT_READY("not_ready");

    private final String wire;

    ErrorCode(String wire) { this.wire = wire; }

    /** The code as the other NanoFlags SDKs spell it ({@code "invalid_bundle"}, …). */
    public String wire() { return wire; }

    @Override public String toString() { return wire; }
}
