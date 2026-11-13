package io.nanoflags.engine

import java.math.BigDecimal
import java.math.BigInteger
import java.math.MathContext
import java.math.RoundingMode
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * A JSON value with JavaScript semantics.
 *
 * The engine is specified by its TypeScript implementation, which evaluates configuration that is plain JSON data
 * with JavaScript semantics (truthiness, loose property access, `Number()`, `String()`, `JSON.stringify`).
 * [JsonValue] models exactly that subset of JavaScript so that this port produces identical results, malformed
 * configurations included. Values are immutable and safe to share between threads.
 *
 * [Undefined] is JavaScript `undefined` (no value at all, e.g. a flag that serves nothing); [Null] is JSON `null`.
 */
sealed class JsonValue {
    /** JavaScript `undefined`. Never produced by parsing JSON text. */
    object Undefined : JsonValue() {
        override fun toString(): String = "undefined"
    }

    /** JSON `null`. */
    object Null : JsonValue() {
        override fun toString(): String = "null"
    }

    class Bool private constructor(val value: Boolean) : JsonValue() {
        companion object {
            val TRUE = Bool(true)
            val FALSE = Bool(false)
            fun of(b: Boolean): Bool = if (b) TRUE else FALSE
        }

        override fun equals(other: Any?): Boolean = other is Bool && other.value == value
        override fun hashCode(): Int = value.hashCode()
        override fun toString(): String = value.toString()
    }

    /** A JavaScript number (IEEE-754 double; JSON overflow becomes ±Infinity). */
    class Num(val value: Double) : JsonValue() {
        override fun equals(other: Any?): Boolean = other is Num && other.value == value
        override fun hashCode(): Int = value.hashCode()
        override fun toString(): String = Js.numberToString(value)
    }

    /** A JavaScript string (UTF-16; lone surrogates are kept as they are). */
    class Str(val value: String) : JsonValue() {
        override fun equals(other: Any?): Boolean = other is Str && other.value == value
        override fun hashCode(): Int = value.hashCode()
        override fun toString(): String = value
    }

    class Arr(val items: List<JsonValue>) : JsonValue() {
        override fun equals(other: Any?): Boolean = other is Arr && other.items == items
        override fun hashCode(): Int = items.hashCode()
        override fun toString(): String = toJson() ?: "[]"
    }

    /**
     * A plain object. [keys] are in JavaScript own-property order: array-index keys ascending first, then the other
     * keys in insertion order (a repeated key keeps its first position and its last value, as `JSON.parse` does).
     */
    class Obj private constructor(val keys: List<String>, private val map: Map<String, JsonValue>) : JsonValue() {
        operator fun get(key: String): JsonValue? = map[key]
        fun containsKey(key: String): Boolean = map.containsKey(key)
        val size: Int get() = keys.size
        val entries: List<Pair<String, JsonValue>> get() = keys.map { it to map.getValue(it) }

        override fun equals(other: Any?): Boolean = other is Obj && other.keys == keys && other.map == map
        override fun hashCode(): Int = map.hashCode()
        override fun toString(): String = toJson() ?: "{}"

        class Builder {
            private val map = LinkedHashMap<String, JsonValue>()
            fun put(key: String, value: JsonValue): Builder = apply { map[key] = value }
            fun build(): Obj {
                val index = ArrayList<Pair<Long, String>>()
                val names = ArrayList<String>()
                for (k in map.keys) {
                    val n = arrayIndex(k)
                    if (n >= 0) index.add(n to k) else names.add(k)
                }
                index.sortBy { it.first }
                return Obj(index.map { it.second } + names, LinkedHashMap(map))
            }
        }

        companion object {
            val EMPTY: Obj = Builder().build()
            fun of(vararg pairs: Pair<String, JsonValue>): Obj = Builder().apply { pairs.forEach { put(it.first, it.second) } }.build()
        }
    }

    /** A function value; only ever produced by reading a String / Array prototype method by name. */
    internal class Func(val name: String) : JsonValue() {
        override fun toString(): String = "function $name() { [native code] }"
    }

    /* ---------------- public helpers ---------------- */

    val isUndefined: Boolean get() = this === Undefined
    val isNull: Boolean get() = this === Null

    /** `JSON.stringify(this)`, or `null` when `JSON.stringify` would return `undefined`. */
    fun toJson(): String? {
        if (this === Undefined || this is Func) return null
        val sb = StringBuilder()
        Js.writeJson(this, sb)
        return sb.toString()
    }

    /**
     * Plain Kotlin data: `null` (null and undefined), [Boolean], [Double], [String], [List] and [Map] (a
     * [LinkedHashMap] in configuration order).
     */
    fun toKotlin(): Any? = when (this) {
        is Bool -> value
        is Num -> value
        is Str -> value
        is Arr -> items.map { it.toKotlin() }
        is Obj -> LinkedHashMap<String, Any?>().also { m -> for (k in keys) this[k]?.let { if (!it.isUndefined) m[k] = it.toKotlin() } }
        else -> null
    }

    /** The engine's type name: "null", "array", or the JavaScript `typeof` ("boolean", "number", …, "undefined"). */
    val typeName: String
        get() = when (this) {
            Undefined -> "undefined"
            Null -> "null"
            is Bool -> "boolean"
            is Num -> "number"
            is Str -> "string"
            is Arr -> "array"
            is Func -> "function"
            is Obj -> "object"
        }

    /** Own property [name] of an object (Undefined when absent or when this is not an object). */
    fun field(name: String): JsonValue = Js.own(this, name)

    companion object {
        /** Parses JSON text exactly like JavaScript's `JSON.parse`. */
        @JvmStatic
        fun parse(text: String): JsonValue = JsonParser(text).parseDocument()

        /** Parses UTF-8 JSON bytes (invalid UTF-8 becomes U+FFFD, as with a `TextDecoder`). */
        @JvmStatic
        fun parse(bytes: ByteArray): JsonValue = parse(String(bytes, Charsets.UTF_8))

        /**
         * Converts Kotlin / Java data: `null`, [Boolean], every [Number] (as a double, like JavaScript), [String],
         * [Char], enums (their name), [Map] (string keys, iteration order), [Iterable] / arrays, [Date] and
         * `java.time` values (ISO-8601 strings), [JsonValue]. Anything else becomes `null`.
         */
        @JvmStatic
        fun of(x: Any?): JsonValue = when (x) {
            null -> Null
            is JsonValue -> x
            is Boolean -> Bool.of(x)
            is String -> Str(x)
            is Char -> Str(x.toString())
            is BigDecimal -> Num(x.toDouble())
            is BigInteger -> Num(x.toDouble())
            is Number -> Num(x.toDouble())
            is Enum<*> -> Str(x.name)
            is Map<*, *> -> Obj.Builder().apply { for ((k, v) in x) put(k.toString(), of(v)) }.build()
            is Iterable<*> -> Arr(x.map { of(it) })
            is Array<*> -> Arr(x.map { of(it) })
            is IntArray -> Arr(x.map { Num(it.toDouble()) })
            is LongArray -> Arr(x.map { Num(it.toDouble()) })
            is DoubleArray -> Arr(x.map { Num(it) })
            is BooleanArray -> Arr(x.map { Bool.of(it) })
            is Date -> Str(isoFormat().format(x))
            else -> if (x.javaClass.name.startsWith("java.time.")) Str(x.toString()) else Null
        }

        private fun isoFormat() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }

        /** A canonical array index (0 … 2^32-2), or -1. */
        internal fun arrayIndex(k: String): Long {
            if (k.isEmpty() || k.length > 10 || (k.length > 1 && k[0] == '0')) return -1
            var n = 0L
            for (c in k) {
                if (c < '0' || c > '9') return -1
                n = n * 10 + (c - '0')
            }
            return if (n < 4294967295L) n else -1
        }
    }
}

/** Thrown by [JsonValue.parse] for text that `JSON.parse` rejects. */
class InvalidJsonException(message: String) : IllegalArgumentException(message)

/* ---------------- JSON.parse ---------------- */

internal class JsonParser(private val s: String) {
    private var i = 0

    fun parseDocument(): JsonValue {
        ws()
        val v = value(0)
        ws()
        if (i != s.length) fail("unexpected trailing data")
        return v
    }

    private fun fail(msg: String): Nothing = throw InvalidJsonException("invalid JSON: $msg at offset $i")

    private fun ws() {
        while (i < s.length) {
            when (s[i]) {
                ' ', '\t', '\n', '\r' -> i++
                else -> return
            }
        }
    }

    private fun value(depth: Int): JsonValue {
        if (depth > 10_000) fail("nesting too deep")
        if (i >= s.length) fail("unexpected end")
        val c = s[i]
        return when {
            c == '{' -> {
                i++
                val b = JsonValue.Obj.Builder()
                ws()
                if (i < s.length && s[i] == '}') {
                    i++
                    return b.build()
                }
                while (true) {
                    ws()
                    if (i >= s.length || s[i] != '"') fail("expected a string key")
                    val k = str()
                    ws()
                    if (i >= s.length || s[i] != ':') fail("expected ':'")
                    i++
                    ws()
                    b.put(k, value(depth + 1))
                    ws()
                    if (i < s.length && s[i] == ',') {
                        i++
                        continue
                    }
                    if (i < s.length && s[i] == '}') {
                        i++
                        return b.build()
                    }
                    fail("expected ',' or '}'")
                }
                @Suppress("UNREACHABLE_CODE")
                JsonValue.Undefined
            }
            c == '[' -> {
                i++
                val out = ArrayList<JsonValue>()
                ws()
                if (i < s.length && s[i] == ']') {
                    i++
                    return JsonValue.Arr(out)
                }
                while (true) {
                    ws()
                    out.add(value(depth + 1))
                    ws()
                    if (i < s.length && s[i] == ',') {
                        i++
                        continue
                    }
                    if (i < s.length && s[i] == ']') {
                        i++
                        return JsonValue.Arr(out)
                    }
                    fail("expected ',' or ']'")
                }
                @Suppress("UNREACHABLE_CODE")
                JsonValue.Undefined
            }
            c == '"' -> JsonValue.Str(str())
            c == 't' -> lit("true", JsonValue.Bool.TRUE)
            c == 'f' -> lit("false", JsonValue.Bool.FALSE)
            c == 'n' -> lit("null", JsonValue.Null)
            c == '-' || (c in '0'..'9') -> number()
            else -> fail("unexpected character")
        }
    }

    private fun lit(word: String, v: JsonValue): JsonValue {
        if (!s.startsWith(word, i)) fail("invalid literal")
        i += word.length
        return v
    }

    private fun digits(): Int {
        var n = 0
        while (i < s.length && s[i] in '0'..'9') {
            i++
            n++
        }
        return n
    }

    private fun number(): JsonValue {
        val start = i
        if (s[i] == '-') i++
        if (i < s.length && s[i] == '0') i++ else if (digits() == 0) fail("invalid number")
        if (i < s.length && s[i] == '.') {
            i++
            if (digits() == 0) fail("invalid number")
        }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            if (digits() == 0) fail("invalid number")
        }
        return JsonValue.Num(java.lang.Double.parseDouble(s.substring(start, i)))
    }

    private fun str(): String {
        i++ // opening quote
        val sb = StringBuilder()
        while (true) {
            val start = i
            while (i < s.length) {
                val c = s[i]
                if (c == '"' || c == '\\' || c < ' ') break
                i++
            }
            sb.append(s, start, i)
            if (i >= s.length) fail("unterminated string")
            val c = s[i]
            when {
                c == '"' -> {
                    i++
                    return sb.toString()
                }
                c < ' ' -> fail("control character in string")
                else -> {
                    i++
                    if (i >= s.length) fail("unterminated escape")
                    val e = s[i++]
                    when (e) {
                        '"', '\\', '/' -> sb.append(e)
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (s.length - i < 4) fail("invalid unicode escape")
                            var u = 0
                            for (j in 0 until 4) {
                                val h = Character.digit(s[i + j], 16)
                                if (h < 0 || s[i + j].code > 0x7f) fail("invalid unicode escape")
                                u = (u shl 4) or h
                            }
                            i += 4
                            sb.append(u.toChar()) // surrogates, paired or lone, are code units as in JavaScript
                        }
                        else -> fail("invalid escape")
                    }
                }
            }
        }
    }
}

/* ---------------- JavaScript abstract operations ---------------- */

/** V8's TypeError for the operations the engine performs (the message matches V8's). */
class JsTypeError(message: String) : RuntimeException(message)

internal object Js {
    fun writeJson(v: JsonValue, sb: StringBuilder) {
        when (v) {
            JsonValue.Null -> sb.append("null")
            is JsonValue.Bool -> sb.append(if (v.value) "true" else "false")
            is JsonValue.Num -> if (v.value.isNaN() || v.value.isInfinite()) sb.append("null") else sb.append(numberToString(v.value))
            is JsonValue.Str -> quote(v.value, sb)
            is JsonValue.Arr -> {
                sb.append('[')
                v.items.forEachIndexed { idx, e ->
                    if (idx > 0) sb.append(',')
                    if (e === JsonValue.Undefined || e is JsonValue.Func) sb.append("null") else writeJson(e, sb)
                }
                sb.append(']')
            }
            is JsonValue.Obj -> {
                sb.append('{')
                var first = true
                for (k in v.keys) {
                    val e = v[k]!!
                    if (e === JsonValue.Undefined || e is JsonValue.Func) continue
                    if (!first) sb.append(',')
                    first = false
                    quote(k, sb)
                    sb.append(':')
                    writeJson(e, sb)
                }
                sb.append('}')
            }
            else -> sb.append("null")
        }
    }

    private const val HEX = "0123456789abcdef"

    /** `JSON.stringify` of a string (well-formed JSON.stringify: lone surrogates are escaped). */
    fun quote(s: String, sb: StringBuilder) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> hex(c, sb)
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    sb.append(c).append(s[i + 1])
                    i++
                }
                Character.isSurrogate(c) -> hex(c, sb)
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun hex(c: Char, sb: StringBuilder) {
        val u = c.code
        sb.append("\\u").append(HEX[(u shr 12) and 0xF]).append(HEX[(u shr 8) and 0xF]).append(HEX[(u shr 4) and 0xF]).append(HEX[u and 0xF])
    }

    /** ECMAScript Number::toString(x) for radix 10 (shortest round-trip digits). */
    fun numberToString(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d == 0.0) return "0"
        if (d == Double.POSITIVE_INFINITY) return "Infinity"
        if (d == Double.NEGATIVE_INFINITY) return "-Infinity"
        val neg = d < 0
        val x = Math.abs(d)
        if (x < 9.007199254740992E15 && x == Math.floor(x)) return (if (neg) "-" else "") + x.toLong().toString()
        // Shortest digit string that round-trips (correctly rounded, so the closest one of that length).
        val exact = BigDecimal(x)
        var digits = ""
        var n = 0
        for (p in 1..17) {
            val r = exact.round(MathContext(p, RoundingMode.HALF_EVEN))
            if (java.lang.Double.parseDouble(r.toString()) == x) {
                var u = r.unscaledValue().toString()
                var scale = r.scale()
                while (u.length > 1 && u.endsWith("0")) {
                    u = u.substring(0, u.length - 1)
                    scale--
                }
                digits = u
                n = u.length - scale
                break
            }
        }
        val k = digits.length
        val out = when {
            k <= n && n <= 21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n > -6 && n <= 0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                val es = (if (e < 0) "-" else "+") + Math.abs(e)
                if (k == 1) digits + "e" + es else digits.substring(0, 1) + "." + digits.substring(1) + "e" + es
            }
        }
        return if (neg) "-$out" else out
    }

    /** `x.toFixed(2)` for 0 ≤ x < 1e21. */
    fun toFixed2(x: Double): String = BigDecimal(x).setScale(2, RoundingMode.HALF_UP).toPlainString()

    /** String(v). */
    fun toStr(v: JsonValue): String = when (v) {
        JsonValue.Undefined -> "undefined"
        JsonValue.Null -> "null"
        is JsonValue.Bool -> if (v.value) "true" else "false"
        is JsonValue.Num -> numberToString(v.value)
        is JsonValue.Str -> v.value
        is JsonValue.Arr -> join(v, ",")
        is JsonValue.Func -> "function ${v.name}() { [native code] }"
        is JsonValue.Obj -> "[object Object]"
    }

    /** Array.prototype.join. */
    fun join(v: JsonValue.Arr, sep: String): String {
        val sb = StringBuilder()
        v.items.forEachIndexed { idx, e ->
            if (idx > 0) sb.append(sep)
            if (e !== JsonValue.Undefined && e !== JsonValue.Null) sb.append(toStr(e))
        }
        return sb.toString()
    }

    /** ToBoolean(v). */
    fun truthy(v: JsonValue): Boolean = when (v) {
        JsonValue.Undefined, JsonValue.Null -> false
        is JsonValue.Bool -> v.value
        is JsonValue.Num -> v.value != 0.0 && !v.value.isNaN()
        is JsonValue.Str -> v.value.isNotEmpty()
        else -> true
    }

    /** ToNumber(ToPrimitive(v, number)). */
    fun toNumber(v: JsonValue): Double = when (v) {
        JsonValue.Undefined -> Double.NaN
        JsonValue.Null -> 0.0
        is JsonValue.Bool -> if (v.value) 1.0 else 0.0
        is JsonValue.Num -> v.value
        is JsonValue.Str -> stringToNumber(v.value)
        else -> stringToNumber(toStr(v))
    }

    fun isJsWhitespace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿' -> true
        else -> c in ' '..' '
    }

    /** String.prototype.trim. */
    fun trim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isJsWhitespace(s[a])) a++
        while (b > a && isJsWhitespace(s[b - 1])) b--
        return s.substring(a, b)
    }

    /** ECMAScript StringToNumber. */
    fun stringToNumber(input: String): Double {
        val s = trim(input)
        if (s.isEmpty()) return 0.0
        when (s) {
            "Infinity", "+Infinity" -> return Double.POSITIVE_INFINITY
            "-Infinity" -> return Double.NEGATIVE_INFINITY
        }
        if (s.length > 2 && s[0] == '0') {
            val base = when (s[1]) {
                'x', 'X' -> 16
                'o', 'O' -> 8
                'b', 'B' -> 2
                else -> 0
            }
            if (base != 0) {
                for (j in 2 until s.length) {
                    val c = s[j]
                    if (c.code > 0x7f) return Double.NaN
                    val dv = Character.digit(c, 16)
                    if (dv < 0 || dv >= base) return Double.NaN
                }
                return BigInteger(s.substring(2), base).toDouble()
            }
        }
        // StrDecimalLiteral: [+-] (digits [. digits] | . digits) [e [+-] digits]
        var i = 0
        if (s[i] == '+' || s[i] == '-') i++
        var intDigits = 0
        while (i < s.length && s[i] in '0'..'9') {
            i++
            intDigits++
        }
        var fracDigits = 0
        if (i < s.length && s[i] == '.') {
            i++
            while (i < s.length && s[i] in '0'..'9') {
                i++
                fracDigits++
            }
        }
        if (intDigits + fracDigits == 0) return Double.NaN
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            var expDigits = 0
            while (i < s.length && s[i] in '0'..'9') {
                i++
                expDigits++
            }
            if (expDigits == 0) return Double.NaN
        }
        if (i != s.length) return Double.NaN
        return try {
            java.lang.Double.parseDouble(s)
        } catch (_: NumberFormatException) {
            Double.NaN
        }
    }

    private val stringMethods = setOf(
        "anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "concat", "constructor", "endsWith", "fixed",
        "fontcolor", "fontsize", "includes", "indexOf", "isWellFormed", "italics", "lastIndexOf", "link", "localeCompare", "match",
        "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "small", "split", "strike",
        "sub", "substr", "substring", "sup", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toString", "toUpperCase",
        "toWellFormed", "trim", "trimEnd", "trimLeft", "trimRight", "trimStart", "valueOf",
    )

    private val arrayMethods = setOf(
        "at", "concat", "constructor", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast",
        "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "map", "pop", "push",
        "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice", "toLocaleString", "toReversed", "toSorted",
        "toSpliced", "toString", "unshift", "values", "with",
    )

    /** Object.prototype members, as `${words[name]}` renders them in describeCondition. */
    val objectProtoStrings = mapOf(
        "constructor" to "function Object() { [native code] }",
        "__defineGetter__" to "function __defineGetter__() { [native code] }",
        "__defineSetter__" to "function __defineSetter__() { [native code] }",
        "hasOwnProperty" to "function hasOwnProperty() { [native code] }",
        "__lookupGetter__" to "function __lookupGetter__() { [native code] }",
        "__lookupSetter__" to "function __lookupSetter__() { [native code] }",
        "isPrototypeOf" to "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" to "function propertyIsEnumerable() { [native code] }",
        "toString" to "function toString() { [native code] }",
        "valueOf" to "function valueOf() { [native code] }",
        "__proto__" to "[object Object]",
        "toLocaleString" to "function toLocaleString() { [native code] }",
    )

    /**
     * The property read `v[name]` for the fixed property names the engine reads. Plain objects only expose own
     * properties here: none of those names exist on Object.prototype.
     */
    fun get(v: JsonValue, name: String): JsonValue {
        when (v) {
            JsonValue.Undefined, JsonValue.Null -> throw JsTypeError("Cannot read properties of ${toStr(v)} (reading '$name')")
            is JsonValue.Str -> {
                if (name == "length") return JsonValue.Num(v.value.length.toDouble())
                val n = JsonValue.arrayIndex(name)
                if (n >= 0) return if (n < v.value.length) JsonValue.Str(v.value[n.toInt()].toString()) else JsonValue.Undefined
                if (name in stringMethods) return JsonValue.Func(name)
            }
            is JsonValue.Arr -> {
                if (name == "length") return JsonValue.Num(v.items.size.toDouble())
                val n = JsonValue.arrayIndex(name)
                if (n >= 0) return if (n < v.items.size) v.items[n.toInt()] else JsonValue.Undefined
                if (name in arrayMethods) return JsonValue.Func(name)
            }
            is JsonValue.Obj -> return v[name] ?: JsonValue.Undefined
            else -> {}
        }
        return JsonValue.Undefined
    }

    /** The engine's `own(obj, key)`: an own-property lookup that never reads inherited members. */
    fun own(obj: JsonValue, key: String): JsonValue = when (obj) {
        is JsonValue.Obj -> obj[key] ?: JsonValue.Undefined
        is JsonValue.Arr, is JsonValue.Str -> if (JsonValue.arrayIndex(key) >= 0 || key == "length") get(obj, key) else JsonValue.Undefined
        else -> JsonValue.Undefined
    }
}
