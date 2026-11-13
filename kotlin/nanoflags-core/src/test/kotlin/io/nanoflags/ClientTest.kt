package io.nanoflags

import io.nanoflags.engine.JsonValue
import io.nanoflags.engine.Reason
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

const val TEST_KEY = "nf_pub_testkey"

fun eventually(timeoutMs: Long = 5_000, what: String = "condition", cond: () -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
        if (cond()) return
        Thread.sleep(10)
    }
    if (!cond()) fail("timed out waiting for $what")
}

class ClientTest {
    private val edge = FakeEdge()
    private val clients = ArrayList<NanoFlags>()

    @After
    fun tearDown() {
        clients.forEach { it.close() }
        edge.close()
    }

    private fun client(configure: NanoFlagsOptions.() -> Unit = {}): NanoFlags {
        val c = NanoFlags(TEST_KEY) {
            baseUrl = edge.baseUrl
            verify = VerifyOptions(publicKeys = listOf(edge.key1.jwk), require = true)
            events.enabled = false
            configure()
        }
        clients.add(c)
        return c
    }

    @Test
    fun refusesServerAndMalformedKeys() {
        for (k in listOf("nf_srv_0123", "", "abc")) {
            try {
                NanoFlags(k)
                fail("accepted $k")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    @Test
    fun loadsVerifiedBundleAndEvaluates() = runBlocking {
        val c = client { live = false; context = NanoFlagsContext("user-1", mapOf("plan" to "free")) }
        assertTrue(c.waitUntilReady())
        assertEquals(Status.READY, c.status.value)
        assertEquals(1L, c.revision)
        assertEquals("t1", c.verifiedKeyId)
        assertFalse(c.boolVariation("new-checkout", true))
        assertTrue(c.boolVariation("new-checkout", false, NanoFlagsContext("user-1", mapOf("plan" to "pro"))))
        assertEquals("blue", c.stringVariation("accent", "x"))
        assertEquals(3.0, c.doubleVariation("limit", 0.0), 0.0)
        assertEquals(3, c.intVariation("limit", 0))
        assertEquals("""{"dark":true,"radius":4}""", c.jsonVariation("theme", JsonValue.Null).toJson())
        // Type mismatch and missing flags return the default with an explanation.
        val mismatch = c.stringVariationDetail("new-checkout", "fallback")
        assertEquals("fallback", mismatch.value)
        assertEquals(Reason.ERROR, mismatch.reason)
        assertEquals(Reason.FLAG_NOT_FOUND, c.boolVariationDetail("nope", true).reason)
        val d = c.boolVariationDetail("new-checkout", false, NanoFlagsContext("u", mapOf("plan" to "pro")))
        assertEquals(Reason.RULE_MATCH, d.reason)
        assertEquals("pro", d.ruleId)
        assertEquals(0, d.ruleIndex)
        val r = c.boolVariationDetail("rollout", false)
        assertNotNull(r.bucket)
        assertEquals(listOf("new-checkout", "accent", "limit", "theme", "rollout"), c.allFlags().keys.toList())
        // Every request carries the SDK's User-Agent; the key never travels in a URL.
        assertTrue(edge.requests.all { it.getHeader("User-Agent")!!.startsWith("nanoflags-kotlin/${BuildInfo.VERSION}") })
        assertTrue(edge.requests.none { it.requestUrl.toString().contains("nf_pub_") })
    }

    @Test
    fun identifyChangesEvaluationWithoutNetwork() = runBlocking {
        val c = client { live = false; pollIntervalMs = 0 }
        assertTrue(c.waitUntilReady())
        val before = edge.bundleRequests.get()
        val seen = CopyOnWriteArrayList<Boolean>()
        val flow = c.boolFlow("new-checkout", false)
        assertFalse(flow.first())
        c.identify(NanoFlagsContext("user-9", mapOf("plan" to "pro")))
        assertTrue(c.boolVariation("new-checkout", false))
        assertTrue(flow.first())
        c.setContext(NanoFlagsContext.build("user-9") { set("plan", "free") })
        seen.add(flow.first())
        assertEquals(listOf(false), seen)
        assertEquals(before, edge.bundleRequests.get())
    }

    @Test
    fun refusesUnsignedAndTamperedBundles() = runBlocking {
        edge.signed = false
        val c = client { live = false }
        assertFalse(c.waitUntilReady())
        assertEquals(Status.NOT_READY, c.status.value)
        assertEquals(ErrorCode.SIGNATURE, c.lastLoadError?.code)
        edge.signed = true
        edge.tamperHttp = true
        assertFalse(c.refresh())
        assertEquals(ErrorCode.SIGNATURE, c.lastLoadError?.code)
        assertNull(c.revision)
        edge.tamperHttp = false
        assertTrue(c.refresh())
        assertEquals(1L, c.revision)
        // A newer revision validly signed for another environment is refused (the environment is pinned).
        edge.environmentId = "env-other"
        edge.setFlags(2, "{}")
        assertFalse(c.refresh())
        assertTrue(c.lastLoadError!!.message!!.contains("different environment"))
        assertEquals(1L, c.revision)
    }

    @Test
    fun etagRevalidationReturns304() = runBlocking {
        val c = client { live = false }
        assertTrue(c.waitUntilReady())
        assertTrue(c.refresh())
        assertTrue(edge.notModified.get() >= 1)
        assertEquals(Status.READY, c.status.value)
    }

    @Test
    fun unknownKidLoadsKeysOnceRateLimited() = runBlocking {
        val k2 = FakeEdge.Key("t2")
        edge.published.add(k2)
        edge.signingKey = k2
        val c = client { live = false; verify = VerifyOptions(publicKeys = listOf(edge.key1.jwk), fetchKeys = true, require = true) }
        assertTrue(c.waitUntilReady())
        assertEquals("t2", c.verifiedKeyId)
        assertEquals(1, edge.keysRequests.get())
        // A key id nobody knows: at most one /v1/keys reload per minute.
        val k3 = FakeEdge.Key("t3")
        edge.signingKey = k3
        edge.setFlags(2, "{}")
        assertFalse(c.refresh())
        assertFalse(c.refresh())
        assertEquals(1, edge.keysRequests.get())
        assertEquals(1L, c.revision)
    }

    @Test
    fun officialEdgeDefaultsVerifyWithEmbeddedKeys() {
        // Default options on the official edge: embedded keys, unsigned refused (no request is made here).
        val v = Verifier.create(null, official = true, client = NanoFlags(TEST_KEY) { events.enabled = false; network = NetworkState(available = false) }.also { clients.add(it) })
        assertNotNull(v)
        assertTrue(v!!.require)
        assertNull(Verifier.create(null, official = false, client = clients[0]))
    }

    @Test
    fun livePushAdoptsVerifiedRevisions() = runBlocking {
        val changes = CopyOnWriteArrayList<ChangeEvent>()
        val c = client { pollIntervalMs = 60_000 }
        c.addChangeListener { changes.add(it) }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { c.transport.value == Transport.LIVE }
        edge.committedAt = System.currentTimeMillis() - 5
        edge.setFlags(2, """{"accent":{"type":"string","enabled":true,"clientExposed":true,"default":"green","off":"blue","rules":[]}}""")
        edge.push()
        eventually(what = "pushed r2") { c.revision == 2L }
        assertEquals("green", c.stringVariation("accent", "x"))
        val ev = changes.last { it.revision == 2L }
        assertEquals(Transport.LIVE, ev.transport)
        assertNotNull(ev.latencyMs)
        // A tampered push is refused and changes nothing.
        val errors = CopyOnWriteArrayList<NanoFlagsException>()
        c.addErrorListener { errors.add(it) }
        Thread.sleep(50)
        edge.setFlags(3, """{"accent":{"type":"string","enabled":true,"clientExposed":true,"default":false,"off":"blue","rules":[]}}""")
        edge.push(tamper = true)
        eventually(what = "signature error") { errors.any { it.code == ErrorCode.SIGNATURE } }
        // The rejection triggers a verified request, which may adopt the genuine r3; the tampered value never shows.
        Thread.sleep(300)
        assertTrue(c.evaluate("accent").value != true)
    }

    @Test
    fun closeCode4004StopsAndKeepsConfiguration() = runBlocking {
        val errors = CopyOnWriteArrayList<NanoFlagsException>()
        val c = client { pollIntervalMs = 60_000 }
        c.addErrorListener { errors.add(it) }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { edge.sockets.size == 1 }
        edge.closeSockets(CLOSE_ENVIRONMENT_DELETED, "environment deleted")
        eventually(what = "environment_deleted") { errors.any { it.code == ErrorCode.ENVIRONMENT_DELETED } }
        assertEquals(Status.STALE, c.status.value)
        assertEquals(1L, c.revision)
        Thread.sleep(2_500)
        assertEquals("no reconnect after 4004", 1, edge.liveConnects.get())
    }

    @Test
    fun reconnectsAfterDrop() = runBlocking {
        val c = client { pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { edge.sockets.size == 1 }
        edge.closeSockets(1011, "restart")
        eventually(8_000, "reconnect") { edge.liveConnects.get() >= 2 && c.transport.value == Transport.LIVE }
    }

    @Test
    fun backgroundPausesAndForegroundResumes() = runBlocking {
        val c = client { pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { edge.sockets.size == 1 }
        c.setForeground(false)
        eventually(what = "socket closed") { edge.sockets.isEmpty() && c.transport.value == Transport.PAUSED }
        val requests = edge.bundleRequests.get()
        Thread.sleep(300)
        assertEquals(requests, edge.bundleRequests.get())
        // A revision published while in the background arrives on resume (hello / revalidation).
        edge.setFlags(5, "{}")
        c.setForeground(true)
        eventually(what = "resumed") { c.revision == 5L && c.transport.value == Transport.LIVE }
    }

    @Test
    fun meteredAndDataSaverPolicies() = runBlocking {
        val c = client { pollIntervalMs = 60_000; meteredPolicy = NetworkPolicy.POLL; dataSaverPolicy = NetworkPolicy.OFFLINE; network = NetworkState(available = true, metered = true) }
        assertTrue(c.waitUntilReady())
        Thread.sleep(300)
        assertEquals(0, edge.liveConnects.get())
        assertEquals(Transport.POLL, c.transport.value)
        c.setNetworkState(NetworkState(available = true, metered = true, dataSaver = true))
        eventually(what = "paused") { c.transport.value == Transport.PAUSED }
        assertEquals(Status.STALE, c.status.value)
        c.setNetworkState(NetworkState(available = true))
        eventually(what = "live") { c.transport.value == Transport.LIVE && c.status.value == Status.READY }
    }

    @Test
    fun persistsAndRestoresVerifiedBundleOffline() = runBlocking {
        val store = InMemoryBundleStore()
        val a = client { live = false; this.store = store }
        assertTrue(a.waitUntilReady())
        eventually(what = "persisted") { store.load() != null }
        a.close()
        assertTrue(store.load()!!.contains("\"sig\""))
        // Offline start: the persisted copy is re-verified and used, status stale.
        val b = client { live = false; this.store = store; network = NetworkState(available = false) }
        assertTrue(b.waitUntilReady(2_000))
        assertEquals(Status.STALE, b.status.value)
        assertEquals(1L, b.revision)
        assertEquals("t1", b.verifiedKeyId)
        // Back online: revalidated with the persisted ETag (304) and ready.
        b.setNetworkState(NetworkState(available = true))
        eventually(what = "ready") { b.status.value == Status.READY }
        assertTrue(edge.notModified.get() >= 1)
        // A tampered store is refused.
        val tampered = InMemoryBundleStore().apply { save(store.load()!!.replace("\\\"default\\\":false", "\\\"default\\\":true")) }
        val logs = CopyOnWriteArrayList<String>()
        val d = client { live = false; this.store = tampered; pollIntervalMs = 0; logger = { logs.add(it) }; network = NetworkState(available = false) }
        assertFalse(d.waitUntilReady(1_000))
        assertNull(d.revision)
        eventually(what = "store signature error") { logs.any { it.contains("failed signature verification") } }
    }

    @Test
    fun bootstrapIsUsedUntilTheNetworkAnswers() = runBlocking {
        edge.bundleStatus = 503
        val c = client {
            live = false
            bootstrap = """{"schema":1,"project":"p","environment":"production","revision":0,"flags":{"accent":{"type":"string","enabled":true,"default":"orange","off":"blue","rules":[]}},"segments":{}}"""
        }
        assertTrue(c.waitUntilReady())
        assertEquals("orange", c.stringVariation("accent", "x"))
        edge.bundleStatus = 200
        assertTrue(c.refresh())
        assertEquals("blue", c.stringVariation("accent", "x"))
    }

    @Test
    fun newerEngineIsRefused() = runBlocking {
        edge.setFlags(1, "{}", engine = 99)
        val c = client { live = false }
        assertFalse(c.waitUntilReady())
        assertEquals(ErrorCode.ENGINE, c.lastLoadError?.code)
    }

    @Test
    fun telemetrySendsAttributeNamesAndTypesOnly() = runBlocking {
        val c = client {
            live = false
            service = "test-app"
            events.enabled = true
            events.sampleRate = 1.0
            context = NanoFlagsContext("secret-user", mapOf("plan" to "pro", "email" to "a@b.c"))
        }
        assertTrue(c.waitUntilReady())
        c.boolVariation("new-checkout", false)
        c.boolVariation("rollout", false)
        c.flush()
        eventually(what = "events") { edge.events.isNotEmpty() }
        val body = edge.events.first()
        assertEquals("test-app", (body.field("service") as JsonValue.Str).value)
        assertEquals("kotlin/${BuildInfo.VERSION}", (body.field("sdk") as JsonValue.Str).value)
        val text = body.toJson()!!
        assertFalse(text.contains("secret-user"))
        assertFalse(text.contains("a@b.c"))
        val evs = (body.field("events") as JsonValue.Arr).items
        assertEquals("""{"plan":"string"}""", evs[0].field("context").toJson())
        assertEquals("""{"key":"string"}""", evs[1].field("context").toJson())
    }

    @Test
    fun telemetryOptOutSendsNothing() = runBlocking {
        val c = client { live = false; events.enabled = false }
        assertTrue(c.waitUntilReady())
        repeat(20) { c.boolVariation("new-checkout", false) }
        c.flush()
        c.close()
        Thread.sleep(300)
        assertTrue(edge.events.isEmpty())
    }

    @Test
    fun rejectedKeyIsReported() = runBlocking {
        edge.bundleStatus = 401
        val c = client { live = false }
        assertFalse(c.waitUntilReady())
        assertEquals(ErrorCode.UNAUTHORIZED, c.lastLoadError?.code)
    }

    @Test
    fun changesFlowEmits() = runBlocking {
        val c = client { pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { edge.sockets.size == 1 }
        val got = async(start = CoroutineStart.UNDISPATCHED) { withTimeout(5_000) { c.changes.take(1).toList() } }
        Thread.sleep(100)
        edge.setFlags(7, "{}")
        edge.push()
        assertEquals(7L, got.await().single().revision)
    }
}
