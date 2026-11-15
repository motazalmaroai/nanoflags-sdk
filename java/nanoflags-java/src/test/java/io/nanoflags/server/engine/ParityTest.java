package io.nanoflags.server.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Cross-language conformance: every expected result was produced by the TypeScript engine
 * ({@code packages/engine/fixtures/generate-parity.mjs}, shared by every port). The Go port's extra corner cases
 * ({@code go/internal/testdata/extra.json}) are checked too, V8 error messages included. Results are compared as
 * canonical JSON text: value, reason, rule, bucket, revision and the full trace.
 */
class ParityTest {
    // Working directory: the module (java/nanoflags-java).
    static final String[] PARITY = {"../../packages/engine/fixtures/parity.json"};
    static final String[] EXTRA = {"../../go/internal/testdata/extra.json"};

    private static final Map<String, JsonValue> CACHE = new HashMap<>();

    static synchronized JsonValue load(String[] candidates) throws IOException {
        for (String c : candidates) {
            Path p = Paths.get(c);
            if (Files.isRegularFile(p)) {
                String key = p.toRealPath().toString();
                JsonValue v = CACHE.get(key);
                if (v == null) {
                    v = JsonValue.parse(Files.readAllBytes(p));
                    CACHE.put(key, v);
                }
                return v;
            }
        }
        return null;
    }

    static String js(JsonValue v) {
        String s = v.toJson();
        return s == null ? "undefined" : s;
    }

    /** Renders a result the way the fixture generator's expectedOf does, with a fixed key order. */
    static String canonicalResult(EngineResult r, boolean withTrace, boolean mask) {
        StringBuilder b = new StringBuilder("{\"reason\":").append(Js.quote(r.reason().wire())).append(",\"revision\":").append(js(r.revision()));
        if (!r.value().isUndefined()) b.append(",\"value\":").append(js(r.value()));
        if (r.ruleIndex() >= 0) b.append(",\"ruleIndex\":").append(r.ruleIndex());
        if (!r.ruleId().isUndefined() && r.ruleIndex() >= 0) b.append(",\"ruleId\":").append(js(r.ruleId()));
        if (r.inRollout() != null) b.append(",\"inRollout\":").append(r.inRollout());
        if (r.bucket() != null) b.append(",\"bucket\":").append(Js.numberToString(r.bucket()));
        if (r.reason() == Reason.ERROR) b.append(",\"error\":true");
        if (withTrace) {
            b.append(",\"trace\":[");
            List<TraceStep> t = r.trace();
            for (int i = 0; i < t.size(); i++) {
                TraceStep s = t.get(i);
                if (i > 0) b.append(',');
                String detail = mask && i == t.size() - 1 ? "<error>" : s.detail();
                b.append("{\"kind\":").append(Js.quote(s.kind())).append(",\"title\":").append(Js.quote(s.title())).append(",\"detail\":").append(Js.quote(detail));
                if (s.matched() != null) b.append(",\"matched\":").append(s.matched());
                b.append('}');
            }
            b.append(']');
        }
        return b.append('}').toString();
    }

    static String canonicalExpected(JsonValue e, boolean mask) {
        StringBuilder b = new StringBuilder("{\"reason\":").append(js(e.field("reason"))).append(",\"revision\":").append(js(e.field("revision")));
        for (String k : new String[] {"value", "ruleIndex", "ruleId", "inRollout", "bucket", "error"}) {
            JsonValue v = e.field(k);
            if (!v.isUndefined()) b.append(",\"").append(k).append("\":").append(js(v));
        }
        JsonValue tr = e.field("trace");
        if (tr instanceof JsonValue.Arr) {
            List<JsonValue> items = ((JsonValue.Arr) tr).items();
            b.append(",\"trace\":[");
            for (int i = 0; i < items.size(); i++) {
                JsonValue s = items.get(i);
                if (i > 0) b.append(',');
                JsonValue detail = mask && i == items.size() - 1 ? new JsonValue.Str("<error>") : s.field("detail");
                b.append("{\"kind\":").append(js(s.field("kind"))).append(",\"title\":").append(js(s.field("title"))).append(",\"detail\":").append(js(detail));
                JsonValue m = s.field("matched");
                if (!m.isUndefined()) b.append(",\"matched\":").append(js(m));
                b.append('}');
            }
            b.append(']');
        }
        return b.append('}').toString();
    }

    /** Evaluates every case of a fixture document; returns the number checked. */
    static int runCases(JsonValue doc, boolean compareErrorMessages) {
        List<JsonValue> bundles = ((JsonValue.Arr) doc.field("bundles")).items();
        List<JsonValue> contexts = ((JsonValue.Arr) doc.field("contexts")).items();
        List<JsonValue> cases = ((JsonValue.Arr) doc.field("cases")).items();
        List<String> failures = new ArrayList<>();
        for (int i = 0; i < cases.size(); i++) {
            JsonValue c = cases.get(i);
            int bi = (int) ((JsonValue.Num) c.field("bundle")).value();
            int ci = (int) ((JsonValue.Num) c.field("context")).value();
            String flag = ((JsonValue.Str) c.field("flag")).value();
            JsonValue bundle = bi >= 0 ? bundles.get(bi) : JsonValue.NULL;
            JsonValue expected = c.field("expected");
            boolean withTrace = !expected.field("trace").isUndefined();
            boolean mask = !expected.field("error").isUndefined() && !compareErrorMessages;
            EngineResult got = Engine.evaluate(bundle, flag, EvalContext.of(contexts.get(ci)), c.field("fallback"));
            String g = canonicalResult(got, withTrace, mask);
            String w = canonicalExpected(expected, mask);
            if (compareErrorMessages) {
                JsonValue msg = expected.field("errorMessage");
                if (msg instanceof JsonValue.Str && !((JsonValue.Str) msg).value().equals(got.error())) {
                    g += " err=" + Js.quote(got.error() == null ? "" : got.error());
                    w += " err=" + Js.quote(((JsonValue.Str) msg).value());
                }
            }
            if (!g.equals(w)) failures.add("case " + i + " " + js(c.field("name")) + "\n got: " + g + "\nwant: " + w);
        }
        if (!failures.isEmpty()) {
            fail(failures.size() + " of " + cases.size() + " cases differ:\n" + String.join("\n", failures.subList(0, Math.min(20, failures.size()))));
        }
        return cases.size();
    }

    @Test
    void evaluateCases() throws IOException {
        JsonValue doc = load(PARITY);
        assumeTrue(doc != null, "parity fixtures not found");
        assertEquals((double) Engine.VERSION, ((JsonValue.Num) doc.field("engineVersion")).value(), "fixtures engine version");
        int n = runCases(doc, false);
        System.out.println("CONFORMANCE: " + n + "/" + n + " evaluation cases identical (packages/engine/fixtures/parity.json)");
    }

    @Test
    void extraCases() throws IOException {
        JsonValue doc = load(EXTRA);
        assumeTrue(doc != null, "extra fixtures not found");
        int n = runCases(doc, true);
        System.out.println("CONFORMANCE: " + n + "/" + n + " extra evaluation cases identical, V8 error messages included (go/internal/testdata/extra.json)");
    }

    @Test
    void hashing() throws IOException {
        JsonValue doc = load(PARITY);
        assumeTrue(doc != null, "parity fixtures not found");
        List<JsonValue> m = ((JsonValue.Arr) doc.field("murmur3")).items();
        for (JsonValue c : m) {
            String input = ((JsonValue.Str) c.field("input")).value();
            long seed = (long) ((JsonValue.Num) c.field("seed")).value();
            assertEquals((long) ((JsonValue.Num) c.field("hash")).value(), Engine.murmur3(input, seed), "murmur3(" + Js.quote(input) + ", " + seed + ")");
        }
        List<JsonValue> b = ((JsonValue.Arr) doc.field("buckets")).items();
        for (JsonValue c : b) {
            String seed = ((JsonValue.Str) c.field("seed")).value();
            String identity = ((JsonValue.Str) c.field("identity")).value();
            assertEquals(((JsonValue.Num) c.field("bucket")).value(), Engine.bucketOf(seed, identity), 0.0, "bucketOf(" + seed + ", " + identity + ")");
        }
        System.out.println("CONFORMANCE: " + m.size() + " murmur3 vectors and " + b.size() + " buckets identical");
    }

    @Test
    void supportsEngineAndClientBundle() throws IOException {
        JsonValue doc = load(PARITY);
        assumeTrue(doc != null, "parity fixtures not found");
        List<JsonValue> s = ((JsonValue.Arr) doc.field("supportsEngine")).items();
        for (JsonValue c : s) {
            assertEquals(JsonValue.TRUE.equals(c.field("expected")), Engine.supportsEngine(c.field("bundle").field("engine")), js(c.field("bundle")));
        }
        List<JsonValue> cb = ((JsonValue.Arr) doc.field("clientBundle")).items();
        for (JsonValue c : cb) {
            assertEquals(js(c.field("expected")), js(Engine.clientBundle((JsonValue.Obj) c.field("bundle"))));
        }
        System.out.println("CONFORMANCE: " + s.size() + " supportsEngine and " + cb.size() + " clientBundle (browser view) vectors identical");
    }
}
