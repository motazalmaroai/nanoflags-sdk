package io.nanoflags.server.engine;

/** V8's TypeError for the operations the engine performs (the message matches V8's). */
public final class JsTypeError extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public JsTypeError(String message) { super(message, null, false, false); }
}
