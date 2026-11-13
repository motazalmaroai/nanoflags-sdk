package io.nanoflags

import io.nanoflags.engine.JsonValue
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest

/** The hosted NanoFlags edge. With this base URL (the default) every bundle is verified and unsigned bundles are refused. */
const val OFFICIAL_EDGE_URL: String = "https://edge.nanoflags.io"

/** A public Ed25519 key as published by `GET /v1/keys` (JWK, `kty` OKP, `crv` Ed25519). */
data class Jwk(
    val kty: String,
    val crv: String,
    val x: String,
    val kid: String? = null,
    /** The private member. A JWK that carries one is a private key and is refused. */
    val privateMember: String? = null,
) {
    internal val isPublicEd25519: Boolean get() = kty == "OKP" && crv == "Ed25519" && x.isNotEmpty() && privateMember == null

    companion object {
        /** Reads a JWK object (`{ kty, crv, x, kid }`); `null` when it is not an object. */
        @JvmStatic
        fun fromJson(v: JsonValue): Jwk? {
            if (v !is JsonValue.Obj) return null
            fun s(k: String) = (v[k] as? JsonValue.Str)?.value
            return Jwk(s("kty") ?: "", s("crv") ?: "", s("x") ?: "", s("kid"), s(PRIVATE_MEMBER))
        }

        private const val PRIVATE_MEMBER = "d"
    }
}

/**
 * The public halves of the production bundle-signing keys (safe to embed; the same list as every NanoFlags SDK).
 * A bundle signed with a key id that is not listed here — a rotation after this release — makes the client load
 * `GET /v1/keys` once (at most once a minute).
 */
@JvmField
val OFFICIAL_SIGNING_KEYS: List<Jwk> = listOf(
    Jwk(kty = "OKP", crv = "Ed25519", x = "wQu1EsaE-yTjqpUbibGyBrajy3IiRb7LyaiqeYRxG4U", kid = "k1"),
)

/** What a signature covers (from the `X-NanoFlags-*` headers / the push message). */
internal data class SignatureInfo(
    val signature: String,
    val kid: String?,
    val environmentId: String,
    val revision: Long,
    val checksum: String,
) {
    fun toJson(): JsonValue.Obj = JsonValue.Obj.Builder().apply {
        put("signature", JsonValue.Str(signature))
        if (kid != null) put("kid", JsonValue.Str(kid))
        put("environmentId", JsonValue.Str(environmentId))
        put("revision", JsonValue.Num(revision.toDouble()))
        put("checksum", JsonValue.Str(checksum))
    }.build()

    companion object {
        fun fromJson(v: JsonValue): SignatureInfo? {
            if (v !is JsonValue.Obj) return null
            val sig = (v["signature"] as? JsonValue.Str)?.value ?: return null
            val env = (v["environmentId"] as? JsonValue.Str)?.value ?: return null
            val rev = (v["revision"] as? JsonValue.Num)?.value ?: return null
            val checksum = (v["checksum"] as? JsonValue.Str)?.value ?: return null
            if (rev != Math.floor(rev)) return null
            return SignatureInfo(sig, (v["kid"] as? JsonValue.Str)?.value, env, rev.toLong(), checksum)
        }
    }
}

internal class PublicKey(val kid: String?, val key: Ed25519PublicKeyParameters)

internal object Signatures {
    fun importKeys(jwks: List<Jwk>): List<PublicKey> = jwks.mapNotNull { k ->
        if (!k.isPublicEd25519) return@mapNotNull null
        val raw = base64UrlDecode(k.x) ?: return@mapNotNull null
        if (raw.size != Ed25519PublicKeyParameters.KEY_SIZE) return@mapNotNull null
        try {
            PublicKey(k.kid, Ed25519PublicKeyParameters(raw, 0))
        } catch (_: RuntimeException) {
            null
        }
    }

    /** Base64url (padding and the standard alphabet tolerated); `null` when malformed. */
    fun base64UrlDecode(input: String): ByteArray? {
        val s = input.replace('+', '-').replace('/', '_').trimEnd('=')
        if (s.length % 4 == 1) return null
        val out = java.io.ByteArrayOutputStream(s.length * 3 / 4)
        var buf = 0
        var bits = 0
        for (c in s) {
            val v = when (c) {
                in 'A'..'Z' -> c - 'A'
                in 'a'..'z' -> c - 'a' + 26
                in '0'..'9' -> c - '0' + 52
                '-' -> 62
                '_' -> 63
                else -> return null
            }
            buf = (buf shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buf shr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }

    fun sha256Hex(data: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(data)
        val sb = StringBuilder(64)
        for (b in d) sb.append("0123456789abcdef"[(b.toInt() shr 4) and 0xf]).append("0123456789abcdef"[b.toInt() and 0xf])
        return sb.toString()
    }

    /** The signed text: `nanoflags-bundle-v1\n<environment>\n<revision>\n<checksum>\n<sha256 hex of the bundle text>`. */
    fun canonicalString(environmentId: String, revision: Long, checksum: String, bundleText: ByteArray): ByteArray =
        "nanoflags-bundle-v1\n$environmentId\n$revision\n$checksum\n${sha256Hex(bundleText)}".toByteArray(Charsets.UTF_8)

    /**
     * Whether [info]'s signature is valid by one of [keys] over the canonical string for [bundleText]. A key id narrows
     * the candidates; an unknown key id matches no key.
     */
    fun verify(keys: List<PublicKey>, info: SignatureInfo, bundleText: ByteArray): Boolean {
        val sig = base64UrlDecode(info.signature) ?: return false
        if (sig.size != 64) return false
        val msg = canonicalString(info.environmentId, info.revision, info.checksum, bundleText)
        for (k in keys) {
            if (info.kid != null && k.kid != null && k.kid != info.kid) continue
            val signer = Ed25519Signer()
            signer.init(false, k.key)
            signer.update(msg, 0, msg.size)
            if (signer.verifySignature(sig)) return true
        }
        return false
    }

    /**
     * The exact source bytes of the top-level member [name] of a JSON object (the last one when it repeats, like
     * `JSON.parse`), or `null`. The edge embeds the stored, signed bundle text byte-for-byte; hashing that span avoids
     * any re-serialisation.
     */
    fun rawMember(text: ByteArray, name: String): ByteArray? {
        var i = 0
        val n = text.size
        fun ws() {
            while (i < n && (text[i] == ' '.code.toByte() || text[i] == '\n'.code.toByte() || text[i] == '\r'.code.toByte() || text[i] == '\t'.code.toByte())) i++
        }
        fun str(): IntArray? {
            if (i >= n || text[i] != '"'.code.toByte()) return null
            val start = i
            i++
            while (i < n) {
                when (text[i]) {
                    '\\'.code.toByte() -> i += 2
                    '"'.code.toByte() -> {
                        i++
                        return intArrayOf(start, i)
                    }
                    else -> i++
                }
            }
            return null
        }
        fun value(): Boolean {
            ws()
            if (i >= n) return false
            when (text[i]) {
                '"'.code.toByte() -> return str() != null
                '{'.code.toByte(), '['.code.toByte() -> {
                    var depth = 0
                    while (i < n) {
                        when (text[i]) {
                            '"'.code.toByte() -> {
                                if (str() == null) return false
                                continue
                            }
                            '{'.code.toByte(), '['.code.toByte() -> depth++
                            '}'.code.toByte(), ']'.code.toByte() -> depth--
                        }
                        i++
                        if (depth == 0) return true
                    }
                    return false
                }
            }
            val start = i
            while (i < n && ",}] \n\r\t".indexOf(text[i].toInt().toChar()) < 0) i++
            return i > start
        }
        ws()
        if (i >= n || text[i] != '{'.code.toByte()) return null
        i++
        var found: ByteArray? = null
        while (true) {
            ws()
            if (i < n && text[i] == '}'.code.toByte()) return found
            val k = str() ?: return null
            ws()
            if (i >= n || text[i] != ':'.code.toByte()) return null
            i++
            ws()
            val start = i
            if (!value()) return null
            val key = try {
                JsonValue.parse(String(text, k[0], k[1] - k[0], Charsets.UTF_8))
            } catch (_: RuntimeException) {
                null
            }
            if (key is JsonValue.Str && key.value == name) found = text.copyOfRange(start, i)
            ws()
            if (i < n && text[i] == ','.code.toByte()) i++
            else if (i < n && text[i] == '}'.code.toByte()) return found
            else return null
        }
    }
}

/**
 * Bundle signature verification settings.
 *
 * Default (`verify` left unset): on the official edge, every bundle must carry a valid signature by one of
 * [OFFICIAL_SIGNING_KEYS] (or a key `GET /v1/keys` adds after a rotation); elsewhere bundles are not verified.
 */
class VerifyOptions @JvmOverloads constructor(
    /** Keys to verify with. Empty: [OFFICIAL_SIGNING_KEYS] on the official edge, else those of `GET /v1/keys`. */
    val publicKeys: List<Jwk> = emptyList(),
    /** Also load keys from `GET /v1/keys` (once, and again at most once a minute for an unknown key id). */
    val fetchKeys: Boolean = false,
    /** Refuse unsigned bundles. `null`: true on the official edge, false elsewhere. */
    val require: Boolean? = null,
) {
    companion object {
        /** Turns verification off (not recommended: only for a self-hosted edge without signing). */
        @JvmField
        val DISABLED = VerifyOptions(require = false).also { it.disabled = true }
    }

    internal var disabled = false
}
