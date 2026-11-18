package io.nanoflags.server;

import io.nanoflags.server.engine.JsonValue;
import java.time.Instant;
import java.util.Map;

/**
 * Evaluates flags for one test session. While {@link #isActive() active}, flags are evaluated against the session's
 * pinned bundle with the session's context overlaid by the call's context (the call's attributes win), and sampled
 * events carry the session id. When the session is unknown, not permitted for this service, or expired, it evaluates
 * exactly like the client ({@code isActive()} is false). Like the client it never performs I/O and never throws.
 * Obtain one with {@link NanoFlagsClient#session(String)} or {@link TestSessions#flagsFor(NanoFlagsClient)}.
 */
public final class SessionEvaluator {
    private final NanoFlagsClient client;
    private final Sessions.State state;

    SessionEvaluator(NanoFlagsClient client, Sessions.State state) {
        this.client = client;
        this.state = state;
    }

    private Sessions.State scope() { return state != null && state.live() ? state : null; }

    /** True while the session is known and has not expired. Re-evaluated on every call. */
    public boolean isActive() { return scope() != null; }

    /** The session id, or {@code null} when the session could not be resolved. */
    public String id() { return state == null ? null : state.id; }

    /** When the session expires, or {@code null} when it could not be resolved. */
    public Instant expiresAt() { return state == null ? null : state.expiresAt; }

    /** The revision evaluations currently run against: the pinned one while active, otherwise the client's (-1 when none is loaded). */
    public long revision() {
        Sessions.State s = scope();
        return s != null ? s.snap.bundle.revision() : client.revision();
    }

    /** The client this evaluator belongs to. */
    public NanoFlagsClient client() { return client; }

    /** {@link NanoFlagsClient#boolVariation} within the session. */
    public boolean boolVariation(String key, Map<String, ?> context, boolean fallback) { return boolVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Boolean> boolVariationDetail(String key, Map<String, ?> context, boolean fallback) { return client.boolDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#stringVariation} within the session. */
    public String stringVariation(String key, Map<String, ?> context, String fallback) { return stringVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<String> stringVariationDetail(String key, Map<String, ?> context, String fallback) { return client.stringDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#doubleVariation} within the session. */
    public double doubleVariation(String key, Map<String, ?> context, double fallback) { return doubleVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Double> doubleVariationDetail(String key, Map<String, ?> context, double fallback) { return client.doubleDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#intVariation} within the session. */
    public int intVariation(String key, Map<String, ?> context, int fallback) { return intVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Integer> intVariationDetail(String key, Map<String, ?> context, int fallback) { return client.intDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#longVariation} within the session. */
    public long longVariation(String key, Map<String, ?> context, long fallback) { return longVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Long> longVariationDetail(String key, Map<String, ?> context, long fallback) { return client.longDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#jsonVariation} within the session. */
    public Object jsonVariation(String key, Map<String, ?> context, Object fallback) { return jsonVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<Object> jsonVariationDetail(String key, Map<String, ?> context, Object fallback) { return client.jsonDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#jsonValueVariation} within the session. */
    public JsonValue jsonValueVariation(String key, Map<String, ?> context, JsonValue fallback) { return jsonValueVariationDetail(key, context, fallback).value(); }

    public EvaluationDetail<JsonValue> jsonValueVariationDetail(String key, Map<String, ?> context, JsonValue fallback) { return client.jsonValueDetail(scope(), key, context, fallback); }

    /** {@link NanoFlagsClient#evaluate} within the session. */
    public EvaluationDetail<Object> evaluate(String key, Map<String, ?> context, Object fallback) { return client.evaluateDetail(scope(), key, context, fallback); }

    @Override public String toString() {
        return "SessionEvaluator{" + (state == null ? "none" : state.id + ", expiresAt=" + state.expiresAt) + ", active=" + isActive() + "}";
    }
}
