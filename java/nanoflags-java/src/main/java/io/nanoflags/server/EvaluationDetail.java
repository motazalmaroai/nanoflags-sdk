package io.nanoflags.server;

import io.nanoflags.server.engine.JsonValue;
import io.nanoflags.server.engine.Reason;
import io.nanoflags.server.engine.TraceStep;
import java.util.List;

/**
 * The full result of an evaluation: the value plus why it was served.
 *
 * @param <T> the type of the value
 */
public final class EvaluationDetail<T> {
    private final String flagKey;
    private final T value;
    private final Reason reason;
    private final int ruleIndex;
    private final String ruleId;
    private final Boolean inRollout;
    private final Double bucket;
    private final long revision;
    private final List<TraceStep> trace;
    private final String error;
    private final JsonValue raw;

    EvaluationDetail(String flagKey, T value, Reason reason, int ruleIndex, String ruleId, Boolean inRollout, Double bucket, long revision,
                     List<TraceStep> trace, String error, JsonValue raw) {
        this.flagKey = flagKey;
        this.value = value;
        this.reason = reason;
        this.ruleIndex = ruleIndex;
        this.ruleId = ruleId;
        this.inRollout = inRollout;
        this.bucket = bucket;
        this.revision = revision;
        this.trace = trace;
        this.error = error;
        this.raw = raw;
    }

    public String flagKey() { return flagKey; }

    /** The value (the fallback for reasons {@code flag_not_found} and {@code error}). */
    public T value() { return value; }

    public Reason reason() { return reason; }

    /** Zero-based index of the matching rule, or -1. */
    public int ruleIndex() { return ruleIndex; }

    /** The matching rule's id, or {@code null}. */
    public String ruleId() { return ruleId; }

    /** For percentage rollouts: whether the context is inside the allocation; otherwise {@code null}. */
    public Boolean inRollout() { return inRollout; }

    /** For percentage rollouts: the context's bucket (0–99.99); otherwise {@code null}. */
    public Double bucket() { return bucket; }

    /** The revision of the configuration that was evaluated (0 without one). */
    public long revision() { return revision; }

    /** The decision step by step, exactly as the dashboard shows it. */
    public List<TraceStep> trace() { return trace; }

    /** Explains reason {@code error} (evaluation error or type mismatch); otherwise {@code null}. */
    public String error() { return error; }

    /** The value the engine produced (the fallback for {@code flag_not_found} / {@code error}), with JavaScript types. */
    public JsonValue rawValue() { return raw; }

    /** Whether the configuration served no value at all (a malformed flag). */
    public boolean valueIsUndefined() { return raw.isUndefined(); }

    /** The type of the served value: "boolean", "string", "number", "array", "object", "null" or "undefined". */
    public String typeName() { return raw.typeName(); }

    /** The served value as JSON text with object keys in configuration order ({@code null} when undefined). */
    public String json() { return raw.toJson(); }

    @Override public String toString() {
        return "EvaluationDetail{" + flagKey + "=" + value + ", reason=" + reason + (ruleId == null ? "" : ", rule=" + ruleId) + ", r" + revision
            + (error == null ? "" : ", error=" + error) + "}";
    }
}
