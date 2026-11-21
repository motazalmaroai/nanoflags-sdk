package io.nanoflags.server.engine;

import static io.nanoflags.server.engine.Js.get;
import static io.nanoflags.server.engine.Js.own;
import static io.nanoflags.server.engine.Js.toStr;
import static io.nanoflags.server.engine.Js.truthy;

import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The NanoFlags evaluation engine: a port of the TypeScript engine ({@code @nanoflags/engine}) that the dashboard,
 * the edge and every SDK share. Pure and deterministic: the same bundle, flag key and context always produce the
 * same result, including the bucket of percentage rollouts (MurmurHash3 x86 32-bit over the NFC-normalised UTF-8
 * bytes of {@code "seed:identity"}). Rules are data; no user code ever runs.
 *
 * <p>The cross-language parity fixtures ({@code packages/engine/fixtures/parity.json}) pin the behaviour,
 * malformed configurations included.
 */
public final class Engine {
    private Engine() {}

    /** The engine version implemented here ({@code ENGINE_VERSION} of the TypeScript engine). Newer bundles are refused. */
    public static final int VERSION = 1;

    /* ---------------- hashing ---------------- */

    /**
     * {@code TextEncoder.encode(input.normalize("NFC"))}: well-formed runs are NFC-normalised, lone surrogates (which
     * never compose with their neighbours) become U+FFFD.
     */
    static byte[] hashInput(String s) {
        boolean simple = true;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) >= 0x0300) {
                simple = false;
                break;
            }
        }
        if (simple) return s.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(s.length());
        int runStart = 0;
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                i += 2;
                continue;
            }
            if (Character.isSurrogate(c)) {
                if (i > runStart) out.append(Normalizer.normalize(s.substring(runStart, i), Normalizer.Form.NFC));
                out.append('�');
                runStart = i + 1;
            }
            i++;
        }
        if (runStart < s.length()) out.append(Normalizer.normalize(s.substring(runStart), Normalizer.Form.NFC));
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of {@code input} (unsigned). Distribution only. */
    public static long murmur3(String input, long seed) {
        byte[] data = hashInput(input);
        final int c1 = 0xcc9e2d51;
        final int c2 = 0x1b873593;
        int h = (int) seed;
        int n = data.length;
        int blocks = n / 4;
        for (int i = 0; i < blocks; i++) {
            int o = i * 4;
            int k = (data[o] & 0xff) | ((data[o + 1] & 0xff) << 8) | ((data[o + 2] & 0xff) << 16) | ((data[o + 3] & 0xff) << 24);
            k *= c1;
            k = Integer.rotateLeft(k, 15);
            k *= c2;
            h ^= k;
            h = Integer.rotateLeft(h, 13);
            h = h * 5 + 0xe6546b64;
        }
        int k = 0;
        int tail = blocks * 4;
        int rem = n & 3;
        if (rem >= 3) k ^= (data[tail + 2] & 0xff) << 16;
        if (rem >= 2) k ^= (data[tail + 1] & 0xff) << 8;
        if (rem >= 1) {
            k ^= data[tail] & 0xff;
            k *= c1;
            k = Integer.rotateLeft(k, 15);
            k *= c2;
            h ^= k;
        }
        h ^= n;
        h ^= h >>> 16;
        h *= 0x85ebca6b;
        h ^= h >>> 13;
        h *= 0xc2b2ae35;
        h ^= h >>> 16;
        return h & 0xffffffffL;
    }

    /** MurmurHash3 with seed 0. */
    public static long murmur3(String input) { return murmur3(input, 0); }

    /** Bucket in [0, 100) with two decimals of resolution, stable for a given seed + identity. */
    public static double bucketOf(String seed, String identity) {
        return (double) (murmur3(seed + ":" + identity) % 10000) / 100;
    }

    /* ---------------- conditions ---------------- */

    private static boolean isObjLike(JsonValue v) { return v == JsonValue.NULL || v instanceof JsonValue.Arr || v instanceof JsonValue.Obj; }

    private static boolean looseEq(JsonValue a, JsonValue b) {
        if (a == JsonValue.UNDEFINED || b == JsonValue.UNDEFINED) return false;
        if (isObjLike(a) || isObjLike(b)) {
            String x = a.toJson();
            String y = b.toJson();
            return x == null ? y == null : x.equals(y);
        }
        return strictEq(a, b);
    }

    private static boolean strictEq(JsonValue a, JsonValue b) {
        if (a instanceof JsonValue.Bool && b instanceof JsonValue.Bool) return ((JsonValue.Bool) a).value() == ((JsonValue.Bool) b).value();
        if (a instanceof JsonValue.Num && b instanceof JsonValue.Num) return ((JsonValue.Num) a).value() == ((JsonValue.Num) b).value();
        if (a instanceof JsonValue.Str && b instanceof JsonValue.Str) return ((JsonValue.Str) a).value().equals(((JsonValue.Str) b).value());
        return a == b && (a == JsonValue.NULL || a == JsonValue.UNDEFINED);
    }

    /** A finite number, or NaN for "not comparable". */
    private static double num(JsonValue v) {
        if (v instanceof JsonValue.Num) {
            double d = ((JsonValue.Num) v).value();
            if (!Double.isNaN(d) && !Double.isInfinite(d)) return d;
        }
        if (v instanceof JsonValue.Str && !Js.trim(((JsonValue.Str) v).value()).isEmpty()) {
            double n = Js.stringToNumber(((JsonValue.Str) v).value());
            if (!Double.isNaN(n) && !Double.isInfinite(n)) return n;
        }
        return Double.NaN;
    }

    private static boolean isStr(JsonValue v, String s) { return v instanceof JsonValue.Str && ((JsonValue.Str) v).value().equals(s); }

    private static JsonValue lookup(EvalContext ctx, String name) {
        if (ctx == null) return JsonValue.UNDEFINED;
        JsonValue v = ctx.lookup(name);
        return v == null ? JsonValue.UNDEFINED : v;
    }

    private static boolean matchCondition(JsonValue c, EvalContext ctx, JsonValue segments, int depth) {
        JsonValue op = get(c, "op");
        if (isStr(op, "segment") || isStr(op, "not_segment")) {
            JsonValue value = get(c, "value");
            JsonValue seg = value instanceof JsonValue.Str ? own(segments, ((JsonValue.Str) value).value()) : JsonValue.UNDEFINED;
            boolean inSeg = false;
            if (seg != JsonValue.UNDEFINED && depth < 4) {
                JsonValue match = get(seg, "match");
                JsonValue conds = get(seg, "conditions");
                inSeg = matchAll(match, conds, ctx, segments, depth + 1);
            }
            return isStr(op, "segment") ? inSeg : seg != JsonValue.UNDEFINED && !inSeg;
        }
        JsonValue attribute = get(c, "attribute");
        JsonValue actual = lookup(ctx, toStr(attribute));
        JsonValue value = get(c, "value");
        if (!(op instanceof JsonValue.Str)) return false;
        switch (((JsonValue.Str) op).value()) {
            case "exists":
                return actual != JsonValue.UNDEFINED && actual != JsonValue.NULL;
            case "not_exists":
                return actual == JsonValue.UNDEFINED || actual == JsonValue.NULL;
            case "eq":
                return looseEq(actual, value);
            case "neq":
                return actual != JsonValue.UNDEFINED && !looseEq(actual, value);
            case "in":
                if (!(value instanceof JsonValue.Arr)) return false;
                for (JsonValue it : ((JsonValue.Arr) value).items()) if (looseEq(actual, it)) return true;
                return false;
            case "not_in":
                if (actual == JsonValue.UNDEFINED || !(value instanceof JsonValue.Arr)) return false;
                for (JsonValue it : ((JsonValue.Arr) value).items()) if (looseEq(actual, it)) return false;
                return true;
            case "contains":
                return actual instanceof JsonValue.Str && value instanceof JsonValue.Str && ((JsonValue.Str) actual).value().contains(((JsonValue.Str) value).value());
            case "starts_with":
                return actual instanceof JsonValue.Str && value instanceof JsonValue.Str && ((JsonValue.Str) actual).value().startsWith(((JsonValue.Str) value).value());
            case "ends_with":
                return actual instanceof JsonValue.Str && value instanceof JsonValue.Str && ((JsonValue.Str) actual).value().endsWith(((JsonValue.Str) value).value());
            case "gt":
            case "gte":
            case "lt":
            case "lte": {
                double a = num(actual);
                if (Double.isNaN(a)) return false;
                double b = num(value);
                if (Double.isNaN(b)) return false;
                switch (((JsonValue.Str) op).value()) {
                    case "gt": return a > b;
                    case "gte": return a >= b;
                    case "lt": return a < b;
                    default: return a <= b;
                }
            }
            case "semver_eq":
            case "semver_neq":
            case "semver_gt":
            case "semver_gte":
            case "semver_lt":
            case "semver_lte":
                return Operators.matchSemver(((JsonValue.Str) op).value(), actual, value);
            case "before":
            case "after":
                return Operators.matchDate(((JsonValue.Str) op).value(), actual, value);
            default:
                return false;
        }
    }

    /** The engine's matchAll(mode, conditions, …), including its failure modes. */
    private static boolean matchAll(JsonValue mode, JsonValue conditions, EvalContext ctx, JsonValue segments, int depth) {
        JsonValue length = get(conditions, "length");
        if (length instanceof JsonValue.Num && ((JsonValue.Num) length).value() == 0.0) return true;
        boolean some = isStr(mode, "any");
        if (!(conditions instanceof JsonValue.Arr)) throw new JsTypeError("conditions." + (some ? "some" : "every") + " is not a function");
        for (JsonValue c : ((JsonValue.Arr) conditions).items()) {
            boolean ok = matchCondition(c, ctx, segments, depth);
            if (some && ok) return true;
            if (!some && !ok) return false;
        }
        return !some;
    }

    private static final Map<String, String> OP_WORDS = new HashMap<>();

    static {
        String[] w = {"eq", "=", "neq", "≠", "in", "in", "not_in", "not in", "contains", "contains", "starts_with", "starts with",
            "ends_with", "ends with", "gt", ">", "gte", "≥", "lt", "<", "lte", "≤", "exists", "exists",
            "not_exists", "does not exist", "segment", "in segment", "not_segment", "not in segment",
            "semver_eq", "version =", "semver_neq", "version ≠", "semver_gt", "version >", "semver_gte", "version ≥",
            "semver_lt", "version <", "semver_lte", "version ≤", "before", "before", "after", "after"};
        for (int i = 0; i < w.length; i += 2) OP_WORDS.put(w[i], w[i + 1]);
    }

    private static String describeCondition(JsonValue c) {
        JsonValue value = get(c, "value");
        String v;
        if (value instanceof JsonValue.Arr) v = Js.join((JsonValue.Arr) value, ", ");
        else if (value == JsonValue.UNDEFINED) v = "";
        else v = toStr(value);
        JsonValue op = get(c, "op");
        String key = toStr(op);
        String word = OP_WORDS.get(key);
        if (word == null) word = Js.OBJECT_PROTO_STRINGS.get(key);
        if (word == null) word = "undefined";
        if (isStr(op, "segment") || isStr(op, "not_segment")) return word + " " + v;
        JsonValue attribute = get(c, "attribute");
        if (isStr(op, "exists") || isStr(op, "not_exists")) return toStr(attribute) + " " + word;
        return toStr(attribute) + " " + word + " " + v;
    }

    /** The engine's fmt(v): strings as they are, everything else as JSON ("undefined" when there is none). */
    private static String fmt(JsonValue v) {
        if (v instanceof JsonValue.Str) return ((JsonValue.Str) v).value();
        String j = v.toJson();
        return j == null ? "undefined" : j;
    }

    private static String pad2(int n) {
        String s = Integer.toString(n);
        return s.length() < 2 ? "0" + s : s;
    }

    /* ---------------- evaluation ---------------- */

    /**
     * Evaluates one flag of {@code bundle} (a parsed bundle document; {@link JsonValue#UNDEFINED} or
     * {@link JsonValue#NULL} for "no configuration loaded"). Never throws: on any problem it returns
     * {@code fallback} with reason {@code flag_not_found} or {@code error}.
     */
    public static EngineResult evaluate(JsonValue bundle, String flagKey, EvalContext ctx, JsonValue fallback) {
        if (bundle == null) bundle = JsonValue.NULL;
        if (fallback == null) fallback = JsonValue.NULL;
        boolean nullish = bundle == JsonValue.UNDEFINED || bundle == JsonValue.NULL;
        JsonValue revision = new JsonValue.Num(0);
        if (!nullish) {
            JsonValue r;
            try {
                r = get(bundle, "revision");
            } catch (RuntimeException e) {
                r = JsonValue.UNDEFINED;
            }
            if (r != JsonValue.UNDEFINED && r != JsonValue.NULL) revision = r;
        }
        List<TraceStep> trace = new ArrayList<>();
        try {
            JsonValue flag = nullish ? JsonValue.UNDEFINED : own(get(bundle, "flags"), flagKey);
            if (!truthy(bundle) || !truthy(flag)) {
                String detail = truthy(bundle) ? "Flag is not in this configuration. The application fallback applies." : "No configuration is loaded. The application fallback applies.";
                trace.add(new TraceStep("result", "Returned " + fmt(fallback), detail));
                return EngineResult.simple(flagKey, fallback, Reason.FLAG_NOT_FOUND, revision, trace);
            }
            trace.add(new TraceStep("config", "Configuration loaded", Js.toNumber(revision) > 0 ? "r" + toStr(revision) : "draft"));
            JsonValue enabled = get(flag, "enabled");
            if (!truthy(enabled)) {
                JsonValue off = get(flag, "off");
                trace.add(new TraceStep("result", "Returned " + fmt(off), "Flag is disabled in this environment."));
                return EngineResult.simple(flagKey, off, Reason.OFF, revision, trace);
            }
            JsonValue rules = get(flag, "rules");
            JsonValue segments = get(bundle, "segments");
            int i = 0;
            while (true) {
                JsonValue length = get(rules, "length");
                if (!((double) i < Js.toNumber(length))) break;
                JsonValue rule = get(rules, Integer.toString(i));
                JsonValue match = get(rule, "match");
                JsonValue conditions = get(rule, "conditions");
                boolean matched = matchAll(match, conditions, ctx, segments, 0);
                String label = "Rule " + pad2(i + 1);
                String summary = "all contexts";
                if (truthy(get(conditions, "length"))) {
                    List<JsonValue> items = ((JsonValue.Arr) conditions).items();
                    StringBuilder sb = new StringBuilder();
                    String sep = isStr(match, "any") ? " OR " : " AND ";
                    for (int j = 0; j < items.size(); j++) {
                        if (j > 0) sb.append(sep);
                        sb.append(describeCondition(items.get(j)));
                    }
                    summary = sb.toString();
                }
                trace.add(new TraceStep("rule", matched ? label + " matched" : label + " did not match", summary, matched));
                if (!matched) {
                    i++;
                    continue;
                }
                JsonValue serve = get(rule, "serve");
                JsonValue serveType = get(serve, "type");
                JsonValue ruleId = get(rule, "id");
                if (isStr(serveType, "fixed")) {
                    JsonValue value = get(serve, "value");
                    trace.add(new TraceStep("result", "Returned " + fmt(value), label + " serves a fixed value."));
                    return new EngineResult(flagKey, value, Reason.RULE_MATCH, i, ruleId, null, null, revision, trace, null);
                }
                JsonValue attrV = get(serve, "bucketBy");
                String attr = attrV == JsonValue.UNDEFINED || attrV == JsonValue.NULL ? "key" : toStr(attrV);
                JsonValue identity = lookup(ctx, attr);
                JsonValue otherwise = get(serve, "otherwise");
                if (identity == JsonValue.UNDEFINED || identity == JsonValue.NULL || isStr(identity, "")) {
                    trace.add(new TraceStep("allocation", "Allocation skipped", "Context has no \"" + attr + "\" to bucket by; treated as outside the allocation.", false));
                    trace.add(new TraceStep("result", "Returned " + fmt(otherwise), "Remaining eligible users."));
                    return new EngineResult(flagKey, otherwise, Reason.RULE_MATCH, i, ruleId, false, null, revision, trace, null);
                }
                JsonValue seedV = get(serve, "seed");
                String seed = seedV == JsonValue.UNDEFINED || seedV == JsonValue.NULL ? flagKey : toStr(seedV);
                double bucket = bucketOf(seed, toStr(identity));
                JsonValue percentage = get(serve, "percentage");
                boolean inRollout = bucket < Js.toNumber(percentage);
                String pct = toStr(percentage);
                trace.add(new TraceStep("allocation", "Allocation evaluated",
                    pct + "% rollout · " + attr + " " + (inRollout ? "inside" : "outside") + " allocation (bucket " + Js.toFixed2(bucket) + ")", inRollout));
                JsonValue value = inRollout ? get(serve, "value") : otherwise;
                trace.add(new TraceStep("result", "Returned " + fmt(value), inRollout ? "Inside the " + pct + "% allocation." : "Remaining eligible users."));
                return new EngineResult(flagKey, value, Reason.RULE_MATCH, i, ruleId, inRollout, bucket, revision, trace, null);
            }
            JsonValue def = get(flag, "default");
            trace.add(new TraceStep("result", "Returned " + fmt(def), "No rule matched. The flag default applies."));
            return EngineResult.simple(flagKey, def, Reason.DEFAULT, revision, trace);
        } catch (RuntimeException | StackOverflowError e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.toString();
            trace.add(new TraceStep("result", "Returned " + fmt(fallback), "Evaluation error: " + msg + ". The application fallback applies."));
            return new EngineResult(flagKey, fallback, Reason.ERROR, -1, JsonValue.UNDEFINED, null, null, revision, trace, msg);
        }
    }

    /** True when this engine can evaluate a bundle whose {@code engine} member is {@code e} ({@link JsonValue#UNDEFINED} when absent). */
    public static boolean supportsEngine(JsonValue e) {
        if (e == JsonValue.UNDEFINED) return true;
        if (!(e instanceof JsonValue.Num)) return false;
        double d = ((JsonValue.Num) e).value();
        return d == Math.floor(d) && !Double.isInfinite(d) && d >= 1 && d <= VERSION;
    }

    private static void segmentRefs(JsonValue conditions, List<String> pending) {
        if (!(conditions instanceof JsonValue.Arr)) return;
        for (JsonValue c : ((JsonValue.Arr) conditions).items()) {
            JsonValue op = c.field("op");
            JsonValue v = c.field("value");
            if ((isStr(op, "segment") || isStr(op, "not_segment")) && v instanceof JsonValue.Str) pending.add(((JsonValue.Str) v).value());
        }
    }

    /**
     * Removes what must not reach browser keys: flags that are not client-exposed, and every segment that no
     * client-exposed flag references (directly or through other segments). Mirrors {@code clientBundle()} of the
     * engine.
     */
    public static JsonValue.Obj clientBundle(JsonValue.Obj bundle) {
        JsonValue fv = bundle.get("flags");
        JsonValue.Obj flags = fv instanceof JsonValue.Obj ? (JsonValue.Obj) fv : JsonValue.Obj.EMPTY;
        JsonValue.Obj.Builder kept = new JsonValue.Obj.Builder();
        List<String> pending = new ArrayList<>();
        for (String k : flags.keys()) {
            JsonValue f = flags.get(k);
            if (!JsonValue.TRUE.equals(f.field("clientExposed"))) continue;
            kept.put(k, f);
            JsonValue rules = f.field("rules");
            if (rules instanceof JsonValue.Arr) for (JsonValue r : ((JsonValue.Arr) rules).items()) segmentRefs(r.field("conditions"), pending);
        }
        JsonValue sv = bundle.get("segments");
        JsonValue.Obj segments = sv instanceof JsonValue.Obj ? (JsonValue.Obj) sv : null;
        Set<String> needed = new HashSet<>();
        while (!pending.isEmpty()) {
            String k = pending.remove(pending.size() - 1);
            JsonValue seg = segments == null ? null : segments.get(k);
            if (seg == null) continue;
            if (!needed.add(k)) continue;
            segmentRefs(seg.field("conditions"), pending);
        }
        JsonValue.Obj.Builder segOut = new JsonValue.Obj.Builder();
        if (segments != null) for (String k : segments.keys()) if (needed.contains(k)) segOut.put(k, segments.get(k));
        JsonValue.Obj.Builder out = new JsonValue.Obj.Builder();
        for (String k : bundle.keys()) {
            if (k.equals("flags")) out.put(k, kept.build());
            else if (k.equals("segments")) out.put(k, segOut.build());
            else out.put(k, bundle.get(k));
        }
        if (!bundle.containsKey("flags")) out.put("flags", kept.build());
        if (!bundle.containsKey("segments")) out.put("segments", segOut.build());
        return out.build();
    }

    private static boolean visitAttributes(JsonValue conds, int depth, JsonValue segments, Set<String> names) {
        if (!(conds instanceof JsonValue.Arr)) return conds instanceof JsonValue.Str;
        for (JsonValue c : ((JsonValue.Arr) conds).items()) {
            JsonValue op = get(c, "op");
            if (isStr(op, "segment") || isStr(op, "not_segment")) {
                JsonValue value = get(c, "value");
                if (value instanceof JsonValue.Str) {
                    JsonValue seg = own(segments, ((JsonValue.Str) value).value());
                    if (truthy(seg) && depth < 4 && !visitAttributes(get(seg, "conditions"), depth + 1, segments, names)) return false;
                }
            } else {
                JsonValue attr = get(c, "attribute");
                if (truthy(attr)) names.add(toStr(attr));
            }
        }
        return true;
    }

    /**
     * The context attributes that the rules of {@code flagKey} reference (through segments up to the engine's
     * nesting limit), plus the bucketing attribute of rollouts. The SDK reports only these attribute names (with the
     * type of the value, never the value) with sampled evaluation events.
     */
    public static List<String> attributesUsedBy(JsonValue bundle, String flagKey) {
        Set<String> names = new LinkedHashSet<>();
        try {
            JsonValue segments = bundle.field("segments");
            JsonValue rules = get(own(bundle.field("flags"), flagKey), "rules");
            if (!(rules instanceof JsonValue.Arr)) return Collections.emptyList();
            for (JsonValue r : ((JsonValue.Arr) rules).items()) {
                if (!visitAttributes(get(r, "conditions"), 0, segments, names)) return Collections.emptyList();
                JsonValue serve = get(r, "serve");
                if (isStr(get(serve, "type"), "rollout")) {
                    JsonValue by = get(serve, "bucketBy");
                    names.add(by == JsonValue.UNDEFINED || by == JsonValue.NULL ? "key" : toStr(by));
                }
            }
            return Collections.unmodifiableList(new ArrayList<>(names));
        } catch (RuntimeException e) {
            return Collections.emptyList();
        }
    }
}
