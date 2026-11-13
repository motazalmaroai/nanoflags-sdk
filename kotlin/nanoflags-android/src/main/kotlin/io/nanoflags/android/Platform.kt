package io.nanoflags.android

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import io.nanoflags.NanoFlags
import io.nanoflags.NetworkState

/**
 * Follows the app's foreground / background state. `ProcessLifecycleOwner` reports the background ~700 ms after the
 * last activity stopped, so a configuration change (rotation) never drops the live socket.
 */
internal class LifecycleBinding(private val owner: LifecycleOwner, private val client: NanoFlags) : DefaultLifecycleObserver {
    fun attach() {
        owner.lifecycle.addObserver(this)
    }

    fun detach() {
        owner.lifecycle.removeObserver(this)
    }

    override fun onStart(owner: LifecycleOwner) {
        client.setForeground(true)
    }

    override fun onStop(owner: LifecycleOwner) {
        client.setForeground(false)
    }

    companion object {
        fun isForeground(owner: LifecycleOwner): Boolean = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    }
}

/**
 * Reports network availability, metered networks and Data Saver from `ConnectivityManager` (needs
 * `ACCESS_NETWORK_STATE`, declared by this library's manifest).
 */
internal class NetworkMonitor(private val context: Context, private val onChange: (NetworkState) -> Unit) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var receiver: BroadcastReceiver? = null

    @SuppressLint("MissingPermission", "UnspecifiedRegisterReceiverFlag")
    fun start() {
        val cm = cm ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = publish()
            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) = publish()
            override fun onLost(network: Network) {
                // The default network is gone; a replacement (if any) is announced with onAvailable.
                if (Build.VERSION.SDK_INT >= 24) onChange(currentState(context).copy(available = false)) else publish()
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                cm.registerDefaultNetworkCallback(cb)
            } else {
                cm.registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), cb)
            }
            callback = cb
        } catch (_: RuntimeException) {
            // SecurityException without ACCESS_NETWORK_STATE, or too many callbacks: the client simply stays online.
        }
        if (Build.VERSION.SDK_INT >= 24) {
            val r = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) = publish()
            }
            val filter = IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED)
            try {
                if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED) else context.registerReceiver(r, filter)
                receiver = r
            } catch (_: RuntimeException) {
            }
        }
    }

    fun stop() {
        callback?.let { runCatching { cm?.unregisterNetworkCallback(it) } }
        callback = null
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    private fun publish() = onChange(currentState(context))

    companion object {
        /** The network state right now (online, metered, Data Saver). Defaults to "online" when it cannot be read. */
        @SuppressLint("MissingPermission")
        @Suppress("DEPRECATION")
        fun currentState(context: Context): NetworkState {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return NetworkState()
            return try {
                val available = if (Build.VERSION.SDK_INT >= 23) {
                    val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
                    caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                } else {
                    cm.activeNetworkInfo?.isConnected == true
                }
                val dataSaver = Build.VERSION.SDK_INT >= 24 && cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
                NetworkState(available = available, metered = available && cm.isActiveNetworkMetered, dataSaver = dataSaver)
            } catch (_: RuntimeException) {
                NetworkState()
            }
        }
    }
}
