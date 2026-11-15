package io.nanoflags.server.engine;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A parsed, immutable configuration bundle: one revision of one environment. Safe for concurrent use.
 *
 * <p>{@link #parse(String)} accepts what every NanoFlags SDK accepts ({@code schema} 1, a numeric {@code revision},
 * an object {@code flags}, an object {@code segments}); the flags themselves are evaluated as they are, malformed or
 * not, exactly like the TypeScript engine.
 */
public final class Bundle {
    private final JsonValue.Obj value;
    private final long revision;
    private final ConcurrentHashMap<String, List<String>> attrsCache = new ConcurrentHashMap<>();

    private Bundle(JsonValue.Obj value) {
        this.value = value;
        double r = ((JsonValue.Num) value.get("revision")).value();
        this.revision = Double.isNaN(r) || Double.isInfinite(r) ? 0L : (long) r;
    }

    /** The bundle document. */
    public JsonValue.Obj value() { return value; }

    /** The bundle's revision number. */
    public long revision() { return revision; }

    /** The bundle's {@code engine} member ({@link JsonValue#UNDEFINED} when absent: engine 1). */
    public JsonValue engine() { return value.field("engine"); }

    /** Whether this SDK's engine can evaluate the bundle. */
    public boolean supportsEngine() { return Engine.supportsEngine(engine()); }

    /** Flag keys in document order. */
    public List<String> flagKeys() { return ((JsonValue.Obj) value.get("flags")).keys(); }

    /** Evaluates one flag. */
    public EngineResult evaluate(String flagKey, EvalContext ctx, JsonValue fallback) { return Engine.evaluate(value, flagKey, ctx, fallback); }

    /** {@code JSON.stringify(bundle)}. */
    public String toJson() { return value.toJson(); }

    /** Attribute names that {@code flagKey}'s rules use (cached; see {@link Engine#attributesUsedBy}). */
    public List<String> attributesUsedBy(String flagKey) {
        return attrsCache.computeIfAbsent(flagKey, k -> Engine.attributesUsedBy(value, k));
    }

    /** Whether {@code v} has the shape the SDKs accept as a bundle. */
    public static boolean isBundle(JsonValue v) {
        if (!(v instanceof JsonValue.Obj)) return false;
        JsonValue schema = v.field("schema");
        JsonValue rev = v.field("revision");
        JsonValue segs = v.field("segments");
        return schema instanceof JsonValue.Num && ((JsonValue.Num) schema).value() == 1.0 && rev instanceof JsonValue.Num
            && v.field("flags") instanceof JsonValue.Obj && (segs instanceof JsonValue.Obj || segs instanceof JsonValue.Arr);
    }

    /** Wraps a parsed bundle document; {@code null} when it is not a bundle. */
    public static Bundle of(JsonValue v) { return isBundle(v) ? new Bundle((JsonValue.Obj) v) : null; }

    /** Parses bundle JSON text; {@code null} when it is not valid JSON or not a bundle. */
    public static Bundle parse(String text) {
        try {
            return of(JsonValue.parse(text));
        } catch (InvalidJsonException e) {
            return null;
        }
    }

    /** Parses UTF-8 bundle JSON; {@code null} when it is not valid JSON or not a bundle. */
    public static Bundle parse(byte[] utf8) {
        try {
            return of(JsonValue.parse(utf8));
        } catch (InvalidJsonException e) {
            return null;
        }
    }
}
