package com.killerx.yt

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.WebExtension

/**
 * Process-wide singleton that owns the GeckoView built-in WebExtension bridge.
 * Fixes the cold-start & warm-restart port loss bug where closing and reopening the app
 * left background.js talking to a destroyed MainActivity or an unverified port.
 */
object ExtensionBridge {

    interface Listener {
        fun onExtensionMessage(json: JSONObject)
        fun onBridgeStatusChanged(connected: Boolean)
        fun buildCurrentConfig(): JSONObject
    }

    private const val EXT_URI = "resource://android/assets/killerx_ext/"
    private const val EXT_ID = "killerx@killerx.yt"
    private const val NATIVE_APP = "killerx"

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var listener: Listener? = null

    @Volatile
    private var installedExt: WebExtension? = null

    @Volatile
    private var activePort: WebExtension.Port? = null

    @Volatile
    private var lastActivityMessageMs: Long = 0L

    fun isConnected(): Boolean {
        return activePort != null || (System.currentTimeMillis() - lastActivityMessageMs < 8000L)
    }

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, port: WebExtension.Port) {
            activePort = port
            lastActivityMessageMs = System.currentTimeMillis()
            val json = message as? JSONObject ?: return

            if (json.optString("type") == "ping") {
                try {
                    port.postMessage(JSONObject().put("type", "pong"))
                } catch (_: Exception) {
                }
                listener?.onBridgeStatusChanged(true)
                return
            }

            if (json.optString("type") == "ready") {
                pushConfigAndResync()
                listener?.onBridgeStatusChanged(true)
                return
            }

            listener?.onExtensionMessage(json)
        }

        override fun onDisconnect(port: WebExtension.Port) {
            if (activePort == port) {
                activePort = null
                listener?.onBridgeStatusChanged(false)
            }
        }
    }

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            val old = activePort
            if (old != null && old != port) {
                try {
                    old.disconnect()
                } catch (_: Exception) {
                }
            }
            activePort = port
            lastActivityMessageMs = System.currentTimeMillis()
            port.setDelegate(portDelegate)
            pushConfigAndResync()
            listener?.onBridgeStatusChanged(true)
        }

        // Stateless fallback handler for browser.runtime.sendNativeMessage("killerx", msg)
        override fun onMessage(
            nativeApp: String,
            message: Any,
            sender: WebExtension.MessageSender
        ): GeckoResult<Any>? {
            lastActivityMessageMs = System.currentTimeMillis()
            val json = message as? JSONObject ?: return GeckoResult.fromValue("ok")
            val type = json.optString("type")

            if (type == "ping") {
                listener?.onBridgeStatusChanged(true)
                return GeckoResult.fromValue(JSONObject().put("type", "pong"))
            }

            if (type == "ready" || type == "getConfig") {
                val cfg = listener?.buildCurrentConfig()
                listener?.onBridgeStatusChanged(true)
                return GeckoResult.fromValue(cfg ?: JSONObject().put("type", "pong"))
            }

            listener?.onExtensionMessage(json)
            return GeckoResult.fromValue("ok")
        }
    }

    fun attach(runtime: GeckoRuntime, newListener: Listener, onReady: () -> Unit) {
        listener = newListener

        var readyDispatched = false
        fun notifyReadyOnce() {
            if (readyDispatched) return
            readyDispatched = true
            mainHandler.post { onReady() }
        }

        // Safety timeout so YouTube always loads even if ensureBuiltIn takes a moment
        mainHandler.postDelayed({ notifyReadyOnce() }, 500L)

        // If already attached from earlier in the same process, immediately resync!
        installedExt?.let { ext ->
            ext.setMessageDelegate(messageDelegate, NATIVE_APP)
            pushConfigAndResync()
            notifyReadyOnce()
            return
        }

        // Register built-in extension (handles both first install AND already-installed cold starts!)
        runtime.webExtensionController
            .ensureBuiltIn(EXT_URI, EXT_ID)
            .accept(
                { ext ->
                    if (ext != null) {
                        installedExt = ext
                        ext.setMessageDelegate(messageDelegate, NATIVE_APP)
                        pushConfigAndResync()
                    }
                    notifyReadyOnce()
                },
                {
                    // Fallback: list already-installed extensions if ensureBuiltIn reported already-present
                    runtime.webExtensionController.list().accept(
                        { list ->
                            val found = list?.firstOrNull { it.id == EXT_ID }
                            if (found != null) {
                                installedExt = found
                                found.setMessageDelegate(messageDelegate, NATIVE_APP)
                                pushConfigAndResync()
                            }
                            notifyReadyOnce()
                        },
                        { notifyReadyOnce() }
                    )
                }
            )
    }

    fun detach(oldListener: Listener) {
        if (listener == oldListener) {
            listener = null
        }
    }

    fun pushConfigAndResync() {
        val cfg = listener?.buildCurrentConfig() ?: return
        send(cfg)
        send(JSONObject().put("type", "resync"))
    }

    fun send(payload: JSONObject) {
        mainHandler.post {
            try {
                activePort?.postMessage(payload)
            } catch (_: Exception) {
                activePort = null
            }
        }
    }
}
