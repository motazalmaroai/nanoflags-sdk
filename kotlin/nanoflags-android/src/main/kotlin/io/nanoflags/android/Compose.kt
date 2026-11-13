package io.nanoflags.android

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import io.nanoflags.NanoFlags
import io.nanoflags.Status
import io.nanoflags.engine.JsonValue

/** The client for [rememberFlag] calls without an explicit receiver; provide it with [ProvideNanoFlags]. */
val LocalNanoFlags: ProvidableCompositionLocal<NanoFlags?> = staticCompositionLocalOf { null }

/** Makes [client] available to [rememberFlag] below [content]. */
@Composable
fun ProvideNanoFlags(client: NanoFlags, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalNanoFlags provides client, content = content)
}

private fun current(client: NanoFlags?): NanoFlags =
    client ?: error("No NanoFlags client: wrap the UI in ProvideNanoFlags(client) { … } or pass the client explicitly.")

/**
 * The value of boolean flag [key] as Compose state: evaluated locally for the client's current context and
 * recomposed when a new configuration arrives or the context changes (`identify`). The first frame already shows the
 * value of the configuration in use (or [default]).
 */
@Composable
fun NanoFlags.rememberFlag(key: String, default: Boolean): State<Boolean> {
    val flow = remember(this, key, default) { boolFlow(key, default) }
    return flow.collectAsState(initial = remember(this, key, default) { boolVariation(key, default) })
}

@Composable
fun NanoFlags.rememberFlag(key: String, default: String): State<String> {
    val flow = remember(this, key, default) { stringFlow(key, default) }
    return flow.collectAsState(initial = remember(this, key, default) { stringVariation(key, default) })
}

@Composable
fun NanoFlags.rememberFlag(key: String, default: Double): State<Double> {
    val flow = remember(this, key, default) { doubleFlow(key, default) }
    return flow.collectAsState(initial = remember(this, key, default) { doubleVariation(key, default) })
}

@Composable
fun NanoFlags.rememberFlag(key: String, default: Int): State<Int> {
    val flow = remember(this, key, default) { intFlow(key, default) }
    return flow.collectAsState(initial = remember(this, key, default) { intVariation(key, default) })
}

@Composable
fun NanoFlags.rememberFlag(key: String, default: JsonValue): State<JsonValue> {
    val flow = remember(this, key, default) { jsonFlow(key, default) }
    return flow.collectAsState(initial = remember(this, key, default) { jsonVariation(key, default) })
}

/** [rememberFlag] with the client from [LocalNanoFlags]. */
@Composable
fun rememberFlag(key: String, default: Boolean): State<Boolean> = current(LocalNanoFlags.current).rememberFlag(key, default)

@Composable
fun rememberFlag(key: String, default: String): State<String> = current(LocalNanoFlags.current).rememberFlag(key, default)

@Composable
fun rememberFlag(key: String, default: Double): State<Double> = current(LocalNanoFlags.current).rememberFlag(key, default)

@Composable
fun rememberFlag(key: String, default: Int): State<Int> = current(LocalNanoFlags.current).rememberFlag(key, default)

@Composable
fun rememberFlag(key: String, default: JsonValue): State<JsonValue> = current(LocalNanoFlags.current).rememberFlag(key, default)

/** The client's [Status] as Compose state (e.g. to show a placeholder until the first configuration). */
@Composable
fun NanoFlags.collectStatusAsState(): State<Status> = status.collectAsState()
