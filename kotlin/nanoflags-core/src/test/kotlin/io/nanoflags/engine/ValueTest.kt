package io.nanoflags.engine

import io.nanoflags.BuildInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Date

class ValueTest {
    @Test
    fun numberToString() {
        val cases = mapOf(
            0.0 to "0", -0.0 to "0", 1.0 to "1", -1.0 to "-1", 1.5 to "1.5", 100.0 to "100", 1e21 to "1e+21", 1e20 to "100000000000000000000",
            1e-7 to "1e-7", 0.000001 to "0.000001", 123456789012.0 to "123456789012", 0.30000000000000004 to "0.30000000000000004",
            33.33 to "33.33", -0.5 to "-0.5", 1.7976931348623157e308 to "1.7976931348623157e+308", 5e-324 to "5e-324",
            9007199254740993.0 to "9007199254740992", 1.25e-7 to "1.25e-7", 2e-3 to "0.002", 1e23 to "1e+23",
            Double.POSITIVE_INFINITY to "Infinity", Double.NEGATIVE_INFINITY to "-Infinity", Double.NaN to "NaN",
        )
        for ((d, want) in cases) assertEquals("numberToString($d)", want, Js.numberToString(d))
        assertEquals("12.30", Js.toFixed2(12.3))
        assertEquals("0.07", Js.toFixed2(0.07))
    }

    @Test
    fun stringToNumber() {
        val ok = mapOf(
            "" to 0.0, " " to 0.0, "10" to 10.0, " 10 " to 10.0, "1e1" to 10.0, "0x10" to 16.0, "0X1f" to 31.0, "0b11" to 3.0, "0o7" to 7.0,
            ".5" to 0.5, "5." to 5.0, "+5" to 5.0, "-5" to -5.0, "Infinity" to Double.POSITIVE_INFINITY, "-Infinity" to Double.NEGATIVE_INFINITY,
            "\u00a07\u2003" to 7.0, "\ufeff7" to 7.0, "1E+2" to 100.0,
        )
        for ((s, want) in ok) assertEquals("stringToNumber($s)", want, Js.stringToNumber(s), 0.0)
        for (s in listOf("-0x10", "5_0", "NaN", "abc", "١٢", "0x", "1e", "e1", ".", "+", "inf", "infinity", "0x1p3", "1 2", "1d", "1f", "0x１")) {
            assertTrue("stringToNumber($s) should be NaN", Js.stringToNumber(s).isNaN())
        }
    }

    @Test
    fun parseOrderAndStringify() {
        val cases = mapOf(
            """{"b":1,"a":2,"2":3,"1":4,"01":5}""" to """{"1":4,"2":3,"b":1,"a":2,"01":5}""",
            """{"a":1,"b":2,"a":3}""" to """{"a":3,"b":2}""",
            """[1e400,-0,1E2,"é😀\ud800",null]""" to """[null,0,100,"é😀\ud800",null]""",
            """"\u0001\u001f\"\\\/\b\f\n\r\t"""" to """"\u0001\u001f\"\\/\b\f\n\r\t"""",
            """ { "x" : [ true , false ] } """ to """{"x":[true,false]}""",
        )
        for ((input, want) in cases) assertEquals(input, want, JsonValue.parse(input).toJson())
        for (bad in listOf("", "{", "[1,]", """{"a":1,}""", "01", "1.", ".5", "+1", "\"a", "\"\u0001\"", "nul", """{"a" 1}""", "1 2", "NaN", "'a'", "\"\\u12G4\"")) {
            try {
                JsonValue.parse(bad)
                fail("accepted invalid JSON: $bad")
            } catch (_: InvalidJsonException) {
            }
        }
    }

    @Test
    fun conversionFromKotlin() {
        val cases = listOf<Pair<Any?, String>>(
            null to "null", true to "true", 7L to "7", 3.toByte() to "3", 1.5f to "1.5", "x" to "\"x\"",
            listOf(1, "a", null) to """[1,"a",null]""", intArrayOf(1, 2) to "[1,2]", linkedMapOf("b" to 1, "a" to 2) to """{"b":1,"a":2}""",
            Date(1767323045006L) to "\"2026-01-02T03:04:05.006Z\"", Double.NaN to "null", Any() to "null",
        )
        for ((x, want) in cases) assertEquals("of($x)", want, JsonValue.of(x).toJson())
    }

    @Test
    fun bundleShape() {
        val b = Bundle.parse("""{"schema":1,"revision":4,"flags":{"f":{"type":"boolean","enabled":true,"default":true,"off":false,"rules":[]}},"segments":{}}""")
        assertNotNull(b)
        assertEquals(4L, b!!.revision)
        assertTrue(b.supportsEngine)
        val r = b.evaluate("f", MapContext(mapOf("key" to "u")), JsonValue.Bool.FALSE)
        assertEquals(JsonValue.Bool.TRUE, r.value)
        assertEquals(Reason.DEFAULT, r.reason)
        for (bad in listOf("{}", """{"schema":2,"revision":1,"flags":{},"segments":{}}""", """{"schema":1,"revision":"1","flags":{},"segments":{}}""", """{"schema":1,"revision":1,"flags":[],"segments":{}}""", "[]", "nope")) {
            assertNull(bad, Bundle.parse(bad))
        }
        val none = Engine.evaluate(JsonValue.Null, "f", null, JsonValue.Str("fb"))
        assertEquals(Reason.FLAG_NOT_FOUND, none.reason)
        assertEquals(JsonValue.Str("fb"), none.value)
    }

    @Test
    fun attributesUsedBy() {
        val v = JsonValue.parse("""{"flags":{"f":{"rules":[{"conditions":[{"attribute":"region","op":"eq","value":"x"},{"attribute":"","op":"segment","value":"s"}],"serve":{"type":"rollout","bucketBy":"org"}}]}},"segments":{"s":{"conditions":[{"attribute":"plan","op":"exists"}]}}}""")
        assertEquals(listOf("region", "plan", "org"), Engine.attributesUsedBy(v, "f"))
    }

    @Test
    fun versionMatchesTheBuild() {
        System.getProperty("nanoflags.version")?.let { assertEquals("BuildInfo.VERSION must equal gradle.properties nanoflags.version", it, BuildInfo.VERSION) }
    }
}
