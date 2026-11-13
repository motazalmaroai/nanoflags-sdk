package io.nanoflags.android

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.core.app.ApplicationProvider
import io.nanoflags.BuildInfo
import io.nanoflags.NanoFlags
import io.nanoflags.Status
import io.nanoflags.Transport
import io.nanoflags.VerifyOptions
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetworkCapabilities
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** JVM (Robolectric) tests of the Android wiring; device-level tests are in src/androidTest. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NanoFlagsAndroidTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val server = MockWebServer()
    private val bundleRequests = AtomicInteger()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val clients = ArrayList<NanoFlags>()

    private class Owner : LifecycleOwner {
        val registry = LifecycleRegistry.createUnsafe(this)
        override val lifecycle: Lifecycle get() = registry
    }

    private val cm get() = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    @Before
    fun setUp() {
        // Robolectric's default network has no capabilities: give it internet access.
        val caps = ShadowNetworkCapabilities.newInstance()
        shadowOf(caps).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        shadowOf(cm).setNetworkCapabilities(cm.activeNetwork, caps)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                return when (request.requestUrl?.encodedPath) {
                    "/v1/bundle" -> {
                        bundleRequests.incrementAndGet()
                        MockResponse().addHeader("ETag", "\"c1-client\"").addHeader("X-NanoFlags-Signed", "false")
                            .setBody("""{"revision":1,"checksum":"c1","bundle":{"schema":1,"project":"p","environment":"e","revision":1,"flags":{"accent":{"type":"string","enabled":true,"default":"green","off":"blue","rules":[]}},"segments":{}}}""")
                    }
                    "/v1/events" -> MockResponse().setResponseCode(202)
                    else -> MockResponse().setResponseCode(503)
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        clients.forEach { it.close() }
        server.shutdown()
    }

    private fun eventually(what: String, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < end) {
            shadowOf(android.os.Looper.getMainLooper()).idle()
            if (cond()) return
            Thread.sleep(10)
        }
        fail("timed out waiting for $what")
    }

    private fun create(owner: LifecycleOwner, context: Context = app): NanoFlags =
        NanoFlagsAndroid.create(context, "nf_pub_androidtest", owner) {
            baseUrl = server.url("/").toString().trimEnd('/')
            verify = VerifyOptions.DISABLED
            events.enabled = false
        }.also { clients.add(it) }

    @Test
    fun platformDefaults() = runBlocking {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.RESUMED }
        val c = create(owner)
        assertTrue(c.waitUntilReady())
        assertEquals("green", c.stringVariation("accent", "x"))
        val ua = requests.first().getHeader("User-Agent")!!
        assertTrue(ua, ua.startsWith("nanoflags-android/${BuildInfo.VERSION} (Android "))
        val file = NanoFlagsAndroid.storeFile(app, "nf_pub_androidtest")
        assertTrue(file.path.startsWith(app.noBackupFilesDir.path))
        eventually("persisted") { file.isFile && file.readText().contains("\"raw\"") }
        assertFalse("the SDK key is never stored", file.readText().contains("nf_pub_"))
    }

    @Test
    fun lifecycleStopPausesAndStartResumes() = runBlocking {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.RESUMED }
        val c = create(owner)
        assertTrue(c.waitUntilReady())
        eventually("active") { c.transport.value != Transport.PAUSED }
        owner.registry.currentState = Lifecycle.State.CREATED // ON_STOP: the app went to the background
        eventually("paused") { c.transport.value == Transport.PAUSED }
        val before = bundleRequests.get()
        Thread.sleep(200)
        assertEquals("no requests in the background", before, bundleRequests.get())
        owner.registry.currentState = Lifecycle.State.RESUMED // ON_START
        eventually("resumed") { c.transport.value != Transport.PAUSED }
    }

    @Test
    fun startsPausedWhenNotInForeground() = runBlocking {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.CREATED }
        val c = create(owner)
        Thread.sleep(300)
        assertEquals(0, bundleRequests.get())
        assertEquals(Transport.PAUSED, c.transport.value)
        owner.registry.currentState = Lifecycle.State.STARTED
        eventually("loaded") { c.status.value == Status.READY }
    }

    @Test
    fun networkLossGoesOfflineAndReturnRefreshes() = runBlocking {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.RESUMED }
        val c = create(owner)
        assertTrue(c.waitUntilReady())
        val callbacks = shadowOf(cm).networkCallbacks
        assertTrue("a network callback is registered", callbacks.isNotEmpty())
        val network = cm.activeNetwork!!
        callbacks.forEach { it.onLost(network) }
        eventually("offline") { c.transport.value == Transport.PAUSED && c.status.value == Status.STALE }
        callbacks.forEach { it.onAvailable(network) }
        eventually("online again") { c.status.value == Status.READY && c.transport.value != Transport.PAUSED }
        c.close()
        assertTrue("callbacks are unregistered on close", shadowOf(cm).networkCallbacks.isEmpty())
    }

    @Test
    fun restartRestoresTheStoredBundleOffline() = runBlocking {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.RESUMED }
        val a = create(owner)
        assertTrue(a.waitUntilReady())
        eventually("persisted") { NanoFlagsAndroid.storeFile(app, "nf_pub_androidtest").isFile }
        a.close()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(503)
        }
        val b = create(owner)
        eventually("restored") { b.revision == 1L }
        assertEquals("green", b.stringVariation("accent", "x"))
        eventually("stale") { b.status.value == Status.STALE }
    }

    @Test
    fun currentNetworkStateReportsDataSaver() {
        assertTrue(NetworkMonitor.currentState(app).available)
        assertFalse(NetworkMonitor.currentState(app).dataSaver)
        shadowOf(cm).setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
        assertTrue(NetworkMonitor.currentState(app).dataSaver)
    }

    @Test
    fun dataSaverSwitchesTheClientToPolling() = runBlocking {
        val owner = Owner().apply { registry.currentState = Lifecycle.State.RESUMED }
        shadowOf(cm).setRestrictBackgroundStatus(ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
        val c = create(owner)
        assertTrue(c.waitUntilReady())
        Thread.sleep(300)
        assertEquals("Data Saver: polling only, no socket", Transport.POLL, c.transport.value)
        assertTrue(requests.none { it.requestUrl?.encodedPath == "/v1/live" })
    }
}
