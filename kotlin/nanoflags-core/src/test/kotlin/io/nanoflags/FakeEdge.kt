package io.nanoflags

import io.nanoflags.engine.JsonValue
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * A fake NanoFlags edge that signs like the real publisher (Ed25519 over the canonical string, kid in a header),
 * serves `/v1/bundle` (ETag / 304), `/v1/keys`, `/v1/live` (WebSocket: `hello`, `rev`, `ping`/`pong`, close codes)
 * and records `/v1/events`.
 */
class FakeEdge(@Volatile var environmentId: String = "env-test-1") : AutoCloseable {
    class Key(val kid: String) {
        val priv = Ed25519PrivateKeyParameters(SecureRandom())
        val jwk = Jwk("OKP", "Ed25519", Base64.getUrlEncoder().withoutPadding().encodeToString(priv.generatePublicKey().encoded), kid)
        fun sign(msg: ByteArray): String {
            val s = Ed25519Signer()
            s.init(true, priv)
            s.update(msg, 0, msg.size)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(s.generateSignature())
        }
    }

    val server = MockWebServer()
    val key1 = Key("t1")
    @Volatile var signingKey: Key = key1
    /** Keys served by /v1/keys. */
    val published = CopyOnWriteArrayList(listOf(key1))

    @Volatile var revision = 0L
    @Volatile var bundleText = ""
    @Volatile var checksum = ""
    @Volatile var signed = true
    @Volatile var tamperHttp = false
    @Volatile var bundleStatus = 200
    @Volatile var liveEnabled = true
    @Volatile var answerPings = true
    @Volatile var committedAt: Long? = null

    val bundleRequests = AtomicInteger()
    val notModified = AtomicInteger()
    val keysRequests = AtomicInteger()
    val liveConnects = AtomicInteger()
    val sockets = CopyOnWriteArrayList<WebSocket>()
    val closedSockets = AtomicInteger()
    val events = CopyOnWriteArrayList<JsonValue>()
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    val baseUrl: String get() = server.url("/").toString().trimEnd('/')

    init {
        setFlags(1, flags = """{"new-checkout":{"type":"boolean","enabled":true,"clientExposed":true,"default":false,"off":false,"rules":[{"id":"pro","match":"all","conditions":[{"attribute":"plan","op":"eq","value":"pro"}],"serve":{"type":"fixed","value":true}}]},"accent":{"type":"string","enabled":true,"clientExposed":true,"default":"blue","off":"blue","rules":[]},"limit":{"type":"number","enabled":true,"clientExposed":true,"default":3,"off":0,"rules":[]},"theme":{"type":"json","enabled":true,"clientExposed":true,"default":{"dark":true,"radius":4},"off":null,"rules":[]},"rollout":{"type":"boolean","enabled":true,"clientExposed":true,"default":false,"off":false,"rules":[{"id":"half","match":"all","conditions":[],"serve":{"type":"rollout","percentage":50,"value":true,"otherwise":false}}]}}""")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        server.start()
    }

    /** Replaces the configuration with a new revision (JSON text exactly as the publisher stores it). */
    fun setFlags(rev: Long, flags: String, engine: Int? = 1) {
        revision = rev
        bundleText = """{"schema":1,""" + (if (engine != null) "\"engine\":$engine," else "") + """"project":"p","environment":"production","revision":$rev,"flags":$flags,"segments":{}}"""
        checksum = "c$rev-" + bundleText.hashCode().toUInt().toString(16)
    }

    fun signature(text: String = bundleText, rev: Long = revision, sum: String = checksum, env: String = environmentId): String =
        signingKey.sign(Signatures.canonicalString(env, rev, sum, text.toByteArray(Charsets.UTF_8)))

    fun revMessage(type: String = "rev", tamper: Boolean = false, env: String = environmentId): String {
        val text = if (tamper) bundleText.replace("\"default\":false", "\"default\":true") else bundleText
        val o = JsonValue.Obj.Builder()
            .put("t", JsonValue.Str(type)).put("revision", JsonValue.Num(revision.toDouble())).put("checksum", JsonValue.Str(checksum))
            .put("signature", JsonValue.Str(signature(env = env))).put("kid", JsonValue.Str(signingKey.kid)).put("environmentId", JsonValue.Str(env))
            .put("bundle", JsonValue.Str(text)).put("committedAt", committedAt?.let { JsonValue.Num(it.toDouble()) } ?: JsonValue.Null)
            .put("sentAt", JsonValue.Num(System.currentTimeMillis().toDouble()))
            .build()
        return o.toJson()!!
    }

    /** Pushes the current revision to every connected socket. */
    fun push(tamper: Boolean = false, env: String = environmentId) {
        val msg = revMessage(tamper = tamper, env = env)
        sockets.forEach { it.send(msg) }
    }

    fun closeSockets(code: Int, reason: String) {
        sockets.forEach { it.close(code, reason) }
    }

    private fun handle(r: RecordedRequest): MockResponse {
        requests.add(r)
        val path = r.requestUrl?.encodedPath ?: ""
        val authed = r.getHeader("Authorization")?.startsWith("Bearer nf_pub_") == true
        return when (path) {
            "/v1/keys" -> {
                keysRequests.incrementAndGet()
                val keys = published.joinToString(",") { """{"kty":"OKP","crv":"Ed25519","x":"${it.jwk.x}","kid":"${it.kid}","alg":"EdDSA","use":"sig","status":"active"}""" }
                MockResponse().setBody("""{"keys":[$keys]}""")
            }
            "/v1/bundle" -> {
                bundleRequests.incrementAndGet()
                if (!authed) return MockResponse().setResponseCode(401).setBody("""{"error":{"code":"unauthorized","message":"x"}}""")
                if (bundleStatus != 200) return MockResponse().setResponseCode(bundleStatus)
                val etag = "\"$checksum-client\""
                val res = MockResponse().addHeader("ETag", etag).addHeader("X-NanoFlags-Environment-Id", environmentId).addHeader("X-NanoFlags-Signed", signed.toString())
                if (signed) res.addHeader("X-NanoFlags-Signature", signature()).addHeader("X-NanoFlags-Key-Id", signingKey.kid)
                if (r.getHeader("If-None-Match") == etag) {
                    notModified.incrementAndGet()
                    return res.setResponseCode(304)
                }
                val text = if (tamperHttp) bundleText.replace("\"default\":false", "\"default\":true") else bundleText
                res.setBody("""{"revision":$revision,"checksum":"$checksum","bundle":$text}""")
            }
            "/v1/live" -> {
                liveConnects.incrementAndGet()
                if (!authed || !liveEnabled || r.requestUrl?.queryParameter("key") != null) return MockResponse().setResponseCode(503)
                MockResponse().addHeader("Sec-WebSocket-Protocol", LIVE_PROTOCOL).withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        sockets.add(webSocket)
                        webSocket.send(revMessage("hello"))
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (text == "ping" && answerPings) webSocket.send("pong")
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        sockets.remove(webSocket)
                        closedSockets.incrementAndGet()
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        if (sockets.remove(webSocket)) closedSockets.incrementAndGet()
                    }
                })
            }
            "/v1/stream" -> MockResponse().setResponseCode(503)
            "/v1/events" -> {
                events.add(JsonValue.parse(r.body.readUtf8()))
                MockResponse().setResponseCode(202).setBody("""{"accepted":1,"capped":false}""")
            }
            else -> MockResponse().setResponseCode(404)
        }
    }

    override fun close() {
        runCatching { closeSockets(1001, "shutdown") }
        runCatching { server.shutdown() }
    }
}
