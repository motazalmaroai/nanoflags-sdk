package io.nanoflags

import io.nanoflags.engine.Bundle
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import okhttp3.OkHttpClient

/** What the client does on a network class (see [NanoFlagsOptions.meteredPolicy], [NanoFlagsOptions.dataSaverPolicy]). */
enum class NetworkPolicy {
    /** Live WebSocket (SSE / polling as fallbacks), as on an unmetered network. */
    LIVE,
    /** No socket: poll `/v1/bundle` (conditional, `304` when nothing changed) every [NanoFlagsOptions.pollIntervalMs]. */
    POLL,
    /** No network activity at all; the configuration in use stays (status stale). */
    OFFLINE,
}

/** Telemetry: periodic service report ("this app runs revision N") and sampled evaluation events. */
class EventsOptions {
    /** Off: nothing is ever sent to `POST /v1/events`. */
    var enabled: Boolean = true

    /** Share of evaluations recorded (0–1). Events carry attribute names and value types, never values. */
    var sampleRate: Double = 0.1

    /** How often queued events are sent (only while the app is in the foreground and online). */
    var flushIntervalMs: Long = 30_000

    /** How often the service report goes out when no events are queued. */
    var reportIntervalMs: Long = 60_000

    /**
     * Replaces the default redaction (attribute names → value type) with your own mapping of the context to what is
     * sent. Return only what may leave the device.
     */
    var redact: ((NanoFlagsContext) -> Map<String, Any?>)? = null

    /** Random source in [0, 1) for sampling (tests). */
    var random: () -> Double = { Math.random() }
}

/** Client configuration. All fields have mobile-friendly defaults. */
class NanoFlagsOptions {
    /** Edge base URL. Default: the hosted edge (bundles verified against the embedded keys, unsigned bundles refused). */
    var baseUrl: String = OFFICIAL_EDGE_URL

    /** Name reported with telemetry (e.g. your application id). */
    var service: String = "unknown"

    /** The initial evaluation context (change it at runtime with `identify`). */
    var context: NanoFlagsContext = NanoFlagsContext.EMPTY

    /** Polling interval without a live socket (and the catch-up cap after failures). `0` disables timed polling. */
    var pollIntervalMs: Long = 30_000

    /** Safety poll while the live socket is healthy. */
    var livePollIntervalMs: Long = 300_000

    /** Live WebSocket (`/v1/live`). Off: SSE + polling. */
    var live: Boolean = true

    /** Realtime updates at all (socket and SSE). Off: polling only. */
    var streaming: Boolean = true

    /** Signature verification; see [VerifyOptions]. `null`: the default for [baseUrl]. */
    var verify: VerifyOptions? = null

    /** Persistence of the last verified bundle (offline-first start). `null`: none. */
    var store: BundleStore? = null

    /**
     * A bundle compiled into the app (`JSON.stringify` of a bundle, e.g. from `nanoflags export`), used when nothing
     * newer is available. Trusted as shipped: it is not signature-checked.
     */
    var bootstrap: String? = null

    /** Behaviour on a metered network (mobile data). */
    var meteredPolicy: NetworkPolicy = NetworkPolicy.LIVE

    /** Behaviour while the user restricts background data (Android Data Saver / Low Data Mode). */
    var dataSaverPolicy: NetworkPolicy = NetworkPolicy.POLL

    /** Whether the app is in the foreground when the client starts (later: `setForeground`). */
    var foreground: Boolean = true

    /** Network conditions when the client starts (later: `setNetworkState`). */
    var network: NetworkState = NetworkState()

    /** Telemetry settings. */
    val events: EventsOptions = EventsOptions()

    fun events(block: EventsOptions.() -> Unit) {
        events.block()
    }

    /** HTTP client to build on (proxies, certificate pinning, interceptors). Timeouts are applied per request. */
    var httpClient: OkHttpClient? = null

    var requestTimeoutMs: Long = 10_000
    var liveConnectTimeoutMs: Long = 10_000

    /** Dispatcher for background work. */
    var dispatcher: CoroutineDispatcher = Dispatchers.IO

    /** Receives debug messages (never the SDK key). */
    var logger: ((String) -> Unit)? = null

    /** Name in telemetry (`<sdkName>/<version>`) and in the User-Agent; set by the Android module. */
    var sdkName: String = "kotlin"

    /** User-Agent of every request. Cloudflare refuses default library agents (`403 1010`), so one is always sent. */
    var userAgent: String = "nanoflags-kotlin/${BuildInfo.VERSION} (JVM ${System.getProperty("java.version") ?: "?"})"

    internal fun bootstrapBundle(): Bundle? = bootstrap?.let { Bundle.parse(it) }

    internal fun copy(): NanoFlagsOptions = NanoFlagsOptions().also { o ->
        o.baseUrl = baseUrl; o.service = service; o.context = context; o.pollIntervalMs = pollIntervalMs
        o.livePollIntervalMs = livePollIntervalMs; o.live = live; o.streaming = streaming; o.verify = verify; o.store = store
        o.bootstrap = bootstrap; o.meteredPolicy = meteredPolicy; o.dataSaverPolicy = dataSaverPolicy
        o.events.enabled = events.enabled; o.events.sampleRate = events.sampleRate; o.events.flushIntervalMs = events.flushIntervalMs
        o.events.reportIntervalMs = events.reportIntervalMs; o.events.redact = events.redact; o.events.random = events.random
        o.httpClient = httpClient; o.requestTimeoutMs = requestTimeoutMs; o.liveConnectTimeoutMs = liveConnectTimeoutMs
        o.dispatcher = dispatcher; o.logger = logger; o.foreground = foreground; o.network = network; o.sdkName = sdkName; o.userAgent = userAgent
    }
}
