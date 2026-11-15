package io.nanoflags.server;

/** Returned by the {@code on…} listener methods; {@link #close()} unregisters the listener. Idempotent. */
@FunctionalInterface
public interface Subscription extends AutoCloseable {
    @Override
    void close();
}
