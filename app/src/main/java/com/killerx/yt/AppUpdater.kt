package com.killerx.yt

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

object AppUpdater {

    private const val GITHUB_REPO = "HfyduTeue638228/Killer_X-YT"
    private const val LATEST_RELEASE_API = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var pendingApkFile: File? = null

    data class UpdateInfo(
        val latestVersion: String,
        val changelog: String,
        val apkUrl: String,
        val apkName: String
    )

    fun getInstalledVersion(context: Context): String {
        return try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    android.content.pm.PackageManager.PackageInfoFlags.of(0L)
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            info.versionName ?: "2.8"
        } catch (_: Exception) {
            "2.8"
        }
    }

    private fun isOnWifi(context: Context): Boolean {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val net = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(net) ?: return false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } catch (_: Exception) {
            false
        }
    }

    private fun isRemoteNewer(remoteRaw: String, localRaw: String): Boolean {
        val rParts = remoteRaw.trim().removePrefix("v").removePrefix("V").split(".").map { it.toIntOrNull() ?: 0 }
        val lParts = localRaw.trim().removePrefix("v").removePrefix("V").split(".").map { it.toIntOrNull() ?: 0 }
        val maxLen = maxOf(rParts.size, lParts.size)
        for (i in 0 until maxLen) {
            val r = rParts.getOrElse(i) { 0 }
            val l = lParts.getOrElse(i) { 0 }
            if (r > l) return true
            if (r < l) return false
        }
        return false
    }

    fun checkForUpdate(activity: Activity, manual: Boolean, ytPackageMode: Boolean) {
        if (!manual && ytPackageMode && !isOnWifi(activity)) {
            return
        }

        if (manual) {
            Toast.makeText(activity, "Checking for Killer X YT updates...", Toast.LENGTH_SHORT).show()
        }

        val currentVersion = getInstalledVersion(activity)

        executor.execute {
            try {
                val conn = (URL(LATEST_RELEASE_API).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 8000
                    readTimeout = 8000
                    setRequestProperty("Accept", "application/vnd.github+json")
                    setRequestProperty("User-Agent", "KillerXYT/$currentVersion")
                }

                val code = conn.responseCode
                if (code !in 200..299) {
                    conn.disconnect()
                    if (manual) {
                        mainHandler.post {
                            Toast.makeText(
                                activity,
                                if (code == 404) "No online releases published yet" else "Update check failed (HTTP $code)",
                                Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                    return@execute
                }

                val body = BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
                conn.disconnect()

                val json = JSONObject(body)
                val tagName = json.optString("tag_name", "").trim()
                val releaseNotes = json.optString("body", "").trim().ifEmpty { "Bug fixes and improvements." }
                val assets = json.optJSONArray("assets")

                var apkUrl = ""
                var apkName = "Killer-X-YT-$tagName.apk"
                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val a = assets.optJSONObject(i) ?: continue
                        val name = a.optString("name", "")
                        if (name.endsWith(".apk", ignoreCase = true)) {
                            apkUrl = a.optString("browser_download_url", "")
                            apkName = name
                            break
                        }
                    }
                }

                if (tagName.isNotEmpty() && apkUrl.isNotEmpty() && isRemoteNewer(tagName, currentVersion)) {
                    val info = UpdateInfo(tagName, releaseNotes, apkUrl, apkName)
                    mainHandler.post {
                        if (!activity.isFinishing && !activity.isDestroyed) {
                            showUpdateDialog(activity, currentVersion, info)
                        }
                    }
                } else if (manual) {
                    mainHandler.post {
                        Toast.makeText(
                            activity,
                            "You are on the latest version (v$currentVersion)!",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                }
            } catch (_: Exception) {
                if (manual) {
                    mainHandler.post {
                        Toast.makeText(
                            activity,
                            "Update check failed (Wi-Fi / Anytime Data check karanna)",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                }
            }
        }
    }

    private fun showUpdateDialog(activity: Activity, currentVersion: String, info: UpdateInfo) {
        AlertDialog.Builder(activity)
            .setTitle("New Update Available! (${info.latestVersion})")
            .setMessage("Current: v$currentVersion -> New: ${info.latestVersion}\n\nWhat's New:\n${info.changelog}")
            .setPositiveButton("Update Now") { _, _ ->
                downloadAndInstall(activity, info)
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun downloadAndInstall(activity: Activity, info: UpdateInfo) {
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * activity.resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        val tvProgress = TextView(activity).apply {
            text = "Downloading ${info.apkName}..."
            textSize = 14f
        }
        val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            isIndeterminate = true
        }
        container.addView(tvProgress)
        container.addView(progressBar)

        val cancelled = AtomicBoolean(false)

        val progressDialog = AlertDialog.Builder(activity)
            .setTitle("Downloading Update (${info.latestVersion})")
            .setView(container)
            .setCancelable(false)
            .setNegativeButton("Cancel") { _, _ -> cancelled.set(true) }
            .create()
        progressDialog.show()

        executor.execute {
            try {
                val updatesDir = File(activity.cacheDir, "updates").apply { mkdirs() }
                updatesDir.listFiles()?.forEach { it.delete() }
                val outFile = File(updatesDir, "killer-x-yt-update.apk")

                val conn = (URL(info.apkUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 15000
                    readTimeout = 30000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "KillerXYT-Updater")
                }

                if (conn.responseCode !in 200..299) {
                    conn.disconnect()
                    throw RuntimeException("HTTP ${conn.responseCode}")
                }

                val totalBytes = conn.contentLengthLong
                var downloaded = 0L
                val buf = ByteArray(16 * 1024)
                var lastUiUpdate = 0L

                conn.inputStream.use { input ->
                    FileOutputStream(outFile).use { output ->
                        while (!cancelled.get()) {
                            val read = input.read(buf)
                            if (read <= 0) break
                            output.write(buf, 0, read)
                            downloaded += read

                            val now = System.currentTimeMillis()
                            if (now - lastUiUpdate > 150L) {
                                lastUiUpdate = now
                                val mb = downloaded / (1024.0 * 1024.0)
                                mainHandler.post {
                                    if (totalBytes > 0) {
                                        val pct = ((downloaded * 100L) / totalBytes).toInt().coerceIn(0, 100)
                                        val totalMb = totalBytes / (1024.0 * 1024.0)
                                        progressBar.isIndeterminate = false
                                        progressBar.progress = pct
                                        tvProgress.text = String.format(Locale.US, "%.1f MB / %.1f MB (%d%%)", mb, totalMb, pct)
                                    } else {
                                        tvProgress.text = String.format(Locale.US, "Downloaded %.1f MB...", mb)
                                    }
                                }
                            }
                        }
                    }
                }
                conn.disconnect()

                if (cancelled.get()) {
                    outFile.delete()
                    return@execute
                }

                mainHandler.post {
                    progressDialog.dismiss()
                    launchApkInstaller(activity, outFile)
                }
            } catch (e: Exception) {
                mainHandler.post {
                    progressDialog.dismiss()
                    if (!cancelled.get()) {
                        Toast.makeText(
                            activity,
                            "Download failed: ${e.message ?: "network error"}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }
        }
    }

    fun launchApkInstaller(activity: Activity, apkFile: File) {
        if (!apkFile.exists()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            pendingApkFile = apkFile
            AlertDialog.Builder(activity)
                .setTitle("Allow App Updates")
                .setMessage("Killer X YT ekata aluth updates install karanna 'Allow from this source' permission eka ON karala back enna.")
                .setPositiveButton("Open Settings") { _, _ ->
                    val intent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}")
                    )
                    activity.startActivity(intent)
                }
                .setNegativeButton("Cancel") { _, _ -> pendingApkFile = null }
                .show()
            return
        }

        pendingApkFile = null
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apkFile)
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(installIntent)
        } catch (e: Exception) {
            Toast.makeText(activity, "Installer failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    fun resumePendingInstallIfPermitted(activity: Activity) {
        val file = pendingApkFile ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()) {
            launchApkInstaller(activity, file)
        }
    }
}
