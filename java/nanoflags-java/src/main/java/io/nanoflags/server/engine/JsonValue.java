package io.nanoflags.server.engine;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * A JSON value with JavaScript semantics.
 *
 * <p>The engine is specified by its TypeScript implementation, which evaluates configuration that is plain JSON
 * data with JavaScript semantics (truthiness, loose property access, {@code Number()}, {@code String()},
 * {@code JSON.stringify}). {@code JsonValue} models exactly that subset of JavaScript so that this port produces
 * identical results, malformed configurations included. Values are immutable and safe to share between threads.
 *
 * <p>{@link #UNDEFINED} is JavaScript {@code undefined} (no value at all, e.g. a flag that serves nothing);
 * {@link #NULL} is JSON {@code null}.
 */
public abstract class JsonValue {
    JsonValue() {}

    /** JavaScript {@code undefined}. Never produced by parsing JSON text. */
    public static final JsonValue UNDEFINED = new Undefined();
    /** JSON {@code null}. */
    public static final JsonValue NULL = new Null();
    public static final Bool TRUE = new Bool(true);
    public static final Bool FALSE = new Bool(false);

    static final class Undefined extends JsonValue {
        @Override public String toString() { return "undefined"; }
    }

    static final class Null extends JsonValue {
        @Override public String toString() { return "null"; }
    }

    /** A JSON boolean. */
    public static final class Bool extends JsonValue {
        private final boolean value;

        private Bool(boolean value) { this.value = value; }

        public static Bool of(boolean b) { return b ? TRUE : FALSE; }

        public boolean value() { return value; }

        @Override public boolean equals(Object o) { return o instanceof Bool && ((Bool) o).value == value; }
        @Override public int hashCode() { return Boolean.hashCode(value); }
        @Override public String toString() { return Boolean.toString(value); }
    }

    /** A JavaScript number (IEEE-754 double; JSON overflow becomes ±Infinity). */
    public static final class Num extends JsonValue {
        private final double value;

        public Num(double value) { this.value = value; }

        public double value() { return value; }

        @Override public boolean equals(Object o) { return o instanceof Num && ((Num) o).value == value; }
        @Override public int hashCode() { return Double.hashCode(value == 0.0 ? 0.0 : value); }
        @Override public String toString() { return Js.numberToString(value); }
    }

    /** A JavaScript string (UTF-16; lone surrogates are kept as they are). */
    public static final class Str extends JsonValue {
        private final String value;

        public Str(String value) { this.value = Objects.requireNonNull(value, "value"); }

        public String value() { return value; }

        @Override public boolean equals(Object o) { return o instanceof Str && ((Str) o).value.equals(value); }
        @Override public int hashCode() { return value.hashCode(); }
        @Override public String toString() { return value; }
    }

    /** A JSON array. */
    public static final class Arr extends JsonValue {
        private final List<JsonValue> items;

        public Arr(List<JsonValue> items) { this.items = Collections.unmodifiableList(new ArrayList<>(items)); }

        Arr(List<JsonValue> items, boolean owned) { this.items = Collections.unmodifiableList(items); }

        public List<JsonValue> items() { return items; }

        public int size() { return items.size(); }

        @Override public boolean equals(Object o) { return o instanceof Arr && ((Arr) o).items.equals(items); }
        @Override public int hashCode() { return items.hashCode(); }
        @Override public String toString() { String s = toJson(); return s == null ? "[]" : s; }
    }

    /**
     * A plain object. {@link #keys()} are in JavaScript own-property order: array-index keys ascending first, then
     * the other keys in insertion order (a repeated key keeps its first position and its last value, as
     * {@code JSON.parse} does).
     */
    public static final class Obj extends JsonValue {
        public static final Obj EMPTY = new Builder().build();

        private final List<String> keys;
        private final Map<String, JsonValue> map;

        private Obj(List<String> keys, Map<String, JsonValue> map) {
            this.keys = Collections.unmodifiableList(keys);
            this.map = map;
        }

        /** The member {@code key}, or {@code null} when absent. */
        public JsonValue get(String key) { return map.get(key); }

        public boolean containsKey(String key) { return map.containsKey(key); }

        public int size() { return keys.size(); }

        public List<String> keys() { return keys; }

        @Override public boolean equals(Object o) { return o instanceof Obj && ((Obj) o).keys.equals(keys) && ((Obj) o).map.equals(map); }
        @Override public int hashCode() { return map.hashCode(); }
        @Override public String toString() { String s = toJson(); return s == null ? "{}" : s; }

        public static Builder builder() { return new Builder(); }

        /** Builds an {@link Obj}; a repeated key keeps its first position and its last value. */
        public static final class Builder {
            private final LinkedHashMap<String, JsonValue> map = new LinkedHashMap<>();

            public Builder put(String key, JsonValue value) {
                map.put(Objects.requireNonNull(key, "key"), Objects.requireNonNull(value, "value"));
                return this;
            }

            public Obj build() {
                List<long[]> index = new ArrayList<>();
                List<String> indexKeys = new ArrayList<>();
                List<String> names = new ArrayList<>();
                for (String k : map.keySet()) {
                    long n = arrayIndex(k);
                    if (n >= 0) {
                        index.add(new long[] {n, indexKeys.size()});
                        indexKeys.add(k);
                    } else {
                        names.add(k);
                    }
                }
                index.sort((a, b) -> Long.compare(a[0], b[0]));
                List<String> keys = new ArrayList<>(map.size());
                for (long[] e : index) keys.add(indexKeys.get((int) e[1]));
                keys.addAll(names);
                return new Obj(keys, new LinkedHashMap<>(map));
            }
        }
    }

    /** A function value; only ever produced by reading a String / Array prototype method by name. */
    static final class Func extends JsonValue {
        final String name;

        Func(String name) { this.name = name; }

        @Override public String toString() { return "function " + name + "() { [native code] }"; }
    }

    /* ---------------- public helpers ---------------- */

    public final boolean isUndefined() { return this == UNDEFINED; }

    public final boolean isNull() { return this == NULL; }

    /** {@code JSON.stringify(this)}, or {@code null} when {@code JSON.stringify} would return {@code undefined}. */
    public final String toJson() {
        if (this == UNDEFINED || this instanceof Func) return null;
        StringBuilder sb = new StringBuilder();
        Js.writeJson(this, sb);
        return sb.toString();
    }

    /**
     * Plain Java data: {@code null} (null and undefined), {@link Boolean}, {@link Double}, {@link String},
     * {@link List} and {@link Map} (a {@link LinkedHashMap} in configuration order).
     */
    public final Object toJava() {
        if (this instanceof Bool) return ((Bool) this).value;
        if (this instanceof Num) return ((Num) this).value;
        if (this instanceof Str) return ((Str) this).value;
        if (this instanceof Arr) {
            List<Object> out = new ArrayList<>(((Arr) this).items.size());
            for (JsonValue v : ((Arr) this).items) out.add(v.toJava());
            return out;
        }
        if (this instanceof Obj) {
            Obj o = (Obj) this;
            LinkedHashMap<String, Object> m = new LinkedHashMap<>();
            for (String k : o.keys) {
                JsonValue v = o.map.get(k);
                if (v != null && !v.isUndefined()) m.put(k, v.toJava());
            }
            return m;
        }
        return null;
    }

    /** The engine's type name: "null", "array", or the JavaScript {@code typeof} ("boolean", "number", …, "undefined"). */
    public final String typeName() {
        if (this == UNDEFINED) return "undefined";
        if (this == NULL) return "null";
        if (this instanceof Bool) return "boolean";
        if (this instanceof Num) return "number";
        if (this instanceof Str) return "string";
        if (this instanceof Arr) return "array";
        if (this instanceof Func) return "function";
        return "object";
    }

    /** Own property {@code name} of an object ({@link #UNDEFINED} when absent or when this is not an object). */
    public final JsonValue field(String name) { return Js.own(this, name); }

    /** Parses JSON text exactly like JavaScript's {@code JSON.parse}. */
    public static JsonValue parse(String text) { return new JsonParser(text).parseDocument(); }

    /** Parses UTF-8 JSON bytes (invalid UTF-8 becomes U+FFFD, as with a {@code TextDecoder}). */
    public static JsonValue parse(byte[] bytes) { return parse(new String(bytes, StandardCharsets.UTF_8)); }

    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /**
     * Converts Java data: {@code null}, {@link Boolean}, every {@link Number} (as a double, like JavaScript),
     * {@link CharSequence}, {@link Character}, enums (their name), {@link Map} (string keys, iteration order),
     * {@link Iterable} / arrays, {@link Date} and {@code java.time} values (ISO-8601 strings), {@link JsonValue}.
     * Anything else becomes {@code null}.
     */
    public static JsonValue of(Object x) {
        if (x == null) return NULL;
        if (x instanceof JsonValue) return (JsonValue) x;
        if (x instanceof Boolean) return Bool.of((Boolean) x);
        if (x instanceof CharSequence) return new Str(x.toString());
        if (x instanceof Character) return new Str(x.toString());
        if (x instanceof BigDecimal) return new Num(((BigDecimal) x).doubleValue());
        if (x instanceof BigInteger) return new Num(((BigInteger) x).doubleValue());
        if (x instanceof Number) return new Num(((Number) x).doubleValue());
        if (x instanceof Enum) return new Str(((Enum<?>) x).name());
        if (x instanceof Map) {
            Obj.Builder b = new Obj.Builder();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) x).entrySet()) b.put(String.valueOf(e.getKey()), of(e.getValue()));
            return b.build();
        }
        if (x instanceof Iterable) {
            List<JsonValue> out = new ArrayList<>();
            for (Object o : (Iterable<?>) x) out.add(of(o));
            return new Arr(out, true);
        }
        if (x instanceof Object[]) {
            List<JsonValue> out = new ArrayList<>();
            for (Object o : (Object[]) x) out.add(of(o));
            return new Arr(out, true);
        }
        if (x instanceof int[]) {
            List<JsonValue> out = new ArrayList<>();
            for (int o : (int[]) x) out.add(new Num(o));
            return new Arr(out, true);
        }
        if (x instanceof long[]) {
            List<JsonValue> out = new ArrayList<>();
            for (long o : (long[]) x) out.add(new Num(o));
            return new Arr(out, true);
        }
        if (x instanceof double[]) {
            List<JsonValue> out = new ArrayList<>();
            for (double o : (double[]) x) out.add(new Num(o));
            return new Arr(out, true);
        }
        if (x instanceof boolean[]) {
            List<JsonValue> out = new ArrayList<>();
            for (boolean o : (boolean[]) x) out.add(Bool.of(o));
            return new Arr(out, true);
        }
        if (x instanceof Date) return new Str(ISO.format(((Date) x).toInstant()));
        if (x instanceof Instant) return new Str(ISO.format((Instant) x));
        if (x.getClass().getName().startsWith("java.time.")) return new Str(x.toString());
        return NULL;
    }

    /** A canonical array index (0 … 2^32-2), or -1. */
    static long arrayIndex(String k) {
        int len = k.length();
        if (len == 0 || len > 10 || (len > 1 && k.charAt(0) == '0')) return -1;
        long n = 0;
        for (int i = 0; i < len; i++) {
            char c = k.charAt(i);
            if (c < '0' || c > '9') return -1;
            n = n * 10 + (c - '0');
        }
        return n < 4294967295L ? n : -1;
    }
}
