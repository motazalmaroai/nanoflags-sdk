package io.nanoflags

import io.nanoflags.engine.Bundle
import io.nanoflags.engine.Engine
import io.nanoflags.engine.EngineResult
import io.nanoflags.engine.JsonValue
import io.nanoflags.engine.Reason
import io.nanoflags.engine.TraceStep
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.Closeable
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * The NanoFlags client for apps (client keys `nf_pub_…` only).
 *
 * Flags are evaluated locally and synchronously against an in-memory configuration (no I/O, never throws: on any
 * problem the default is returned). The configuration is kept current in the background over the live WebSocket
 * (SSE and conditional polling as fallbacks), verified (Ed25519, by key id) and persisted for an offline-first start.
 * The evaluation context belongs to the client and can change at runtime with [identify] — no network round trip.
 *
 * ```
 * val flags = NanoFlags("nf_pub_…") { service = "my-app"; context = NanoFlagsContext("user-42") }
 * flags.waitUntilReady()
 * if (flags.boolVariation("new-checkout", false)) …
 * ```
 *
 * Create one client per SDK key and share it; [close] it when done. Thread-safe.
 */
class NanoFlags(sdkKey: String, options: NanoFlagsOptions = NanoFlagsOptions()) : Closeable {
    constructor(sdkKey: String, configure: NanoFlagsOptions.() -> Unit) : this(sdkKey, NanoFlagsOptions().apply(configure))

    private val sdkKey: String = sdkKey.trim()
    private val opts: NanoFlagsOptions = options.copy()
    internal val baseUrl: String = opts.baseUrl.trimEnd('/')
    private val official = baseUrl == OFFICIAL_EDGE_URL

    init {
        require(this.sdkKey.isNotEmpty()) { "An SDK key is required." }
        require(!this.sdkKey.startsWith("nf_srv_")) { "Server keys (nf_srv_…) must never ship in an app. Use the environment's client key (nf_pub_…)." }
        require(this.sdkKey.startsWith("nf_pub_")) { "NanoFlags for apps takes client keys only (nf_pub_…)." }
        require(baseUrl.startsWith("https://") || baseUrl.startsWith("http://")) { "The base URL must be an http(s) URL, got \"$baseUrl\"." }
    }

    /** Non-secret fingerprint binding persisted bundles to this key + edge. */
    internal val id: String = String.format(Locale.ROOT, "%08x", Engine.murmur3("$baseUrl|${this.sdkKey}"))

    private val baseHttp: OkHttpClient = opts.httpClient ?: OkHttpClient()
    internal val http: OkHttpClient = baseHttp.newBuilder().callTimeout(opts.requestTimeoutMs, TimeUnit.MILLISECONDS).build()
    internal val streamHttp: OkHttpClient = baseHttp.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    internal val wsHttp: OkHttpClient = baseHttp.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(opts.liveConnectTimeoutMs, TimeUnit.MILLISECONDS).pingInterval(0, TimeUnit.MILLISECONDS).build()

    internal val scope = CoroutineScope(SupervisorJob() + opts.dispatcher + CoroutineName("nanoflags"))

    /* ---------------- state ---------------- */

    internal class Snapshot(val bundle: Bundle, val etag: String?, val checksum: String?, val sig: SignatureInfo?, val raw: String?)

    internal val snap = MutableStateFlow<Snapshot?>(null)
    private val _status = MutableStateFlow(Status.NOT_READY)
    internal val _transport = MutableStateFlow(Transport.PAUSED)
    private val _context = MutableStateFlow(opts.context)
    private val _changes = MutableSharedFlow<ChangeEvent>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val _errors = MutableSharedFlow<NanoFlagsException>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val ready = CompletableDeferred<Unit>()

    private val lock = Any()
    private val adoptLock = Any()
    private val persistLock = Any()
    private var failures = 0
    private var lastError: NanoFlagsException? = null
    internal var pinnedEnvironment: String? = null
    private var liveRevision = 0L
    @Volatile internal var environmentDeleted = false
    @Volatile private var lastSyncAt = 0L
    private var streamTriggered = false
    private var lastPersistedRevision = -1L
    @Volatile private var closed = false

    private val syncMutex = Mutex()
    private enum class Wake { KICK, STREAM_KICK, RESCHEDULE }
    private val wake = Channel<Wake>(Channel.CONFLATED)

    internal val verifier: Verifier? = Verifier.create(opts.verify, official, this)
    internal val events = EventQueue(this, opts)
    internal val live = LiveTransport(this, opts)

    /* ---------------- lifecycle & network ---------------- */

    private val foreground = MutableStateFlow(opts.foreground)
    private val network = MutableStateFlow(opts.network)

    internal enum class Mode { OFFLINE, POLL, LIVE }

    private fun modeOf(fg: Boolean, net: NetworkState): Mode {
        if (!fg || !net.available) return Mode.OFFLINE
        val policy = when {
            net.dataSaver -> opts.dataSaverPolicy
            net.metered -> opts.meteredPolicy
            else -> NetworkPolicy.LIVE
        }
        return when (policy) {
            NetworkPolicy.LIVE -> Mode.LIVE
            NetworkPolicy.POLL -> Mode.POLL
            NetworkPolicy.OFFLINE -> Mode.OFFLINE
        }
    }


    private suspend fun run() {
        restore()
        if (modeOf(foreground.value, network.value) == Mode.OFFLINE) markReady()
        combine(foreground, network) { fg, net -> modeOf(fg, net) }.distinctUntilChanged().collectLatest { mode ->
            if (mode == Mode.OFFLINE) {
                _transport.value = Transport.PAUSED
                // Offline (not merely in the background): what is in use can no longer be confirmed.
                if (foreground.value && snap.value != null) setStatus(Status.STALE)
                return@collectLatest
            }
            _transport.value = Transport.POLL
            if (needsSync()) syncNow(false)
            markReady()
            coroutineScope {
                launch { pollLoop() }
                if (mode == Mode.LIVE && opts.streaming && !environmentDeleted) launch { live.run() }
                if (opts.events.enabled) launch { events.loop() }
            }
        }
    }

    private fun needsSync(): Boolean {
        val s = snap.value ?: return true
        if (_status.value != Status.READY) return true
        if (synchronized(lock) { failures } > 0) return true
        val interval = if (opts.pollIntervalMs > 0) minOf(opts.pollIntervalMs, 30_000) else 30_000
        return System.currentTimeMillis() - lastSyncAt >= interval
    }

    /**
     * Tell the client whether the app is in the foreground. In the background every network activity stops (socket,
     * stream, polling; queued telemetry is sent first); back in the foreground the client reconnects and revalidates
     * at once when the configuration may be out of date. `nanoflags-android` calls this from `ProcessLifecycleOwner`.
     */
    fun setForeground(foreground: Boolean) {
        if (closed) return
        if (!foreground && this.foreground.value) scope.launch { runCatching { events.flush() } }
        this.foreground.value = foreground
    }

    /** Tell the client about the network (availability, metered, data saver). */
    fun setNetworkState(state: NetworkState) {
        if (closed) return
        network.value = state
    }

    /* ---------------- public state ---------------- */

    /** State of the configuration in use. */
    val status: StateFlow<Status> = _status.asStateFlow()

    /** How updates reach the client right now. */
    val transport: StateFlow<Transport> = _transport.asStateFlow()

    /** Every newly adopted configuration. */
    val changes: SharedFlow<ChangeEvent> = _changes.asSharedFlow()

    /** Background problems (failed requests, rejected signatures, …). They never change the configuration in use. */
    val errors: SharedFlow<NanoFlagsException> = _errors.asSharedFlow()

    /** The current evaluation context. */
    val context: StateFlow<NanoFlagsContext> = _context.asStateFlow()

    /** Revision in use, or `null` when no configuration is loaded. */
    val revision: Long? get() = snap.value?.bundle?.revision

    /** The configuration in use (`null` when none is loaded). Bundles are immutable. */
    val bundle: Bundle? get() = snap.value?.bundle

    /** Key id of the signature that the configuration in use was verified with (`null` when unsigned / not verified). */
    val verifiedKeyId: String? get() = snap.value?.sig?.kid

    /** Replaces the evaluation context (e.g. after sign-in). Synchronous; no network round trip. */
    fun identify(context: NanoFlagsContext) {
        _context.value = context
    }

    /** Alias of [identify]. */
    fun setContext(context: NanoFlagsContext) = identify(context)

    /**
     * Suspends until the first load attempt has finished (or a configuration was adopted from storage or bootstrap)
     * and returns whether a configuration is in use; `false` after [timeoutMs].
     */
    suspend fun waitUntilReady(timeoutMs: Long = 10_000): Boolean {
        withTimeoutOrNull(timeoutMs) { ready.await() } ?: return snap.value != null
        return snap.value != null
    }

    /** The error that prevented loading a configuration, if any (after [waitUntilReady] returned false). */
    val lastLoadError: NanoFlagsException? get() = synchronized(lock) { lastError }

    /** Revalidates the configuration now (conditional request) and returns when it has finished. */
    suspend fun refresh(): Boolean {
        if (closed) return false
        return syncNow(false) == null
    }

    /** Sends queued telemetry now. */
    suspend fun flush() = events.flush()

    /** Registers [listener] for new configurations (called on a background thread). Close the result to unregister. */
    fun addChangeListener(listener: (ChangeEvent) -> Unit): Closeable = subscribe(_changes, listener)

    /** Registers [listener] for status changes (called on a background thread with the current status first). */
    fun addStatusListener(listener: (Status) -> Unit): Closeable = subscribe(_status, listener)

    /** Registers [listener] for background errors (called on a background thread). */
    fun addErrorListener(listener: (NanoFlagsException) -> Unit): Closeable = subscribe(_errors, listener)

    private fun <T> subscribe(flow: Flow<T>, listener: (T) -> Unit): Closeable {
        val job = scope.launch(Dispatchers.Unconfined) { flow.collect { runCatching { listener(it) } } }
        return Closeable { job.cancel() }
    }

    private val closeHooks = ArrayList<() -> Unit>()

    /** Runs [block] when the client is closed (platform integrations unregister their callbacks this way). */
    fun invokeOnClose(block: () -> Unit) {
        val runNow = synchronized(lock) { if (closed) true else { closeHooks.add(block); false } }
        if (runNow) block()
    }

    /** Whether [close] was called. */
    val isClosed: Boolean get() = closed

    /**
     * Stops every background activity (queued telemetry is sent first, best effort, without blocking the caller).
     * Evaluations keep working on the last configuration. Idempotent.
     */
    override fun close() {
        if (closed) return
        closed = true
        val hooks = synchronized(lock) { closeHooks.toList().also { closeHooks.clear() } }
        hooks.forEach { runCatching { it() } }
        val q = events
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { withTimeoutOrNull(2_000) { runCatching { q.flush(force = true) } } }
        scope.cancel()
        markReady()
    }

    /* ---------------- adoption ---------------- */

    private fun markReady() {
        ready.complete(Unit)
    }

    internal fun setStatus(s: Status) {
        _status.value = s
    }

    internal fun emitError(e: NanoFlagsException) {
        log("error: $e")
        _errors.tryEmit(e)
    }

    internal fun log(msg: String) {
        opts.logger?.invoke("nanoflags: $msg")
    }

    private fun adopt(next: Snapshot, status: Status, source: Source, transport: Transport, latencyMs: Long?) {
        val prev = snap.value
        snap.value = next
        setStatus(status)
        markReady()
        if (prev != null && prev.bundle.revision == next.bundle.revision && prev.checksum == next.checksum) return
        _changes.tryEmit(ChangeEvent(next.bundle.revision, prev?.bundle?.revision, next.checksum, source, transport, latencyMs))
    }

    internal fun engineError(b: Bundle): NanoFlagsException = NanoFlagsException(
        ErrorCode.ENGINE,
        "Bundle r${b.revision} needs evaluation engine ${b.engine.toJson() ?: "undefined"}; this SDK supports up to ${Engine.VERSION}. " +
            "Upgrade the NanoFlags SDK. The configuration in use is unchanged.",
    )

    /* ---------------- polling: GET /v1/bundle ---------------- */

    internal fun request(path: String): Request.Builder = Request.Builder().url(baseUrl + path)
        .header("Authorization", "Bearer $sdkKey")
        .header("User-Agent", opts.userAgent)

    internal fun authHeader(): String = "Bearer $sdkKey"

    /** Wakes the poll loop for an immediate request (from the stream, or after a rejected push). */
    internal fun trigger(fromStream: Boolean = false) {
        if (fromStream) synchronized(lock) { streamTriggered = true }
        wake.trySend(if (fromStream) Wake.STREAM_KICK else Wake.KICK)
    }

    /** Re-arms the poll timer (the live socket opened or closed). */
    internal fun reschedule() {
        wake.trySend(Wake.RESCHEDULE)
    }

    private suspend fun pollLoop() {
        while (true) {
            val delayMs = nextDelay()
            val w = if (delayMs == null) wake.receive() else withTimeoutOrNull(delayMs) { select<Wake> { wake.onReceive { it } } }
            when (w) {
                null -> syncNow(false)
                Wake.KICK -> syncNow(false)
                Wake.STREAM_KICK -> syncNow(true)
                Wake.RESCHEDULE -> {}
            }
        }
    }

    private fun nextDelay(): Long? {
        if (opts.pollIntervalMs <= 0) return null
        val f = synchronized(lock) { failures }
        var interval = opts.pollIntervalMs
        if (live.isOpen && opts.livePollIntervalMs > interval) interval = opts.livePollIntervalMs
        var base = interval
        if (f > 0) base = minOf(opts.pollIntervalMs, 1000L shl minOf(f - 1, 10))
        return maxOf(250L, (base * (0.8 + 0.4 * Random.nextDouble())).toLong())
    }

    /** One conditional bundle request; adopts what it returns. Returns the error, or null. */
    private suspend fun syncNow(fromStream: Boolean): NanoFlagsException? = syncMutex.withLock {
        if (closed) return null
        val transport = synchronized(lock) {
            lastSyncAt = System.currentTimeMillis()
            val t = if (streamTriggered || fromStream) Transport.STREAM else Transport.POLL
            streamTriggered = false
            t
        }
        val err: NanoFlagsException = try {
            syncOnce(transport)
            synchronized(lock) {
                failures = 0
                lastError = null
            }
            return null
        } catch (e: NanoFlagsException) {
            e
        } catch (e: IOException) {
            NanoFlagsException(ErrorCode.NETWORK, "Could not reach the NanoFlags edge: ${e.message ?: e.javaClass.simpleName}", cause = e)
        }
        synchronized(lock) {
            lastError = err
            if (err.code != ErrorCode.ENGINE) failures++
        }
        when (err.code) {
            ErrorCode.ENGINE, ErrorCode.SIGNATURE -> {} // a rejected update changes nothing: same configuration, same status
            else -> {
                if (err.code == ErrorCode.UNAUTHORIZED) live.drop()
                if (snap.value != null) setStatus(Status.STALE)
            }
        }
        emitError(err)
        err
    }

    private suspend fun syncOnce(transport: Transport) {
        val cur = snap.value
        val req = request("/v1/bundle").apply { cur?.etag?.let { header("If-None-Match", it) } }.get().build()
        val res = http.newCall(req).await()
        val (code, headers, text) = res.use { r ->
            Triple(r.code, r.headers, if (r.code in 200..299) r.bodyBytes(MAX_BUNDLE_BYTES) ?: throw NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge returned a bundle larger than $MAX_BUNDLE_BYTES bytes.") else null)
        }
        val servedStale = headers["X-NanoFlags-Stale"] == "true"
        when {
            code == 304 -> {
                if (cur != null) setStatus(if (servedStale) Status.STALE else Status.READY)
                return
            }
            code == 401 || code == 403 -> throw NanoFlagsException(ErrorCode.UNAUTHORIZED, "The SDK key was rejected (unknown or revoked).", code)
            code !in 200..299 -> throw NanoFlagsException(ErrorCode.HTTP, "Bundle request failed with HTTP $code.", code)
        }
        val bytes = text!!
        val body = try {
            JsonValue.parse(bytes)
        } catch (_: RuntimeException) {
            null
        }
        val bundle = body?.field("bundle")?.let { Bundle.of(it) } ?: throw NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge returned an invalid bundle.")
        val checksum = (body.field("checksum") as? JsonValue.Str)?.value
        // An unsigned answer (the edge's database fallback while the publisher catches up) that is not newer than
        // the verified configuration in use tells nothing new: keep what is in use, quietly.
        if (verifier?.require == true && headers["X-NanoFlags-Signed"] != "true" && cur?.sig != null && bundle.revision <= cur.bundle.revision) return
        val signed = checkSignature(headers, bytes, body, bundle)
        if (!bundle.supportsEngine) throw engineError(bundle)
        val next = Snapshot(bundle, headers["ETag"], checksum, signed?.first, signed?.second ?: bundle.toJson())
        synchronized(adoptLock) {
            val now = snap.value
            // The edge is serving its last-known-good copy: never go backwards because of it.
            if (servedStale && now != null && now.bundle.revision >= bundle.revision) {
                setStatus(Status.STALE)
                return
            }
            // A revision that was pushed while this request was under way wins.
            val pushed = synchronized(lock) { liveRevision }
            if (now != null && bundle.revision < pushed && now.bundle.revision >= pushed) return
            adopt(next, if (servedStale) Status.STALE else Status.READY, Source.NETWORK, transport, null)
        }
        persist(next)
    }

    /** Verifies the response's signature (when verification is on); returns what was verified, or null when unsigned. */
    private suspend fun checkSignature(h: okhttp3.Headers, text: ByteArray, body: JsonValue, bundle: Bundle): Pair<SignatureInfo, String>? {
        val v = verifier ?: return null
        val rev = bundle.revision
        fun reject(why: String) = NanoFlagsException(ErrorCode.SIGNATURE, "Bundle r$rev was rejected: $why The configuration in use is unchanged.")
        if (h["X-NanoFlags-Signed"] != "true") {
            if (v.require) throw reject("it is not signed (the edge is still distributing it) and unsigned bundles are refused; fetching again shortly.")
            return null
        }
        val signature = h["X-NanoFlags-Signature"]
        val envId = h["X-NanoFlags-Environment-Id"]
        val kid = h["X-NanoFlags-Key-Id"]
        val checksum = (body.field("checksum") as? JsonValue.Str)?.value
        if (signature.isNullOrEmpty() || envId.isNullOrEmpty() || checksum == null) throw reject("the signature headers are incomplete.")
        val r = body.field("revision")
        if (r is JsonValue.Num && r.value != rev.toDouble()) throw reject("the signed revision does not match the bundle.")
        val pinned = synchronized(lock) { pinnedEnvironment }
        if (pinned != null && pinned != envId) throw reject("it was signed for a different environment.")
        val info = SignatureInfo(signature, kid, envId, rev, checksum)
        val keys = try {
            v.keysFor(kid)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            throw reject("the signing keys could not be loaded (${e.message}).")
        }
        // The edge embeds the stored bundle text byte-for-byte; re-serialisation is the fallback.
        var raw = Signatures.rawMember(text, "bundle")
        var ok = raw != null && Signatures.verify(keys, info, raw)
        if (!ok) {
            val again = bundle.toJson().toByteArray(Charsets.UTF_8)
            if (raw == null || !raw.contentEquals(again)) {
                ok = Signatures.verify(keys, info, again)
                if (ok) raw = again
            }
        }
        if (!ok) throw reject("its signature does not verify.")
        synchronized(lock) { pinnedEnvironment = envId }
        return info to String(raw!!, Charsets.UTF_8)
    }

    /* ---------------- live push ---------------- */

    /** Applies one `rev` / `hello` message. A message that cannot be trusted changes nothing. */
    internal suspend fun applyPush(text: String) {
        val m = try {
            JsonValue.parse(text)
        } catch (_: RuntimeException) {
            return
        }
        if (m !is JsonValue.Obj) return
        val t = (m.field("t") as? JsonValue.Str)?.value
        if (t != "rev" && t != "hello") return
        val revF = (m.field("revision") as? JsonValue.Num)?.value ?: return
        val bundleText = (m.field("bundle") as? JsonValue.Str)?.value
        // Revision 0 / no bundle: the environment has nothing published yet.
        if (revF != Math.floor(revF) || revF < 1 || bundleText == null) return
        val revision = revF.toLong()
        snap.value?.let { if (revision < it.bundle.revision) return } // never backwards
        val checksum = (m.field("checksum") as? JsonValue.Str)?.value
        var info: SignatureInfo? = null
        val v = verifier
        if (v != null) {
            fun reject(why: String) {
                emitError(NanoFlagsException(ErrorCode.SIGNATURE, "Pushed bundle r$revision was rejected: $why The configuration in use is unchanged."))
                trigger() // the regular (verified) request path says what is really current
            }
            val sig = (m.field("signature") as? JsonValue.Str)?.value
            val envId = (m.field("environmentId") as? JsonValue.Str)?.value
            if (sig.isNullOrEmpty() || envId.isNullOrEmpty() || checksum == null) return reject("it carries no complete signature.")
            val pinned = synchronized(lock) { pinnedEnvironment }
            if (pinned != null && pinned != envId) return reject("it was signed for a different environment.")
            val kid = (m.field("kid") as? JsonValue.Str)?.value
            val candidate = SignatureInfo(sig, kid, envId, revision, checksum)
            val keys = try {
                v.keysFor(kid)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                null
            }
            if (keys == null || !Signatures.verify(keys, candidate, bundleText.toByteArray(Charsets.UTF_8))) return reject("its signature does not verify.")
            info = candidate
        }
        val bundle = Bundle.parse(bundleText)
        if (bundle == null || bundle.revision != revision) {
            emitError(NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The edge pushed an invalid bundle; it was ignored."))
            return
        }
        if (!bundle.supportsEngine) {
            emitError(engineError(bundle))
            return
        }
        val next: Snapshot
        synchronized(adoptLock) {
            val cur = snap.value
            if (cur != null && revision < cur.bundle.revision) return
            synchronized(lock) { failures = 0 }
            if (cur != null && revision == cur.bundle.revision) {
                // Already in use: the push only confirms that it is current.
                if (cur.checksum == null || cur.checksum == checksum) setStatus(Status.READY)
                return
            }
            synchronized(lock) {
                if (info != null) pinnedEnvironment = info.environmentId
                liveRevision = revision
            }
            // What /v1/bundle would send as ETag for this revision, so the safety poll gets a 304.
            next = Snapshot(bundle, checksum?.let { "\"$it-client\"" }, checksum, info, bundleText)
            val committedAt = (m.field("committedAt") as? JsonValue.Num)?.value
            val latency = committedAt?.let { System.currentTimeMillis() - it.toLong() }
            adopt(next, Status.READY, Source.NETWORK, Transport.LIVE, latency)
        }
        persist(next)
    }

    internal fun onEnvironmentDeleted() {
        environmentDeleted = true
        if (snap.value != null) setStatus(Status.STALE)
        emitError(NanoFlagsException(ErrorCode.ENVIRONMENT_DELETED, "The environment of this SDK key was deleted. The last configuration stays in use; it will not be updated."))
        reschedule()
    }

    /** Called by the SSE stream for every `revision` notification. */
    internal fun onRevisionNotice(data: String) {
        val m = try {
            JsonValue.parse(data)
        } catch (_: RuntimeException) {
            return
        }
        val rev = (m.field("revision") as? JsonValue.Num)?.value
        val checksum = (m.field("checksum") as? JsonValue.Str)?.value
        val cur = snap.value
        if (cur == null || rev == null || rev.toLong() != cur.bundle.revision || checksum != cur.checksum || _status.value != Status.READY) trigger(fromStream = true)
    }

    /* ---------------- persistence ---------------- */

    private fun persist(s: Snapshot) {
        val store = opts.store ?: return
        synchronized(persistLock) {
            if (s.bundle.revision < lastPersistedRevision) return
            try {
                val p = JsonValue.Obj.Builder()
                    .put("v", JsonValue.Num(1.0))
                    .put("id", JsonValue.Str(id))
                    .put("etag", s.etag?.let { JsonValue.Str(it) } ?: JsonValue.Null)
                    .put("checksum", s.checksum?.let { JsonValue.Str(it) } ?: JsonValue.Null)
                    .put("savedAt", JsonValue.Str(isoNow()))
                    .put("raw", JsonValue.Str(s.raw ?: s.bundle.toJson()))
                    .put("sig", s.sig?.toJson() ?: JsonValue.Null)
                    .build()
                store.save(p.toJson()!!)
                lastPersistedRevision = s.bundle.revision
            } catch (e: Exception) {
                emitError(NanoFlagsException(ErrorCode.STORE, "Could not persist the bundle.", cause = e))
            }
        }
    }

    private suspend fun restore() {
        val store = opts.store ?: return
        val data = try {
            store.load()
        } catch (e: Exception) {
            emitError(NanoFlagsException(ErrorCode.STORE, "Could not read the persisted bundle.", cause = e))
            return
        }
        if (data.isNullOrEmpty()) return
        val p = try {
            JsonValue.parse(data)
        } catch (_: RuntimeException) {
            return
        }
        if (p.field("v") != JsonValue.Num(1.0) || p.field("id") != JsonValue.Str(id)) return
        val raw = (p.field("raw") as? JsonValue.Str)?.value ?: return
        val bundle = Bundle.parse(raw) ?: return
        if (!bundle.supportsEngine) return emitError(engineError(bundle))
        snap.value?.let { if (it.bundle.revision >= bundle.revision) return }
        var sig: SignatureInfo? = null
        val v = verifier
        if (v != null) {
            // The store is outside the trust boundary: a signed copy must verify again, and with `require` an
            // unsigned copy is not used at all.
            val s = SignatureInfo.fromJson(p.field("sig"))
            if (s != null && s.revision == bundle.revision) {
                val keys = try {
                    v.keysFor(s.kid)
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    null
                }
                if (keys == null || !Signatures.verify(keys, s, raw.toByteArray(Charsets.UTF_8))) {
                    return emitError(NanoFlagsException(ErrorCode.SIGNATURE, "The persisted bundle failed signature verification and was ignored."))
                }
                sig = s
                synchronized(lock) { if (pinnedEnvironment == null) pinnedEnvironment = s.environmentId }
            } else if (v.require) {
                return
            }
        }
        val next = Snapshot(bundle, (p.field("etag") as? JsonValue.Str)?.value, (p.field("checksum") as? JsonValue.Str)?.value, sig, raw)
        synchronized(adoptLock) {
            snap.value?.let { if (it.bundle.revision >= bundle.revision) return }
            synchronized(persistLock) { lastPersistedRevision = bundle.revision }
            // Usable but not known to be current: stale until the edge confirms it.
            adopt(next, Status.STALE, Source.STORE, Transport.POLL, null)
        }
    }

    /* ---------------- evaluation ---------------- */

    private fun eval(key: String, ctx: NanoFlagsContext?, fallback: JsonValue, accepts: ((JsonValue) -> Boolean)?, record: Boolean): EngineResult {
        val s = snap.value
        val c = ctx ?: _context.value
        var res = if (s == null) Engine.evaluate(JsonValue.Null, key, c.evalContext, fallback) else s.bundle.evaluate(key, c.evalContext, fallback)
        if (accepts != null && res.reason != Reason.FLAG_NOT_FOUND && res.reason != Reason.ERROR && !accepts(res.value)) {
            val msg = "Flag \"$key\" has a ${res.value.typeName} value, which does not match the requested type."
            res = EngineResult(key, fallback, Reason.ERROR, revision = res.revision, trace = res.trace + TraceStep("result", "Returned the fallback", msg), error = msg)
        }
        if (record) events.record(res, c, s)
        return res
    }

    private fun <T> detail(r: EngineResult, value: T): EvaluationDetail<T> = EvaluationDetail(
        flagKey = r.flagKey,
        value = value,
        reason = r.reason,
        ruleIndex = r.ruleIndex,
        ruleId = if (r.ruleIndex >= 0) (r.ruleId as? JsonValue.Str)?.value ?: r.ruleId.toJson() else null,
        inRollout = r.inRollout,
        bucket = r.bucket,
        revision = (r.revision as? JsonValue.Num)?.value?.takeIf { !it.isNaN() && !it.isInfinite() }?.toLong() ?: 0L,
        trace = r.trace,
        error = r.error,
        raw = r.value,
    )

    private fun isFinite(v: JsonValue) = v is JsonValue.Num && !v.value.isNaN() && !v.value.isInfinite()
    private fun isInt(v: JsonValue) = isFinite(v) && (v as JsonValue.Num).value == Math.floor(v.value) && v.value >= Int.MIN_VALUE && v.value <= Int.MAX_VALUE

    /** The boolean value of flag [key], or [default] when it is missing, not loaded, or serves another type. */
    @JvmOverloads
    fun boolVariation(key: String, default: Boolean, context: NanoFlagsContext? = null): Boolean =
        (eval(key, context, JsonValue.Bool.of(default), { it is JsonValue.Bool }, true).value as? JsonValue.Bool)?.value ?: default

    @JvmOverloads
    fun boolVariationDetail(key: String, default: Boolean, context: NanoFlagsContext? = null): EvaluationDetail<Boolean> {
        val r = eval(key, context, JsonValue.Bool.of(default), { it is JsonValue.Bool }, true)
        return detail(r, (r.value as? JsonValue.Bool)?.value ?: default)
    }

    /** The string value of flag [key], or [default]. */
    @JvmOverloads
    fun stringVariation(key: String, default: String, context: NanoFlagsContext? = null): String =
        (eval(key, context, JsonValue.Str(default), { it is JsonValue.Str }, true).value as? JsonValue.Str)?.value ?: default

    @JvmOverloads
    fun stringVariationDetail(key: String, default: String, context: NanoFlagsContext? = null): EvaluationDetail<String> {
        val r = eval(key, context, JsonValue.Str(default), { it is JsonValue.Str }, true)
        return detail(r, (r.value as? JsonValue.Str)?.value ?: default)
    }

    /** The numeric value of flag [key], or [default]. */
    @JvmOverloads
    fun doubleVariation(key: String, default: Double, context: NanoFlagsContext? = null): Double =
        doubleVariationDetail(key, default, context).value

    @JvmOverloads
    fun doubleVariationDetail(key: String, default: Double, context: NanoFlagsContext? = null): EvaluationDetail<Double> {
        val r = eval(key, context, JsonValue.Num(default), ::isFinite, true)
        return detail(r, (r.value as? JsonValue.Num)?.value?.takeIf { isFinite(r.value) } ?: default)
    }

    /** The value of a number flag that serves whole numbers (in the Int range), or [default]. */
    @JvmOverloads
    fun intVariation(key: String, default: Int, context: NanoFlagsContext? = null): Int = intVariationDetail(key, default, context).value

    @JvmOverloads
    fun intVariationDetail(key: String, default: Int, context: NanoFlagsContext? = null): EvaluationDetail<Int> {
        val r = eval(key, context, JsonValue.Num(default.toDouble()), ::isInt, true)
        return detail(r, if (isInt(r.value)) (r.value as JsonValue.Num).value.toInt() else default)
    }

    /** The value of a JSON flag (any served value), or [default]. Use [JsonValue.toKotlin] for plain Kotlin data. */
    @JvmOverloads
    fun jsonVariation(key: String, default: JsonValue, context: NanoFlagsContext? = null): JsonValue = jsonVariationDetail(key, default, context).value

    @JvmOverloads
    fun jsonVariationDetail(key: String, default: JsonValue, context: NanoFlagsContext? = null): EvaluationDetail<JsonValue> {
        val r = eval(key, context, default, { !it.isUndefined }, true)
        return detail(r, if (r.reason == Reason.ERROR || r.reason == Reason.FLAG_NOT_FOUND) default else r.value)
    }

    /** The full engine result without any type check ([default] is converted with [JsonValue.of]). */
    @JvmOverloads
    fun evaluate(key: String, default: Any? = null, context: NanoFlagsContext? = null): EvaluationDetail<Any?> {
        val r = eval(key, context, JsonValue.of(default), null, true)
        return detail(r, if (r.reason == Reason.ERROR || r.reason == Reason.FLAG_NOT_FOUND) default else r.value.toKotlin())
    }

    /** Every flag of the configuration in use, as plain Kotlin values (no telemetry). Empty without a configuration. */
    @JvmOverloads
    fun allFlags(context: NanoFlagsContext? = null): Map<String, Any?> = allFlagsDetail(context).mapValues { it.value.value }

    @JvmOverloads
    fun allFlagsDetail(context: NanoFlagsContext? = null): Map<String, EvaluationDetail<Any?>> {
        val out = LinkedHashMap<String, EvaluationDetail<Any?>>()
        val s = snap.value ?: return out
        val c = context ?: _context.value
        for (k in s.bundle.flagKeys) {
            val r = s.bundle.evaluate(k, c.evalContext, JsonValue.Null)
            if (r.reason == Reason.FLAG_NOT_FOUND) continue // keys whose entry is not a flag at all
            out[k] = detail(r, r.value.toKotlin())
        }
        return out
    }

    /* ---------------- flows (Compose / lifecycle-aware collection) ---------------- */

    private fun <T> flagFlow(evaluate: (NanoFlagsContext) -> T): Flow<T> =
        combine(snap, _context) { _, ctx -> evaluate(ctx) }.distinctUntilChanged()

    /** The value of a boolean flag for the current context, re-evaluated on every new configuration or context. */
    fun boolFlow(key: String, default: Boolean): Flow<Boolean> = flagFlow { boolVariation(key, default, it) }

    fun stringFlow(key: String, default: String): Flow<String> = flagFlow { stringVariation(key, default, it) }

    fun doubleFlow(key: String, default: Double): Flow<Double> = flagFlow { doubleVariation(key, default, it) }

    fun intFlow(key: String, default: Int): Flow<Int> = flagFlow { intVariation(key, default, it) }

    fun jsonFlow(key: String, default: JsonValue): Flow<JsonValue> = flagFlow { jsonVariation(key, default, it) }

    /** Every flag's value, re-evaluated on every new configuration or context. */
    fun allFlagsFlow(): Flow<Map<String, Any?>> = flagFlow { allFlags(it) }

    internal val currentContext: NanoFlagsContext get() = _context.value
    internal val sdkName: String get() = opts.sdkName
    internal val userAgent: String get() = opts.userAgent

    // Last in the class body: everything the background work touches is initialised by now.
    init {
        if (opts.bootstrap != null) {
            val b = opts.bootstrapBundle()
            when {
                b == null -> emitError(NanoFlagsException(ErrorCode.INVALID_BUNDLE, "The bootstrap bundle is invalid and was ignored."))
                !b.supportsEngine -> emitError(engineError(b))
                else -> adopt(Snapshot(b, null, null, null, null), Status.READY, Source.BOOTSTRAP, Transport.POLL, null)
            }
        }
        scope.launch { run() }
    }

    internal companion object {
        const val MAX_BUNDLE_BYTES = 16L shl 20

        fun isoNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    }
}
