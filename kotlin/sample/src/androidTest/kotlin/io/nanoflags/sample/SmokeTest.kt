package io.nanoflags.sample

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import java.util.concurrent.TimeUnit
import org.junit.runner.RunWith

/** UI smoke test: the Compose screen renders flag values through `rememberFlag` (bootstrap bundle, no network needed). */
@RunWith(AndroidJUnit4::class)
class SmokeTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    /** Fail with the stuck thread's stack instead of blocking the CI job. */
    @get:Rule
    val timeout: Timeout = Timeout.builder().withTimeout(3, TimeUnit.MINUTES).withLookingForStuckThread(true).build()

    @Test
    fun screenShowsFlagValues() {
        rule.onNodeWithTag("title").assertIsDisplayed()
        rule.onNodeWithTag("accent").assertTextContains("demo-accent = ", substring = true)
        rule.onNodeWithTag("swatch").assertIsDisplayed()
        rule.onNodeWithTag("checkout").assertTextContains("New checkout: ", substring = true)
        rule.onNodeWithTag("status").assertTextContains("Status: ", substring = true)
    }
}
