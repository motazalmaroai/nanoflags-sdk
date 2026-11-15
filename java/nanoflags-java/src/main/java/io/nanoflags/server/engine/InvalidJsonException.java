package io.nanoflags.server.engine;

/** Thrown by {@link JsonValue#parse(String)} for text that {@code JSON.parse} rejects. */
public final class InvalidJsonException extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    public InvalidJsonException(String message) { super(message); }
}
