package io.nanoflags.server.engine;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The JavaScript abstract operations the engine relies on. */
final class Js {
    private Js() {}

    static void writeJson(JsonValue v, StringBuilder sb) {
        if (v == JsonValue.NULL) {
            sb.append("null");
        } else if (v instanceof JsonValue.Bool) {
            sb.append(((JsonValue.Bool) v).value() ? "true" : "false");
        } else if (v instanceof JsonValue.Num) {
            double d = ((JsonValue.Num) v).value();
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
            else sb.append(numberToString(d));
        } else if (v instanceof JsonValue.Str) {
            quote(((JsonValue.Str) v).value(), sb);
        } else if (v instanceof JsonValue.Arr) {
            sb.append('[');
            List<JsonValue> items = ((JsonValue.Arr) v).items();
            for (int idx = 0; idx < items.size(); idx++) {
                if (idx > 0) sb.append(',');
                JsonValue e = items.get(idx);
                if (e == JsonValue.UNDEFINED || e instanceof JsonValue.Func) sb.append("null");
                else writeJson(e, sb);
            }
            sb.append(']');
        } else if (v instanceof JsonValue.Obj) {
            JsonValue.Obj o = (JsonValue.Obj) v;
            sb.append('{');
            boolean first = true;
            for (String k : o.keys()) {
                JsonValue e = o.get(k);
                if (e == JsonValue.UNDEFINED || e instanceof JsonValue.Func) continue;
                if (!first) sb.append(',');
                first = false;
                quote(k, sb);
                sb.append(':');
                writeJson(e, sb);
            }
            sb.append('}');
        } else {
            sb.append("null");
        }
    }

    private static final String HEX = "0123456789abcdef";

    /** {@code JSON.stringify} of a string (well-formed JSON.stringify: lone surrogates are escaped). */
    static void quote(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') sb.append("\\\"");
            else if (c == '\\') sb.append("\\\\");
            else if (c == '\b') sb.append("\\b");
            else if (c == '\f') sb.append("\\f");
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else if (c == '\t') sb.append("\\t");
            else if (c < ' ') hex(c, sb);
            else if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                sb.append(c).append(s.charAt(i + 1));
                i++;
            } else if (Character.isSurrogate(c)) hex(c, sb);
            else sb.append(c);
        }
        sb.append('"');
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        quote(s, sb);
        return sb.toString();
    }

    private static void hex(char c, StringBuilder sb) {
        int u = c;
        sb.append("\\u").append(HEX.charAt((u >> 12) & 0xF)).append(HEX.charAt((u >> 8) & 0xF)).append(HEX.charAt((u >> 4) & 0xF)).append(HEX.charAt(u & 0xF));
    }

    private static String zeros(int n) {
        char[] z = new char[Math.max(0, n)];
        Arrays.fill(z, '0');
        return new String(z);
    }

    /** ECMAScript Number::toString(x) for radix 10 (shortest round-trip digits). */
    static String numberToString(double d) {
        if (Double.isNaN(d)) return "NaN";
        if (d == 0.0) return "0";
        if (d == Double.POSITIVE_INFINITY) return "Infinity";
        if (d == Double.NEGATIVE_INFINITY) return "-Infinity";
        boolean neg = d < 0;
        double x = Math.abs(d);
        if (x < 9.007199254740992E15 && x == Math.floor(x)) return (neg ? "-" : "") + Long.toString((long) x);
        // Shortest digit string that round-trips (correctly rounded, so the closest one of that length).
        BigDecimal exact = new BigDecimal(x);
        String digits = "";
        int n = 0;
        for (int p = 1; p <= 17; p++) {
            BigDecimal r = exact.round(new MathContext(p, RoundingMode.HALF_EVEN));
            if (Double.parseDouble(r.toString()) == x) {
                String u = r.unscaledValue().toString();
                int scale = r.scale();
                while (u.length() > 1 && u.endsWith("0")) {
                    u = u.substring(0, u.length() - 1);
                    scale--;
                }
                digits = u;
                n = u.length() - scale;
                break;
            }
        }
        int k = digits.length();
        String out;
        if (k <= n && n <= 21) out = digits + zeros(n - k);
        else if (n >= 1 && n <= 21) out = digits.substring(0, n) + "." + digits.substring(n);
        else if (n > -6 && n <= 0) out = "0." + zeros(-n) + digits;
        else {
            int e = n - 1;
            String es = (e < 0 ? "-" : "+") + Math.abs(e);
            out = k == 1 ? digits + "e" + es : digits.substring(0, 1) + "." + digits.substring(1) + "e" + es;
        }
        return neg ? "-" + out : out;
    }

    /** {@code x.toFixed(2)} for 0 ≤ x &lt; 1e21. */
    static String toFixed2(double x) { return new BigDecimal(x).setScale(2, RoundingMode.HALF_UP).toPlainString(); }

    /** String(v). */
    static String toStr(JsonValue v) {
        if (v == JsonValue.UNDEFINED) return "undefined";
        if (v == JsonValue.NULL) return "null";
        if (v instanceof JsonValue.Bool) return ((JsonValue.Bool) v).value() ? "true" : "false";
        if (v instanceof JsonValue.Num) return numberToString(((JsonValue.Num) v).value());
        if (v instanceof JsonValue.Str) return ((JsonValue.Str) v).value();
        if (v instanceof JsonValue.Arr) return join((JsonValue.Arr) v, ",");
        if (v instanceof JsonValue.Func) return "function " + ((JsonValue.Func) v).name + "() { [native code] }";
        return "[object Object]";
    }

    /** Array.prototype.join. */
    static String join(JsonValue.Arr v, String sep) {
        StringBuilder sb = new StringBuilder();
        List<JsonValue> items = v.items();
        for (int idx = 0; idx < items.size(); idx++) {
            if (idx > 0) sb.append(sep);
            JsonValue e = items.get(idx);
            if (e != JsonValue.UNDEFINED && e != JsonValue.NULL) sb.append(toStr(e));
        }
        return sb.toString();
    }

    /** ToBoolean(v). */
    static boolean truthy(JsonValue v) {
        if (v == JsonValue.UNDEFINED || v == JsonValue.NULL) return false;
        if (v instanceof JsonValue.Bool) return ((JsonValue.Bool) v).value();
        if (v instanceof JsonValue.Num) {
            double d = ((JsonValue.Num) v).value();
            return d != 0.0 && !Double.isNaN(d);
        }
        if (v instanceof JsonValue.Str) return !((JsonValue.Str) v).value().isEmpty();
        return true;
    }

    /** ToNumber(ToPrimitive(v, number)). */
    static double toNumber(JsonValue v) {
        if (v == JsonValue.UNDEFINED) return Double.NaN;
        if (v == JsonValue.NULL) return 0.0;
        if (v instanceof JsonValue.Bool) return ((JsonValue.Bool) v).value() ? 1.0 : 0.0;
        if (v instanceof JsonValue.Num) return ((JsonValue.Num) v).value();
        if (v instanceof JsonValue.Str) return stringToNumber(((JsonValue.Str) v).value());
        return stringToNumber(toStr(v));
    }

    static boolean isJsWhitespace(char c) {
        switch (c) {
            case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0: case 0x1680:
            case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
                return true;
            default:
                return c >= 0x2000 && c <= 0x200A;
        }
    }

    /** String.prototype.trim. */
    static String trim(String s) {
        int a = 0;
        int b = s.length();
        while (a < b && isJsWhitespace(s.charAt(a))) a++;
        while (b > a && isJsWhitespace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    /** ECMAScript StringToNumber. */
    static double stringToNumber(String input) {
        String s = trim(input);
        if (s.isEmpty()) return 0.0;
        if (s.equals("Infinity") || s.equals("+Infinity")) return Double.POSITIVE_INFINITY;
        if (s.equals("-Infinity")) return Double.NEGATIVE_INFINITY;
        if (s.length() > 2 && s.charAt(0) == '0') {
            int base = 0;
            char p = s.charAt(1);
            if (p == 'x' || p == 'X') base = 16;
            else if (p == 'o' || p == 'O') base = 8;
            else if (p == 'b' || p == 'B') base = 2;
            if (base != 0) {
                for (int j = 2; j < s.length(); j++) {
                    char c = s.charAt(j);
                    if (c > 0x7f) return Double.NaN;
                    int dv = Character.digit(c, 16);
                    if (dv < 0 || dv >= base) return Double.NaN;
                }
                return new BigInteger(s.substring(2), base).doubleValue();
            }
        }
        // StrDecimalLiteral: [+-] (digits [. digits] | . digits) [e [+-] digits]
        int i = 0;
        if (s.charAt(i) == '+' || s.charAt(i) == '-') i++;
        int intDigits = 0;
        while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
            i++;
            intDigits++;
        }
        int fracDigits = 0;
        if (i < s.length() && s.charAt(i) == '.') {
            i++;
            while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                i++;
                fracDigits++;
            }
        }
        if (intDigits + fracDigits == 0) return Double.NaN;
        if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
            i++;
            if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
            int expDigits = 0;
            while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                i++;
                expDigits++;
            }
            if (expDigits == 0) return Double.NaN;
        }
        if (i != s.length()) return Double.NaN;
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static Set<String> set(String... names) { return new HashSet<>(Arrays.asList(names)); }

    private static final Set<String> STRING_METHODS = set(
        "anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "concat", "constructor", "endsWith", "fixed",
        "fontcolor", "fontsize", "includes", "indexOf", "isWellFormed", "italics", "lastIndexOf", "link", "localeCompare", "match",
        "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "small", "split", "strike",
        "sub", "substr", "substring", "sup", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toString", "toUpperCase",
        "toWellFormed", "trim", "trimEnd", "trimLeft", "trimRight", "trimStart", "valueOf");

    private static final Set<String> ARRAY_METHODS = set(
        "at", "concat", "constructor", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast",
        "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push",
        "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
        "toSpliced", "toString", "unshift", "values", "with");

    /** Object.prototype members, as {@code ${words[name]}} renders them in describeCondition. */
    static final Map<String, String> OBJECT_PROTO_STRINGS = new HashMap<>();

    static {
        for (String n : new String[] {"__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
            "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString"}) {
            OBJECT_PROTO_STRINGS.put(n, "function " + n + "() { [native code] }");
        }
        OBJECT_PROTO_STRINGS.put("constructor", "function Object() { [native code] }");
        OBJECT_PROTO_STRINGS.put("__proto__", "[object Object]");
    }

    /**
     * The property read {@code v[name]} for the fixed property names the engine reads. Plain objects only expose
     * own properties here: none of those names exist on Object.prototype.
     */
    static JsonValue get(JsonValue v, String name) {
        if (v == JsonValue.UNDEFINED || v == JsonValue.NULL) {
            throw new JsTypeError("Cannot read properties of " + toStr(v) + " (reading '" + name + "')");
        }
        if (v instanceof JsonValue.Str) {
            String s = ((JsonValue.Str) v).value();
            if (name.equals("length")) return new JsonValue.Num(s.length());
            long n = JsonValue.arrayIndex(name);
            if (n >= 0) return n < s.length() ? new JsonValue.Str(String.valueOf(s.charAt((int) n))) : JsonValue.UNDEFINED;
            if (STRING_METHODS.contains(name)) return new JsonValue.Func(name);
        } else if (v instanceof JsonValue.Arr) {
            List<JsonValue> items = ((JsonValue.Arr) v).items();
            if (name.equals("length")) return new JsonValue.Num(items.size());
            long n = JsonValue.arrayIndex(name);
            if (n >= 0) return n < items.size() ? items.get((int) n) : JsonValue.UNDEFINED;
            if (ARRAY_METHODS.contains(name)) return new JsonValue.Func(name);
        } else if (v instanceof JsonValue.Obj) {
            JsonValue r = ((JsonValue.Obj) v).get(name);
            return r == null ? JsonValue.UNDEFINED : r;
        }
        return JsonValue.UNDEFINED;
    }

    /** The engine's {@code own(obj, key)}: an own-property lookup that never reads inherited members. */
    static JsonValue own(JsonValue obj, String key) {
        if (obj instanceof JsonValue.Obj) {
            JsonValue r = ((JsonValue.Obj) obj).get(key);
            return r == null ? JsonValue.UNDEFINED : r;
        }
        if (obj instanceof JsonValue.Arr || obj instanceof JsonValue.Str) {
            return JsonValue.arrayIndex(key) >= 0 || key.equals("length") ? get(obj, key) : JsonValue.UNDEFINED;
        }
        return JsonValue.UNDEFINED;
    }
}
