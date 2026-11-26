package com.killerx.yt

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat

class MediaPlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "killer_x_yt_playback"
        const val NOTIFICATION_ID = 1001

        const val ACTION_UPDATE = "com.killerx.yt.SERVICE_UPDATE"
        const val ACTION_STOP = "com.killerx.yt.SERVICE_STOP"
        const val ACTION_SET_SLEEP_TIMER = "com.killerx.yt.SET_SLEEP_TIMER"

        const val BROADCAST_MEDIA_CONTROL = "com.killerx.yt.MEDIA_CONTROL"
        const val BROADCAST_SLEEP_EXPIRED = "com.killerx.yt.SLEEP_EXPIRED"
        const val EXTRA_CMD = "cmd"
        const val EXTRA_TITLE = "title"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_SLEEP_END_MS = "sleep_end_ms"

        const val CMD_TOGGLE = "toggle"
        const val CMD_PREV = "prev"
        const val CMD_NEXT = "next"
        const val CMD_STOP = "stop"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var currentTitle: String = "Killer X YT"
    private var isPlaying: Boolean = false
    private var sleepEndElapsedMs: Long = 0L

    private val sleepCheckRunnable = object : Runnable {
        override fun run() {
            if (sleepEndElapsedMs <= 0L) return
            val remainingMs = sleepEndElapsedMs - SystemClock.elapsedRealtime()
            if (remainingMs <= 0L) {
                sleepEndElapsedMs = 0L
                sendMediaCommand(CMD_STOP)
                val exp = Intent(BROADCAST_SLEEP_EXPIRED).apply {
                    setPackage(packageName)
                }
                sendBroadcast(exp)
                releaseWakeLock()
                stopForegroundCompat()
                stopSelf()
                return
            }

            // Refresh notification countdown text
            updateForegroundNotification()

            val nextDelay = when {
                remainingMs <= 2000L -> remainingMs.coerceAtLeast(200L)
                remainingMs <= 15000L -> 1000L
                else -> 15000L
            }
            handler.postDelayed(this, nextDelay)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                sleepEndElapsedMs = 0L
                handler.removeCallbacks(sleepCheckRunnable)
                sendMediaCommand(CMD_STOP)
                releaseWakeLock()
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            CMD_TOGGLE, CMD_PREV, CMD_NEXT -> {
                sendMediaCommand(intent.action!!)
                return START_STICKY
            }
            ACTION_SET_SLEEP_TIMER -> {
                sleepEndElapsedMs = intent.getLongExtra(EXTRA_SLEEP_END_MS, 0L)
                handler.removeCallbacks(sleepCheckRunnable)
                if (sleepEndElapsedMs > SystemClock.elapsedRealtime()) {
                    val durationMs = sleepEndElapsedMs - SystemClock.elapsedRealtime()
                    updateForegroundNotification()
                    acquireWakeLock(durationMs + 60_000L)
                    handler.postDelayed(sleepCheckRunnable, 1000L)
                } else {
                    sleepEndElapsedMs = 0L
                    if (isPlaying) {
                        updateForegroundNotification()
                    } else {
                        releaseWakeLock()
                        stopForegroundCompat()
                        stopSelf()
                        return START_NOT_STICKY
                    }
                }
            }
            else -> {
                currentTitle = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: currentTitle
                isPlaying = intent?.getBooleanExtra(EXTRA_PLAYING, true) ?: true

                if (intent?.hasExtra(EXTRA_SLEEP_END_MS) == true) {
                    val newEnd = intent.getLongExtra(EXTRA_SLEEP_END_MS, 0L)
                    if (newEnd > SystemClock.elapsedRealtime()) {
                        sleepEndElapsedMs = newEnd
                        handler.removeCallbacks(sleepCheckRunnable)
                        handler.postDelayed(sleepCheckRunnable, 1000L)
                    }
                }

                updateForegroundNotification()
                val sleepActive = sleepEndElapsedMs > SystemClock.elapsedRealtime()
                if (isPlaying || sleepActive) {
                    val capMs = if (sleepActive) (sleepEndElapsedMs - SystemClock.elapsedRealtime() + 60_000L) else (4L * 60L * 60L * 1000L)
                    acquireWakeLock(capMs)
                } else {
                    releaseWakeLock()
                }
            }
        }
        return START_STICKY
    }

    private fun updateForegroundNotification() {
        val notification = buildNotification(currentTitle, isPlaying)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun sendMediaCommand(cmd: String) {
        val b = Intent(BROADCAST_MEDIA_CONTROL).apply {
            setPackage(packageName)
            putExtra(EXTRA_CMD, cmd)
        }
        sendBroadcast(b)
    }

    private fun buildNotification(title: String, playing: Boolean): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val openAppPi = PendingIntent.getActivity(this, 0, openAppIntent, piFlags)

        fun serviceActionPi(action: String, reqCode: Int): PendingIntent {
            val i = Intent(this, MediaPlaybackService::class.java).apply { this.action = action }
            return PendingIntent.getService(this, reqCode, i, piFlags)
        }

        val playPauseIcon = if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val playPauseLabel = if (playing) "Pause" else "Play"

        val remainingMs = sleepEndElapsedMs - SystemClock.elapsedRealtime()
        val sleepSuffix = if (remainingMs > 0L) {
            val mins = ((remainingMs + 59_999L) / 60_000L).toInt().coerceAtLeast(1)
            " • 🌙 Sleep in ${mins}m"
        } else {
            ""
        }
        val statusText = (if (playing) "Playing in background" else "Paused") + sleepSuffix

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(statusText)
            .setContentIntent(openAppPi)
            .setOngoing(playing || remainingMs > 0L)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Prev", serviceActionPi(CMD_PREV, 1))
            .addAction(playPauseIcon, playPauseLabel, serviceActionPi(CMD_TOGGLE, 2))
            .addAction(android.R.drawable.ic_media_next, "Next", serviceActionPi(CMD_NEXT, 3))
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", serviceActionPi(ACTION_STOP, 4))
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Killer X YT Background Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Controls for background, screen-off playback & sleep timer"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    private fun acquireWakeLock(timeoutMs: Long) {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KillerXYT::BgAudioWakeLock").apply {
                    setReferenceCounted(false)
                }
            }
            wakeLock?.acquire(timeoutMs.coerceIn(60_000L, 4L * 60L * 60L * 1000L))
        } catch (_: Exception) {
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(sleepCheckRunnable)
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
