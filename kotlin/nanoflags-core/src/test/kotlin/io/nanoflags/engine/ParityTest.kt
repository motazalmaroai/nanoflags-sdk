package io.nanoflags.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Cross-language parity: every expected result was produced by the TypeScript engine
 * (packages/engine/fixtures/generate-parity.mjs, shared by every port). The Go port's extra corner cases
 * (packages/sdk-go/internal/testdata/extra.json) are checked too, V8 error messages included.
 */
class ParityTest {
    companion object {
        // Working directory: the module (packages/sdk-kotlin/nanoflags-core, or kotlin/nanoflags-core in the public mirror).
        private val parityCandidates = listOf("../../engine/fixtures/parity.json", "../../packages/engine/fixtures/parity.json")
        private val extraCandidates = listOf("../../sdk-go/internal/testdata/extra.json", "../../go/internal/testdata/extra.json")

        private val cache = HashMap<String, JsonValue>()

        fun load(candidates: List<String>): Pair<JsonValue, File>? {
            val f = candidates.map { File(it) }.firstOrNull { it.isFile } ?: return null
            return cache.getOrPut(f.canonicalPath) { JsonValue.parse(f.readBytes()) } to f.canonicalFile
        }

        fun js(v: JsonValue): String = v.toJson() ?: "undefined"

        fun quote(s: String): String = StringBuilder().also { Js.quote(s, it) }.toString()

        /** Renders a result the way the fixture generator's expectedOf does, with a fixed key order. */
        fun canonicalResult(r: EngineResult, withTrace: Boolean, mask: Boolean): String {
            val b = StringBuilder("{\"reason\":").append(quote(r.reason.wire)).append(",\"revision\":").append(js(r.revision))
            if (!r.value.isUndefined) b.append(",\"value\":").append(js(r.value))
            if (r.ruleIndex >= 0) b.append(",\"ruleIndex\":").append(r.ruleIndex)
            if (!r.ruleId.isUndefined && r.ruleIndex >= 0) b.append(",\"ruleId\":").append(js(r.ruleId))
            r.inRollout?.let { b.append(",\"inRollout\":").append(it) }
            r.bucket?.let { b.append(",\"bucket\":").append(Js.numberToString(it)) }
            if (r.reason == Reason.ERROR) b.append(",\"error\":true")
            if (withTrace) {
                b.append(",\"trace\":[")
                r.trace.forEachIndexed { i, s ->
                    if (i > 0) b.append(',')
                    val detail = if (mask && i == r.trace.size - 1) "<error>" else s.detail
                    b.append("{\"kind\":").append(quote(s.kind)).append(",\"title\":").append(quote(s.title)).append(",\"detail\":").append(quote(detail))
                    s.matched?.let { b.append(",\"matched\":").append(it) }
                    b.append('}')
                }
                b.append(']')
            }
            return b.append('}').toString()
        }

        fun canonicalExpected(e: JsonValue, mask: Boolean): String {
            val b = StringBuilder("{\"reason\":").append(js(e.field("reason"))).append(",\"revision\":").append(js(e.field("revision")))
            for (k in listOf("value", "ruleIndex", "ruleId", "inRollout", "bucket", "error")) {
                val v = e.field(k)
                if (!v.isUndefined) b.append(",\"").append(k).append("\":").append(js(v))
            }
            val tr = e.field("trace")
            if (tr is JsonValue.Arr) {
                b.append(",\"trace\":[")
                tr.items.forEachIndexed { i, s ->
                    if (i > 0) b.append(',')
                    val detail = if (mask && i == tr.items.size - 1) JsonValue.Str("<error>") else s.field("detail")
                    b.append("{\"kind\":").append(js(s.field("kind"))).append(",\"title\":").append(js(s.field("title"))).append(",\"detail\":").append(js(detail))
                    val m = s.field("matched")
                    if (!m.isUndefined) b.append(",\"matched\":").append(js(m))
                    b.append('}')
                }
                b.append(']')
            }
            return b.append('}').toString()
        }

        /** Evaluates every case of a fixture document; returns the number checked. */
        fun runCases(doc: JsonValue, compareErrorMessages: Boolean): Int {
            val bundles = doc.field("bundles") as JsonValue.Arr
            val contexts = doc.field("contexts") as JsonValue.Arr
            val cases = doc.field("cases") as JsonValue.Arr
            val failures = ArrayList<String>()
            cases.items.forEachIndexed { i, c ->
                val bi = (c.field("bundle") as JsonValue.Num).value.toInt()
                val ci = (c.field("context") as JsonValue.Num).value.toInt()
                val flag = (c.field("flag") as JsonValue.Str).value
                val bundle = if (bi >= 0) bundles.items[bi] else JsonValue.Null
                val expected = c.field("expected")
                val withTrace = !expected.field("trace").isUndefined
                val mask = !expected.field("error").isUndefined && !compareErrorMessages
                val got = Engine.evaluate(bundle, flag, ValueContext(contexts.items[ci]), c.field("fallback"))
                var g = canonicalResult(got, withTrace, mask)
                var w = canonicalExpected(expected, mask)
                if (compareErrorMessages) {
                    val msg = expected.field("errorMessage")
                    if (msg is JsonValue.Str && msg.value != got.error) {
                        g += " err=" + quote(got.error ?: "")
                        w += " err=" + quote(msg.value)
                    }
                }
                if (g != w) failures.add("case $i ${js(c.field("name"))}\n got: $g\nwant: $w")
            }
            if (failures.isNotEmpty()) fail("${failures.size} of ${cases.items.size} cases differ:\n" + failures.take(20).joinToString("\n"))
            return cases.items.size
        }
    }

    @Test
    fun evaluateCases() {
        val (doc, path) = load(parityCandidates) ?: return assumeTrue("parity fixtures not found", false)
        assertEquals("fixtures engine version", Engine.VERSION.toDouble(), (doc.field("engineVersion") as JsonValue.Num).value, 0.0)
        val n = runCases(doc, false)
        println("PARITY: $n/$n evaluation cases identical [$path]")
    }

    @Test
    fun extraCases() {
        val (doc, path) = load(extraCandidates) ?: return assumeTrue("extra fixtures not found", false)
        val n = runCases(doc, true)
        println("PARITY: $n/$n extra evaluation cases identical, V8 error messages included [$path]")
    }

    @Test
    fun hashing() {
        val (doc, _) = load(parityCandidates) ?: return assumeTrue("parity fixtures not found", false)
        val m = doc.field("murmur3") as JsonValue.Arr
        for (c in m.items) {
            val input = (c.field("input") as JsonValue.Str).value
            val seed = (c.field("seed") as JsonValue.Num).value.toLong()
            assertEquals("murmur3(${quote(input)}, $seed)", (c.field("hash") as JsonValue.Num).value.toLong(), Engine.murmur3(input, seed))
        }
        val b = doc.field("buckets") as JsonValue.Arr
        for (c in b.items) {
            val seed = (c.field("seed") as JsonValue.Str).value
            val identity = (c.field("identity") as JsonValue.Str).value
            assertEquals("bucketOf($seed, $identity)", (c.field("bucket") as JsonValue.Num).value, Engine.bucketOf(seed, identity), 0.0)
        }
        println("PARITY: ${m.items.size} murmur3 vectors and ${b.items.size} buckets identical")
    }

    @Test
    fun supportsEngineAndClientBundle() {
        val (doc, _) = load(parityCandidates) ?: return assumeTrue("parity fixtures not found", false)
        val s = doc.field("supportsEngine") as JsonValue.Arr
        for (c in s.items) {
            assertEquals(js(c.field("bundle")), c.field("expected") == JsonValue.Bool.TRUE, Engine.supportsEngine(c.field("bundle").field("engine")))
        }
        val cb = doc.field("clientBundle") as JsonValue.Arr
        for (c in cb.items) {
            assertEquals(js(c.field("expected")), js(Engine.clientBundle(c.field("bundle") as JsonValue.Obj)))
        }
        println("PARITY: ${s.items.size} supportsEngine and ${cb.items.size} clientBundle (browser view) vectors identical")
    }
}
