package io.nanoflags.engine

import io.nanoflags.engine.Js.get
import io.nanoflags.engine.Js.own
import io.nanoflags.engine.Js.toStr
import io.nanoflags.engine.Js.truthy
import java.text.Normalizer

/**
 * The NanoFlags evaluation engine: a port of the TypeScript engine (`@nanoflags/engine`) that the dashboard, the
 * edge Worker and every SDK share. Pure and deterministic: the same bundle, flag key and context always produce the
 * same result, including the bucket of percentage rollouts (MurmurHash3 x86 32-bit over the NFC-normalised UTF-8
 * bytes of `"seed:identity"`). Rules are data; no user code ever runs.
 *
 * The cross-language parity fixtures (`packages/engine/fixtures/parity.json`) pin the behaviour, malformed
 * configurations included.
 */
object Engine {
    /** The engine version implemented here (`ENGINE_VERSION` of the TypeScript engine). Newer bundles are refused. */
    const val VERSION: Int = 1

    /* ---------------- hashing ---------------- */

    /**
     * `TextEncoder.encode(input.normalize("NFC"))`: well-formed runs are NFC-normalised, lone surrogates (which never
     * compose with their neighbours) become U+FFFD.
     */
    internal fun hashInput(s: String): ByteArray {
        var simple = true
        for (c in s) if (c >= '̀') {
            simple = false
            break
        }
        if (simple) return s.toByteArray(Charsets.UTF_8)
        val out = StringBuilder(s.length)
        var runStart = 0
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) {
                i += 2
                continue
            }
            if (Character.isSurrogate(c)) {
                if (i > runStart) out.append(Normalizer.normalize(s.substring(runStart, i), Normalizer.Form.NFC))
                out.append('�')
                runStart = i + 1
            }
            i++
        }
        if (runStart < s.length) out.append(Normalizer.normalize(s.substring(runStart), Normalizer.Form.NFC))
        return out.toString().toByteArray(Charsets.UTF_8)
    }

    /** MurmurHash3 x86 32-bit over the NFC-normalised UTF-8 bytes of [input] (unsigned, as a Long). Distribution only. */
    @JvmStatic
    @JvmOverloads
    fun murmur3(input: String, seed: Long = 0): Long {
        val data = hashInput(input)
        val c1 = 0xcc9e2d51.toInt()
        val c2 = 0x1b873593
        var h = seed.toInt()
        val n = data.size
        val blocks = n / 4
        fun b(i: Int) = data[i].toInt() and 0xff
        for (i in 0 until blocks) {
            val o = i * 4
            var k = b(o) or (b(o + 1) shl 8) or (b(o + 2) shl 16) or (b(o + 3) shl 24)
            k *= c1
            k = (k shl 15) or (k ushr 17)
            k *= c2
            h = h xor k
            h = (h shl 13) or (h ushr 19)
            h = h * 5 + 0xe6546b64.toInt()
        }
        var k = 0
        val tail = blocks * 4
        val rem = n and 3
        if (rem >= 3) k = k xor (b(tail + 2) shl 16)
        if (rem >= 2) k = k xor (b(tail + 1) shl 8)
        if (rem >= 1) {
            k = k xor b(tail)
            k *= c1
            k = (k shl 15) or (k ushr 17)
            k *= c2
            h = h xor k
        }
        h = h xor n
        h = h xor (h ushr 16)
        h *= 0x85ebca6b.toInt()
        h = h xor (h ushr 13)
        h *= 0xc2b2ae35.toInt()
        h = h xor (h ushr 16)
        return h.toLong() and 0xffffffffL
    }

    /** Bucket in [0, 100) with two decimals of resolution, stable for a given seed + identity. */
    @JvmStatic
    fun bucketOf(seed: String, identity: String): Double = (murmur3("$seed:$identity") % 10000).toDouble() / 100

    /* ---------------- conditions ---------------- */

    private fun isObjLike(v: JsonValue) = v === JsonValue.Null || v is JsonValue.Arr || v is JsonValue.Obj

    private fun looseEq(a: JsonValue, b: JsonValue): Boolean {
        if (a === JsonValue.Undefined || b === JsonValue.Undefined) return false
        if (isObjLike(a) || isObjLike(b)) return a.toJson() == b.toJson()
        return strictEq(a, b)
    }

    private fun strictEq(a: JsonValue, b: JsonValue): Boolean = when {
        a is JsonValue.Bool && b is JsonValue.Bool -> a.value == b.value
        a is JsonValue.Num && b is JsonValue.Num -> a.value == b.value
        a is JsonValue.Str && b is JsonValue.Str -> a.value == b.value
        else -> a === b && (a === JsonValue.Null || a === JsonValue.Undefined)
    }

    private fun num(v: JsonValue): Double? {
        if (v is JsonValue.Num && !v.value.isNaN() && !v.value.isInfinite()) return v.value
        if (v is JsonValue.Str && Js.trim(v.value) != "") {
            val n = Js.stringToNumber(v.value)
            if (!n.isNaN() && !n.isInfinite()) return n
        }
        return null
    }

    private fun isStr(v: JsonValue, s: String) = v is JsonValue.Str && v.value == s

    private fun lookup(ctx: EvalContext?, name: String): JsonValue = ctx?.lookup(name) ?: JsonValue.Undefined

    private fun matchCondition(c: JsonValue, ctx: EvalContext?, segments: JsonValue, depth: Int): Boolean {
        val op = get(c, "op")
        if (isStr(op, "segment") || isStr(op, "not_segment")) {
            val value = get(c, "value")
            val seg = if (value is JsonValue.Str) own(segments, value.value) else JsonValue.Undefined
            var inSeg = false
            if (seg !== JsonValue.Undefined && depth < 4) {
                val match = get(seg, "match")
                val conds = get(seg, "conditions")
                inSeg = matchAll(match, conds, ctx, segments, depth + 1)
            }
            return if (isStr(op, "segment")) inSeg else seg !== JsonValue.Undefined && !inSeg
        }
        val attribute = get(c, "attribute")
        val actual = lookup(ctx, toStr(attribute))
        val value = get(c, "value")
        if (op !is JsonValue.Str) return false
        return when (op.value) {
            "exists" -> actual !== JsonValue.Undefined && actual !== JsonValue.Null
            "not_exists" -> actual === JsonValue.Undefined || actual === JsonValue.Null
            "eq" -> looseEq(actual, value)
            "neq" -> actual !== JsonValue.Undefined && !looseEq(actual, value)
            "in" -> value is JsonValue.Arr && value.items.any { looseEq(actual, it) }
            "not_in" -> actual !== JsonValue.Undefined && value is JsonValue.Arr && value.items.none { looseEq(actual, it) }
            "contains" -> actual is JsonValue.Str && value is JsonValue.Str && actual.value.contains(value.value)
            "starts_with" -> actual is JsonValue.Str && value is JsonValue.Str && actual.value.startsWith(value.value)
            "ends_with" -> actual is JsonValue.Str && value is JsonValue.Str && actual.value.endsWith(value.value)
            "gt", "gte", "lt", "lte" -> {
                val a = num(actual) ?: return false
                val b = num(value) ?: return false
                when (op.value) {
                    "gt" -> a > b
                    "gte" -> a >= b
                    "lt" -> a < b
                    else -> a <= b
                }
            }
            else -> false
        }
    }

    /** The engine's matchAll(mode, conditions, …), including its failure modes. */
    private fun matchAll(mode: JsonValue, conditions: JsonValue, ctx: EvalContext?, segments: JsonValue, depth: Int): Boolean {
        val length = get(conditions, "length")
        if (length is JsonValue.Num && length.value == 0.0) return true
        val some = isStr(mode, "any")
        if (conditions !is JsonValue.Arr) throw JsTypeError("conditions.${if (some) "some" else "every"} is not a function")
        for (c in conditions.items) {
            val ok = matchCondition(c, ctx, segments, depth)
            if (some && ok) return true
            if (!some && !ok) return false
        }
        return !some
    }

    private val opWords = mapOf(
        "eq" to "=", "neq" to "≠", "in" to "in", "not_in" to "not in", "contains" to "contains", "starts_with" to "starts with",
        "ends_with" to "ends with", "gt" to ">", "gte" to "≥", "lt" to "<", "lte" to "≤", "exists" to "exists",
        "not_exists" to "does not exist", "segment" to "in segment", "not_segment" to "not in segment",
    )

    private fun describeCondition(c: JsonValue): String {
        val value = get(c, "value")
        val v = when (value) {
            is JsonValue.Arr -> Js.join(value, ", ")
            JsonValue.Undefined -> ""
            else -> toStr(value)
        }
        val op = get(c, "op")
        val key = toStr(op)
        val word = opWords[key] ?: Js.objectProtoStrings[key] ?: "undefined"
        if (isStr(op, "segment") || isStr(op, "not_segment")) return "$word $v"
        val attribute = get(c, "attribute")
        if (isStr(op, "exists") || isStr(op, "not_exists")) return "${toStr(attribute)} $word"
        return "${toStr(attribute)} $word $v"
    }

    /** The engine's fmt(v): strings as they are, everything else as JSON ("undefined" when there is none). */
    private fun fmt(v: JsonValue): String = if (v is JsonValue.Str) v.value else v.toJson() ?: "undefined"

    /* ---------------- evaluation ---------------- */

    /**
     * Evaluates one flag of [bundle] (a parsed bundle document; [JsonValue.Undefined] or [JsonValue.Null] for "no
     * configuration loaded"). Never throws: on any problem it returns [fallback] with reason `flag_not_found` or
     * `error`.
     */
    @JvmStatic
    fun evaluate(bundle: JsonValue, flagKey: String, ctx: EvalContext?, fallback: JsonValue): EngineResult {
        val nullish = bundle === JsonValue.Undefined || bundle === JsonValue.Null
        var revision: JsonValue = JsonValue.Num(0.0)
        if (!nullish) {
            val r = runCatching { get(bundle, "revision") }.getOrDefault(JsonValue.Undefined)
            if (r !== JsonValue.Undefined && r !== JsonValue.Null) revision = r
        }
        val trace = ArrayList<TraceStep>()
        try {
            val flag = if (nullish) JsonValue.Undefined else own(get(bundle, "flags"), flagKey)
            if (!truthy(bundle) || !truthy(flag)) {
                val detail = if (truthy(bundle)) "Flag is not in this configuration. The application fallback applies." else "No configuration is loaded. The application fallback applies."
                trace.add(TraceStep("result", "Returned ${fmt(fallback)}", detail))
                return EngineResult(flagKey, fallback, Reason.FLAG_NOT_FOUND, revision = revision, trace = trace)
            }
            trace.add(TraceStep("config", "Configuration loaded", if (Js.toNumber(revision) > 0) "r${toStr(revision)}" else "draft"))
            val enabled = get(flag, "enabled")
            if (!truthy(enabled)) {
                val off = get(flag, "off")
                trace.add(TraceStep("result", "Returned ${fmt(off)}", "Flag is disabled in this environment."))
                return EngineResult(flagKey, off, Reason.OFF, revision = revision, trace = trace)
            }
            val rules = get(flag, "rules")
            val segments = get(bundle, "segments")
            var i = 0
            while (true) {
                val length = get(rules, "length")
                if (!(i.toDouble() < Js.toNumber(length))) break
                val rule = get(rules, i.toString())
                val match = get(rule, "match")
                val conditions = get(rule, "conditions")
                val matched = matchAll(match, conditions, ctx, segments, 0)
                val label = "Rule " + (i + 1).toString().padStart(2, '0')
                var summary = "all contexts"
                if (truthy(get(conditions, "length"))) {
                    val parts = (conditions as JsonValue.Arr).items.map { describeCondition(it) }
                    summary = parts.joinToString(if (isStr(match, "any")) " OR " else " AND ")
                }
                trace.add(TraceStep("rule", if (matched) "$label matched" else "$label did not match", summary, matched))
                if (!matched) {
                    i++
                    continue
                }
                val serve = get(rule, "serve")
                val serveType = get(serve, "type")
                val ruleId = get(rule, "id")
                if (isStr(serveType, "fixed")) {
                    val value = get(serve, "value")
                    trace.add(TraceStep("result", "Returned ${fmt(value)}", "$label serves a fixed value."))
                    return EngineResult(flagKey, value, Reason.RULE_MATCH, i, ruleId, revision = revision, trace = trace)
                }
                val attrV = get(serve, "bucketBy")
                val attr = if (attrV === JsonValue.Undefined || attrV === JsonValue.Null) "key" else toStr(attrV)
                val identity = lookup(ctx, attr)
                val otherwise = get(serve, "otherwise")
                if (identity === JsonValue.Undefined || identity === JsonValue.Null || isStr(identity, "")) {
                    trace.add(TraceStep("allocation", "Allocation skipped", "Context has no \"$attr\" to bucket by; treated as outside the allocation.", false))
                    trace.add(TraceStep("result", "Returned ${fmt(otherwise)}", "Remaining eligible users."))
                    return EngineResult(flagKey, otherwise, Reason.RULE_MATCH, i, ruleId, inRollout = false, revision = revision, trace = trace)
                }
                val seedV = get(serve, "seed")
                val seed = if (seedV === JsonValue.Undefined || seedV === JsonValue.Null) flagKey else toStr(seedV)
                val bucket = bucketOf(seed, toStr(identity))
                val percentage = get(serve, "percentage")
                val inRollout = bucket < Js.toNumber(percentage)
                val pct = toStr(percentage)
                trace.add(TraceStep("allocation", "Allocation evaluated", "$pct% rollout · $attr ${if (inRollout) "inside" else "outside"} allocation (bucket ${Js.toFixed2(bucket)})", inRollout))
                val value = if (inRollout) get(serve, "value") else otherwise
                trace.add(TraceStep("result", "Returned ${fmt(value)}", if (inRollout) "Inside the $pct% allocation." else "Remaining eligible users."))
                return EngineResult(flagKey, value, Reason.RULE_MATCH, i, ruleId, inRollout, bucket, revision, trace)
            }
            val def = get(flag, "default")
            trace.add(TraceStep("result", "Returned ${fmt(def)}", "No rule matched. The flag default applies."))
            return EngineResult(flagKey, def, Reason.DEFAULT, revision = revision, trace = trace)
        } catch (e: Throwable) {
            if (e is VirtualMachineError && e !is StackOverflowError) throw e
            val msg = e.message ?: e.toString()
            trace.add(TraceStep("result", "Returned ${fmt(fallback)}", "Evaluation error: $msg. The application fallback applies."))
            return EngineResult(flagKey, fallback, Reason.ERROR, revision = revision, trace = trace, error = msg)
        }
    }

    /** True when this engine can evaluate a bundle whose `engine` member is [e] (Undefined when absent). */
    @JvmStatic
    fun supportsEngine(e: JsonValue): Boolean {
        if (e === JsonValue.Undefined) return true
        return e is JsonValue.Num && e.value == Math.floor(e.value) && !e.value.isInfinite() && e.value >= 1 && e.value <= VERSION
    }

    /**
     * Removes what must not reach browser keys: flags that are not client-exposed, and every segment that no
     * client-exposed flag references (directly or through other segments). Mirrors `clientBundle()` of the engine.
     */
    @JvmStatic
    fun clientBundle(bundle: JsonValue.Obj): JsonValue.Obj {
        val flags = bundle["flags"] as? JsonValue.Obj ?: JsonValue.Obj.EMPTY
        val kept = JsonValue.Obj.Builder()
        val pending = ArrayList<String>()
        fun refs(conditions: JsonValue) {
            if (conditions !is JsonValue.Arr) return
            for (c in conditions.items) {
                val op = c.field("op")
                val v = c.field("value")
                if ((isStr(op, "segment") || isStr(op, "not_segment")) && v is JsonValue.Str) pending.add(v.value)
            }
        }
        for ((k, f) in flags.entries) {
            if (f.field("clientExposed") != JsonValue.Bool.TRUE) continue
            kept.put(k, f)
            val rules = f.field("rules")
            if (rules is JsonValue.Arr) for (r in rules.items) refs(r.field("conditions"))
        }
        val segments = bundle["segments"] as? JsonValue.Obj
        val needed = HashSet<String>()
        while (pending.isNotEmpty()) {
            val k = pending.removeAt(pending.size - 1)
            val seg = segments?.get(k) ?: continue
            if (!needed.add(k)) continue
            refs(seg.field("conditions"))
        }
        val segOut = JsonValue.Obj.Builder()
        if (segments != null) for ((k, s) in segments.entries) if (k in needed) segOut.put(k, s)
        val out = JsonValue.Obj.Builder()
        for ((k, v) in bundle.entries) {
            out.put(k, when (k) {
                "flags" -> kept.build()
                "segments" -> segOut.build()
                else -> v
            })
        }
        if (!bundle.containsKey("flags")) out.put("flags", kept.build())
        if (!bundle.containsKey("segments")) out.put("segments", segOut.build())
        return out.build()
    }

    /**
     * The context attributes that the rules of [flagKey] reference (through segments up to the engine's nesting
     * limit), plus the bucketing attribute of rollouts. The SDK reports only these attribute names (with the type of
     * the value, never the value) with sampled evaluation events.
     */
    @JvmStatic
    fun attributesUsedBy(bundle: JsonValue, flagKey: String): List<String> {
        val names = LinkedHashSet<String>()
        return try {
            val segments = bundle.field("segments")
            fun visit(conds: JsonValue, depth: Int): Boolean {
                if (conds !is JsonValue.Arr) return conds is JsonValue.Str
                for (c in conds.items) {
                    val op = get(c, "op")
                    if (isStr(op, "segment") || isStr(op, "not_segment")) {
                        val value = get(c, "value")
                        if (value is JsonValue.Str) {
                            val seg = own(segments, value.value)
                            if (truthy(seg) && depth < 4 && !visit(get(seg, "conditions"), depth + 1)) return false
                        }
                    } else {
                        val attr = get(c, "attribute")
                        if (truthy(attr)) names.add(toStr(attr))
                    }
                }
                return true
            }
            val rules = get(own(bundle.field("flags"), flagKey), "rules") as? JsonValue.Arr ?: return emptyList()
            for (r in rules.items) {
                if (!visit(get(r, "conditions"), 0)) return emptyList()
                val serve = get(r, "serve")
                if (isStr(get(serve, "type"), "rollout")) {
                    val by = get(serve, "bucketBy")
                    names.add(if (by === JsonValue.Undefined || by === JsonValue.Null) "key" else toStr(by))
                }
            }
            names.toList()
        } catch (_: RuntimeException) {
            emptyList()
        }
    }
}

/** Why an evaluation produced its value. [wire] is the engine's spelling ("rule_match", …). */
enum class Reason(val wire: String) {
    RULE_MATCH("rule_match"),
    DEFAULT("default"),
    OFF("off"),
    FLAG_NOT_FOUND("flag_not_found"),
    ERROR("error");

    override fun toString(): String = wire
}

/** One line of the human-readable explanation of an evaluation. */
data class TraceStep(
    /** "config", "rule", "allocation" or "result". */
    val kind: String,
    val title: String,
    val detail: String,
    /** Set for rule and allocation steps. */
    val matched: Boolean? = null,
)

/** The full outcome of [Engine.evaluate], mirroring the engine's `Evaluation` object. */
data class EngineResult(
    val flagKey: String,
    /** The served value; [JsonValue.Undefined] when the configuration served nothing (a malformed flag). */
    val value: JsonValue,
    val reason: Reason,
    /** Zero-based index of the matching rule, or -1. */
    val ruleIndex: Int = -1,
    /** The matching rule's `id` ([JsonValue.Undefined] when there is none). */
    val ruleId: JsonValue = JsonValue.Undefined,
    val inRollout: Boolean? = null,
    val bucket: Double? = null,
    /** The bundle's `revision` (0 without a bundle). */
    val revision: JsonValue = JsonValue.Num(0.0),
    val trace: List<TraceStep> = emptyList(),
    /** The evaluation error message (reason [Reason.ERROR] only). */
    val error: String? = null,
)

/** Attribute lookup for evaluation: the engine only ever reads own attributes by name. */
fun interface EvalContext {
    /** The attribute, or `null` when it is absent (`undefined`). */
    fun lookup(name: String): JsonValue?
}

/** A context held as an object [JsonValue] (as parsed from JSON). */
class ValueContext(private val v: JsonValue) : EvalContext {
    override fun lookup(name: String): JsonValue? = (v as? JsonValue.Obj)?.get(name)
}

/** A context backed by Kotlin data; values are converted with [JsonValue.of] when they are read. */
class MapContext(private val m: Map<String, Any?>) : EvalContext {
    override fun lookup(name: String): JsonValue? = if (m.containsKey(name)) JsonValue.of(m[name]) else null
}
