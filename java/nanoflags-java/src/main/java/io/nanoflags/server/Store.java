package io.nanoflags.server;

import java.io.IOException;

/**
 * Persists the last good configuration so that a restarting process can evaluate flags before (or without)
 * reaching the edge. The client stores an opaque UTF-8 JSON document. A persisted bundle is verified again when it
 * is loaded, like any other bundle: the store is outside the trust boundary.
 */
public interface Store {
    /** The stored document, or {@code null} when nothing is stored. */
    byte[] load() throws IOException;

    void save(byte[] data) throws IOException;
}
