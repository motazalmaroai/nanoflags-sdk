package io.nanoflags.android

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.nanoflags.BuildInfo
import io.nanoflags.FileBundleStore
import io.nanoflags.NanoFlags
import io.nanoflags.NanoFlagsOptions
import io.nanoflags.engine.Engine
import java.io.File
import java.util.Locale

/**
 * Creates NanoFlags clients wired into the Android platform:
 *
 * - **Lifecycle** (`ProcessLifecycleOwner`): the live socket, polling and telemetry run only while the app is in the
 *   foreground; queued telemetry is sent when the app goes to the background; back in the foreground the client
 *   reconnects and revalidates at once if the configuration may be out of date.
 * - **Network** (`ConnectivityManager`): no network activity while offline (status `STALE`), reconnect when the
 *   network returns; metered networks and Data Saver follow [NanoFlagsOptions.meteredPolicy] /
 *   [NanoFlagsOptions.dataSaverPolicy] (default: live on mobile data, polling only under Data Saver).
 * - **Storage**: the last verified bundle is kept in `noBackupFilesDir/nanoflags/` (excluded from cloud backups) and
 *   re-verified on the next start, so the app starts offline-first.
 * - Telemetry is reported as `android/<version>` with your application id as service name.
 *
 * ```
 * val flags = NanoFlagsAndroid.create(applicationContext, "nf_pub_…") {
 *     context = NanoFlagsContext(userId, mapOf("plan" to plan))
 * }
 * ```
 *
 * Create one client per SDK key, typically in `Application.onCreate`, and keep it for the life of the process.
 */
object NanoFlagsAndroid {
    /** User-Agent sent with every request. */
    @JvmStatic
    val userAgent: String
        get() = "nanoflags-android/${BuildInfo.VERSION} (Android ${Build.VERSION.RELEASE}; API ${Build.VERSION.SDK_INT})"

    /** The file in which the bundle of [sdkKey] is stored (one per key; the name is a non-secret fingerprint). */
    @JvmStatic
    fun storeFile(context: Context, sdkKey: String): File =
        File(File((context.applicationContext ?: context).noBackupFilesDir, "nanoflags"), String.format(Locale.ROOT, "bundle-%08x.json", Engine.murmur3(sdkKey.trim())))

    /**
     * Creates a client for the client key [sdkKey] (`nf_pub_…`; server keys are refused). [configure] can override
     * every default (pass `store = null` to disable persistence).
     */
    @JvmStatic
    @JvmOverloads
    fun create(context: Context, sdkKey: String, configure: NanoFlagsOptions.() -> Unit = {}): NanoFlags =
        create(context, sdkKey, ProcessLifecycleOwner.get(), configure)

    /** As [create], following the lifecycle of [lifecycleOwner] instead of the process (tests, multi-process apps). */
    @JvmStatic
    fun create(context: Context, sdkKey: String, lifecycleOwner: LifecycleOwner, configure: NanoFlagsOptions.() -> Unit): NanoFlags {
        val app = context.applicationContext ?: context
        val options = NanoFlagsOptions().apply {
            service = app.packageName
            sdkName = "android"
            userAgent = NanoFlagsAndroid.userAgent
            store = FileBundleStore(storeFile(app, sdkKey))
            network = NetworkMonitor.currentState(app)
            foreground = LifecycleBinding.isForeground(lifecycleOwner)
            configure()
        }
        val client = NanoFlags(sdkKey, options)
        val monitor = NetworkMonitor(app) { client.setNetworkState(it) }
        monitor.start()
        client.invokeOnClose { monitor.stop() }
        val binding = LifecycleBinding(lifecycleOwner, client)
        onMain {
            if (!client.isClosed) {
                binding.attach()
                client.invokeOnClose { onMain { binding.detach() } }
            }
        }
        return client
    }

    internal fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else Handler(Looper.getMainLooper()).post(block)
    }
}
