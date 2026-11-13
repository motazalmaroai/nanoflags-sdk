package io.nanoflags

import io.nanoflags.engine.EngineResult
import io.nanoflags.engine.JsonValue
import kotlinx.coroutines.delay
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Samples evaluations and sends them, with the periodic service report ("this app runs revision N"), to
 * `POST /v1/events`. Off the hot path: evaluation only appends to a bounded list; telemetry is never retried and
 * never affects evaluation. Events carry attribute names and the type of their values — never values.
 */
internal class EventQueue(private val client: NanoFlags, private val opts: NanoFlagsOptions) {
    private val lock = Any()
    private val queue = ArrayList<JsonValue.Obj>()
    private var lastReport = 0L

    private val enabled get() = opts.events.enabled
    private val sampleRate = opts.events.sampleRate.coerceIn(0.0, 1.0)

    companion object {
        const val MAX_QUEUE = 500
        const val MAX_BATCH = 50
        const val MAX_VALUE_CHARS = 1024
        private val JSON = "application/json".toMediaType()
    }

    /** Runs while the app is in the foreground and online. */
    suspend fun loop() {
        val interval = opts.events.flushIntervalMs
        if (interval <= 0) return
        while (true) {
            delay(interval)
            val idle = synchronized(lock) { queue.isEmpty() && System.currentTimeMillis() - lastReport < opts.events.reportIntervalMs }
            if (!idle) runCatching { flush() }
        }
    }

    fun record(r: EngineResult, ctx: NanoFlagsContext, s: NanoFlags.Snapshot?) {
        if (!enabled || sampleRate <= 0 || opts.events.random() >= sampleRate) return
        try {
            synchronized(lock) { if (queue.size >= MAX_QUEUE) return }
            val e = JsonValue.Obj.Builder()
                .put("flagKey", JsonValue.Str(r.flagKey))
                .put("value", eventValue(r.value))
                .put("reason", JsonValue.Str(r.reason.wire))
            if (r.ruleIndex >= 0) e.put("ruleIndex", JsonValue.Num(r.ruleIndex.toDouble()))
            val rev = (r.revision as? JsonValue.Num)?.value?.takeIf { !it.isNaN() && !it.isInfinite() } ?: 0.0
            e.put("revision", JsonValue.Num(Math.floor(rev)))
            val redact = opts.events.redact
            e.put("context", if (redact != null) JsonValue.of(redact(ctx)) else defaultRedact(s, r.flagKey, ctx))
            e.put("at", JsonValue.Str(NanoFlags.isoNow()))
            val built = e.build()
            synchronized(lock) { if (queue.size < MAX_QUEUE) queue.add(built) }
        } catch (_: RuntimeException) {
            // telemetry must never affect evaluation
        }
    }

    private fun eventValue(v: JsonValue): JsonValue {
        if (v is JsonValue.Str) return if (v.value.length > MAX_VALUE_CHARS) JsonValue.Str(v.value.substring(0, MAX_VALUE_CHARS)) else v
        val text = v.toJson() ?: return JsonValue.Null
        if ((v is JsonValue.Obj || v is JsonValue.Arr) && text.length > MAX_VALUE_CHARS) return JsonValue.Null
        return v
    }

    /** No attribute values: only the names of the attributes the flag's rules use that were present, mapped to the value's type. */
    private fun defaultRedact(s: NanoFlags.Snapshot?, flagKey: String, ctx: NanoFlagsContext): JsonValue.Obj {
        if (s == null || ctx.values.isEmpty()) return JsonValue.Obj.EMPTY
        val out = JsonValue.Obj.Builder()
        for (n in s.bundle.attributesUsedBy(flagKey)) ctx.values[n]?.let { out.put(n, JsonValue.Str(it.typeName)) }
        return out.build()
    }

    /** Sends up to one batch of queued events with the service report. [force]: final flush on close (skipped when there is nothing to say). */
    suspend fun flush(force: Boolean = false) {
        if (!enabled) return
        val batch = synchronized(lock) {
            val n = minOf(queue.size, MAX_BATCH)
            val b = ArrayList(queue.subList(0, n))
            queue.subList(0, n).clear()
            lastReport = System.currentTimeMillis()
            b
        }
        if (force && batch.isEmpty() && client.revision == null) return
        val events = batch.map { e ->
            val k = (e["flagKey"] as JsonValue.Str).value
            if (k.length <= 63) e else JsonValue.Obj.Builder().apply { for ((name, v) in e.entries) put(name, if (name == "flagKey") JsonValue.Str(k.substring(0, 63)) else v) }.build()
        }
        val body = JsonValue.Obj.Builder()
            .put("service", JsonValue.Str(opts.service))
            .put("sdk", JsonValue.Str("${opts.sdkName}/${BuildInfo.VERSION}"))
            .put("revision", JsonValue.Num((client.revision ?: 0L).toDouble()))
            .put("events", JsonValue.Arr(events))
            .build()
        val req = client.request("/v1/events").post(body.toJson()!!.toRequestBody(JSON)).build()
        // Dropped on failure by design: telemetry is never retried.
        client.http.newCall(req).await().use { res ->
            if (res.code >= 300) throw NanoFlagsException(ErrorCode.HTTP, "Events request failed with HTTP ${res.code}.", res.code)
        }
    }
}
