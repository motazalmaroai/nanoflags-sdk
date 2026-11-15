package io.nanoflags.server.engine;

import java.util.Collections;
import java.util.List;

/** The full outcome of {@link Engine#evaluate}, mirroring the engine's {@code Evaluation} object. */
public final class EngineResult {
    private final String flagKey;
    private final JsonValue value;
    private final Reason reason;
    private final int ruleIndex;
    private final JsonValue ruleId;
    private final Boolean inRollout;
    private final Double bucket;
    private final JsonValue revision;
    private final List<TraceStep> trace;
    private final String error;

    public EngineResult(String flagKey, JsonValue value, Reason reason, int ruleIndex, JsonValue ruleId, Boolean inRollout, Double bucket,
                        JsonValue revision, List<TraceStep> trace, String error) {
        this.flagKey = flagKey;
        this.value = value;
        this.reason = reason;
        this.ruleIndex = ruleIndex;
        this.ruleId = ruleId == null ? JsonValue.UNDEFINED : ruleId;
        this.inRollout = inRollout;
        this.bucket = bucket;
        this.revision = revision == null ? new JsonValue.Num(0) : revision;
        this.trace = Collections.unmodifiableList(trace);
        this.error = error;
    }

    static EngineResult simple(String flagKey, JsonValue value, Reason reason, JsonValue revision, List<TraceStep> trace) {
        return new EngineResult(flagKey, value, reason, -1, JsonValue.UNDEFINED, null, null, revision, trace, null);
    }

    public String flagKey() { return flagKey; }

    /** The served value; {@link JsonValue#UNDEFINED} when the configuration served nothing (a malformed flag). */
    public JsonValue value() { return value; }

    public Reason reason() { return reason; }

    /** Zero-based index of the matching rule, or -1. */
    public int ruleIndex() { return ruleIndex; }

    /** The matching rule's {@code id} ({@link JsonValue#UNDEFINED} when there is none). */
    public JsonValue ruleId() { return ruleId; }

    /** Set for percentage rollouts. */
    public Boolean inRollout() { return inRollout; }

    /** The rollout bucket (0–99.99), set for percentage rollouts. */
    public Double bucket() { return bucket; }

    /** The bundle's {@code revision} (0 without a bundle). */
    public JsonValue revision() { return revision; }

    public List<TraceStep> trace() { return trace; }

    /** The evaluation error message (reason {@link Reason#ERROR} only). */
    public String error() { return error; }
}
