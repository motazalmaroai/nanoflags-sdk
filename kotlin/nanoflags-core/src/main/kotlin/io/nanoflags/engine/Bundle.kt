package io.nanoflags.engine

/**
 * A parsed, immutable configuration bundle: one revision of one environment. Safe for concurrent use.
 *
 * [parse] accepts what every NanoFlags SDK accepts (`schema` 1, a numeric `revision`, an object `flags`, an object
 * `segments`); the flags themselves are evaluated as they are, malformed or not, exactly like the TypeScript engine.
 */
class Bundle private constructor(
    /** The bundle document. */
    val value: JsonValue.Obj,
) {
    /** The bundle's revision number. */
    val revision: Long = (value["revision"] as JsonValue.Num).value.let { if (it.isNaN() || it.isInfinite()) 0L else it.toLong() }

    /** The bundle's `engine` member ([JsonValue.Undefined] when absent: engine 1). */
    val engine: JsonValue get() = value.field("engine")

    /** Whether this SDK's engine can evaluate the bundle. */
    val supportsEngine: Boolean get() = Engine.supportsEngine(engine)

    /** Flag keys in document order. */
    val flagKeys: List<String> get() = (value["flags"] as JsonValue.Obj).keys

    /** Evaluates one flag. */
    fun evaluate(flagKey: String, ctx: EvalContext?, fallback: JsonValue): EngineResult = Engine.evaluate(value, flagKey, ctx, fallback)

    /** `JSON.stringify(bundle)`. */
    fun toJson(): String = value.toJson()!!

    @Volatile
    private var attrsCache: Map<String, List<String>> = emptyMap()

    /** Attribute names that [flagKey]'s rules use (cached; see [Engine.attributesUsedBy]). */
    fun attributesUsedBy(flagKey: String): List<String> {
        attrsCache[flagKey]?.let { return it }
        val names = Engine.attributesUsedBy(value, flagKey)
        attrsCache = attrsCache + (flagKey to names)
        return names
    }

    companion object {
        /** Whether [v] has the shape the SDKs accept as a bundle. */
        @JvmStatic
        fun isBundle(v: JsonValue): Boolean {
            if (v !is JsonValue.Obj) return false
            val schema = v.field("schema")
            val rev = v.field("revision")
            val segs = v.field("segments")
            return schema is JsonValue.Num && schema.value == 1.0 && rev is JsonValue.Num && v.field("flags") is JsonValue.Obj &&
                (segs is JsonValue.Obj || segs is JsonValue.Arr)
        }

        /** Wraps a parsed bundle document; `null` when it is not a bundle. */
        @JvmStatic
        fun of(v: JsonValue): Bundle? = if (isBundle(v)) Bundle(v as JsonValue.Obj) else null

        /** Parses bundle JSON text; `null` when it is not valid JSON or not a bundle. */
        @JvmStatic
        fun parse(text: String): Bundle? = try {
            of(JsonValue.parse(text))
        } catch (_: InvalidJsonException) {
            null
        }
    }
}
