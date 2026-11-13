package io.nanoflags

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Executes the call asynchronously; cancelling the coroutine cancels the call. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, value, _ -> value.close() }
        }

        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}

/** [await] bounded by [timeoutMs] (connect + headers + body read are all covered by the caller's use). */
internal suspend fun <T> Call.awaitWithin(timeoutMs: Long, block: (Response) -> T): T = withTimeout(timeoutMs) {
    val res = await()
    res.use { block(it) }
}

/** Reads at most [limit] bytes of the body; `null` when it is larger. */
internal fun Response.bodyBytes(limit: Long): ByteArray? {
    val source = body?.source() ?: return ByteArray(0)
    if (source.request(limit + 1)) return null
    return source.readByteArray()
}
