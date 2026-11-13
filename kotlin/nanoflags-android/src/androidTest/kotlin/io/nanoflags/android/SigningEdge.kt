package io.nanoflags.android

import android.app.Activity
import io.nanoflags.Jwk
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** An empty activity: launching / stopping it moves `ProcessLifecycleOwner` to the foreground / background. */
class TestActivity : Activity()

/** A small on-device fake edge that signs bundles like the publisher (Ed25519 over the canonical string). */
class SigningEdge : AutoCloseable {
    private val priv = Ed25519PrivateKeyParameters(SecureRandom())
    val jwk = Jwk("OKP", "Ed25519", b64(priv.generatePublicKey().encoded), "dev1")
    val environmentId = "env-device"
    @Volatile var revision = 1L
    @Volatile var accent = "green"
    val bundleRequests = AtomicInteger()
    val liveConnects = AtomicInteger()
    val sockets = CopyOnWriteArrayList<WebSocket>()
    private val server = MockWebServer()

    val baseUrl: String get() = server.url("/").toString().trimEnd('/')

    private fun bundleText() =
        """{"schema":1,"engine":1,"project":"p","environment":"device","revision":$revision,"flags":{"accent":{"type":"string","enabled":true,"clientExposed":true,"default":"$accent","off":"blue","rules":[]}},"segments":{}}"""

    private fun checksum() = "c$revision$accent"

    private fun sign(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val msg = "nanoflags-bundle-v1\n$environmentId\n$revision\n${checksum()}\n$digest".toByteArray(Charsets.UTF_8)
        val s = Ed25519Signer()
        s.init(true, priv)
        s.update(msg, 0, msg.size)
        return b64(s.generateSignature())
    }

    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    fun revMessage(type: String): String {
        val text = bundleText()
        return """{"t":"$type","revision":$revision,"checksum":"${checksum()}","signature":"${sign(text)}","kid":"${jwk.kid}","environmentId":"$environmentId","bundle":${quote(text)},"committedAt":${System.currentTimeMillis()}}"""
    }

    fun publish(newAccent: String) {
        accent = newAccent
        revision++
        val msg = revMessage("rev")
        sockets.forEach { it.send(msg) }
    }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl?.encodedPath) {
                "/v1/bundle" -> {
                    bundleRequests.incrementAndGet()
                    val text = bundleText()
                    val etag = "\"${checksum()}-client\""
                    val r = MockResponse().addHeader("ETag", etag).addHeader("X-NanoFlags-Signed", "true").addHeader("X-NanoFlags-Environment-Id", environmentId)
                        .addHeader("X-NanoFlags-Key-Id", jwk.kid!!).addHeader("X-NanoFlags-Signature", sign(text))
                    if (request.getHeader("If-None-Match") == etag) r.setResponseCode(304) else r.setBody("""{"revision":$revision,"checksum":"${checksum()}","bundle":$text}""")
                }
                "/v1/live" -> {
                    liveConnects.incrementAndGet()
                    MockResponse().addHeader("Sec-WebSocket-Protocol", "nanoflags.v1").withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            sockets.add(webSocket)
                            webSocket.send(revMessage("hello"))
                        }

                        override fun onMessage(webSocket: WebSocket, text: String) {
                            if (text == "ping") webSocket.send("pong")
                        }

                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                            webSocket.close(1000, null)
                        }

                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                            sockets.remove(webSocket)
                        }

                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            sockets.remove(webSocket)
                        }
                    })
                }
                "/v1/events" -> MockResponse().setResponseCode(202)
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
    }

    override fun close() {
        runCatching { sockets.forEach { it.close(1001, "bye") } }
        runCatching { server.shutdown() }
    }

    companion object {
        fun b64(bytes: ByteArray): String = android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    }
}
