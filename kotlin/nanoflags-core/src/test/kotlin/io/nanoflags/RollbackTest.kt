package io.nanoflags

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Rollback protection (an older revision than one already verified is never adopted), the status after a rejected
 * update, the same-message check and the official edge address.
 */
class RollbackTest {
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
            live = false
            pollIntervalMs = 0
            configure()
        }
        clients.add(c)
        return c
    }

    private fun errorsOf(c: NanoFlags): CopyOnWriteArrayList<NanoFlagsException> {
        val errors = CopyOnWriteArrayList<NanoFlagsException>()
        c.addErrorListener { errors.add(it) }
        Thread.sleep(50)
        return errors
    }

    private fun accent(rev: Long, value: String) =
        edge.setFlags(rev, """{"accent":{"type":"string","enabled":true,"clientExposed":true,"default":"$value","off":"blue","rules":[]}}""")

    @Test
    fun fetchRefusesAnOlderSignedRevisionAndTurnsStale() = runBlocking {
        accent(5, "v5")
        val c = client()
        assertTrue(c.waitUntilReady())
        val errors = errorsOf(c)
        assertEquals(5L, c.revision)

        // A replayed answer for r4: genuinely signed, so signature verification alone accepts it.
        accent(4, "v4")
        assertFalse(c.refresh())
        assertEquals(5L, c.revision)
        assertEquals("v5", c.stringVariation("accent", "x"))
        assertEquals(listOf(ErrorCode.ROLLBACK), errors.map { it.code })
        assertTrue(errors[0].message!!.contains("older than r5"))
        assertEquals(Status.STALE, c.status.value)
        assertEquals(ErrorCode.ROLLBACK, c.lastLoadError?.code)

        // The edge answers the current revision again: ready; newer revisions are adopted as usual.
        accent(5, "v5")
        assertTrue(c.refresh())
        assertEquals(Status.READY, c.status.value)
        assertNull(c.lastLoadError)
        accent(6, "v6")
        assertTrue(c.refresh())
        assertEquals(6L, c.revision)
    }

    @Test
    fun anOlderCopyMarkedStaleByTheEdgeKeepsTodaysBehaviour() = runBlocking {
        accent(5, "v5")
        val c = client()
        assertTrue(c.waitUntilReady())
        val errors = errorsOf(c)
        accent(4, "v4")
        edge.staleMarker = true
        assertTrue(c.refresh())
        assertEquals(5L, c.revision)
        assertEquals(Status.STALE, c.status.value)
        assertTrue(errors.isEmpty())
    }

    @Test
    fun aRestoredRevisionIsAdoptedNormally() = runBlocking {
        accent(7, "v7")
        val c = client()
        assertTrue(c.waitUntilReady())
        // "Restore r5" publishes r5's content as the new, higher r8.
        accent(8, "v5")
        assertTrue(c.refresh())
        assertEquals(8L, c.revision)
        assertEquals("v5", c.stringVariation("accent", "x"))
        assertEquals(Status.READY, c.status.value)
    }

    @Test
    fun aBundleSignedForAnotherEnvironmentNeverMovesTheFloor() = runBlocking {
        accent(5, "v5")
        val c = client()
        assertTrue(c.waitUntilReady())
        edge.environmentId = "env-other"
        accent(900, "v900")
        assertFalse(c.refresh())
        assertEquals(ErrorCode.SIGNATURE, c.lastLoadError?.code)
        edge.environmentId = "env-test-1"
        accent(6, "v6")
        assertTrue(c.refresh())
        assertEquals(6L, c.revision)
    }

    @Test
    fun unverifiedSourcesNeverBlockUpdates() = runBlocking {
        accent(5, "v5")
        val boot = client {
            bootstrap = """{"schema":1,"project":"p","environment":"production","revision":9,"flags":{"accent":{"type":"string","enabled":true,"default":"orange","off":"blue","rules":[]}},"segments":{}}"""
        }
        assertTrue(boot.waitUntilReady())
        assertTrue(boot.refresh())
        assertEquals(5L, boot.revision) // the bootstrap is trusted as given but is not a verified revision

        // Without verification there is nothing to anchor a revision on.
        val off = client { verify = VerifyOptions.DISABLED }
        assertTrue(off.waitUntilReady())
        accent(4, "v4")
        assertTrue(off.refresh())
        assertEquals(4L, off.revision)
        assertNull(off.lastLoadError)
    }

    @Test
    fun anUnsignedOlderAnswerDoesNotGetAroundIt() = runBlocking {
        accent(5, "v5")
        val c = client { verify = VerifyOptions(publicKeys = listOf(edge.key1.jwk), require = false) }
        assertTrue(c.waitUntilReady())
        accent(4, "v4")
        edge.signed = false
        assertFalse(c.refresh())
        assertEquals(5L, c.revision)
        assertEquals(ErrorCode.ROLLBACK, c.lastLoadError?.code)
        // An unsigned NEWER answer is still accepted with `require = false`, as before.
        accent(6, "v6")
        assertTrue(c.refresh())
        assertEquals(6L, c.revision)
    }

    @Test
    fun theStoreAnchorsTheFloorAcrossARestart() = runBlocking {
        val store = InMemoryBundleStore()
        accent(5, "v5")
        val first = client { this.store = store }
        assertTrue(first.waitUntilReady())
        eventually(what = "persisted") { store.load() != null }
        first.close()

        accent(4, "v4")
        val c = client { this.store = store }
        assertTrue(c.waitUntilReady())
        eventually(what = "rollback") { c.lastLoadError?.code == ErrorCode.ROLLBACK }
        assertEquals(5L, c.revision)
        assertEquals(Status.STALE, c.status.value)
        assertEquals("v5", c.stringVariation("accent", "x"))

        // A stored copy older than the edge's revision is the normal case: replaced, no error.
        accent(6, "v6")
        val d = client { this.store = store }
        assertTrue(d.waitUntilReady())
        eventually(what = "r6") { d.revision == 6L && d.status.value == Status.READY }
        assertNull(d.lastLoadError)
    }

    @Test
    fun anotherSdkKeyDoesNotReadTheOldKeysStoredCopy() = runBlocking {
        val store = InMemoryBundleStore()
        accent(5, "v5")
        val first = client { this.store = store }
        assertTrue(first.waitUntilReady())
        eventually(what = "persisted") { store.load() != null }
        first.close()
        accent(4, "v4")
        val rotated = NanoFlags("nf_pub_rotated") {
            baseUrl = edge.baseUrl
            verify = VerifyOptions(publicKeys = listOf(edge.key1.jwk), require = true)
            events.enabled = false; live = false; pollIntervalMs = 0
            this.store = store
        }.also { clients.add(it) }
        assertTrue(rotated.waitUntilReady())
        assertEquals(4L, rotated.revision)
        assertNull(rotated.lastLoadError)
    }

    @Test
    fun livePushOlderThanVerifiedIsRefusedAndReported() = runBlocking {
        accent(5, "v5")
        val c = client { live = true; pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { c.transport.value == Transport.LIVE }
        val errors = errorsOf(c)
        accent(6, "v6")
        edge.push()
        eventually(what = "pushed r6") { c.revision == 6L }

        accent(4, "v4")
        edge.push()
        eventually(what = "rollback error") { errors.any { it.code == ErrorCode.ROLLBACK } }
        assertEquals(6L, c.revision)
        assertEquals("v6", c.stringVariation("accent", "x"))
        assertEquals(Status.STALE, c.status.value)
    }

    @Test
    fun anHttpAnswerTrailingALivePushIsDroppedWithoutAnError() = runBlocking {
        accent(5, "v5")
        val c = client { live = true; pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { c.transport.value == Transport.LIVE }
        val errors = errorsOf(c)
        accent(6, "v6")
        edge.push()
        eventually(what = "pushed r6") { c.revision == 6L }
        // The HTTP path still answers the previous revision for a moment.
        accent(5, "v5")
        c.refresh()
        assertEquals(6L, c.revision)
        assertTrue(errors.none { it.code == ErrorCode.ROLLBACK })
        assertEquals(Status.READY, c.status.value)
    }

    @Test
    fun aTamperedUpdateTurnsStaleUntilABundleVerifies() = runBlocking {
        accent(3, "v3")
        val c = client()
        assertTrue(c.waitUntilReady())
        accent(4, "v4")
        edge.tamperHttp = true
        edge.bundleText = edge.bundleText.replace("\"default\":\"v4\"", "\"default\":false")
        assertFalse(c.refresh())
        assertEquals(3L, c.revision)
        assertEquals(Status.STALE, c.status.value)
        assertEquals(ErrorCode.SIGNATURE, c.lastLoadError?.code)
        edge.tamperHttp = false
        accent(4, "v4")
        assertTrue(c.refresh())
        assertEquals(4L, c.revision)
        assertEquals(Status.READY, c.status.value)
    }

    @Test
    fun anUnsignedAnswerWhilePublishingDoesNotMakeTheClientStale() = runBlocking {
        accent(3, "v3")
        val c = client()
        assertTrue(c.waitUntilReady())
        accent(4, "v4")
        edge.signed = false
        assertFalse(c.refresh())
        assertEquals(Status.READY, c.status.value)
        assertEquals(ErrorCode.SIGNATURE, c.lastLoadError?.code)
        edge.signed = true
        assertTrue(c.refresh())
        assertEquals(4L, c.revision)
    }

    @Test
    fun anUnsupportedEngineLeavesTheStatusUnchanged() = runBlocking {
        accent(3, "v3")
        val c = client()
        assertTrue(c.waitUntilReady())
        edge.setFlags(4, "{}", engine = 99)
        assertFalse(c.refresh())
        assertEquals(ErrorCode.ENGINE, c.lastLoadError?.code)
        assertEquals(Status.READY, c.status.value)
        assertEquals(3L, c.revision)
    }

    @Test
    fun aRejectedPushTurnsAClientWithAConfigurationStale() = runBlocking {
        accent(3, "v3")
        val c = client { live = true; pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { c.transport.value == Transport.LIVE }
        val errors = errorsOf(c)
        edge.setFlags(4, """{"f":{"type":"boolean","enabled":true,"clientExposed":true,"default":false,"off":false,"rules":[]}}""")
        edge.bundleStatus = 503 // the verified request path cannot confirm anything meanwhile
        edge.push(tamper = true)
        eventually(what = "signature error") { errors.any { it.code == ErrorCode.SIGNATURE } }
        eventually(what = "stale") { c.status.value == Status.STALE }
        assertEquals(3L, c.revision)
    }

    @Test
    fun aPushWithTheSameRevisionButOtherContentDoesNotConfirmTheConfigurationInUse() = runBlocking {
        accent(3, "v3")
        val c = client { live = true; pollIntervalMs = 60_000 }
        assertTrue(c.waitUntilReady())
        eventually(what = "live socket") { c.transport.value == Transport.LIVE }
        val genuine = edge.bundleText
        // Make the client stale: the edge's HTTP path fails, nothing else changes.
        edge.bundleStatus = 503
        assertFalse(c.refresh())
        assertEquals(Status.STALE, c.status.value)
        // Same revision number, other content.
        edge.bundleText = genuine.replace("\"default\":\"v3\"", "\"default\":\"attacker\"")
        edge.push()
        Thread.sleep(300)
        assertEquals(Status.STALE, c.status.value)
        assertEquals("v3", c.stringVariation("accent", "x"))
        // The very same signed message confirms it.
        edge.bundleText = genuine
        edge.push()
        eventually(what = "confirmed") { c.status.value == Status.READY }
    }

    @Test
    fun theOfficialEdgeAddressIsRecognisedInEverySpelling() {
        for (u in listOf("https://edge.nanoflags.io", "https://edge.nanoflags.io/", "https://edge.nanoflags.io///", "https://EDGE.nanoflags.io:443", "https://edge.nanoflags.io./", "https://edge.nanoflags.io:443/")) {
            assertEquals(u, OFFICIAL_EDGE_URL, normalizeBaseUrl(u))
            val c = offlineClient(u)
            assertEquals(u, OFFICIAL_EDGE_URL, c.baseUrl)
            val v = Verifier.create(null, official = c.baseUrl == OFFICIAL_EDGE_URL, client = c)
            assertNotNull(u, v)
            assertTrue(u, v!!.require)
        }
    }

    @Test
    fun otherAddressesStayNotOfficial() {
        for (u in listOf("https://edge.nanoflags.io.example.com", "http://edge.nanoflags.io", "https://edge.nanoflags.io/x", "https://user@edge.nanoflags.io", "https://user:pw@edge.nanoflags.io", "https://edge.nanoflags.io?x=1", "https://edge.nanoflags.io:8443", "https://xedge.nanoflags.io")) {
            val n = normalizeBaseUrl(u)
            assertTrue("$u -> $n", n != OFFICIAL_EDGE_URL)
            assertEquals(u.trimEnd('/'), n)
        }
    }

    private fun offlineClient(baseUrl: String): NanoFlags =
        NanoFlags(TEST_KEY) { this.baseUrl = baseUrl; events.enabled = false; network = NetworkState(available = false) }.also { clients.add(it) }
}
