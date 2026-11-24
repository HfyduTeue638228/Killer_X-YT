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
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class MediaPlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "killer_x_yt_playback"
        const val NOTIFICATION_ID = 1001

        const val ACTION_UPDATE = "com.killerx.yt.SERVICE_UPDATE"
        const val ACTION_STOP = "com.killerx.yt.SERVICE_STOP"

        // Broadcast actions sent from Notification / PiP to MainActivity
        const val BROADCAST_MEDIA_CONTROL = "com.killerx.yt.MEDIA_CONTROL"
        const val EXTRA_CMD = "cmd"
        const val EXTRA_TITLE = "title"
        const val EXTRA_PLAYING = "playing"

        const val CMD_TOGGLE = "toggle"
        const val CMD_PREV = "prev"
        const val CMD_NEXT = "next"
        const val CMD_STOP = "stop"
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var currentTitle: String = "Killer X YT"
    private var isPlaying: Boolean = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
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
            else -> {
                currentTitle = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: currentTitle
                isPlaying = intent?.getBooleanExtra(EXTRA_PLAYING, true) ?: true

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

                if (isPlaying) acquireWakeLock() else releaseWakeLock()
            }
        }
        return START_STICKY
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
        val statusText = if (playing) "Playing in background • Screen-off ready" else "Paused"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title)
            .setContentText(statusText)
            .setContentIntent(openAppPi)
            .setOngoing(playing)
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
                description = "Controls for background & screen-off YouTube playback"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    private fun acquireWakeLock() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KillerXYT::BgAudioWakeLock").apply {
                    setReferenceCounted(false)
                }
            }
            if (wakeLock?.isHeld == false) {
                wakeLock?.acquire(4L * 60L * 60L * 1000L) // Safety cap 4 hours
            }
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
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
