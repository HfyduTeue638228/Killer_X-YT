package com.killerx.yt

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream

class MainActivity : AppCompatActivity() {

    private lateinit var appContainer: LinearLayout
    private lateinit var topBar: LinearLayout
    private lateinit var webView: KillerXWebView
    private lateinit var progressBar: ProgressBar
    private lateinit var fullscreenContainer: FrameLayout
    private lateinit var subtitleOverlayContainer: LinearLayout
    private lateinit var tvOrigSub: TextView
    private lateinit var tvSinhalaSub: TextView
    private lateinit var btnBgPlay: TextView
    private lateinit var btnShield: TextView

    private val mainHandler = Handler(Looper.getMainLooper())
    private val hideSubRunnable = Runnable { subtitleOverlayContainer.visibility = View.GONE }

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var ytEngineScript: String = ""
    private var adBlockScript: String = ""
    private var pendingDirectSiPayload: String? = null

    // App Settings
    private var bgPlayEnabled = true
    private var autoPipEnabled = true
    private var ccEnabled = true
    private var ytPackageMode = true
    private var dualSub = false
    private var adShield = true
    private var fontSizeSp = 18
    private var subPosition = "bottom"
    private var subColorHex = "#FFFFFF"

    // Playback & UI state
    private var isVideoPlaying = false
    private var currentVideoTitle = "Killer X YT"
    private var isInPip = false
    private var lastSourceMode = "Waiting for CC..."
    private var lastOrigText = ""
    private var lastSiText = ""

    private val prefs by lazy { getSharedPreferences("killer_x_yt_prefs", Context.MODE_PRIVATE) }

    companion object {
        private const val YOUTUBE_HOME = "https://m.youtube.com/"
        private const val GOOGLE_LOGIN_URL =
            "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fm.youtube.com%2F"

        // Clean Chrome Mobile UA (without "; wv") for smooth YouTube playback & captions
        private const val CHROME_MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.106 Mobile Safari/537.36"

        // Clean Firefox Mobile UA used specifically on accounts.google.com so Gmail Login works without MicroG!
        private const val FIREFOX_LOGIN_UA =
            "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0"
    }

    private val mediaControlReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val cmd = intent?.getStringExtra(MediaPlaybackService.EXTRA_CMD) ?: return
            mainHandler.post {
                webView.evaluateJavascript(
                    "window.__kxMediaControl && window.__kxMediaControl(${JSONObject.quote(cmd)});",
                    null
                )
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        appContainer = findViewById(R.id.appContainer)
        topBar = findViewById(R.id.topBar)
        webView = findViewById(R.id.webView)
        progressBar = findViewById(R.id.progressBar)
        fullscreenContainer = findViewById(R.id.fullscreenContainer)
        subtitleOverlayContainer = findViewById(R.id.subtitleOverlayContainer)
        tvOrigSub = findViewById(R.id.tvOrigSub)
        tvSinhalaSub = findViewById(R.id.tvSinhalaSub)
        btnBgPlay = findViewById(R.id.btnBgPlay)
        btnShield = findViewById(R.id.btnShield)

        // Strict Android 15 / HyperOS status bar & navigation bar safe inset handling (zero overlap!)
        ViewCompat.setOnApplyWindowInsetsListener(appContainer) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            if (isInPip || customView != null) {
                view.setPadding(0, 0, 0, 0)
            } else {
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            }
            insets
        }

        loadSettings()
        webView.backgroundPlayEnabled = bgPlayEnabled
        applySubtitleStyle()
        updateTopBadges()

        // Request notification permission on Android 13+ so Lock Screen Background Play controls appear
        requestNotificationPermissionIfNeeded()

        // Offline built-in ad list active immediately (0 KB Anytime Data when YT Package Mode is ON)
        AdBlocker.init(this, allowAutoDownload = !ytPackageMode)

        ytEngineScript = assets.open("yt_engine.js").bufferedReader().use { it.readText() }
        adBlockScript = assets.open("adblock_cosmetic.js").bufferedReader().use { it.readText() }

        ContextCompat.registerReceiver(
            this,
            mediaControlReceiver,
            IntentFilter(MediaPlaybackService.BROADCAST_MEDIA_CONTROL),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )

        setupWebView()
        setupControls()
        setupBackNavigation()

        val initialUrl = intent?.dataString?.takeIf { it.contains("youtu") } ?: YOUTUBE_HOME
        webView.loadUrl(initialUrl)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val incoming = intent.dataString
        if (!incoming.isNullOrBlank() && incoming.contains("youtu")) {
            webView.loadUrl(incoming)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    2001
                )
            }
        }
    }

    private fun loadSettings() {
        bgPlayEnabled = prefs.getBoolean("bgPlayEnabled", true)
        autoPipEnabled = prefs.getBoolean("autoPipEnabled", true)
        ccEnabled = prefs.getBoolean("ccEnabled", true)
        ytPackageMode = prefs.getBoolean("ytPackageMode", true)
        dualSub = prefs.getBoolean("dualSub", false)
        adShield = prefs.getBoolean("adShield", true)
        fontSizeSp = prefs.getInt("fontSizeSp", 18)
        subPosition = prefs.getString("subPosition", "bottom") ?: "bottom"
        subColorHex = prefs.getString("subColorHex", "#FFFFFF") ?: "#FFFFFF"
    }

    private fun saveSettings() {
        prefs.edit()
            .putBoolean("bgPlayEnabled", bgPlayEnabled)
            .putBoolean("autoPipEnabled", autoPipEnabled)
            .putBoolean("ccEnabled", ccEnabled)
            .putBoolean("ytPackageMode", ytPackageMode)
            .putBoolean("dualSub", dualSub)
            .putBoolean("adShield", adShield)
            .putInt("fontSizeSp", fontSizeSp)
            .putString("subPosition", subPosition)
            .putString("subColorHex", subColorHex)
            .apply()
    }

    private fun updateTopBadges() {
        mainHandler.post {
            if (adShield) {
                btnShield.text = "🛡${AdBlocker.getPageBlocked()}"
                btnShield.setTextColor(Color.parseColor("#FF4B3A"))
            } else {
                btnShield.text = "🛡OFF"
                btnShield.setTextColor(Color.parseColor("#888C9E"))
            }

            if (bgPlayEnabled) {
                btnBgPlay.text = "BG"
                btnBgPlay.setTextColor(Color.parseColor("#4ADE80"))
            } else {
                btnBgPlay.text = "BG"
                btnBgPlay.setTextColor(Color.parseColor("#7D8094"))
            }
        }
    }

    private fun applySubtitleStyle() {
        val activeSize = if (isInPip) 11f else fontSizeSp.toFloat()
        tvSinhalaSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, activeSize)
        tvOrigSub.setTextSize(TypedValue.COMPLEX_UNIT_SP, maxOf(9f, activeSize * 0.68f))
        try {
            tvSinhalaSub.setTextColor(Color.parseColor(subColorHex))
        } catch (_: Exception) {
            tvSinhalaSub.setTextColor(Color.WHITE)
        }

        val lp = subtitleOverlayContainer.layoutParams as FrameLayout.LayoutParams
        val density = resources.displayMetrics.density
        if (isInPip) {
            lp.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            lp.topMargin = 0
            lp.bottomMargin = (6 * density).toInt()
            lp.marginStart = (6 * density).toInt()
            lp.marginEnd = (6 * density).toInt()
        } else if (subPosition == "top") {
            lp.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            lp.topMargin = ((if (customView != null) 16 else 58) * density).toInt()
            lp.bottomMargin = 0
            lp.marginStart = (14 * density).toInt()
            lp.marginEnd = (14 * density).toInt()
        } else {
            lp.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            lp.topMargin = 0
            lp.bottomMargin = ((if (customView != null) 24 else 44) * density).toInt()
            lp.marginStart = (14 * density).toInt()
            lp.marginEnd = (14 * density).toInt()
        }
        subtitleOverlayContainer.layoutParams = lp
    }

    private fun applySmartUserAgentForUrl(url: String) {
        val lower = url.lowercase()
        val isGoogleAuth = lower.contains("accounts.google.com") || lower.contains("accounts.youtube.com")
        val targetUa = if (isGoogleAuth) FIREFOX_LOGIN_UA else CHROME_MOBILE_UA
        if (webView.settings.userAgentString != targetUa) {
            webView.settings.userAgentString = targetUa
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            userAgentString = CHROME_MOBILE_UA
        }

        webView.addJavascriptInterface(KillerXBridge(), "KillerX")

        webView.webViewClient = object : WebViewClient() {

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url?.toString() ?: return null
                val isMain = request.isForMainFrame

                // 1. Block all YouTube & external ads
                if (adShield && AdBlocker.shouldBlockRequest(url, isMain)) {
                    updateTopBadges()
                    return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                }

                // 2. Native YouTube Sinhala CC (&tlang=si directly on youtube.com -> 0 Anytime Data!)
                if (ccEnabled && TranslatorEngine.isYouTubeTimedTextUrl(url)) {
                    val siUrl = TranslatorEngine.toYouTubeSinhalaUrl(url)
                    val headers = HashMap<String, String>(request.requestHeaders ?: emptyMap())
                    val cookie = try { CookieManager.getInstance().getCookie(siUrl) } catch (_: Exception) { null }
                    if (!cookie.isNullOrBlank()) headers["Cookie"] = cookie

                    TranslatorEngine.sniffSubtitleAsync(siUrl, headers) { _, _, cuesJson ->
                        val payloadStr = JSONObject().apply {
                            put("url", siUrl)
                            put("cues", cuesJson)
                        }.toString()
                        pendingDirectSiPayload = payloadStr
                        mainHandler.post {
                            webView.evaluateJavascript(
                                "window.__kxReceiveDirectSinhalaTrack && window.__kxReceiveDirectSinhalaTrack(${JSONObject.quote(payloadStr)});",
                                null
                            )
                        }
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    // Prevent YouTube mobile web from trying to open the official YouTube app via intent://
                    return true
                }
                if (adShield && AdBlocker.shouldBlockRequest(url, true)) {
                    updateTopBadges()
                    return true
                }
                applySmartUserAgentForUrl(url)
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (!url.isNullOrBlank()) {
                    applySmartUserAgentForUrl(url)
                }
                AdBlocker.resetPageCount()
                updateTopBadges()
                pendingDirectSiPayload = null
                hideNativeSubtitle()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                CookieManager.getInstance().flush()
                if (!url.isNullOrBlank() && url.contains("youtube.com")) {
                    injectEngines()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress in 1..99) {
                    progressBar.visibility = View.VISIBLE
                    progressBar.progress = newProgress
                } else {
                    progressBar.visibility = View.GONE
                }
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                // Handle Google Sign-in popups inside same WebView, block ad popups
                val href = view?.hitTestResult?.extra
                if (!href.isNullOrBlank() && (href.contains("accounts.google.com") || href.contains("youtube.com"))) {
                    applySmartUserAgentForUrl(href)
                    webView.loadUrl(href)
                } else if (adShield) {
                    AdBlocker.recordBlock()
                    updateTopBadges()
                }
                return false
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                fullscreenContainer.addView(
                    view,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                fullscreenContainer.visibility = View.VISIBLE
                appContainer.visibility = View.GONE
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                setImmersiveMode(true)
                applySubtitleStyle()
            }

            override fun onHideCustomView() {
                exitFullscreenVideo()
            }
        }
    }

    private fun injectEngines() {
        if (adShield) {
            webView.evaluateJavascript(adBlockScript, null)
        }
        webView.evaluateJavascript(ytEngineScript, null)
        pendingDirectSiPayload?.let { payload ->
            webView.evaluateJavascript(
                "window.__kxReceiveDirectSinhalaTrack && window.__kxReceiveDirectSinhalaTrack(${JSONObject.quote(payload)});",
                null
            )
        }
    }

    // -------------------------------------------------------------------------
    // Picture-in-Picture (PiP) Support (Android 8.0+ / API 26+)
    // -------------------------------------------------------------------------
    private fun buildPipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null

        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))

        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val toggleIntent = Intent(MediaPlaybackService.BROADCAST_MEDIA_CONTROL).apply {
            setPackage(packageName)
            putExtra(MediaPlaybackService.EXTRA_CMD, MediaPlaybackService.CMD_TOGGLE)
        }
        val togglePi = PendingIntent.getBroadcast(this, 101, toggleIntent, piFlags)
        val iconRes = if (isVideoPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val label = if (isVideoPlaying) "Pause" else "Play"

        val toggleAction = RemoteAction(
            Icon.createWithResource(this, iconRes),
            label,
            label,
            togglePi
        )

        val nextIntent = Intent(MediaPlaybackService.BROADCAST_MEDIA_CONTROL).apply {
            setPackage(packageName)
            putExtra(MediaPlaybackService.EXTRA_CMD, MediaPlaybackService.CMD_NEXT)
        }
        val nextPi = PendingIntent.getBroadcast(this, 102, nextIntent, piFlags)
        val nextAction = RemoteAction(
            Icon.createWithResource(this, android.R.drawable.ic_media_next),
            "Next",
            "Next",
            nextPi
        )

        builder.setActions(listOf(toggleAction, nextAction))
        return builder.build()
    }

    private fun enterPipModeNow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Toast.makeText(this, "PiP requires Android 8.0 or higher", Toast.LENGTH_SHORT).show()
            return
        }
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            Toast.makeText(this, "PiP not supported on this device", Toast.LENGTH_SHORT).show()
            return
        }
        val params = buildPipParams() ?: return
        try {
            enterPictureInPictureMode(params)
        } catch (_: Exception) {
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (autoPipEnabled && isVideoPlaying && !isInPip) {
            enterPipModeNow()
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        isInPip = isInPictureInPictureMode
        topBar.visibility = if (isInPip) View.GONE else View.VISIBLE
        progressBar.visibility = View.GONE
        if (isInPip) {
            appContainer.setPadding(0, 0, 0, 0)
        } else {
            ViewCompat.requestApplyInsets(appContainer)
        }
        webView.evaluateJavascript("window.__kxSetPipMode && window.__kxSetPipMode($isInPip);", null)
        applySubtitleStyle()
    }

    // -------------------------------------------------------------------------
    // Background & Screen-Off Foreground Media Service Sync
    // -------------------------------------------------------------------------
    private fun syncBackgroundService(playing: Boolean, title: String) {
        if (!bgPlayEnabled) {
            stopService(Intent(this, MediaPlaybackService::class.java))
            return
        }
        if (playing) {
            val svcIntent = Intent(this, MediaPlaybackService::class.java).apply {
                action = MediaPlaybackService.ACTION_UPDATE
                putExtra(MediaPlaybackService.EXTRA_TITLE, title)
                putExtra(MediaPlaybackService.EXTRA_PLAYING, true)
            }
            try {
                ContextCompat.startForegroundService(this, svcIntent)
            } catch (_: Exception) {
            }
        } else {
            // Update notification to Paused state (or stop if not needed)
            val svcIntent = Intent(this, MediaPlaybackService::class.java).apply {
                action = MediaPlaybackService.ACTION_UPDATE
                putExtra(MediaPlaybackService.EXTRA_TITLE, title)
                putExtra(MediaPlaybackService.EXTRA_PLAYING, false)
            }
            try {
                startService(svcIntent)
            } catch (_: Exception) {
            }
        }
    }

    override fun onPause() {
        super.onPause()
        // CRITICAL: Do NOT pause WebView when Background Play or PiP is active!
        if (!bgPlayEnabled && !isInPip) {
            webView.onPause()
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(mediaControlReceiver)
        } catch (_: Exception) {
        }
        stopService(Intent(this, MediaPlaybackService::class.java))
        super.onDestroy()
    }

    private fun exitFullscreenVideo() {
        if (customView == null) return
        fullscreenContainer.removeView(customView)
        customView = null
        fullscreenContainer.visibility = View.GONE
        appContainer.visibility = View.VISIBLE
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        setImmersiveMode(false)
        ViewCompat.requestApplyInsets(appContainer)
        applySubtitleStyle()
    }

    @Suppress("DEPRECATION")
    private fun setImmersiveMode(enable: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            if (enable) {
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            }
        } else {
            window.decorView.systemUiVisibility = if (enable) {
                (View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
            } else {
                View.SYSTEM_UI_FLAG_VISIBLE
            }
        }
    }

    private fun setupControls() {
        val goHome: (View) -> Unit = {
            applySmartUserAgentForUrl(YOUTUBE_HOME)
            webView.loadUrl(YOUTUBE_HOME)
        }
        findViewById<ImageView>(R.id.ivBrandLogo).setOnClickListener(goHome)
        findViewById<TextView>(R.id.tvBrandTitle).setOnClickListener(goHome)

        findViewById<TextView>(R.id.btnBack).setOnClickListener {
            if (webView.canGoBack()) webView.goBack()
        }

        findViewById<TextView>(R.id.btnPip).setOnClickListener {
            enterPipModeNow()
        }

        btnBgPlay.setOnClickListener {
            bgPlayEnabled = !bgPlayEnabled
            webView.backgroundPlayEnabled = bgPlayEnabled
            saveSettings()
            updateTopBadges()
            if (!bgPlayEnabled) {
                stopService(Intent(this, MediaPlaybackService::class.java))
            } else if (isVideoPlaying) {
                syncBackgroundService(true, currentVideoTitle)
            }
            val msg = if (bgPlayEnabled) "Background & Screen-Off Play: ON" else "Background Play: OFF"
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        }

        btnShield.setOnClickListener {
            Toast.makeText(
                this,
                "Killer X Shield: ${if (adShield) "ON" else "OFF"} | Blocked: ${AdBlocker.getPageBlocked()} (Total ${AdBlocker.getTotalBlocked()})",
                Toast.LENGTH_SHORT
            ).show()
        }

        findViewById<TextView>(R.id.btnSettings).setOnClickListener {
            showSettingsDialog()
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> exitFullscreenVideo()
                    webView.canGoBack() -> webView.goBack()
                    else -> moveTaskToBack(true) // Keeps Background Play alive instead of killing app!
                }
            }
        })
    }

    private fun showNativeSubtitle(siText: String, origText: String, sourceMode: String) {
        mainHandler.post {
            if (!ccEnabled) return@post
            lastSourceMode = sourceMode
            lastOrigText = origText
            lastSiText = siText

            tvSinhalaSub.text = siText
            if (dualSub && origText.isNotBlank() && !isInPip) {
                tvOrigSub.text = origText
                tvOrigSub.visibility = View.VISIBLE
            } else {
                tvOrigSub.visibility = View.GONE
            }
            subtitleOverlayContainer.visibility = View.VISIBLE

            mainHandler.removeCallbacks(hideSubRunnable)
            mainHandler.postDelayed(hideSubRunnable, 6500L)
        }
    }

    private fun hideNativeSubtitle() {
        mainHandler.post {
            mainHandler.removeCallbacks(hideSubRunnable)
            subtitleOverlayContainer.visibility = View.GONE
        }
    }

    private fun showSettingsDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_settings, null)

        val cbBgPlay = view.findViewById<CheckBox>(R.id.cbBgPlay)
        val cbAutoPip = view.findViewById<CheckBox>(R.id.cbAutoPip)
        val cbEnabled = view.findViewById<CheckBox>(R.id.cbEnabled)
        val cbYtPackageMode = view.findViewById<CheckBox>(R.id.cbYtPackageMode)
        val cbDualSub = view.findViewById<CheckBox>(R.id.cbDualSub)
        val cbAdShield = view.findViewById<CheckBox>(R.id.cbAdShield)
        val tvSizeLabel = view.findViewById<TextView>(R.id.tvSizeLabel)
        val sbFontSize = view.findViewById<SeekBar>(R.id.sbFontSize)
        val rgPosition = view.findViewById<RadioGroup>(R.id.rgPosition)
        val rbPosBottom = view.findViewById<RadioButton>(R.id.rbPosBottom)
        val rbPosTop = view.findViewById<RadioButton>(R.id.rbPosTop)
        val rgColor = view.findViewById<RadioGroup>(R.id.rgColor)
        val rbWhite = view.findViewById<RadioButton>(R.id.rbColorWhite)
        val rbYellow = view.findViewById<RadioButton>(R.id.rbColorYellow)
        val rbCyan = view.findViewById<RadioButton>(R.id.rbColorCyan)
        val btnGmailLogin = view.findViewById<Button>(R.id.btnGmailLogin)
        val btnEnterPipNow = view.findViewById<Button>(R.id.btnEnterPipNow)
        val btnTestOverlay = view.findViewById<Button>(R.id.btnTestOverlay)
        val btnReloadYt = view.findViewById<Button>(R.id.btnReloadYt)
        val tvDebugStatus = view.findViewById<TextView>(R.id.tvDebugStatus)

        cbBgPlay.isChecked = bgPlayEnabled
        cbAutoPip.isChecked = autoPipEnabled
        cbEnabled.isChecked = ccEnabled
        cbYtPackageMode.isChecked = ytPackageMode
        cbDualSub.isChecked = dualSub
        cbAdShield.isChecked = adShield

        sbFontSize.progress = (fontSizeSp - 12).coerceIn(0, 22)
        tvSizeLabel.text = "Subtitle Font Size: ${fontSizeSp}sp"

        if (subPosition == "top") rbPosTop.isChecked = true else rbPosBottom.isChecked = true
        when (subColorHex.uppercase()) {
            "#FFE66D" -> rbYellow.isChecked = true
            "#8BE9FD" -> rbCyan.isChecked = true
            else -> rbWhite.isChecked = true
        }

        tvDebugStatus.text = buildString {
            append("BG Play: ${if (bgPlayEnabled) "ON" else "OFF"} | YT Pkg: ${if (ytPackageMode) "ON (0 Anytime)" else "OFF"}")
            append("\nAds Blocked: ${AdBlocker.getTotalBlocked()} | CC: $lastSourceMode")
            if (lastOrigText.isNotEmpty()) append("\nOrig: $lastOrigText")
            if (lastSiText.isNotEmpty()) append("\nSI: $lastSiText")
        }

        sbFontSize.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                fontSizeSp = 12 + progress
                tvSizeLabel.text = "Subtitle Font Size: ${fontSizeSp}sp"
                applySubtitleStyle()
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        })

        val dialog = AlertDialog.Builder(this)
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                val shieldChanged = adShield != cbAdShield.isChecked
                val ytPkgChanged = ytPackageMode != cbYtPackageMode.isChecked

                bgPlayEnabled = cbBgPlay.isChecked
                autoPipEnabled = cbAutoPip.isChecked
                ccEnabled = cbEnabled.isChecked
                ytPackageMode = cbYtPackageMode.isChecked
                dualSub = cbDualSub.isChecked
                adShield = cbAdShield.isChecked
                subPosition = if (rgPosition.checkedRadioButtonId == R.id.rbPosTop) "top" else "bottom"
                subColorHex = when (rgColor.checkedRadioButtonId) {
                    R.id.rbColorYellow -> "#FFE66D"
                    R.id.rbColorCyan -> "#8BE9FD"
                    else -> "#FFFFFF"
                }

                webView.backgroundPlayEnabled = bgPlayEnabled
                saveSettings()
                applySubtitleStyle()
                updateTopBadges()

                webView.evaluateJavascript(
                    "window.__kxSetConfig && window.__kxSetConfig($ccEnabled, $ytPackageMode);",
                    null
                )
                if (!ccEnabled) hideNativeSubtitle()
                if (!bgPlayEnabled) stopService(Intent(this, MediaPlaybackService::class.java))
                if (shieldChanged || ytPkgChanged) webView.reload()
            }
            .setNegativeButton("Close", null)
            .create()

        btnGmailLogin.setOnClickListener {
            dialog.dismiss()
            applySmartUserAgentForUrl(GOOGLE_LOGIN_URL)
            webView.loadUrl(GOOGLE_LOGIN_URL)
            Toast.makeText(this, "Sign in with your Gmail account", Toast.LENGTH_SHORT).show()
        }

        btnEnterPipNow.setOnClickListener {
            dialog.dismiss()
            enterPipModeNow()
        }

        btnTestOverlay.setOnClickListener {
            dialog.dismiss()
            showNativeSubtitle("Killer X YT සිංහල උපසිරැසි සාර්ථකයි!", "Killer X YT Sinhala CC OK!", "Test OK")
        }

        btnReloadYt.setOnClickListener {
            dialog.dismiss()
            webView.reload()
        }

        dialog.show()
    }

    inner class KillerXBridge {

        @JavascriptInterface
        fun isCcEnabled(): Boolean = ccEnabled

        @JavascriptInterface
        fun isYtPackageMode(): Boolean = ytPackageMode

        @JavascriptInterface
        fun isAdShieldEnabled(): Boolean = adShield

        @JavascriptInterface
        fun isBgPlayEnabled(): Boolean = bgPlayEnabled

        @JavascriptInterface
        fun onJsAdBlocked() {
            AdBlocker.recordBlock()
            updateTopBadges()
        }

        @JavascriptInterface
        fun onMediaStateChanged(playing: Boolean, title: String) {
            isVideoPlaying = playing
            if (title.isNotBlank()) currentVideoTitle = title
            mainHandler.post {
                syncBackgroundService(playing, currentVideoTitle)
                if (isInPip && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    buildPipParams()?.let {
                        try {
                            setPictureInPictureParams(it)
                        } catch (_: Exception) {
                        }
                    }
                }
            }
        }

        @JavascriptInterface
        fun showSubtitle(siText: String, origText: String, sourceMode: String) {
            showNativeSubtitle(siText, origText, sourceMode)
        }

        @JavascriptInterface
        fun hideSubtitle() {
            hideNativeSubtitle()
        }

        @JavascriptInterface
        fun translateSingle(reqId: Int, text: String) {
            TranslatorEngine.translateSingleAsync(text) { translated ->
                mainHandler.post {
                    webView.evaluateJavascript(
                        "window.__kxOnTranslateResult && window.__kxOnTranslateResult($reqId, ${JSONObject.quote(translated)});",
                        null
                    )
                }
            }
        }
    }
}
