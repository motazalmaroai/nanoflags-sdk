package io.nanoflags.server;

/** A client error. A failed update never changes the configuration in use. */
public class NanoFlagsException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final ErrorCode code;
    private final int httpStatus;

    public NanoFlagsException(ErrorCode code, String message) { this(code, message, 0, null); }

    public NanoFlagsException(ErrorCode code, String message, int httpStatus, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public ErrorCode code() { return code; }

    /** The HTTP status for {@link ErrorCode#UNAUTHORIZED} and {@link ErrorCode#HTTP} errors, otherwise 0. */
    public int httpStatus() { return httpStatus; }

    @Override public String toString() { return "NanoFlagsException(" + code.wire() + "): " + getMessage(); }
}
