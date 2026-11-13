package io.nanoflags.android

import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.nanoflags.ChangeEvent
import io.nanoflags.NanoFlags
import io.nanoflags.NanoFlagsException
import io.nanoflags.OFFICIAL_EDGE_URL
import io.nanoflags.Status
import io.nanoflags.Transport
import io.nanoflags.VerifyOptions
import io.nanoflags.engine.JsonValue
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Device tests (emulator in CI): the real `ProcessLifecycleOwner`, `ConnectivityManager`, file storage and the
 * Ed25519 verifier on ART, against an on-device signing edge and (opt-in) the production edge.
 */
@RunWith(AndroidJUnit4::class)
class DeviceTest {
    /** A hung test fails with the stack of the stuck thread instead of blocking the run until the CI job times out. */
    @get:Rule
    val timeout: Timeout = Timeout.builder().withTimeout(3, TimeUnit.MINUTES).withLookingForStuckThread(true).build()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val clients = ArrayList<NanoFlags>()

    @After
    fun tearDown() {
        clients.forEach { it.close() }
    }

    private fun eventually(what: String, timeoutMs: Long = 10_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(20)
        }
        if (!cond()) fail("timed out waiting for $what")
    }

    private fun client(edge: SigningEdge, key: String, configure: io.nanoflags.NanoFlagsOptions.() -> Unit = {}) =
        NanoFlagsAndroid.create(context, key) {
            baseUrl = edge.baseUrl
            verify = VerifyOptions(publicKeys = listOf(edge.jwk), require = true)
            events.enabled = false
            configure()
        }.also { clients.add(it) }

    @Test
    fun backgroundDisconnectsAndForegroundRefreshes() {
        SigningEdge().use { edge ->
            val scenario = ActivityScenario.launch(TestActivity::class.java)
            val c = client(edge, "nf_pub_devicelifecycle")
            eventually("ready and live") { c.status.value == Status.READY && c.transport.value == Transport.LIVE }
            assertEquals("green", c.stringVariation("accent", "x"))
            // Background: ProcessLifecycleOwner reports ON_STOP ~700 ms after the last activity stopped.
            scenario.moveToState(Lifecycle.State.CREATED)
            eventually("socket closed in the background") { c.transport.value == Transport.PAUSED && edge.sockets.isEmpty() }
            val connects = edge.liveConnects.get()
            edge.accent = "orange"
            edge.revision = 9 // published while the app was in the background
            scenario.moveToState(Lifecycle.State.RESUMED)
            eventually("refreshed in the foreground") { c.revision == 9L && c.stringVariation("accent", "x") == "orange" }
            eventually("reconnected") { c.transport.value == Transport.LIVE && edge.liveConnects.get() > connects }
            scenario.close()
        }
    }

    @Test
    fun persistedBundleIsReloadedAndReverified() {
        val key = "nf_pub_devicestore"
        NanoFlagsAndroid.storeFile(context, key).delete()
        SigningEdge().use { edge ->
            val scenario = ActivityScenario.launch(TestActivity::class.java)
            val a = client(edge, key)
            eventually("ready") { a.status.value == Status.READY }
            val file = NanoFlagsAndroid.storeFile(context, key)
            eventually("persisted") { file.isFile && file.readText().contains("\"sig\"") }
            a.close()
            val url = edge.baseUrl // the stored copy is bound to this edge URL + key
            edge.close()

            // Restart while the edge is unreachable: the stored copy is re-verified and used, status stale.
            val b = NanoFlagsAndroid.create(context, key) {
                baseUrl = url
                verify = VerifyOptions(publicKeys = listOf(edge.jwk), require = true)
                events.enabled = false
                live = false
            }.also { clients.add(it) }
            eventually("restored") { b.revision == 1L }
            eventually("stale") { b.status.value == Status.STALE }
            assertEquals("green", b.stringVariation("accent", "x"))
            assertEquals("dev1", b.verifiedKeyId)
            b.close()

            // A tampered copy fails verification and is not used.
            file.writeText(file.readText().replace("green", "black"))
            val errors = CopyOnWriteArrayList<NanoFlagsException>()
            val d = NanoFlagsAndroid.create(context, key) {
                baseUrl = url
                verify = VerifyOptions(publicKeys = listOf(edge.jwk), require = true)
                events.enabled = false
                live = false
                logger = { if (it.contains("failed signature verification")) errors.add(NanoFlagsException(io.nanoflags.ErrorCode.SIGNATURE, it)) }
            }.also { clients.add(it) }
            eventually("tampered copy refused") { errors.isNotEmpty() }
            assertNull(d.revision)
            scenario.close()
        }
    }

    /**
     * Opt-in: pass the public demo browser key as instrumentation argument `nanoflagsSdkKey`
     * (`-Pandroid.testInstrumentationRunnerArguments.nanoflagsSdkKey=nf_pub_…`). Toggles `demo-accent` through the
     * public, rate-limited demo endpoint, waits for the pushed update and restores the original value.
     */
    @Test
    fun liveUpdateFromProduction() = runBlocking {
        val key = InstrumentationRegistry.getArguments().getString("nanoflagsSdkKey").orEmpty()
        assumeTrue("set the instrumentation argument nanoflagsSdkKey to run the production check", key.startsWith("nf_pub_"))
        val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
        fun toggle(value: String): JsonValue {
            val body = """{"flag":"demo-accent","value":"$value"}""".toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url("$OFFICIAL_EDGE_URL/v1/demo/toggle").header("User-Agent", NanoFlagsAndroid.userAgent).post(body).build()
            return http.newCall(req).execute().use { JsonValue.parse(it.body!!.string()) }
        }
        val scenario = ActivityScenario.launch(TestActivity::class.java)
        val updates = CopyOnWriteArrayList<ChangeEvent>()
        val c = NanoFlagsAndroid.create(context, key) { service = "kotlin-sdk-device-test"; events.enabled = false }.also { clients.add(it) }
        c.addChangeListener { updates.add(it) }
        eventually("verified configuration", 20_000) { c.status.value == Status.READY && c.verifiedKeyId == "k1" }
        eventually("live socket", 20_000) { c.transport.value == Transport.LIVE }
        val original = c.stringVariation("demo-accent", "blue")
        val next = if (original == "orange") "green" else "orange"
        var published = false
        try {
            for (attempt in 1..5) {
                val r = toggle(next)
                if ((r.field("status") as? JsonValue.Str)?.value == "published") {
                    val rev = (r.field("revision") as JsonValue.Num).value.toLong()
                    published = true
                    eventually("pushed r$rev", 20_000) { updates.any { it.revision >= rev } }
                    val ev = updates.first { it.revision >= rev }
                    assertEquals(Transport.LIVE, ev.transport)
                    println("NanoFlags device live update: r${ev.revision} commit->update ${ev.latencyMs} ms")
                    break
                }
                val retry = (r.field("retryAfterMs") as? JsonValue.Num)?.value?.toLong() ?: 5_000
                Thread.sleep(minOf(30_000, retry + 1_000))
            }
            assertTrue("the demo toggle was published", published)
        } finally {
            if (published) {
                for (attempt in 1..5) {
                    val r = toggle(original)
                    val status = (r.field("status") as? JsonValue.Str)?.value
                    if (status == "published" || status == "unchanged") break
                    Thread.sleep(((r.field("retryAfterMs") as? JsonValue.Num)?.value?.toLong() ?: 3_000) + 1_000)
                }
            }
            scenario.close()
        }
    }
}
