package com.killerx.yt

import android.Manifest
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
import android.graphics.Color
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
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
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.MediaSession

class MainActivity : AppCompatActivity(), ExtensionBridge.Listener {

    private lateinit var appContainer: LinearLayout
    private lateinit var topBar: LinearLayout
    private lateinit var geckoView: GeckoView
    private lateinit var progressBar: ProgressBar
    private lateinit var subtitleOverlayContainer: LinearLayout
    private lateinit var tvOrigSub: TextView
    private lateinit var tvSinhalaSub: TextView
    private lateinit var btnBgPlay: TextView
    private lateinit var btnShield: TextView

    private lateinit var geckoRuntime: GeckoRuntime
    private lateinit var geckoSession: GeckoSession
    private var activeMediaSession: MediaSession? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val hideSubRunnable = Runnable { subtitleOverlayContainer.visibility = View.GONE }

    // Settings
    private var bgPlayEnabled = true
    private var autoPipEnabled = true
    private var ccEnabled = true
    private var ytPackageMode = true
    private var dualSub = false
    private var adShield = true
    private var fontSizeSp = 18
    private var subPosition = "bottom"
    private var subColorHex = "#FFFFFF"

    // Live State
    private var canGoBack = false
    private var isFullscreen = false
    private var isVideoPlaying = false
    private var wasPlayingBeforePip = false
    private var currentVideoTitle = "Killer X YT"
    private var isInPip = false
    private var pageBlockedCount = 0
    private var totalBlockedCount = 0
    private var loadedCueCount = 0
    private var lastSourceMode = "Waiting for CC..."
    private var lastOrigText = ""
    private var lastSiText = ""

    private val prefs by lazy { getSharedPreferences("killer_x_yt_prefs", Context.MODE_PRIVATE) }

    companion object {
        private const val YOUTUBE_HOME = "https://m.youtube.com/"
        private const val GOOGLE_LOGIN_URL =
            "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fm.youtube.com%2F"
    }

    private val mediaControlReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val cmd = intent?.getStringExtra(MediaPlaybackService.EXTRA_CMD) ?: return
            handleMediaCommand(cmd)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        appContainer = findViewById(R.id.appContainer)
        topBar = findViewById(R.id.topBar)
        geckoView = findViewById(R.id.geckoView)
        progressBar = findViewById(R.id.progressBar)
        subtitleOverlayContainer = findViewById(R.id.subtitleOverlayContainer)
        tvOrigSub = findViewById(R.id.tvOrigSub)
        tvSinhalaSub = findViewById(R.id.tvSinhalaSub)
        btnBgPlay = findViewById(R.id.btnBgPlay)
        btnShield = findViewById(R.id.btnShield)

        // Android 15 / HyperOS safe insets (status bar + nav bar + keyboard IME)
        ViewCompat.setOnApplyWindowInsetsListener(appContainer) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            if (isInPip || isFullscreen) {
                view.setPadding(0, 0, 0, 0)
            } else {
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            }
            insets
        }

        loadSettings()
        applySubtitleStyle()
        updateTopBadges()
        requestNotificationPermissionIfNeeded()

        ContextCompat.registerReceiver(
            this,
            mediaControlReceiver,
            IntentFilter(MediaPlaybackService.BROADCAST_MEDIA_CONTROL),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )

        val initialUrl = intent?.dataString?.takeIf { it.contains("youtu") } ?: YOUTUBE_HOME
        setupGeckoEngine(initialUrl)
        setupControls()
        setupBackNavigation()

        // Silently check GitHub Releases for updates (Wi-Fi only when YT Package Mode is ON -> 0 Anytime Data!)
        mainHandler.postDelayed({
            AppUpdater.checkForUpdate(this, manual = false, ytPackageMode = ytPackageMode)
        }, 3000L)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val incoming = intent.dataString
        if (!incoming.isNullOrBlank() && incoming.contains("youtu")) {
            geckoSession.loadUri(incoming)
        }
    }

    override fun buildCurrentConfig(): JSONObject {
        return JSONObject().apply {
            put("type", "config")
            put("ccEnabled", ccEnabled)
            put("ytPackageMode", ytPackageMode)
            put("adShield", adShield)
            put("bgPlayEnabled", bgPlayEnabled)
        }
    }

    override fun onBridgeStatusChanged(connected: Boolean) {
        // Status is reflected in CC Settings debug panel
    }

    override fun onExtensionMessage(json: JSONObject) {
        when (json.optString("type")) {
            "adBlocked" -> recordAdBlocked()
            "trackLoaded" -> {
                loadedCueCount = json.optInt("count", 0)
            }
            "showSubtitle" -> {
                val si = json.optString("si", "")
                val orig = json.optString("orig", "")
                val mode = json.optString("mode", "YouTube CC")
                if (si.isNotBlank()) showNativeSubtitle(si, orig, mode)
            }
            "hideSubtitle" -> hideNativeSubtitle()
            "mediaState" -> {
                val playing = json.optBoolean("playing", false)
                val title = json.optString("title", "")
                onPlaybackStateUpdated(playing, title)
            }
        }
    }

    private fun handleMediaCommand(cmd: String) {
        mainHandler.post {
            geckoSession.setActive(true)
            val ms = activeMediaSession
            when (cmd) {
                MediaPlaybackService.CMD_TOGGLE -> {
                    if (isVideoPlaying) {
                        ms?.pause()
                        ExtensionBridge.send(JSONObject().apply {
                            put("type", "mediaControl")
                            put("cmd", "pause")
                        })
                    } else {
                        ms?.play()
                        ExtensionBridge.send(JSONObject().apply {
                            put("type", "mediaControl")
                            put("cmd", "play")
                        })
                    }
                }
                MediaPlaybackService.CMD_NEXT -> {
                    ms?.nextTrack()
                    ExtensionBridge.send(JSONObject().apply {
                        put("type", "mediaControl")
                        put("cmd", "next")
                    })
                }
                MediaPlaybackService.CMD_PREV -> {
                    ms?.previousTrack()
                    ExtensionBridge.send(JSONObject().apply {
                        put("type", "mediaControl")
                        put("cmd", "prev")
                    })
                }
                MediaPlaybackService.CMD_STOP -> {
                    ms?.pause()
                    ExtensionBridge.send(JSONObject().apply {
                        put("type", "mediaControl")
                        put("cmd", "stop")
                    })
                }
                else -> {
                    ExtensionBridge.send(JSONObject().apply {
                        put("type", "mediaControl")
                        put("cmd", cmd)
                    })
                }
            }
        }
    }

    private fun setupGeckoEngine(initialUrl: String) {
        geckoRuntime = GeckoRuntime.getDefault(this)

        val sessionSettings = GeckoSessionSettings.Builder()
            .usePrivateMode(false)
            .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
            .build()

        geckoSession = GeckoSession(sessionSettings)

        geckoSession.permissionDelegate = object : GeckoSession.PermissionDelegate {
            override fun onContentPermissionRequest(
                session: GeckoSession,
                perm: GeckoSession.PermissionDelegate.ContentPermission
            ): GeckoResult<Int> {
                return when (perm.permission) {
                    GeckoSession.PermissionDelegate.PERMISSION_AUTOPLAY_AUDIBLE,
                    GeckoSession.PermissionDelegate.PERMISSION_AUTOPLAY_INAUDIBLE,
                    GeckoSession.PermissionDelegate.PERMISSION_MEDIA_KEY_SYSTEM_ACCESS ->
                        GeckoResult.fromValue(GeckoSession.PermissionDelegate.ContentPermission.VALUE_ALLOW)
                    else ->
                        GeckoResult.fromValue(GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY)
                }
            }
        }

        geckoSession.mediaSessionDelegate = object : MediaSession.Delegate {
            override fun onActivated(session: GeckoSession, mediaSession: MediaSession) {
                activeMediaSession = mediaSession
            }

            override fun onDeactivated(session: GeckoSession, mediaSession: MediaSession) {
                if (activeMediaSession == mediaSession) activeMediaSession = null
                onPlaybackStateUpdated(false, currentVideoTitle)
            }

            override fun onMetadata(
                session: GeckoSession,
                mediaSession: MediaSession,
                meta: MediaSession.Metadata
            ) {
                activeMediaSession = mediaSession
                if (!meta.title.isNullOrBlank()) {
                    currentVideoTitle = meta.title!!
                    if (isVideoPlaying) syncBackgroundService(true, currentVideoTitle)
                }
            }

            override fun onPlay(session: GeckoSession, mediaSession: MediaSession) {
                activeMediaSession = mediaSession
                onPlaybackStateUpdated(true, currentVideoTitle)
            }

            override fun onPause(session: GeckoSession, mediaSession: MediaSession) {
                activeMediaSession = mediaSession
                onPlaybackStateUpdated(false, currentVideoTitle)
            }

            override fun onStop(session: GeckoSession, mediaSession: MediaSession) {
                onPlaybackStateUpdated(false, currentVideoTitle)
            }
        }

        geckoSession.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onFullScreen(session: GeckoSession, fullScreen: Boolean) {
                mainHandler.post {
                    isFullscreen = fullScreen
                    if (fullScreen) {
                        topBar.visibility = View.GONE
                        progressBar.visibility = View.GONE
                        appContainer.setPadding(0, 0, 0, 0)
                        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        setImmersiveMode(true)
                    } else {
                        if (!isInPip) topBar.visibility = View.VISIBLE
                        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                        setImmersiveMode(false)
                        ViewCompat.requestApplyInsets(appContainer)
                    }
                    applySubtitleStyle()
                }
            }

            override fun onTitleChange(session: GeckoSession, title: String?) {
                val clean = title?.replace(Regex("""\s*-\s*YouTube$""", RegexOption.IGNORE_CASE), "")?.trim()
                if (!clean.isNullOrBlank()) {
                    currentVideoTitle = clean
                }
            }
        }

        geckoSession.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onCanGoBack(session: GeckoSession, canGoBackValue: Boolean) {
                canGoBack = canGoBackValue
            }

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest
            ): GeckoResult<AllowOrDeny> {
                val uri = request.uri
                if (uri.startsWith("intent://")) {
                    try {
                        val parsed = Intent.parseUri(uri, Intent.URI_INTENT_SCHEME)
                        val fallback = parsed.getStringExtra("browser_fallback_url")
                        if (!fallback.isNullOrBlank() && fallback.startsWith("http")) {
                            session.loadUri(fallback)
                        }
                    } catch (_: Exception) {
                    }
                    return GeckoResult.fromValue(AllowOrDeny.DENY)
                }
                if (!uri.startsWith("http://") && !uri.startsWith("https://") && !uri.startsWith("about:") && !uri.startsWith("data:")) {
                    return GeckoResult.fromValue(AllowOrDeny.DENY)
                }
                if (request.target == GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW) {
                    if (uri.contains("accounts.google.com") ||
                        uri.contains("accounts.youtube.com") ||
                        uri.contains("youtube.com") ||
                        uri.contains("google.com")
                    ) {
                        session.loadUri(uri)
                    } else if (adShield) {
                        recordAdBlocked()
                    }
                    return GeckoResult.fromValue(AllowOrDeny.DENY)
                }
                return GeckoResult.fromValue(AllowOrDeny.ALLOW)
            }
        }

        geckoSession.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String) {
                mainHandler.post {
                    pageBlockedCount = 0
                    loadedCueCount = 0
                    updateTopBadges()
                    hideNativeSubtitle()
                }
            }

            override fun onProgressChange(session: GeckoSession, progress: Int) {
                mainHandler.post {
                    if (isInPip || isFullscreen) {
                        progressBar.visibility = View.GONE
                    } else if (progress in 1..99) {
                        progressBar.visibility = View.VISIBLE
                        progressBar.progress = progress
                    } else {
                        progressBar.visibility = View.GONE
                    }
                }
            }
        }

        geckoSession.open(geckoRuntime)
        geckoSession.setActive(true)
        geckoView.coverUntilFirstPaint(Color.parseColor("#0B0B0F"))
        geckoView.setSession(geckoSession)

        // Attach process-wide ExtensionBridge BEFORE loading YouTube so cold & warm restarts NEVER miss CC!
        ExtensionBridge.attach(geckoRuntime, this) {
            geckoSession.loadUri(initialUrl)
        }
    }

    private fun onPlaybackStateUpdated(playing: Boolean, title: String) {
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

    private fun recordAdBlocked() {
        pageBlockedCount++
        totalBlockedCount++
        updateTopBadges()
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
                btnShield.text = "🛡$pageBlockedCount"
                btnShield.setTextColor(Color.parseColor("#FF4B3A"))
            } else {
                btnShield.text = "🛡OFF"
                btnShield.setTextColor(Color.parseColor("#888C9E"))
            }
            btnBgPlay.text = "BG"
            btnBgPlay.setTextColor(
                Color.parseColor(if (bgPlayEnabled) "#4ADE80" else "#7D8094")
            )
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
            lp.topMargin = ((if (isFullscreen) 16 else 58) * density).toInt()
            lp.bottomMargin = 0
            lp.marginStart = (14 * density).toInt()
            lp.marginEnd = (14 * density).toInt()
        } else {
            lp.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            lp.topMargin = 0
            lp.bottomMargin = ((if (isFullscreen) 24 else 44) * density).toInt()
            lp.marginStart = (14 * density).toInt()
            lp.marginEnd = (14 * density).toInt()
        }
        subtitleOverlayContainer.layoutParams = lp
    }

    // -------------------------------------------------------------------------
    // Picture-in-Picture (PiP) Support
    // -------------------------------------------------------------------------
    private fun buildPipParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        val builder = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        val toggleIntent = Intent(MediaPlaybackService.BROADCAST_MEDIA_CONTROL).apply {
            setPackage(packageName)
            putExtra(MediaPlaybackService.EXTRA_CMD, MediaPlaybackService.CMD_TOGGLE)
        }
        val togglePi = PendingIntent.getBroadcast(this, 101, toggleIntent, piFlags)
        val iconRes = if (isVideoPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val label = if (isVideoPlaying) "Pause" else "Play"
        val toggleAction = RemoteAction(Icon.createWithResource(this, iconRes), label, label, togglePi)

        val nextIntent = Intent(MediaPlaybackService.BROADCAST_MEDIA_CONTROL).apply {
            setPackage(packageName)
            putExtra(MediaPlaybackService.EXTRA_CMD, MediaPlaybackService.CMD_NEXT)
        }
        val nextPi = PendingIntent.getBroadcast(this, 102, nextIntent, piFlags)
        val nextAction = RemoteAction(Icon.createWithResource(this, android.R.drawable.ic_media_next), "Next", "Next", nextPi)

        builder.setActions(listOf(toggleAction, nextAction))
        return builder.build()
    }

    private fun enterPipModeNow() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            Toast.makeText(this, "PiP requires Android 8.0+", Toast.LENGTH_SHORT).show()
            return
        }
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            Toast.makeText(this, "PiP not supported on this device", Toast.LENGTH_SHORT).show()
            return
        }
        wasPlayingBeforePip = isVideoPlaying
        geckoSession.setActive(true)
        buildPipParams()?.let {
            try {
                enterPictureInPictureMode(it)
            } catch (_: Exception) {
            }
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
        geckoSession.setActive(true)
        topBar.visibility = if (isInPip || isFullscreen) View.GONE else View.VISIBLE
        progressBar.visibility = View.GONE
        if (isInPip) {
            appContainer.setPadding(0, 0, 0, 0)
        } else {
            ViewCompat.requestApplyInsets(appContainer)
        }
        ExtensionBridge.send(JSONObject().apply {
            put("type", "setPip")
            put("inPip", isInPip)
        })
        applySubtitleStyle()

        if (isInPip && wasPlayingBeforePip) {
            mainHandler.postDelayed({
                if (isInPip && !isVideoPlaying) {
                    activeMediaSession?.play()
                    ExtensionBridge.send(JSONObject().apply {
                        put("type", "mediaControl")
                        put("cmd", "play")
                    })
                }
            }, 250L)
            mainHandler.postDelayed({
                if (isInPip && !isVideoPlaying) {
                    activeMediaSession?.play()
                    ExtensionBridge.send(JSONObject().apply {
                        put("type", "mediaControl")
                        put("cmd", "play")
                    })
                }
            }, 650L)
        }
    }

    // -------------------------------------------------------------------------
    // Background & Screen-Off Playback Service
    // -------------------------------------------------------------------------
    private fun syncBackgroundService(playing: Boolean, title: String) {
        if (!bgPlayEnabled) {
            stopService(Intent(this, MediaPlaybackService::class.java))
            return
        }
        val svcIntent = Intent(this, MediaPlaybackService::class.java).apply {
            action = MediaPlaybackService.ACTION_UPDATE
            putExtra(MediaPlaybackService.EXTRA_TITLE, title)
            putExtra(MediaPlaybackService.EXTRA_PLAYING, playing)
        }
        try {
            if (playing) {
                ContextCompat.startForegroundService(this, svcIntent)
            } else {
                startService(svcIntent)
            }
        } catch (_: Exception) {
        }
    }

    override fun onPause() {
        super.onPause()
        if (bgPlayEnabled || isInPip || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode)) {
            geckoSession.setActive(true)
        } else {
            geckoSession.setActive(false)
        }
    }

    override fun onResume() {
        super.onResume()
        geckoSession.setActive(true)
        ExtensionBridge.pushConfigAndResync()
        AppUpdater.resumePendingInstallIfPermitted(this)
    }

    override fun onDestroy() {
        ExtensionBridge.detach(this)
        try {
            unregisterReceiver(mediaControlReceiver)
        } catch (_: Exception) {
        }
        stopService(Intent(this, MediaPlaybackService::class.java))
        try {
            geckoSession.close()
        } catch (_: Exception) {
        }
        super.onDestroy()
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
        val goHome: (View) -> Unit = { geckoSession.loadUri(YOUTUBE_HOME) }
        findViewById<ImageView>(R.id.ivBrandLogo).setOnClickListener(goHome)
        findViewById<TextView>(R.id.tvBrandTitle).setOnClickListener(goHome)

        findViewById<TextView>(R.id.btnBack).setOnClickListener {
            if (canGoBack) geckoSession.goBack()
        }

        findViewById<TextView>(R.id.btnPip).setOnClickListener {
            enterPipModeNow()
        }

        btnBgPlay.setOnClickListener {
            bgPlayEnabled = !bgPlayEnabled
            saveSettings()
            updateTopBadges()
            ExtensionBridge.pushConfigAndResync()
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
                "Killer X Shield (Firefox): ${if (adShield) "ON" else "OFF"} | Blocked: $pageBlockedCount (Total $totalBlockedCount)",
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
                    isFullscreen -> geckoSession.exitFullScreen()
                    canGoBack -> geckoSession.goBack()
                    else -> moveTaskToBack(true)
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
        val btnCheckUpdate = view.findViewById<Button>(R.id.btnCheckUpdate)
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
            append("Version: v${AppUpdater.getInstalledVersion(this@MainActivity)} | Bridge: ${if (ExtensionBridge.isConnected()) "Connected" else "Reconnecting..."} | Cues: $loadedCueCount")
            append("\nBG Play: ${if (bgPlayEnabled) "ON" else "OFF"} | YT Pkg: ${if (ytPackageMode) "ON (0 Anytime)" else "OFF"}")
            append("\nAds Blocked: $totalBlockedCount | CC: $lastSourceMode")
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

                saveSettings()
                applySubtitleStyle()
                updateTopBadges()
                ExtensionBridge.pushConfigAndResync()

                if (!ccEnabled) hideNativeSubtitle()
                if (!bgPlayEnabled) stopService(Intent(this, MediaPlaybackService::class.java))
            }
            .setNegativeButton("Close", null)
            .create()

        btnGmailLogin.setOnClickListener {
            dialog.dismiss()
            geckoSession.loadUri(GOOGLE_LOGIN_URL)
            Toast.makeText(this, "Opening Google Sign-In (Firefox Engine)...", Toast.LENGTH_SHORT).show()
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
            geckoSession.reload()
        }

        btnCheckUpdate.setOnClickListener {
            dialog.dismiss()
            AppUpdater.checkForUpdate(this, manual = true, ytPackageMode = ytPackageMode)
        }

        dialog.show()
    }
}
