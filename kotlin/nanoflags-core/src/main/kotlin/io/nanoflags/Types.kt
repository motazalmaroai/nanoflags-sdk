package io.nanoflags

import io.nanoflags.engine.EvalContext
import io.nanoflags.engine.JsonValue
import io.nanoflags.engine.Reason
import io.nanoflags.engine.TraceStep

/** SDK release information. */
object BuildInfo {
    /** This SDK's version (also in the User-Agent and in telemetry as `kotlin/<version>` / `android/<version>`). */
    const val VERSION: String = "0.1.0"
}

/** What kind of problem a [NanoFlagsException] reports. */
enum class ErrorCode {
    /** Invalid configuration of the client. */
    CONFIG,
    /** The edge could not be reached. */
    NETWORK,
    /** The edge answered with an unexpected HTTP status. */
    HTTP,
    /** The SDK key was rejected (unknown or revoked). */
    UNAUTHORIZED,
    /** The edge sent something that is not a valid bundle. */
    INVALID_BUNDLE,
    /** A bundle failed signature verification (or was unsigned while signatures are required). */
    SIGNATURE,
    /** A bundle needs a newer evaluation engine than this SDK ships. */
    ENGINE,
    /** The on-device store could not be read or written. */
    STORE,
    /** The environment of the SDK key was deleted (live socket closed with 4004). */
    ENVIRONMENT_DELETED,
}

/** A background problem. A failed update never changes the configuration in use. */
class NanoFlagsException @JvmOverloads constructor(
    val code: ErrorCode,
    message: String,
    /** HTTP status of the failed request, when there was one. */
    val httpStatus: Int? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    override fun toString(): String = "NanoFlagsException(${code.name.lowercase()}): $message"
}

/** State of the configuration in use. */
enum class Status {
    /** No configuration is loaded: every evaluation returns its default. */
    NOT_READY,
    /** The configuration is known to be current. */
    READY,
    /** A configuration is in use but is not known to be current (offline, restored from storage, environment deleted…). */
    STALE,
}

/** How updates reach the client right now. */
enum class Transport {
    /** Pushed over the `/v1/live` WebSocket. */
    LIVE,
    /** Announced over server-sent events (`/v1/stream`), then fetched. */
    STREAM,
    /** Polled (`/v1/bundle` with `If-None-Match`). */
    POLL,
    /** No network activity (app in the background, offline, or the data-saver policy). */
    PAUSED,
}

/** Where an adopted configuration came from. */
enum class Source { NETWORK, STORE, BOOTSTRAP }

/** A newly adopted configuration. */
data class ChangeEvent(
    val revision: Long,
    /** `null` when no configuration was loaded before. */
    val previousRevision: Long?,
    val checksum: String?,
    val source: Source,
    val transport: Transport,
    /**
     * Time from the commit of the revision in the database to this event, for revisions pushed over the live socket
     * that carry their commit time. Compares the database's clock with this device's.
     */
    val latencyMs: Long?,
)

/**
 * The attributes of the evaluated user / device. [key] is the stable identity used for percentage rollouts.
 * Attribute values may be strings, booleans, numbers, `null`, lists and maps. Immutable.
 */
class NanoFlagsContext @JvmOverloads constructor(
    val key: String? = null,
    attributes: Map<String, Any?> = emptyMap(),
) {
    /** The attributes (without [key]). */
    val attributes: Map<String, Any?> = LinkedHashMap(attributes).apply { if (key != null) remove("key") }

    /** Converted once, so evaluations do no conversion work. */
    internal val values: Map<String, JsonValue> = LinkedHashMap<String, JsonValue>().apply {
        for ((k, v) in this@NanoFlagsContext.attributes) put(k, JsonValue.of(v))
        if (key != null) put("key", JsonValue.Str(key)) else attributes["key"]?.let { put("key", JsonValue.of(it)) }
    }

    internal val evalContext = EvalContext { values[it] }

    /** A copy with [name] set (or replaced). */
    fun with(name: String, value: Any?): NanoFlagsContext =
        if (name == "key") NanoFlagsContext(value?.toString(), attributes) else NanoFlagsContext(key, attributes + (name to value))

    override fun equals(other: Any?): Boolean = other is NanoFlagsContext && other.values == values
    override fun hashCode(): Int = values.hashCode()
    override fun toString(): String = "NanoFlagsContext(key=$key, attributes=${attributes.keys})"

    /** Builder for Java and DSL use: `NanoFlagsContext.build("user-42") { set("plan", "pro") }`. */
    class Builder(private var key: String? = null) {
        private val attrs = LinkedHashMap<String, Any?>()
        fun key(key: String?): Builder = apply { this.key = key }
        fun set(name: String, value: Any?): Builder = apply { attrs[name] = value }
        fun build(): NanoFlagsContext = NanoFlagsContext(key, attrs)
    }

    companion object {
        /** The empty context (no key: rollouts treat it as outside every allocation). */
        @JvmField
        val EMPTY = NanoFlagsContext()

        @JvmStatic
        fun builder(key: String? = null): Builder = Builder(key)

        /** `NanoFlagsContext.build("user-42") { set("plan", "pro") }` */
        inline fun build(key: String? = null, block: Builder.() -> Unit): NanoFlagsContext = Builder(key).apply(block).build()
    }
}

/** The full result of an evaluation. */
data class EvaluationDetail<T>(
    val flagKey: String,
    /** The value returned to the application (the default for reasons [Reason.FLAG_NOT_FOUND] and [Reason.ERROR]). */
    val value: T,
    val reason: Reason,
    /** Zero-based index of the matching rule, or -1. */
    val ruleIndex: Int,
    val ruleId: String?,
    /** For percentage rollouts: whether the context fell inside the allocation, and its bucket (0–99.99). */
    val inRollout: Boolean?,
    val bucket: Double?,
    /** Revision of the configuration used (0 when none is loaded). */
    val revision: Long,
    /** Human-readable explanation, step by step. */
    val trace: List<TraceStep>,
    /** Explains reason [Reason.ERROR] (evaluation error or type mismatch). */
    val error: String?,
    /** The served value as the engine produced it ([JsonValue.Undefined] when the configuration served nothing). */
    val raw: JsonValue,
)

/** Network conditions as the platform reports them (`nanoflags-android` feeds them in automatically). */
data class NetworkState @JvmOverloads constructor(
    val available: Boolean = true,
    /** A metered network (mobile data, a metered Wi-Fi). */
    val metered: Boolean = false,
    /** The user restricts background data (Android Data Saver). */
    val dataSaver: Boolean = false,
)
