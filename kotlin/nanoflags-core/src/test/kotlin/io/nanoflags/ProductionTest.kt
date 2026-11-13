package io.nanoflags

import io.nanoflags.engine.JsonValue
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Opt-in checks against the hosted edge with the public live demo:
 *
 *     NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=<demo browser key> gradle :nanoflags-core:test --tests '*ProductionTest*'
 *
 * Default options (official edge: signatures verified against the embedded key, unsigned bundles refused), the live
 * socket, an offline tamper check of the real signed response, then `demo-accent` is toggled through the public
 * `POST /v1/demo/toggle` (rate limited — gentle, NANOFLAGS_TOGGLES times, default 3) and restored. Latencies are printed.
 */
class ProductionTest {
    private val key = System.getenv("NANOFLAGS_SDK_KEY") ?: ""
    private val enabled = System.getenv("NANOFLAGS_PRODUCTION_TESTS") == "1" && key.startsWith("nf_pub_")
    private val ua = "nanoflags-kotlin-verify/${BuildInfo.VERSION}"
    private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()

    private fun toggle(flag: String, value: String): JsonValue {
        val body = JsonValue.Obj.of("flag" to JsonValue.Str(flag), "value" to JsonValue.Str(value)).toJson()!!
        val req = Request.Builder().url("$OFFICIAL_EDGE_URL/v1/demo/toggle").header("User-Agent", ua).post(body.toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { r -> return JsonValue.parse(r.body!!.string()) }
    }

    private fun median(xs: List<Long>) = xs.sorted().let { if (it.isEmpty()) 0 else it[it.size / 2] }

    @Test
    fun liveUpdatesFromProduction() = runBlocking {
        assumeTrue("production tests are opt-in (NANOFLAGS_PRODUCTION_TESTS=1 NANOFLAGS_SDK_KEY=nf_pub_…)", enabled)
        val updates = CopyOnWriteArrayList<Pair<Long, ChangeEvent>>()
        val errors = CopyOnWriteArrayList<NanoFlagsException>()
        val t0 = System.nanoTime()
        val flags = NanoFlags(key) { service = "kotlin-sdk-verify"; events.enabled = false }
        flags.addChangeListener { updates.add(System.nanoTime() to it) }
        flags.addErrorListener { errors.add(it) }
        try {
            // The first answer can be refused (e.g. unsigned while the publisher is still distributing a fresh
            // revision); the client retries within a second or two, so wait for a verified configuration.
            flags.waitUntilReady(15_000)
            eventually(15_000, "verified configuration") { flags.status.value == Status.READY }
            println("LIVE: ready in ${(System.nanoTime() - t0) / 1_000_000} ms status=${flags.status.value} r${flags.revision} verified kid=${flags.verifiedKeyId}")
            assertEquals(Status.READY, flags.status.value)
            assertEquals("k1", flags.verifiedKeyId)
            eventually(15_000, "live socket") { flags.transport.value == Transport.LIVE }
            println("LIVE: transport=${flags.transport.value} after ${(System.nanoTime() - t0) / 1_000_000} ms; values=${flags.allFlags(NanoFlagsContext("kotlin-verify"))}")

            // Offline tamper check against the real signed response (retried while the edge still serves an unsigned
            // fallback for a revision the publisher has not distributed yet).
            var checked = false
            for (attempt in 1..5) {
                val req = Request.Builder().url("$OFFICIAL_EDGE_URL/v1/bundle").header("Authorization", "Bearer $key").header("User-Agent", ua).build()
                http.newCall(req).execute().use { r ->
                    assertEquals(200, r.code)
                    val signature = r.header("X-NanoFlags-Signature")
                    if (r.header("X-NanoFlags-Signed") != "true" || signature == null) {
                        println("LIVE: /v1/bundle answered unsigned (publisher lag), retrying")
                        return@use
                    }
                    val text = r.body!!.bytes()
                    val body = JsonValue.parse(text)
                    val info = SignatureInfo(signature, r.header("X-NanoFlags-Key-Id"), r.header("X-NanoFlags-Environment-Id")!!,
                        (body.field("revision") as JsonValue.Num).value.toLong(), (body.field("checksum") as JsonValue.Str).value)
                    val raw = Signatures.rawMember(text, "bundle")!!
                    val keys = Signatures.importKeys(OFFICIAL_SIGNING_KEYS)
                    val tampered = String(raw, Charsets.UTF_8).let { if (it.contains("\"default\":false")) it.replaceFirst("\"default\":false", "\"default\":true") else "$it " }
                    val genuine = Signatures.verify(keys, info, raw)
                    val forged = Signatures.verify(keys, info, tampered.toByteArray(Charsets.UTF_8))
                    println("LIVE: offline check r${info.revision} genuine verifies=$genuine tampered verifies=$forged")
                    assertTrue(genuine)
                    assertFalse(forged)
                    checked = true
                }
                if (checked) break
                Thread.sleep(1_500)
            }
            // While the demo is published every few seconds the edge can answer from its unsigned fallback for a
            // while; the SDK itself only ever adopted signed revisions above (VerifyTest covers a captured response).
            if (!checked) println("LIVE: offline check skipped: /v1/bundle stayed unsigned (publisher lag on the busy demo)")

            val colors = listOf("blue", "orange", "green")
            val original = flags.stringVariation("demo-accent", "blue")
            var current = original
            val toggles = System.getenv("NANOFLAGS_TOGGLES")?.toIntOrNull() ?: 3
            val returnedToUpdate = ArrayList<Long>()
            val sentToUpdate = ArrayList<Long>()
            val commitToUpdate = ArrayList<Long>()
            try {
                var i = 0
                var attempts = 0
                while (i < toggles && attempts < toggles + 4) {
                    attempts++
                    val next = colors[(colors.indexOf(current).coerceAtLeast(0) + 1) % colors.size]
                    val before = updates.size
                    val tSent = System.nanoTime()
                    val r = toggle("demo-accent", next)
                    val tReturned = System.nanoTime()
                    if ((r.field("status") as? JsonValue.Str)?.value != "published") {
                        val retry = (r.field("retryAfterMs") as? JsonValue.Num)?.value ?: (r.field("error").field("retryAfterMs") as? JsonValue.Num)?.value ?: 5_000.0
                        println("LIVE: toggle ${i + 1} not published: ${r.toJson()?.take(200)}; waiting ${retry.toLong()} ms")
                        Thread.sleep(minOf(30_000L, retry.toLong() + 1_000))
                        continue
                    }
                    val rev = (r.field("revision") as JsonValue.Num).value.toLong()
                    eventually(15_000, "update r$rev") { updates.drop(before).any { it.second.revision >= rev } }
                    val (tUpdate, ev) = updates.drop(before).first { it.second.revision >= rev }
                    val seen = flags.stringVariation("demo-accent", "?")
                    returnedToUpdate.add((tUpdate - tReturned) / 1_000_000)
                    sentToUpdate.add((tUpdate - tSent) / 1_000_000)
                    ev.latencyMs?.let { commitToUpdate.add(it) }
                    println("LIVE: toggle ${i + 1}: r${ev.revision} $next -> app saw '$seen' via ${ev.transport}; POST rtt ${(tReturned - tSent) / 1_000_000} ms, POST returned->update ${(tUpdate - tReturned) / 1_000_000} ms, POST sent->update ${(tUpdate - tSent) / 1_000_000} ms, commit->update (SDK) ${ev.latencyMs} ms")
                    assertEquals(next, seen)
                    assertEquals(Transport.LIVE, ev.transport)
                    current = next
                    i++
                    Thread.sleep(4_000)
                }
            } finally {
                if (current != original) println("LIVE: restored demo-accent=$original: ${(toggle("demo-accent", original).field("status") as? JsonValue.Str)?.value}")
            }
            println("LIVE: n=${returnedToUpdate.size} POST returned->update median ${median(returnedToUpdate)} ms (min ${returnedToUpdate.minOrNull()}, max ${returnedToUpdate.maxOrNull()}); POST sent->update median ${median(sentToUpdate)} ms (max ${sentToUpdate.maxOrNull()}); commit->update median ${median(commitToUpdate)} ms (max ${commitToUpdate.maxOrNull()})")
            println("LIVE: errors=${errors.map { it.toString() }}")
            assertTrue("at least one live update", returnedToUpdate.isNotEmpty())
        } finally {
            flags.close()
        }
    }
}
