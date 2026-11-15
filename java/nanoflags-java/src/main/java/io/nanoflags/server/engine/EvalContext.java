package io.nanoflags.server.engine;

import java.util.Map;

/** Attribute lookup for evaluation: the engine only ever reads own attributes by name. */
@FunctionalInterface
public interface EvalContext {
    /** The attribute, or {@code null} when it is absent ({@code undefined}). */
    JsonValue lookup(String name);

    /** A context held as an object {@link JsonValue} (as parsed from JSON). */
    static EvalContext of(JsonValue v) {
        return name -> v instanceof JsonValue.Obj ? ((JsonValue.Obj) v).get(name) : null;
    }

    /** A context backed by Java data; values are converted with {@link JsonValue#of(Object)} when they are read. */
    static EvalContext of(Map<String, ?> m) {
        if (m == null) return name -> null;
        return name -> m.containsKey(name) ? JsonValue.of(m.get(name)) : null;
    }
}
