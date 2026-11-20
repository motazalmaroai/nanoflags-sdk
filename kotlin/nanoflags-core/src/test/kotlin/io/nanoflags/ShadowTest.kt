package io.nanoflags

import io.nanoflags.engine.Bundle
import io.nanoflags.engine.JsonValue
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * Shadow evaluation of drafts (migration 0179): the draft of a change waiting for approval is evaluated next to the live
 * bundle for a sample of evaluations; only counters leave the device; the shadow bundle is never applied. Same cases
 * as the JS SDK's test/shadow.test.ts.
 */
class ShadowTest {
    private val edge = FakeEdge(environmentId = ENV)
    private val clients = ArrayList<NanoFlags>()

    companion object {
        const val ENV = "6f0c7c1e-0000-4000-8000-000000000001"
        const val SESSION = "6f1c2a4e-8b1d-4c3e-9f00-1234567890ab"
        const val DRAFT = "0123456789abcdef0123456789abcdef"
    }

    @After
    fun tearDown() {
        clients.forEach { it.close() }
        edge.close()
    }

    /** The draft: new-checkout is on by default (live: off by default, on for plan "pro"). Everything else as live. */
    private fun draft(text: String = edge.bundleText) = text.replace("\"default\":false,\"off\":false,\"rules\":[{\"id\":\"pro\"", "\"default\":true,\"off\":false,\"rules\":[{\"id\":\"pro\"")

    private fun announce(sessionId: String = SESSION, checksum: String = DRAFT, response: () -> okhttp3.mockwebserver.MockResponse = { edge.shadowResponse(draft(), sessionId, checksum) }) {
        edge.shadowHeader = "$sessionId.$checksum"
        edge.shadowBody = response
    }

    private fun client(configure: NanoFlagsOptions.() -> Unit = {}): NanoFlags {
        val c = NanoFlags(TEST_KEY) {
            baseUrl = edge.baseUrl
            live = false
            pollIntervalMs = 0
            service = "checkout-service"
            serviceVersion = "3.1.0"
            verify = VerifyOptions(publicKeys = listOf(edge.key1.jwk), require = true)
            events.sampleRate = 0.0
            events.flushIntervalMs = 60_000
            shadow.sampleRate = 1.0
            configure()
        }
        clients.add(c)
        return c
    }

    private fun errorsOf(c: NanoFlags): MutableList<NanoFlagsException> = CopyOnWriteArrayList<NanoFlagsException>().also { l -> c.addErrorListener { l.add(it) } }

    private fun shadowOf(body: JsonValue): JsonValue = body.field("shadow")
    private fun lastShadow(): JsonValue = shadowOf(edge.events.last())
    private fun pro() = NanoFlagsContext("u", mapOf("plan" to "pro"))
    private fun free(i: Int = 0) = NanoFlagsContext("u$i", mapOf("plan" to "free", "email" to "person$i@example.test", "region" to "DE"))

    /** Waits until the shadow bundle was fetched and checked (it loads in the background). */
    private fun settle(c: NanoFlags) = eventually(what = "shadow bundle") { c.shadow.active }

    private fun settleRejected(errors: List<NanoFlagsException>) = eventually(what = "shadow error") { errors.any { it.code == ErrorCode.SHADOW } }

    @Test
    fun evaluatesTheDraftNeverAppliesItAndReportsOnlyCounters() = runBlocking {
        announce()
        val c = client()
        val errors = errorsOf(c)
        assertTrue(c.waitUntilReady())
        settle(c)
        assertEquals(1, edge.shadowRequests.get())

        // Zero behaviour change: the app always gets the live value.
        repeat(30) { assertFalse(c.boolVariation("new-checkout", true, free(it))) }
        repeat(10) { assertTrue(c.boolVariation("new-checkout", false, pro())) }
        assertEquals("blue", c.stringVariation("accent", "x")) // unchanged flag: not shadowed
        assertEquals(1L, c.revision)
        assertTrue(errors.isEmpty())

        c.flush()
        val report = lastShadow()
        assertEquals(
            """{"sessionId":"$SESSION","checksum":"$DRAFT","version":"3.1.0","flags":[{"flag":"new-checkout","samples":40,"flips":30,"pairs":[{"live":"false","shadow":"true","count":30}],"rules":{"0":10,"default":30}}]}""",
            report.toJson(),
        )
        // No context, attribute or identifier leaves the device with the shadow report.
        val text = report.toJson()!!
        for (s in listOf("example.test", "person", "u1", "plan", "free", "region", "DE", "email")) assertFalse(s, text.contains(s))
        assertEquals("checkout-service", (edge.events.last().field("service") as JsonValue.Str).value)

        // Counters restart after a report: the next flush carries no shadow member.
        c.flush()
        assertTrue(shadowOf(edge.events.last()).isUndefined)
    }

    @Test
    fun samplesAtTheConfiguredRateAndOnlyTheFlagsTheDraftChanges() = runBlocking {
        announce()
        val n = AtomicInteger()
        val draws = AtomicInteger()
        val c = client {
            shadow.sampleRate = 0.25
            shadow.random = { draws.incrementAndGet(); (n.getAndIncrement() % 4) / 4.0 }
        }
        c.waitUntilReady()
        settle(c)
        repeat(100) { c.boolVariation("new-checkout", false, free()) }
        repeat(50) { c.intVariation("limit", 0) }
        assertEquals(100, draws.get()) // unchanged flags never draw
        c.flush()
        assertEquals(
            """[{"flag":"new-checkout","samples":25,"flips":25,"pairs":[{"live":"false","shadow":"true","count":25}],"rules":{"default":25}}]""",
            lastShadow().field("flags").toJson(),
        )
    }

    @Test
    fun aTamperedShadowBundleIsIgnored() = runBlocking {
        announce { edge.shadowResponse(draft(), SESSION, DRAFT, tamper = { it.replace("\"default\":true", "\"default\":\"evil\"") }) }
        val c = client()
        val errors = errorsOf(c)
        c.waitUntilReady()
        settleRejected(errors)
        repeat(5) { assertFalse(c.boolVariation("new-checkout", true, free())) }
        c.flush()
        assertTrue(lastShadow().isUndefined)
        assertEquals(listOf(ErrorCode.SHADOW), errors.map { it.code })
        assertEquals(1L, c.revision)
    }

    @Test
    fun rejectsForgedOrMismatchedShadowBundles() = runBlocking {
        val otherEnv = "6f0c7c1e-0000-4000-8000-000000000999"
        val cases: List<Pair<String, () -> okhttp3.mockwebserver.MockResponse>> = listOf(
            "signed by an unknown key" to { edge.shadowResponse(draft(), SESSION, DRAFT, key = FakeEdge.Key("t1")) },
            "signed as a normal bundle (no domain separation abuse)" to { edge.shadowResponse(draft(), SESSION, DRAFT, bundleDomain = true) },
            "marker of another session inside the signed bytes" to { edge.shadowResponse(draft(), SESSION, DRAFT, markerSession = "11111111-2222-4333-8444-555555555555") },
            "marker of another environment" to { edge.shadowResponse(draft(), SESSION, DRAFT, markerEnv = otherEnv) },
            "signed for another environment" to { edge.shadowResponse(draft(), SESSION, DRAFT, env = otherEnv, markerEnv = otherEnv) },
        )
        for ((name, response) in cases) {
            announce(response = response)
            val c = client()
            val errors = errorsOf(c)
            c.waitUntilReady()
            settleRejected(errors)
            c.boolVariation("new-checkout", true, free())
            c.flush()
            assertTrue(name, lastShadow().isUndefined)
            assertEquals(name, listOf(ErrorCode.SHADOW), errors.map { it.code })
            c.close()
        }
    }

    @Test
    fun aShadowBundleIsNeverAppliedAsConfiguration() = runBlocking {
        val c = client()
        val errors = errorsOf(c)
        assertTrue(c.waitUntilReady())
        assertEquals(1L, c.revision)
        // An attacker (or a bug) serves the shadow bundle on /v1/bundle with a valid bundle signature over its bytes.
        val marker = """{"sessionId":"$SESSION","checksum":"$DRAFT","environmentId":"$ENV","baseRevision":1}"""
        edge.setFlags(2, flags = """{"new-checkout":{"type":"boolean","enabled":true,"clientExposed":true,"default":true,"off":false,"rules":[]}}""")
        edge.bundleText = edge.bundleText.removeSuffix("}") + ""","shadow":$marker}"""
        c.refresh()
        assertEquals(1L, c.revision)
        assertFalse(c.boolVariation("new-checkout", true, free()))
        eventually(what = "error") { errors.any { it.code == ErrorCode.INVALID_BUNDLE } }
        // Nor as a bootstrap, nor through the engine's bundle parser.
        assertNull(Bundle.parse(edge.bundleText))
        val b = NanoFlags(TEST_KEY) { baseUrl = edge.baseUrl; bootstrap = edge.bundleText; network = NetworkState(available = false); events.enabled = false }.also { clients.add(it) }
        assertNull(b.revision)
    }

    @Test
    fun isWithdrawnWhenTheEdgeStopsAnnouncingItPendingCountersGoFirst() = runBlocking {
        announce()
        val c = client()
        c.waitUntilReady()
        settle(c)
        c.boolVariation("new-checkout", false, free())
        edge.shadowHeader = null
        c.refresh() // 304 without the header
        eventually(what = "withdrawn") { !c.shadow.active }
        eventually(what = "pending counters") { edge.events.isNotEmpty() }
        assertEquals(1.0, (lastShadow().field("flags") as JsonValue.Arr).items[0].field("samples").let { (it as JsonValue.Num).value }, 0.0)
        val before = edge.events.size
        c.boolVariation("new-checkout", false, free())
        c.flush()
        assertEquals(before + 1, edge.events.size)
        assertTrue(lastShadow().isUndefined)
    }

    @Test
    fun a404FromTheShadowEndpointDropsTheSession() = runBlocking {
        announce()
        val c = client()
        c.waitUntilReady()
        settle(c)
        // A new announcement whose bundle is already gone.
        announce(checksum = "f".repeat(32)) { okhttp3.mockwebserver.MockResponse().setResponseCode(404) }
        c.refresh()
        eventually(what = "dropped") { !c.shadow.active }
    }

    @Test
    fun aNewDraftReplacesTheSessionTheOldCountersGoOutFirst() = runBlocking {
        announce()
        val c = client()
        c.waitUntilReady()
        settle(c)
        c.boolVariation("new-checkout", false, free())
        val next = "f".repeat(32)
        announce(checksum = next)
        c.refresh()
        eventually(what = "old counters") { edge.events.isNotEmpty() }
        assertEquals(DRAFT, (lastShadow().field("checksum") as JsonValue.Str).value)
        eventually(what = "new session") { c.shadow.checksum == next }
        c.boolVariation("new-checkout", false, free())
        c.flush()
        assertEquals(next, (lastShadow().field("checksum") as JsonValue.Str).value)
        assertEquals("""[{"flag":"new-checkout","samples":1,"flips":1,"pairs":[{"live":"false","shadow":"true","count":1}],"rules":{"default":1}}]""", lastShadow().field("flags").toJson())
    }

    @Test
    fun countersRideWithTimerFlushesAtMostOnceAMinute() = runBlocking {
        announce()
        val c = client { events.sampleRate = 1.0; events.flushIntervalMs = 20 }
        c.waitUntilReady()
        settle(c)
        c.boolVariation("new-checkout", false, free())
        eventually(what = "timer flush") { edge.events.isNotEmpty() }
        Thread.sleep(100)
        assertTrue(edge.events.all { shadowOf(it).isUndefined })
        c.flush()
        assertEquals(1.0, ((lastShadow().field("flags") as JsonValue.Arr).items[0].field("samples") as JsonValue.Num).value, 0.0)
    }

    @Test
    fun goingToTheBackgroundSendsPendingCounters() = runBlocking {
        announce()
        val c = client()
        c.waitUntilReady()
        settle(c)
        c.boolVariation("new-checkout", false, free())
        c.setForeground(false)
        eventually(what = "background flush") { edge.events.any { !shadowOf(it).isUndefined } }
    }

    @Test
    fun closeSendsPendingCounters() = runBlocking {
        announce()
        val c = client()
        c.waitUntilReady()
        settle(c)
        c.boolVariation("new-checkout", false, free())
        c.close()
        eventually(what = "close flush") { edge.events.any { !shadowOf(it).isUndefined } }
    }

    @Test
    fun shadowOffOrEventsOffNeverFetchTheShadowBundle() = runBlocking {
        announce()
        for (configure in listOf<NanoFlagsOptions.() -> Unit>({ shadow.enabled = false }, { events.enabled = false })) {
            val c = client(configure)
            assertTrue(c.waitUntilReady())
            c.refresh()
            Thread.sleep(100)
            assertEquals(0, edge.shadowRequests.get())
            assertFalse(c.shadow.active)
            c.close()
        }
    }

    @Test
    fun withoutVerificationTheShadowBundleIsStillCheckedWithV1Keys() = runBlocking {
        announce()
        val c = client { verify = VerifyOptions.DISABLED }
        c.waitUntilReady()
        settle(c)
        assertEquals(1, edge.keysRequests.get())
        c.boolVariation("new-checkout", false, free())
        c.flush()
        assertEquals(1.0, ((lastShadow().field("flags") as JsonValue.Arr).items[0].field("samples") as JsonValue.Num).value, 0.0)
        // The SDK key is never sent to the public keys endpoint.
        assertNull(edge.requests.last { it.requestUrl?.encodedPath == "/v1/keys" }.getHeader("Authorization"))
    }

    @Test
    fun theAppsOwnDefaultNeverLeavesTheDevice() = runBlocking {
        // A flag only in the draft, and a flag whose draft value has the wrong type.
        val text = draft().replace("\"flags\":{", "\"flags\":{\"brand-new\":{\"type\":\"string\",\"enabled\":true,\"clientExposed\":true,\"default\":\"x\",\"off\":\"off\",\"rules\":[]},")
            .replace("\"default\":\"blue\"", "\"default\":42")
        announce { edge.shadowResponse(text, SESSION, DRAFT) }
        val c = client()
        c.waitUntilReady()
        settle(c)
        assertEquals("alice@example.test", c.stringVariation("brand-new", "alice@example.test"))
        assertEquals("blue", c.stringVariation("accent", "bob@example.test"))
        c.flush()
        val report = lastShadow()
        assertFalse(report.toJson()!!.contains("example.test"))
        val flags = (report.field("flags") as JsonValue.Arr).items.associateBy { (it.field("flag") as JsonValue.Str).value }
        assertEquals("""[{"live":"<fallback>","shadow":"\"x\"","count":1}]""", flags.getValue("brand-new").field("pairs").toJson())
        assertEquals("""[{"live":"\"blue\"","shadow":"<fallback>","count":1}]""", flags.getValue("accent").field("pairs").toJson())
    }

    /* ---------------- helpers ---------------- */

    @Test
    fun parsesTheAnnouncementHeader() {
        assertEquals(ShadowWire.Announcement(SESSION, DRAFT), ShadowWire.parseHeader("$SESSION.$DRAFT"))
        assertEquals(ShadowWire.Announcement(SESSION, DRAFT), ShadowWire.parseHeader(" ${SESSION.uppercase()}.${DRAFT.uppercase()} "))
        for (bad in listOf(null, "", "x.y", SESSION, "$SESSION.${DRAFT}x", "not-a-uuid-not-a-uuid-not-a-uuid-xxx.$DRAFT")) assertNull(bad, ShadowWire.parseHeader(bad))
    }

    private fun obj(text: String) = JsonValue.parse(text) as JsonValue.Obj

    @Test
    fun changedFlagsConfigurationDifferencesAndChangedSegmentsWhateverTheKeyOrder() {
        val live = obj(edge.bundleText)
        assertEquals(emptySet<String>(), ShadowWire.changedFlags(live, live))
        val reordered = obj(edge.bundleText.replace("\"type\":\"string\",\"enabled\":true", "\"enabled\":true,\"type\":\"string\""))
        assertEquals(emptySet<String>(), ShadowWire.changedFlags(live, reordered))
        assertEquals(setOf("new-checkout"), ShadowWire.changedFlags(live, obj(draft())))
        val added = obj(edge.bundleText.replace("\"flags\":{", "\"flags\":{\"brand_new\":{\"type\":\"boolean\",\"enabled\":true,\"default\":true,\"off\":false,\"rules\":[]},"))
        assertEquals(setOf("brand_new"), ShadowWire.changedFlags(live, added))
    }

    @Test
    fun changedFlagsSegmentsInsideSegmentsAndRemovedSegmentsCount() {
        fun flag(op: String, v: String) = """{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"r","match":"all","conditions":[{"attribute":"","op":"$op","value":"$v"}],"serve":{"type":"fixed","value":true}}]}"""
        val g = """{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[]}"""
        fun bundle(flags: String, segments: String) = obj("""{"schema":1,"project":"p","environment":"e","revision":1,"flags":$flags,"segments":$segments}""")
        fun nested(v: Int) = bundle("""{"f":${flag("segment", "a")},"g":$g}""", """{"a":{"match":"all","conditions":[{"attribute":"","op":"segment","value":"b"}]},"b":{"match":"all","conditions":[{"attribute":"x","op":"eq","value":$v}]}}""")
        assertEquals(setOf("f"), ShadowWire.changedFlags(nested(1), nested(2)))
        assertEquals(emptySet<String>(), ShadowWire.changedFlags(nested(1), nested(1)))
        val withC = bundle("""{"f":${flag("not_segment", "a")},"g":$g}""", """{"a":{"match":"any","conditions":[{"attribute":"","op":"segment","value":"c"}]},"c":{"match":"all","conditions":[]}}""")
        val withoutC = bundle("""{"f":${flag("not_segment", "a")},"g":$g}""", """{"a":{"match":"any","conditions":[{"attribute":"","op":"segment","value":"c"}]}}""")
        assertEquals(setOf("f"), ShadowWire.changedFlags(withC, withoutC))
        // A cycle terminates.
        val EXTRA = ",{\"attribute\":\"x\",\"op\":\"eq\",\"value\":1}"
        fun cyc(extra: Boolean) = bundle(
            """{"f":${flag("segment", "a")},"g":$g}""",
            """{"a":{"match":"all","conditions":[{"attribute":"","op":"segment","value":"b"}]},"b":{"match":"all","conditions":[{"attribute":"","op":"segment","value":"a"}${if (extra) EXTRA else ""}]}}""",
        )
        assertEquals(setOf("f"), ShadowWire.changedFlags(cyc(false), cyc(true)))
    }

    @Test
    fun flipsAreDecidedIndependentlyOfObjectKeyOrder() {
        val c = ShadowCounters(SESSION, DRAFT)
        c.add("cfg", JsonValue.parse("""{"a":1,"b":2}"""), JsonValue.parse("""{"b":2,"a":1}"""), -1)
        c.add("cfg", JsonValue.parse("""{"a":1,"b":{"e":1,"c":2}}"""), JsonValue.parse("""{"b":{"c":2,"e":1},"a":1}"""), -1)
        assertEquals("""{"flag":"cfg","samples":2,"flips":0,"pairs":[],"rules":{"default":2}}""", (c.report(null).field("flags") as JsonValue.Arr).items[0].toJson())
        assertEquals("""{"a":1,"b":2}""", ShadowWire.reprValue(JsonValue.parse("""{"b":2,"a":1}""")))
    }

    @Test
    fun valuesAreJsonTextUpTo100CharactersLongerOnesHashed() {
        assertEquals("true", ShadowWire.reprValue(JsonValue.Bool.of(true)))
        assertEquals("\"blue\"", ShadowWire.reprValue(JsonValue.Str("blue")))
        assertEquals("""{"a":1}""", ShadowWire.reprValue(JsonValue.parse("""{"a":1}""")))
        assertEquals("1.5", ShadowWire.reprValue(JsonValue.Num(1.5)))
        assertEquals("null", ShadowWire.reprValue(JsonValue.Undefined))
        // Same hashes as the JS SDK (murmur3 of the canonical JSON text).
        assertEquals("#6685751d", ShadowWire.reprValue(JsonValue.Str("x".repeat(200))))
        assertEquals("#e30d3d0f", ShadowWire.reprValue(JsonValue.Obj.of("long" to JsonValue.Str("é".repeat(120)), "a" to JsonValue.Num(1.0))))
    }

    @Test
    fun countersAreBounded() {
        val c = ShadowCounters(SESSION, DRAFT)
        for (i in 0 until ShadowWire.MAX_FLAGS + 20) c.add("f$i", JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        assertEquals(ShadowWire.MAX_FLAGS, c.size)
        val p = ShadowCounters(SESSION, DRAFT)
        for (i in 0 until 50) p.add("color", JsonValue.Str("a"), JsonValue.Str("b$i"), i)
        val r = (p.report(null).field("flags") as JsonValue.Arr).items[0]
        assertEquals(50.0, (r.field("samples") as JsonValue.Num).value, 0.0)
        assertEquals(50.0, (r.field("flips") as JsonValue.Num).value, 0.0)
        val pairs = (r.field("pairs") as JsonValue.Arr).items
        assertEquals(ShadowWire.MAX_PAIRS, pairs.size)
        assertEquals("""{"live":"*","shadow":"*","count":${50 - (ShadowWire.MAX_PAIRS - 1)}}""", pairs.last().toJson())
        assertEquals(50.0, pairs.sumOf { (it.field("count") as JsonValue.Num).value }, 0.0)
        assertEquals(50, (r.field("rules") as JsonValue.Obj).size)
        assertTrue(p.report(null).field("version").isUndefined)
        assertNotNull(p.report("1.0").field("version") as? JsonValue.Str)
    }

    @Test
    fun skipsFlagKeysTheEdgeWouldRefuseAndStopsAFlagsCountersAt10To7Samples() {
        assertEquals(63, ShadowWire.MAX_FLAG_KEY)
        assertEquals(10_000_000L, ShadowWire.MAX_COUNT)
        val c = ShadowCounters(SESSION, DRAFT)
        c.add("k".repeat(64), JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        c.add("", JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        assertEquals(0, c.size)
        c.add("k".repeat(63), JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        // Counted in UTF-16 code units, as the edge does: 31 emoji (surrogate pairs) + 1 = 63; 32 emoji = 64.
        c.add("\uD83D\uDE00".repeat(31) + "x", JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        c.add("\uD83D\uDE00".repeat(32), JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        assertEquals(2, c.size)
        val big = ShadowCounters(SESSION, DRAFT)
        big.add("big", JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        for (i in 1 until ShadowWire.MAX_COUNT.toInt()) big.add("big", JsonValue.Bool.TRUE, JsonValue.Bool.TRUE, 0)
        big.add("big", JsonValue.Bool.FALSE, JsonValue.Bool.TRUE, 0)
        big.add("big", JsonValue.Bool.TRUE, JsonValue.Bool.TRUE, 1)
        assertEquals(
            """{"flag":"big","samples":10000000,"flips":1,"pairs":[{"live":"false","shadow":"true","count":1}],"rules":{"0":10000000}}""",
            (big.report(null).field("flags") as JsonValue.Arr).items[0].toJson(),
        )
    }
}
