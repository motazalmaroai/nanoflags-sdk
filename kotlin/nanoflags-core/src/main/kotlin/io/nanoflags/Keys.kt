package io.nanoflags

import io.nanoflags.engine.InvalidJsonException
import io.nanoflags.engine.JsonValue
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.Request

/** Effective verification settings and the key cache. */
internal class Verifier private constructor(
    private val client: NanoFlags,
    private val base: List<PublicKey>,
    val require: Boolean,
    private val refetch: Boolean,
) {
    private val mutex = Mutex()
    private var fetched: List<PublicKey> = emptyList()
    private var fetchedAt = 0L

    companion object {
        const val KEYS_REFETCH_MS = 60_000L

        fun create(o: VerifyOptions?, official: Boolean, client: NanoFlags): Verifier? {
            if (o == null) return if (official) Verifier(client, Signatures.importKeys(OFFICIAL_SIGNING_KEYS), require = true, refetch = true) else null
            if (o.disabled) return null
            val require = o.require ?: official
            return when {
                o.publicKeys.isNotEmpty() -> {
                    require(o.publicKeys.all { it.isPublicEd25519 }) { "VerifyOptions.publicKeys must contain public Ed25519 JWKs only (no private keys)." }
                    Verifier(client, Signatures.importKeys(o.publicKeys), require, o.fetchKeys)
                }
                o.fetchKeys || !official -> Verifier(client, emptyList(), require, refetch = true)
                else -> Verifier(client, Signatures.importKeys(OFFICIAL_SIGNING_KEYS), require, refetch = true)
            }
        }
    }

    /**
     * Keys to verify a signature by [kid] with: the pinned or embedded keys plus those fetched from `/v1/keys`. With
     * refetch, a key id that none of them has (rotation) loads `/v1/keys` once — again at most once a minute.
     */
    suspend fun keysFor(kid: String?): List<PublicKey> {
        if (!refetch) return base
        return mutex.withLock {
            val known = base + fetched
            if (known.isNotEmpty() && (kid == null || known.any { it.kid == kid })) return@withLock known
            if (fetchedAt != 0L && System.currentTimeMillis() - fetchedAt < KEYS_REFETCH_MS) return@withLock known
            try {
                fetched = fetch()
                fetchedAt = System.currentTimeMillis()
                base + fetched
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                // Without any key the bundle cannot be checked. With the embedded keys the failed reload counts as
                // this minute's reload, so a bad key id cannot make every request ask for keys.
                if (base.isEmpty()) throw e
                fetchedAt = System.currentTimeMillis()
                known
            }
        }
    }

    private suspend fun fetch(): List<PublicKey> {
        // Public endpoint: the SDK key is deliberately not sent.
        val req = Request.Builder().url(client.baseUrl + "/v1/keys").header("User-Agent", client.userAgent).get().build()
        val (code, bytes) = client.http.newCall(req).await().use { it.code to (if (it.code == 200) it.bodyBytes(1L shl 20) else null) }
        if (code != 200) throw NanoFlagsException(ErrorCode.SIGNATURE, "Signing keys request failed with HTTP $code.", code)
        val body = try {
            JsonValue.parse(bytes ?: throw NanoFlagsException(ErrorCode.SIGNATURE, "The signing keys response is too large."))
        } catch (_: InvalidJsonException) {
            throw NanoFlagsException(ErrorCode.SIGNATURE, "Invalid signing keys response.")
        }
        val list = (body.field("keys") as? JsonValue.Arr)?.items.orEmpty().mapNotNull { Jwk.fromJson(it) }
        val keys = Signatures.importKeys(list)
        if (keys.isEmpty()) throw NanoFlagsException(ErrorCode.SIGNATURE, "The edge returned no usable signing keys.")
        return keys
    }
}
