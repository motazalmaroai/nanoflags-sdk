package io.nanoflags.openfeature

import dev.openfeature.kotlin.sdk.EvaluationContext
import dev.openfeature.kotlin.sdk.EvaluationMetadata
import dev.openfeature.kotlin.sdk.FeatureProvider
import dev.openfeature.kotlin.sdk.Hook
import dev.openfeature.kotlin.sdk.ProviderEvaluation
import dev.openfeature.kotlin.sdk.ProviderMetadata
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.events.OpenFeatureProviderEvents
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import dev.openfeature.kotlin.sdk.exceptions.OpenFeatureError
import io.nanoflags.EvaluationDetail
import io.nanoflags.NanoFlags
import io.nanoflags.NanoFlagsContext
import io.nanoflags.Status
import io.nanoflags.engine.JsonValue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.merge
import io.nanoflags.engine.Reason as NfReason

/**
 * OpenFeature provider backed by a [NanoFlags] client (official OpenFeature Kotlin SDK, `dev.openfeature:kotlin-sdk`).
 *
 * ```
 * OpenFeatureAPI.setProviderAndWait(NanoFlagsProvider(flags), initialContext = ImmutableContext("user-42"))
 * val on = OpenFeatureAPI.getClient().getBooleanValue("new-checkout", false)
 * ```
 *
 * Evaluations are local (the native engine). Mapping (same as the JS and Python providers): `targetingKey` becomes the
 * bucketing identity `key`; `off` → DISABLED, `default` → DEFAULT, a fixed rule → TARGETING_MATCH, a rollout rule →
 * SPLIT; the variant is the rule id. The context set with `OpenFeatureAPI.setEvaluationContext` becomes the client's
 * context (`identify`). New configurations and status changes become provider events.
 *
 * @param closeClient close the client on [shutdown] (default false: the client is yours).
 */
class NanoFlagsProvider @JvmOverloads constructor(
    val client: NanoFlags,
    private val readyTimeoutMs: Long = 10_000,
    private val closeClient: Boolean = false,
) : FeatureProvider {
    override val hooks: List<Hook<*>> = emptyList()
    override val metadata: ProviderMetadata = object : ProviderMetadata {
        override val name: String = "NanoFlags"
    }

    override suspend fun initialize(initialContext: EvaluationContext?) {
        if (initialContext != null) client.identify(toNanoFlagsContext(initialContext))
        if (!client.waitUntilReady(readyTimeoutMs)) {
            throw OpenFeatureError.ProviderNotReadyError("NanoFlags has no configuration loaded yet (${client.lastLoadError?.message ?: "timeout"}).")
        }
    }

    override fun shutdown() {
        if (closeClient) client.close()
    }

    override suspend fun onContextSet(oldContext: EvaluationContext?, newContext: EvaluationContext) {
        client.identify(toNanoFlagsContext(newContext))
    }

    override fun observe(): Flow<OpenFeatureProviderEvents> = merge(
        client.changes.map {
            OpenFeatureProviderEvents.ProviderConfigurationChanged(
                OpenFeatureProviderEvents.EventDetails(message = "Revision ${it.revision} is now in use.", eventMetadata = mapOf("revision" to it.revision)),
            )
        },
        client.status.drop(1).mapNotNull {
            when (it) {
                Status.READY -> OpenFeatureProviderEvents.ProviderReady()
                Status.STALE -> OpenFeatureProviderEvents.ProviderStale(OpenFeatureProviderEvents.EventDetails(message = "The configuration in use is not known to be current."))
                Status.NOT_READY -> null
            }
        },
    )

    override fun getBooleanEvaluation(key: String, defaultValue: Boolean, context: EvaluationContext?): ProviderEvaluation<Boolean> =
        resolve(key, defaultValue, context, "boolean") { (it as? JsonValue.Bool)?.value }

    override fun getStringEvaluation(key: String, defaultValue: String, context: EvaluationContext?): ProviderEvaluation<String> =
        resolve(key, defaultValue, context, "string") { (it as? JsonValue.Str)?.value }

    override fun getIntegerEvaluation(key: String, defaultValue: Int, context: EvaluationContext?): ProviderEvaluation<Int> =
        resolve(key, defaultValue, context, "integer") { v -> finite(v)?.takeIf { it == Math.floor(it) && it >= Int.MIN_VALUE && it <= Int.MAX_VALUE }?.toInt() }

    override fun getLongEvaluation(key: String, defaultValue: Long, context: EvaluationContext?): ProviderEvaluation<Long> =
        resolve(key, defaultValue, context, "long") { v -> finite(v)?.takeIf { it == Math.floor(it) && Math.abs(it) <= 9.007199254740991E15 }?.toLong() }

    override fun getDoubleEvaluation(key: String, defaultValue: Double, context: EvaluationContext?): ProviderEvaluation<Double> =
        resolve(key, defaultValue, context, "double") { finite(it) }

    override fun getObjectEvaluation(key: String, defaultValue: Value, context: EvaluationContext?): ProviderEvaluation<Value> =
        resolve(key, defaultValue, context, "object") { if (it.isUndefined) null else toValue(it) }

    private fun finite(v: JsonValue): Double? = (v as? JsonValue.Num)?.value?.takeIf { !it.isNaN() && !it.isInfinite() }

    private fun <T> resolve(key: String, default: T, context: EvaluationContext?, kind: String, extract: (JsonValue) -> T?): ProviderEvaluation<T> {
        val d: EvaluationDetail<Any?> = try {
            client.evaluate(key, null, context?.let { toNanoFlagsContext(it) })
        } catch (e: RuntimeException) {
            return ProviderEvaluation(default, reason = Reason.ERROR.name, errorCode = ErrorCode.GENERAL, errorMessage = e.message)
        }
        val meta = EvaluationMetadata.builder().putLong("revision", d.revision).build()
        fun failure(code: ErrorCode, message: String) = ProviderEvaluation(default, reason = Reason.ERROR.name, errorCode = code, errorMessage = message, metadata = meta)
        when (d.reason) {
            NfReason.FLAG_NOT_FOUND -> return if (client.revision == null) {
                failure(ErrorCode.PROVIDER_NOT_READY, "NanoFlags has no configuration loaded yet.")
            } else {
                failure(ErrorCode.FLAG_NOT_FOUND, "Flag \"$key\" is not in the loaded configuration (r${d.revision}).")
            }
            NfReason.ERROR -> return failure(ErrorCode.GENERAL, d.error ?: "Evaluation failed.")
            else -> {}
        }
        val value = extract(d.raw) ?: return failure(ErrorCode.TYPE_MISMATCH, "Flag \"$key\" has a ${d.raw.typeName} value; a $kind was requested.")
        val reason = when (d.reason) {
            NfReason.OFF -> Reason.DISABLED
            NfReason.DEFAULT -> Reason.DEFAULT
            else -> if (d.inRollout == null) Reason.TARGETING_MATCH else Reason.SPLIT
        }
        return ProviderEvaluation(value, variant = d.ruleId, reason = reason.name, metadata = meta)
    }

    companion object {
        /** OpenFeature context → NanoFlags context. The targeting key becomes `key` and wins over an attribute `key`. */
        @JvmStatic
        fun toNanoFlagsContext(context: EvaluationContext): NanoFlagsContext {
            val attrs = LinkedHashMap<String, Any?>()
            for ((name, v) in context.asMap()) if (name != "targetingKey") attrs[name] = toKotlin(v, 0)
            val tk = context.getTargetingKey()
            return if (tk.isNotEmpty()) NanoFlagsContext(tk, attrs) else NanoFlagsContext(null, attrs)
        }

        @OptIn(kotlin.time.ExperimentalTime::class)
        private fun toKotlin(v: Value, depth: Int): Any? = when (v) {
            is Value.String -> v.string
            is Value.Boolean -> v.boolean
            is Value.Integer -> v.integer
            is Value.Long -> v.long
            is Value.Double -> if (v.double.isNaN() || v.double.isInfinite()) null else v.double
            is Value.Instant -> v.instant.toString()
            is Value.List -> if (depth >= 8) null else v.list.map { toKotlin(it, depth + 1) }
            is Value.Structure -> if (depth >= 8) null else v.structure.mapValues { toKotlin(it.value, depth + 1) }
            else -> null
        }

        /** NanoFlags JSON → OpenFeature value (numbers stay doubles unless they are whole and fit an Int). */
        @JvmStatic
        fun toValue(v: JsonValue): Value = when (v) {
            is JsonValue.Bool -> Value.Boolean(v.value)
            is JsonValue.Str -> Value.String(v.value)
            is JsonValue.Num -> if (v.value == Math.floor(v.value) && v.value >= Int.MIN_VALUE && v.value <= Int.MAX_VALUE) Value.Integer(v.value.toInt()) else Value.Double(v.value)
            is JsonValue.Arr -> Value.List(v.items.map { toValue(it) })
            is JsonValue.Obj -> Value.Structure(v.entries.associate { it.first to toValue(it.second) })
            else -> Value.Null
        }
    }
}
