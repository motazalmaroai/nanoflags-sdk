package io.nanoflags

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import kotlin.random.Random

/** WebSocket subprotocol of `GET /v1/live`. */
const val LIVE_PROTOCOL: String = "nanoflags.v1"

/** Close code with which the edge tells SDKs that the environment was deleted: no reconnect, last configuration kept. */
const val CLOSE_ENVIRONMENT_DELETED: Int = 4004

/**
 * The live transport: one `/v1/live` WebSocket (key in the `Authorization` header, never in the URL), reconnecting
 * with jittered exponential backoff (1 s · 2ⁿ capped at 5 min, × 0.5–1.5). While no socket can be opened, SSE
 * (`/v1/stream`) plus polling take over. Text `ping` every ~30 s (the edge answers `pong` without waking anything),
 * 10 s pong timeout, the socket is replaced every ~50 min (the edge drops sockets older than 2 h).
 */
internal class LiveTransport(private val client: NanoFlags, private val opts: NanoFlagsOptions) {
    @Volatile
    var isOpen = false
        private set

    @Volatile
    private var socket: WebSocket? = null
    private var streamJob: Job? = null

    companion object {
        const val PING_MS = 30_000L
        const val PONG_TIMEOUT_MS = 10_000L
        const val MAX_BACKOFF_MS = 300_000L
        const val ROTATE_MS = 50 * 60_000L
        const val STABLE_MS = 30_000L

        fun jitter(ms: Long, lo: Double, hi: Double): Long = (ms * (lo + (hi - lo) * Random.nextDouble())).toLong()
    }

    private val liveUrl: String get() = "ws" + client.baseUrl.removePrefix("http") + "/v1/live"

    /** Runs until cancelled (the app went to the background, the network changed, the client closed). */
    suspend fun run() = coroutineScope {
        if (!opts.live) {
            startStream(this)
            awaitCancellation()
        }
        var attempt = 0
        try {
            while (true) {
                val r = runSocket()
                if (r.deleted) {
                    // Keep evaluating the last configuration; it can no longer be updated. No socket, no stream; the
                    // regular poll stays (it reports the key as rejected, and recovers if the environment exists after all).
                    stopStream()
                    client.onEnvironmentDeleted()
                    return@coroutineScope
                }
                if (r.rotating) continue // planned replacement: no fallback, no backoff
                attempt = if (r.opened && r.openForMs > STABLE_MS) 1 else attempt + 1
                if (!r.opened) startStream(this) else client.reschedule()
                delay(jitter(minOf(MAX_BACKOFF_MS, 1000L shl minOf(attempt - 1, 10)), 0.5, 1.5))
            }
        } finally {
            stopStream()
            isOpen = false
        }
    }

    /** Closes the current socket (a rejected key); the loop reconnects with backoff. */
    fun drop() {
        socket?.close(1000, "bye")
    }

    private class Outcome(val opened: Boolean, val openForMs: Long, val rotating: Boolean, val deleted: Boolean)

    private sealed class Ev {
        object Open : Ev()
        class Message(val text: String) : Ev()
        class Closing(val code: Int) : Ev()
        class Closed(val code: Int) : Ev()
        class Failure(val t: Throwable, val status: Int?) : Ev()
    }

    private suspend fun runSocket(): Outcome {
        val events = Channel<Ev>(Channel.UNLIMITED)
        val req = client.request("").url(liveUrl).header("Sec-WebSocket-Protocol", LIVE_PROTOCOL).build()
        val ws = client.wsHttp.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                events.trySend(Ev.Open)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                events.trySend(Ev.Message(text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                events.trySend(Ev.Closing(code))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                events.trySend(Ev.Closed(code))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                events.trySend(Ev.Failure(t, response?.code))
            }
        })
        var opened = false
        var openedAt = 0L
        var rotated = false
        var closeCode = 0
        try {
            val first = withTimeoutOrNull(opts.liveConnectTimeoutMs + 1_000) { events.receive() }
            if (first !is Ev.Open) {
                client.log("live socket unavailable: ${(first as? Ev.Failure)?.let { it.status ?: it.t.message } ?: "timeout"}")
                if (first is Ev.Closing) closeCode = first.code
                return Outcome(false, 0, false, closeCode == CLOSE_ENVIRONMENT_DELETED)
            }
            opened = true
            openedAt = System.currentTimeMillis()
            socket = ws
            isOpen = true
            client._transport.value = Transport.LIVE
            stopStream() // SSE is not used while the socket is healthy
            client.reschedule() // the poll becomes a safety net
            val rotateAt = openedAt + jitter(ROTATE_MS, 0.9, 1.1)
            var nextPingAt = System.currentTimeMillis() + jitter(PING_MS, 0.9, 1.1)
            var awaitingPongSince = 0L
            loop@ while (true) {
                val now = System.currentTimeMillis()
                if (now >= rotateAt) {
                    rotated = true
                    ws.close(1000, "rotate")
                    break
                }
                val deadline = minOf(rotateAt, if (awaitingPongSince != 0L) awaitingPongSince + PONG_TIMEOUT_MS else nextPingAt)
                val ev = withTimeoutOrNull(maxOf(1L, deadline - now)) { events.receive() }
                if (ev == null) {
                    val t = System.currentTimeMillis()
                    if (awaitingPongSince != 0L && t >= awaitingPongSince + PONG_TIMEOUT_MS) {
                        // The edge answers `pong` without waking anything up; silence means a dead connection.
                        ws.cancel()
                        break
                    }
                    if (awaitingPongSince == 0L && t >= nextPingAt) {
                        if (!ws.send("ping")) {
                            ws.cancel()
                            break
                        }
                        awaitingPongSince = t
                    }
                    continue
                }
                when (ev) {
                    is Ev.Message -> {
                        awaitingPongSince = 0L
                        nextPingAt = System.currentTimeMillis() + jitter(PING_MS, 0.9, 1.1)
                        if (ev.text != "pong") client.applyPush(ev.text)
                    }
                    is Ev.Closing -> {
                        closeCode = ev.code
                        ws.close(1000, null)
                        break@loop
                    }
                    is Ev.Closed -> {
                        closeCode = ev.code
                        break@loop
                    }
                    is Ev.Failure -> break@loop
                    Ev.Open -> {}
                }
            }
        } finally {
            if (!opened) ws.cancel() else ws.close(1000, "bye")
            socket = null
            if (isOpen) {
                isOpen = false
                if (client._transport.value == Transport.LIVE) client._transport.value = Transport.POLL
            }
        }
        return Outcome(true, System.currentTimeMillis() - openedAt, rotated, closeCode == CLOSE_ENVIRONMENT_DELETED)
    }

    /* ---------------- SSE fallback: GET /v1/stream ---------------- */

    private fun startStream(scope: CoroutineScope) {
        if (!opts.streaming || streamJob?.isActive == true || client.environmentDeleted) return
        streamJob = scope.launch { streamLoop() }
    }

    private fun stopStream() {
        streamJob?.cancel()
        streamJob = null
    }

    /** The stream only says "revision N exists"; the bundle is always fetched conditionally. */
    private suspend fun streamLoop() {
        var attempt = 0
        try {
            while (true) {
                val started = System.currentTimeMillis()
                if (readStream()) return
                attempt = if (System.currentTimeMillis() - started > 30_000) 0 else attempt + 1
                delay(jitter(minOf(30_000L, 1000L shl minOf(attempt, 5)), 0.5, 1.5))
            }
        } finally {
            if (client._transport.value == Transport.STREAM) client._transport.value = Transport.POLL
        }
    }

    /** Reads one SSE connection; returns true when streaming should stop (key rejected). */
    private suspend fun readStream(): Boolean = coroutineScope {
        val req = client.request("/v1/stream").header("Accept", "text/event-stream").get().build()
        val call = client.streamHttp.newCall(req)
        val watcher = launch {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            val res = try {
                call.await()
            } catch (_: IOException) {
                return@coroutineScope false
            }
            res.use {
                if (it.code == 401 || it.code == 403) return@coroutineScope true // polling keeps reporting the error
                if (it.code != 200) return@coroutineScope false
                if (!isOpen) client._transport.value = Transport.STREAM
                val source = it.body?.source() ?: return@coroutineScope false
                var event = "message"
                val data = ArrayList<String>()
                while (true) {
                    val raw = try {
                        source.readUtf8Line()
                    } catch (_: IOException) {
                        null
                    } ?: break
                    val line = raw.removeSuffix("\r")
                    if (line.isEmpty()) {
                        if (data.isNotEmpty()) {
                            if (event == "revision") client.onRevisionNotice(data.joinToString("\n"))
                            else if (event == "revoked") {
                                client.trigger()
                                return@coroutineScope true
                            }
                        }
                        event = "message"
                        data.clear()
                        continue
                    }
                    if (line.startsWith(":")) continue
                    val idx = line.indexOf(':')
                    val field = if (idx < 0) line else line.substring(0, idx)
                    val value = if (idx < 0) "" else line.substring(idx + 1).removePrefix(" ")
                    when (field) {
                        "event" -> event = value
                        "data" -> data.add(value)
                    }
                }
            }
            false
        } finally {
            watcher.cancel()
        }
    }
}
