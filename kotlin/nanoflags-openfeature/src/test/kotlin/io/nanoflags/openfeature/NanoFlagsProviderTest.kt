package io.nanoflags.openfeature

import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.OpenFeatureAPI
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import io.nanoflags.NanoFlags
import io.nanoflags.VerifyOptions
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class NanoFlagsProviderTest {
    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = if (request.requestUrl?.encodedPath == "/v1/bundle") {
                MockResponse().addHeader("X-NanoFlags-Signed", "false").setBody(
                    """{"revision":3,"checksum":"c3","bundle":{"schema":1,"project":"p","environment":"e","revision":3,"flags":{""" +
                        """"checkout":{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"pro","match":"all","conditions":[{"attribute":"plan","op":"eq","value":"pro"}],"serve":{"type":"fixed","value":true}}]},""" +
                        """"split":{"type":"boolean","enabled":true,"default":false,"off":false,"rules":[{"id":"half","match":"all","conditions":[],"serve":{"type":"rollout","percentage":100,"value":true,"otherwise":false}}]},""" +
                        """"limit":{"type":"number","enabled":true,"default":5,"off":0,"rules":[]},""" +
                        """"theme":{"type":"json","enabled":true,"default":{"dark":true,"sizes":[1,2.5]},"off":null,"rules":[]},""" +
                        """"killed":{"type":"string","enabled":false,"default":"a","off":"off-value","rules":[]}},"segments":{}}}""",
                )
            } else {
                MockResponse().setResponseCode(503)
            }
        }
        start()
    }
    private val client = NanoFlags("nf_pub_providertest") {
        baseUrl = server.url("/").toString().trimEnd('/')
        verify = VerifyOptions.DISABLED
        live = false
        events.enabled = false
    }

    @After
    fun tearDown() {
        runBlocking { OpenFeatureAPI.shutdown() }
        client.close()
        server.shutdown()
    }

    @Test
    fun resolvesThroughTheOpenFeatureClient() = runBlocking {
        val provider = NanoFlagsProvider(client)
        OpenFeatureAPI.setProviderAndWait(provider, ImmutableContext("user-1", mapOf("plan" to Value.String("free"))))
        val of = OpenFeatureAPI.getClient()
        assertEquals(false, of.getBooleanValue("checkout", true))
        OpenFeatureAPI.setEvaluationContextAndWait(ImmutableContext("user-1", mapOf("plan" to Value.String("pro"))))
        val d = of.getBooleanDetails("checkout", false)
        assertEquals(true, d.value)
        assertEquals(Reason.TARGETING_MATCH.name, d.reason)
        assertEquals("pro", d.variant)
        assertEquals(Reason.SPLIT.name, of.getBooleanDetails("split", false).reason)
        assertEquals(5, of.getIntegerValue("limit", 0))
        assertEquals(5.0, of.getDoubleValue("limit", 0.0), 0.0)
        val off = of.getStringDetails("killed", "x")
        assertEquals("off-value", off.value)
        assertEquals(Reason.DISABLED.name, off.reason)
        assertEquals(Reason.DEFAULT.name, of.getIntegerDetails("limit", 0).reason)
        assertEquals(Value.Structure(mapOf("dark" to Value.Boolean(true), "sizes" to Value.List(listOf(Value.Integer(1), Value.Double(2.5))))), of.getObjectValue("theme", Value.Null))
        val mismatch = of.getStringDetails("limit", "fb")
        assertEquals("fb", mismatch.value)
        assertEquals(ErrorCode.TYPE_MISMATCH, mismatch.errorCode)
        val missing = of.getBooleanDetails("nope", true)
        assertEquals(true, missing.value)
        assertEquals(ErrorCode.FLAG_NOT_FOUND, missing.errorCode)
        assertEquals(3L, d.metadata.getLong("revision"))
    }
}
