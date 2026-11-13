package io.nanoflags

import io.nanoflags.engine.JsonValue
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

class VerifyTest {
    private val official = Signatures.importKeys(OFFICIAL_SIGNING_KEYS)

    /** A real `GET /v1/bundle` answer of the production edge (captured by the Go SDK team), verified offline. */
    @Test
    fun productionResponseVerifiesWithEmbeddedKey() {
        val f = listOf("../../sdk-go/internal/testdata/signed-demo-response.json", "../../go/internal/testdata/signed-demo-response.json").map(::File).firstOrNull { it.isFile }
        assumeTrue("signed-demo-response.json not found", f != null)
        val doc = JsonValue.parse(f!!.readBytes())
        val h = doc.field("headers")
        fun hdr(n: String) = (h.field(n) as JsonValue.Str).value
        val body = (doc.field("body") as JsonValue.Str).value.toByteArray(Charsets.UTF_8)
        val parsed = JsonValue.parse(body)
        val info = SignatureInfo(hdr("x-nanoflags-signature"), hdr("x-nanoflags-key-id"), hdr("x-nanoflags-environment-id"),
            (parsed.field("revision") as JsonValue.Num).value.toLong(), (parsed.field("checksum") as JsonValue.Str).value)
        val raw = Signatures.rawMember(body, "bundle")!!
        assertTrue("genuine bundle verifies", Signatures.verify(official, info, raw))
        val tampered = String(raw, Charsets.UTF_8).replace("\"default\":false", "\"default\":true").toByteArray(Charsets.UTF_8)
        assertFalse("tampered bundle is refused", Signatures.verify(official, info, tampered))
        assertFalse("other revision is refused", Signatures.verify(official, info.copy(revision = info.revision + 1), raw))
        assertFalse("other environment is refused", Signatures.verify(official, info.copy(environmentId = "x"), raw))
        assertFalse("unknown kid matches no key", Signatures.verify(official, info.copy(kid = "k9"), raw))
        // Re-serialising the parsed bundle reproduces the signed bytes (JSON.stringify of JSON.parse).
        assertEquals(String(raw, Charsets.UTF_8), JsonValue.parse(raw).toJson())
    }

    @Test
    fun rawMemberReturnsExactBytes() {
        val text = """ { "a" : 1 , "bundle" : {"x":"}\"]","y":[1,{"z":null}]} , "bundle2":2 } """.toByteArray()
        assertArrayEquals("""{"x":"}\"]","y":[1,{"z":null}]}""".toByteArray(), Signatures.rawMember(text, "bundle"))
        assertArrayEquals("2".toByteArray(), Signatures.rawMember("""{"bundle":1,"bundle":2}""".toByteArray(), "bundle"))
        assertNull(Signatures.rawMember("[1]".toByteArray(), "bundle"))
        assertNull(Signatures.rawMember("""{"bundle":""".toByteArray(), "bundle"))
    }

    @Test
    fun keyImportRefusesPrivateAndMalformedKeys() {
        val good = OFFICIAL_SIGNING_KEYS[0]
        assertEquals(1, Signatures.importKeys(listOf(good)).size)
        assertEquals(0, Signatures.importKeys(listOf(good.copy(privateMember = "secret"))).size)
        assertEquals(0, Signatures.importKeys(listOf(good.copy(crv = "P-256"))).size)
        assertEquals(0, Signatures.importKeys(listOf(good.copy(x = "AAAA"))).size)
        assertEquals(0, Signatures.importKeys(listOf(good.copy(x = "!!"))).size)
    }

    @Test
    fun base64UrlAcceptsBothAlphabets() {
        assertArrayEquals(byteArrayOf(-5, -1), Signatures.base64UrlDecode("-_8"))
        assertArrayEquals(byteArrayOf(-5, -1), Signatures.base64UrlDecode("+/8="))
        assertNull(Signatures.base64UrlDecode("A"))
    }
}
