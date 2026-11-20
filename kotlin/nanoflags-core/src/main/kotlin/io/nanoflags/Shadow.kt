package io.nanoflags

import io.nanoflags.engine.Bundle
import io.nanoflags.engine.Engine
import io.nanoflags.engine.EngineResult
import io.nanoflags.engine.JsonValue
import io.nanoflags.engine.Reason
import kotlinx.coroutines.launch
import okhttp3.Request
import java.util.Locale

/**
 * Shadow evaluation of drafts (migration 0179; RUNTIME.md "Shadow evaluation of drafts"; same rules and wire format as
 * the JS SDK's `src/shadow.ts`).
 *
 * While a change waits for approval in an environment whose admin turned shadow evaluation on, the edge announces a
 * signed shadow bundle (`X-NanoFlags-Shadow` on `/v1/bundle`, the bundle itself on `/v1/shadow`). For a sample of the
 * evaluations of the flags the draft changes, the client evaluates the draft as well and counts, per flag, how often the
 * value would change. Only those counters leave the device, with the next `/v1/events` report:
 *
 *   { sessionId, checksum, version?, flags: [{ flag, samples, flips, pairs: [{ live, shadow, count }], rules: { "<i>" | "default": n } }] }
 *
 * No context, attribute, key or identifier is ever part of it. Values are the flag's own configured values as JSON text
 * with object keys sorted, at most 100 characters (longer ones are replaced by a hash); a side that used the app's own
 * default (flag missing there, evaluation error, wrong type) is reported as `"<fallback>"`, never as the value. The
 * shadow bundle is NEVER applied: the app always gets the live value, and the client refuses any bundle that carries a
 * `shadow` member as configuration ([Bundle.isBundle]).
 *
 * Client keys receive the browser view of the draft (client-exposed flags only); the server counts their reports only
 * for flags the draft exposes to clients and keeps them apart from server reports.
 */
internal object ShadowWire {
    const val MAX_FLAGS = 100
    const val MAX_PAIRS = 10
    const val MAX_RULES = 50
    const val MAX_VALUE_CHARS = 100
    /** The edge accepts counts up to 10^7; a flag's counter stops there (the next report starts from zero again). */
    const val MAX_COUNT = 10_000_000L
    /** The edge accepts flag keys of 1–63 characters (UTF-16 code units, as String.length counts) in a report. */
    const val MAX_FLAG_KEY = 63
    /** Shadow counters go out with the events report at most this often (and on flush(), background and close). */
    const val FLUSH_MS = 60_000L
    /** A failed shadow fetch is not retried for the same announcement before this. */
    const val RETRY_MS = 60_000L
    /** Reported instead of a value that did not come from a bundle: the application's own default. */
    const val FALLBACK_TOKEN = "<fallback>"

    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private val CHECKSUM = Regex("^[0-9a-f]{32}$")
    private val HEADER = Regex("^([0-9a-fA-F-]{36})\\.([0-9a-fA-F]{32})$")

    data class Announcement(val sessionId: String, val checksum: String)

    /** `X-NanoFlags-Shadow: <sessionId>.<checksum>` → its parts, or null. */
    fun parseHeader(v: String?): Announcement? {
        if (v.isNullOrEmpty()) return null
        val m = HEADER.find(v.trim()) ?: return null
        val id = m.groupValues[1]
        if (!UUID.matches(id)) return null
        return Announcement(id.lowercase(Locale.ROOT), m.groupValues[2].lowercase(Locale.ROOT))
    }

    /** The `shadow` member of a signed shadow bundle: `{ sessionId, checksum, environmentId, baseRevision }`. */
    fun isMarker(v: JsonValue): Boolean {
        if (v !is JsonValue.Obj) return false
        val id = v.field("sessionId")
        val sum = v.field("checksum")
        return id is JsonValue.Str && UUID.matches(id.value) && sum is JsonValue.Str && CHECKSUM.matches(sum.value) &&
            v.field("environmentId") is JsonValue.Str && v.field("baseRevision") is JsonValue.Num
    }

    /** JSON text with object keys sorted, so two configurations compare equal whatever their key order. */
    fun stableStringify(v: JsonValue): String {
        val sb = StringBuilder()
        write(v, sb)
        return sb.toString()
    }

    private fun write(v: JsonValue, sb: StringBuilder) {
        when (v) {
            is JsonValue.Obj -> {
                sb.append('{')
                var first = true
                for (k in v.keys.sorted()) {
                    val x = v[k] ?: continue
                    if (x.isUndefined) continue
                    if (!first) sb.append(',')
                    first = false
                    sb.append(JsonValue.Str(k).toJson()).append(':')
                    write(x, sb)
                }
                sb.append('}')
            }
            is JsonValue.Arr -> {
                sb.append('[')
                v.items.forEachIndexed { i, x ->
                    if (i > 0) sb.append(',')
                    write(x, sb)
                }
                sb.append(']')
            }
            else -> sb.append(v.toJson() ?: "null")
        }
    }

    /** A value as it is reported: canonical JSON text, at most 100 characters (longer values become `#<murmur3 hex>`). */
    fun reprValue(v: JsonValue): String {
        val text = try {
            stableStringify(v)
        } catch (_: RuntimeException) {
            "null"
        }
        return if (text.length <= MAX_VALUE_CHARS) text else "#" + String.format(Locale.ROOT, "%08x", Engine.murmur3(text))
    }

    private fun obj(v: JsonValue): JsonValue.Obj = v as? JsonValue.Obj ?: JsonValue.Obj.EMPTY

    /** Segment keys a list of conditions references directly (segment / not_segment). */
    private fun conditionRefs(conditions: JsonValue): List<String> {
        val out = ArrayList<String>()
        for (c in (conditions as? JsonValue.Arr)?.items.orEmpty()) {
            val op = (c.field("op") as? JsonValue.Str)?.value
            val value = c.field("value")
            if ((op == "segment" || op == "not_segment") && value is JsonValue.Str) out.add(value.value)
        }
        return out
    }

    /** Segment keys a flag's rules reference directly. */
    private fun segmentRefs(flag: JsonValue): List<String> =
        (flag.field("rules") as? JsonValue.Arr)?.items.orEmpty().flatMap { conditionRefs(it.field("conditions")) }

    /**
     * Segments whose evaluation can differ between the live and the shadow bundle: the definition differs (new, edited or
     * removed in the draft), or one of its conditions references such a segment, transitively. Iterated to a fixpoint.
     * Same rule as the database (`app.shadow_changed_segments`).
     */
    fun changedSegments(live: JsonValue.Obj, shadow: JsonValue.Obj): Set<String> {
        val ls = obj(live.field("segments"))
        val ss = obj(shadow.field("segments"))
        val changed = LinkedHashSet<String>()
        for (k in ss.keys) if (!ls.containsKey(k) || stableStringify(ls[k]!!) != stableStringify(ss[k]!!)) changed.add(k)
        for (k in ls.keys) if (!ss.containsKey(k)) changed.add(k)
        var grew = true
        while (grew) {
            grew = false
            for (k in ss.keys) {
                if (k !in changed && conditionRefs(ss[k]!!.field("conditions")).any { it in changed }) {
                    changed.add(k)
                    grew = true
                }
            }
        }
        return changed
    }

    /**
     * Keys of the shadow bundle's flags that the draft changes compared with the live bundle: a different configuration,
     * or a referenced segment that differs. Same rule as the database (`app.shadow_flags`).
     */
    fun changedFlags(live: JsonValue.Obj, shadow: JsonValue.Obj): Set<String> {
        val segs = changedSegments(live, shadow)
        val lf = obj(live.field("flags"))
        val sf = obj(shadow.field("flags"))
        val out = LinkedHashSet<String>()
        for (k in sf.keys) {
            val s = sf[k]!!
            if (!lf.containsKey(k) || stableStringify(lf[k]!!) != stableStringify(s) || segmentRefs(s).any { it in segs }) out.add(k)
        }
        return out
    }
}

/** In-memory counters of one shadow session. Bounded: 100 flags × (10 value pairs + 50 rule counters). Not thread-safe (callers lock). */
internal class ShadowCounters(val sessionId: String, val checksum: String) {
    private class Pair(val live: String, val shadow: String) {
        var count = 0L
    }

    private class Counter {
        var samples = 0L
        var flips = 0L
        val pairs = LinkedHashMap<String, Pair>()
        val rules = LinkedHashMap<String, Long>()
    }

    private val flags = LinkedHashMap<String, Counter>()

    val size: Int get() = flags.size

    /**
     * One sampled evaluation: the value the app got, what the draft would give, and which draft rule matched (-1: none).
     * A side whose value is the app's default ([liveFallback] / [shadowFallback]) is reported as `"<fallback>"`.
     */
    fun add(flag: String, live: JsonValue, shadow: JsonValue, ruleIndex: Int, liveFallback: Boolean = false, shadowFallback: Boolean = false) {
        // The edge refuses the whole report (400) over one flag key outside 1–63 characters.
        if (flag.isEmpty() || flag.length > ShadowWire.MAX_FLAG_KEY) return
        val c = flags[flag] ?: run {
            if (flags.size >= ShadowWire.MAX_FLAGS) return
            Counter().also { flags[flag] = it }
        }
        // Every count of a flag (flips, pair and rule counters) is ≤ samples, so stopping samples keeps them all ≤ 10^7.
        if (c.samples >= ShadowWire.MAX_COUNT) return
        c.samples++
        val rk = if (ruleIndex in 0 until 10_000) ruleIndex.toString() else "default"
        if (c.rules.containsKey(rk) || c.rules.size < ShadowWire.MAX_RULES) c.rules[rk] = (c.rules[rk] ?: 0L) + 1
        val same = try {
            ShadowWire.stableStringify(live) == ShadowWire.stableStringify(shadow)
        } catch (_: RuntimeException) {
            false
        }
        if (same) return
        val a = if (liveFallback) ShadowWire.FALLBACK_TOKEN else ShadowWire.reprValue(live)
        val b = if (shadowFallback) ShadowWire.FALLBACK_TOKEN else ShadowWire.reprValue(shadow)
        c.flips++
        var key = "$a\u0000$b"
        if (!c.pairs.containsKey(key) && c.pairs.size >= ShadowWire.MAX_PAIRS - 1) key = "*\u0000*"
        val p = c.pairs.getOrPut(key) { if (key == "*\u0000*") Pair("*", "*") else Pair(a, b) }
        p.count++
    }

    fun report(version: String?): JsonValue.Obj {
        val list = flags.map { (flag, c) ->
            JsonValue.Obj.Builder()
                .put("flag", JsonValue.Str(flag))
                .put("samples", JsonValue.Num(c.samples.toDouble()))
                .put("flips", JsonValue.Num(c.flips.toDouble()))
                .put("pairs", JsonValue.Arr(c.pairs.values.map { JsonValue.Obj.of("live" to JsonValue.Str(it.live), "shadow" to JsonValue.Str(it.shadow), "count" to JsonValue.Num(it.count.toDouble())) }))
                .put("rules", JsonValue.Obj.Builder().apply { for ((k, n) in c.rules) put(k, JsonValue.Num(n.toDouble())) }.build())
                .build()
        }
        return JsonValue.Obj.Builder().apply {
            put("sessionId", JsonValue.Str(sessionId))
            put("checksum", JsonValue.Str(checksum))
            if (version != null) put("version", JsonValue.Str(version))
            put("flags", JsonValue.Arr(list))
        }.build()
    }
}

/** The client's shadow state: announcement handling, fetch + verification, sampled evaluation and the counters. */
internal class ShadowEvaluator(private val client: NanoFlags, private val opts: NanoFlagsOptions) {
    val enabled: Boolean = opts.shadow.enabled && opts.events.enabled
    private val rate: Double = opts.shadow.sampleRate.let { if (it.isNaN() || it.isInfinite()) 0.1 else it.coerceIn(0.0, 1.0) }
    val serviceVersion: String? = opts.serviceVersion?.trim()?.takeIf { it.isNotEmpty() }?.let { if (it.length > 40) it.substring(0, 40) else it }

    private class State(val bundle: Bundle, val sessionId: String, val checksum: String) {
        var live: Bundle? = null
        var changed: Set<String> = emptySet()
    }

    private class FetchEntry(val id: String) {
        @Volatile var at = System.currentTimeMillis()
        @Volatile var running = true
    }

    private val lock = Any()
    @Volatile private var state: State? = null
    private var counters: ShadowCounters? = null
    private var flushedAt = System.currentTimeMillis()
    private var fetch: FetchEntry? = null
    private var keysOnly: Verifier? = null

    /** Whether a shadow bundle is in use (tests). */
    val active: Boolean get() = state != null

    /** Draft checksum of the shadow session in use (tests). */
    val checksum: String? get() = state?.checksum

    /**
     * Takes the pending report: when [force], or when the last one went out at least a minute ago. Counters restart.
     */
    fun takeReport(force: Boolean): JsonValue.Obj? = synchronized(lock) {
        val c = counters ?: return null
        if (c.size == 0 || (!force && System.currentTimeMillis() - flushedAt < ShadowWire.FLUSH_MS)) return null
        counters = ShadowCounters(c.sessionId, c.checksum)
        flushedAt = System.currentTimeMillis()
        c.report(serviceVersion)
    }

    /** Whether counters are due with the next timer flush. */
    val due: Boolean get() = synchronized(lock) { (counters?.size ?: 0) > 0 && System.currentTimeMillis() - flushedAt >= ShadowWire.FLUSH_MS }

    /** Sends the pending counters now (before the session they belong to ends). */
    private fun sendPending() {
        val r = takeReport(force = true) ?: return
        client.scope.launch { runCatching { client.events.flush(shadowReport = r) } }
    }

    private fun drop() {
        sendPending()
        synchronized(lock) {
            state = null
            counters = null
        }
    }

    /** `X-NanoFlags-Shadow` of a fresh `/v1/bundle` answer (200 or 304): fetch the announced shadow bundle, or drop the one in use. */
    fun note(header: String?) {
        if (!enabled || client.isClosed) return
        val want = ShadowWire.parseHeader(header) ?: return drop()
        val st = state
        if (st != null && st.sessionId == want.sessionId && st.checksum == want.checksum) return
        val id = "${want.sessionId}.${want.checksum}"
        val entry = synchronized(lock) {
            val f = fetch
            if (f != null && f.id == id && (f.running || System.currentTimeMillis() - f.at < ShadowWire.RETRY_MS)) return
            FetchEntry(id).also { fetch = it }
        }
        client.scope.launch {
            try {
                load(want)
            } finally {
                entry.running = false
                entry.at = System.currentTimeMillis()
            }
        }
    }

    /** Keys a shadow bundle is checked with: the configured ones, or (verification off for this edge) `/v1/keys`. */
    private suspend fun keysFor(kid: String?): List<PublicKey> {
        client.verifier?.let { return it.keysFor(kid) }
        val v = synchronized(lock) { keysOnly ?: Verifier.create(VerifyOptions(fetchKeys = true), false, client)!!.also { keysOnly = it } }
        return v.keysFor(kid)
    }

    /** Loads and verifies a shadow bundle. Only a bundle signed for this session, with a matching marker inside, is used. */
    private suspend fun load(want: ShadowWire.Announcement) {
        fun reject(why: String) = client.emitError(
            NanoFlagsException(ErrorCode.SHADOW, "The shadow bundle of session ${want.sessionId} was ignored: $why Nothing changes for the app (shadow bundles are never applied)."),
        )
        try {
            val req: Request = client.request("/v1/shadow").header("Cache-Control", "no-store").get().build()
            val (code, headers, bytes) = client.http.newCall(req).await().use { r ->
                Triple(r.code, r.headers, if (r.code in 200..299) r.bodyBytes(NanoFlags.MAX_BUNDLE_BYTES) else null)
            }
            if (client.isClosed) return
            if (code == 404) return drop()
            if (code !in 200..299 || bytes == null) return
            val body = JsonValue.parse(bytes)
            // Already replaced by a newer session: the next bundle answer announces that one.
            if ((body.field("sessionId") as? JsonValue.Str)?.value != want.sessionId || (body.field("checksum") as? JsonValue.Str)?.value != want.checksum) return
            val raw = Signatures.rawMember(bytes, "bundle")
            val signature = headers["X-NanoFlags-Signature"]
            val kid = headers["X-NanoFlags-Key-Id"]
            val environmentId = headers["X-NanoFlags-Environment-Id"]
            if (signature.isNullOrEmpty() || environmentId.isNullOrEmpty() || raw == null) return reject("it is not signed.")
            val pinned = client.pinned
            if (pinned != null && pinned != environmentId) return reject("it was signed for a different environment.")
            val ok = try {
                Signatures.verifyShadow(keysFor(kid), signature, kid, environmentId, want.sessionId, want.checksum, raw)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                false
            }
            if (client.isClosed) return
            if (!ok) return reject("its signature does not verify.")
            val parsed = JsonValue.parse(raw)
            val bundle = Bundle.shadowOf(parsed) ?: return reject("it is not a shadow bundle.")
            val m = parsed.field("shadow")
            if (!ShadowWire.isMarker(m) || (m.field("sessionId") as JsonValue.Str).value != want.sessionId ||
                (m.field("checksum") as JsonValue.Str).value != want.checksum || (m.field("environmentId") as JsonValue.Str).value != environmentId
            ) return reject("its shadow marker does not match.")
            if (!bundle.supportsEngine) return
            sendPending()
            synchronized(lock) {
                state = State(bundle, want.sessionId, want.checksum)
                counters = ShadowCounters(want.sessionId, want.checksum)
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // shadow evaluation never affects the app
        }
    }

    /** After a live evaluation: for a sample of the flags the draft changes, evaluate the draft too and count. */
    fun evaluate(key: String, fallback: JsonValue, ctx: NanoFlagsContext, accepts: ((JsonValue) -> Boolean)?, live: EngineResult, liveBundle: Bundle) {
        val st = state ?: return
        if (rate <= 0) return
        try {
            val changed = synchronized(lock) {
                if (st.live !== liveBundle) {
                    st.live = liveBundle
                    st.changed = ShadowWire.changedFlags(liveBundle.value, st.bundle.value)
                }
                st.changed
            }
            if (key !in changed || opts.shadow.random() >= rate) return
            val r = st.bundle.evaluate(key, ctx.evalContext, fallback)
            // A side that used the app's own default is reported as "<fallback>" (flag missing on that side, evaluation
            // error, or a value of the wrong type, which eval() already turned into an error).
            val liveFallback = live.reason == Reason.FLAG_NOT_FOUND || live.reason == Reason.ERROR
            val shadowFallback = r.reason == Reason.FLAG_NOT_FOUND || r.reason == Reason.ERROR || (accepts != null && !accepts(r.value))
            synchronized(lock) {
                if (state !== st) return
                counters?.add(key, live.value, if (shadowFallback) fallback else r.value, if (r.reason == Reason.RULE_MATCH) r.ruleIndex else -1, liveFallback, shadowFallback)
            }
        } catch (_: RuntimeException) {
            // shadow evaluation never affects the app
        }
    }
}
