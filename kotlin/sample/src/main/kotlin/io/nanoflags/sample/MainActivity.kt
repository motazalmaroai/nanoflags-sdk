package io.nanoflags.sample

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.nanoflags.NanoFlags
import io.nanoflags.NanoFlagsContext
import io.nanoflags.android.NanoFlagsAndroid
import io.nanoflags.android.ProvideNanoFlags
import io.nanoflags.android.collectStatusAsState
import io.nanoflags.android.rememberFlag
import io.nanoflags.engine.Bundle as NfBundle

/** Creates the one client of the process. */
class SampleApp : Application() {
    lateinit var flags: NanoFlags
        private set

    override fun onCreate() {
        super.onCreate()
        // A real app passes its environment's client key; the sample falls back to a placeholder plus a bootstrap
        // bundle, so it renders without a network or a key.
        val key = BuildConfig.NANOFLAGS_SDK_KEY.ifEmpty { "nf_pub_sample" }
        flags = NanoFlagsAndroid.create(this, key) {
            context = NanoFlagsContext("sample-user", mapOf("platform" to "android"))
            bootstrap = BOOTSTRAP
            if (BuildConfig.NANOFLAGS_SDK_KEY.isEmpty()) {
                streaming = false
                pollIntervalMs = 0
                events.enabled = false
            }
        }
    }

    companion object {
        /** What the app shows before (or without) its first network answer. */
        const val BOOTSTRAP = """{"schema":1,"project":"public-demo","environment":"demo","revision":0,"flags":{"demo-accent":{"type":"string","enabled":true,"clientExposed":true,"default":"blue","off":"blue","rules":[]},"demo-new-checkout":{"type":"boolean","enabled":true,"clientExposed":true,"default":false,"off":false,"rules":[]}},"segments":{}}"""

        init {
            check(NfBundle.parse(BOOTSTRAP) != null)
        }
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val flags = (application as SampleApp).flags
        setContent {
            MaterialTheme {
                ProvideNanoFlags(flags) { FlagsScreen(flags) }
            }
        }
    }
}

@Composable
fun FlagsScreen(flags: NanoFlags) {
    val accent by rememberFlag("demo-accent", "blue")
    val newCheckout by rememberFlag("demo-new-checkout", false)
    val status by flags.collectStatusAsState()
    val color = when (accent) {
        "orange" -> Color(0xFFF97316)
        "green" -> Color(0xFF16A34A)
        else -> Color(0xFF2563EB)
    }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("NanoFlags sample", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.testTag("title"))
        Text("Status: ${status.name.lowercase()} · revision ${flags.revision ?: "-"}", modifier = Modifier.testTag("status"))
        Text("demo-accent = $accent", modifier = Modifier.testTag("accent"))
        Box(Modifier.size(48.dp).background(color).testTag("swatch"))
        Text(if (newCheckout) "New checkout: on" else "New checkout: off", modifier = Modifier.testTag("checkout"))
    }
}
