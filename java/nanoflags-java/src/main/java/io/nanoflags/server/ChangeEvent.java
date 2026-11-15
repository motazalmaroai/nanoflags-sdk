package io.nanoflags.server;

import java.time.Duration;
import java.util.Optional;

/** Describes a newly adopted configuration. */
public final class ChangeEvent {
    private final long revision;
    private final long previousRevision;
    private final String checksum;
    private final Source source;
    private final Transport transport;
    private final Duration latency;

    ChangeEvent(long revision, long previousRevision, String checksum, Source source, Transport transport, Duration latency) {
        this.revision = revision;
        this.previousRevision = previousRevision;
        this.checksum = checksum;
        this.source = source;
        this.transport = transport;
        this.latency = latency;
    }

    public long revision() { return revision; }

    /** -1 when no configuration was loaded before. */
    public long previousRevision() { return previousRevision; }

    /** The bundle checksum ({@code ""} when unknown, e.g. a bootstrap bundle). */
    public String checksum() { return checksum; }

    public Source source() { return source; }

    public Transport transport() { return transport; }

    /**
     * The time from the commit of the revision in the database to this event, for revisions pushed over the live
     * socket that carry their commit time. It compares the database's clock with this machine's.
     */
    public Optional<Duration> latency() { return Optional.ofNullable(latency); }

    @Override public String toString() {
        return "ChangeEvent{r" + revision + " (was " + previousRevision + "), " + source + "/" + transport + (latency == null ? "" : ", " + latency.toMillis() + " ms") + "}";
    }
}
