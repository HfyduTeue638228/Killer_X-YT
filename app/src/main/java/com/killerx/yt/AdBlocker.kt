package com.killerx.yt

import android.content.Context
import android.net.Uri
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

object AdBlocker {

    private val executor = Executors.newSingleThreadExecutor()
    private val blockedHosts: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private val totalBlocked = AtomicInteger(0)
    private val pageBlocked = AtomicInteger(0)

    private const val CACHE_FILENAME = "adblock_domains_v1.txt"
    private const val REFRESH_INTERVAL_MS = 5L * 24L * 60L * 60L * 1000L // 5 days

    // Clean, fast, Brave-compatible community domain lists (no false positives on video streaming!)
    private val FILTER_LIST_URLS = listOf(
        "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=plain&showintro=0&mimetype=plaintext",
        "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/light.txt"
    )

    // Never block core video players, CDNs, or translation APIs
    private val SAFE_WHITELIST = setOf(
        "translate.googleapis.com",
        "api.mymemory.translated.net",
        "youtube.com",
        "m.youtube.com",
        "accounts.google.com",
        "accounts.youtube.com",
        "myaccount.google.com",
        "ssl.gstatic.com",
        "google.lk",
        "recaptcha.net",
        "withgoogle.com",
        "youtubei.googleapis.com",
        "www.googleapis.com",
        "oauth2.googleapis.com",
        "accounts.googleapis.com",
        "content.googleapis.com",
        "gvt1.com",
        "gvt2.com",
        "youtu.be",
        "googlevideo.com",
        "ytimg.com",
        "ggpht.com",
        "googleusercontent.com",
        "donghuastream.org",
        "dailymotion.com",
        "dmcdn.net",
        "ok.ru",
        "vk.com",
        "vimeo.com",
        "vimeocdn.com",
        "cloudflare.com",
        "cdnjs.cloudflare.com",
        "jsdelivr.net",
        "cdn.jsdelivr.net",
        "google.com",
        "gstatic.com",
        "fonts.googleapis.com",
        "fonts.gstatic.com"
    )

    // Built-in instant seed list (active immediately on first launch even before list download!)
    private val BUILTIN_AD_HOSTS = listOf(
        // Major ad & tracker networks
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
        "googletagmanager.com", "googletagservices.com", "adservice.google.com", "pagead2.googlesyndication.com",
        "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
        "mgid.com", "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com", "smartadserver.com",
        "adform.net", "adroll.com", "quantserve.com", "scorecardresearch.com", "hotjar.com", "clarity.ms",
        "moatads.com", "adsafeprotected.com", "doubleverify.com", "bidswitch.net", "sharethrough.com",
        "yieldmo.com", "triplelift.com", "33across.com", "indexww.com", "lijit.com", "sovrn.com",
        "teads.tv", "revcontent.com", "zedo.com", "advertising.com", "unityads.unity3d.com",
        "applovin.com", "vungle.com", "chartboost.com", "inmobi.com", "smaato.net", "mopub.com",
        // Aggressive anime / donghua / movie streaming popunder & ad networks
        "exoclick.com", "exosrv.com", "realsrv.com", "popads.net", "popcash.net", "propellerads.com",
        "propu.sh", "monetag.com", "alwingulla.com", "adsterra.com", "highperformanceformat.com",
        "effectivegatecpm.com", "topcreativeformat.com", "profitablegatecpm.com", "wayfarerorthodox.com",
        "juicyads.com", "trafficjunky.net", "trafficstars.com", "trafficfactory.biz",
        "hilltopads.net", "hilltopads.com", "clickadu.com", "clickadilla.com", "adcash.com",
        "acscdn.com", "onclkds.com", "galaksion.com", "richads.com", "evadav.com", "pushground.com",
        "push.house", "rollerads.com", "admaven.com", "ad-maven.com", "popmyads.com", "popunderjs.com",
        "ero-advertising.com", "plugrush.com", "adspyglass.com", "tsyndicate.com", "adtng.com",
        "histats.com", "amung.us", "whos.amung.us", "mc.yandex.ru", "an.yandex.ru", "statcounter.com",
        "dtscout.com", "rtmark.net", "bidgear.com", "a-ads.com", "coinzilla.com", "adskeeper.com",
        "adskeeper.co.uk", "undertone.com", "gumgum.com", "kargo.com", "connatix.com", "primis.tech",
        "aniview.com", "vidazoo.com", "springserve.com", "spotxchange.com", "imasdk.googleapis.com"
    )

    private val AD_PATH_REGEX = Regex(
        """(/pagead/|/adserver/|/popunder|/pop\.js|/pops\.js|/afu\.php|/adframe|/banner[_-]?ad|/ads/vast|/vast\.xml|doubleclick\.net|googlesyndication|/ptracking\?|/api/stats/ads|/youtubei/v1/log_event)""",
        RegexOption.IGNORE_CASE
    )

    private val REDIRECT_AD_REGEX = Regex(
        """(/afu\.php|/click\.php\?|/go/out|/redirect\?.*ad|popads\.net|popcash\.net|adsterra|exoclick|propellerads|hilltopads|clickadu|monetag)""",
        RegexOption.IGNORE_CASE
    )

    @Volatile
    private var initialized = false

    fun init(context: Context, allowAutoDownload: Boolean = true, onReady: ((Int) -> Unit)? = null) {
        if (!initialized) {
            blockedHosts.addAll(BUILTIN_AD_HOSTS)
            initialized = true
        }

        executor.execute {
            val cacheFile = File(context.filesDir, CACHE_FILENAME)
            if (cacheFile.exists() && cacheFile.length() > 1000) {
                loadFromFile(cacheFile)
            }
            onReady?.invoke(blockedHosts.size)

            if (allowAutoDownload) {
                val needsUpdate = !cacheFile.exists() ||
                    (System.currentTimeMillis() - cacheFile.lastModified() > REFRESH_INTERVAL_MS)
                if (needsUpdate) {
                    downloadListsSync(cacheFile)
                    onReady?.invoke(blockedHosts.size)
                }
            }
        }
    }

    fun forceUpdateLists(context: Context, callback: (Boolean, Int) -> Unit) {
        executor.execute {
            val cacheFile = File(context.filesDir, CACHE_FILENAME)
            val ok = downloadListsSync(cacheFile)
            callback(ok, blockedHosts.size)
        }
    }

    private fun loadFromFile(file: File) {
        try {
            file.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (line in lines) {
                    val h = line.trim().lowercase()
                    if (h.length >= 4 && !h.startsWith("#") && !SAFE_WHITELIST.contains(h)) {
                        blockedHosts.add(h)
                    }
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun downloadListsSync(cacheFile: File): Boolean {
        val merged = LinkedHashSet<String>(60000)
        merged.addAll(BUILTIN_AD_HOSTS)
        var downloadedAny = false

        for (listUrl in FILTER_LIST_URLS) {
            try {
                val conn = (URL(listUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 10000
                    readTimeout = 15000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "SinhalaCCBrowser/1.1")
                }
                try {
                    if (conn.responseCode in 200..299) {
                        BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { br ->
                            var line: String? = br.readLine()
                            while (line != null) {
                                val cleaned = parseDomainLine(line)
                                if (cleaned != null && !isWhitelistedHost(cleaned)) {
                                    merged.add(cleaned)
                                }
                                line = br.readLine()
                            }
                        }
                        downloadedAny = true
                    }
                } finally {
                    conn.disconnect()
                }
            } catch (_: Exception) {
            }
        }

        if (downloadedAny && merged.size > BUILTIN_AD_HOSTS.size) {
            blockedHosts.addAll(merged)
            try {
                cacheFile.bufferedWriter(Charsets.UTF_8).use { bw ->
                    for (d in merged) {
                        bw.write(d)
                        bw.newLine()
                    }
                }
            } catch (_: Exception) {
            }
            return true
        }
        return false
    }

    private fun parseDomainLine(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty() || s.startsWith("#") || s.startsWith("!")) return null
        val hashIdx = s.indexOf('#')
        if (hashIdx >= 0) s = s.substring(0, hashIdx).trim()
        // Handle hosts format ("0.0.0.0 domain.com" or "127.0.0.1 domain.com")
        if (s.startsWith("0.0.0.0") || s.startsWith("127.0.0.1")) {
            val parts = s.split(Regex("""\s+"""))
            s = if (parts.size >= 2) parts[1] else return null
        }
        // Handle wildcard domains ("*.domain.com")
        if (s.startsWith("*.")) s = s.substring(2)
        s = s.lowercase()
        if (s.length < 4 || !s.contains('.') || s.contains('/') || s.contains(' ')) return null
        if (s == "localhost" || s == "localdomain") return null
        return s
    }

    private fun isWhitelistedHost(host: String): Boolean {
        var cur = host
        while (true) {
            if (SAFE_WHITELIST.contains(cur)) return true
            val dot = cur.indexOf('.')
            if (dot < 0) break
            cur = cur.substring(dot + 1)
        }
        return false
    }

    fun isHostBlocked(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        val clean = host.lowercase()
        if (isWhitelistedHost(clean)) return false

        // O(labels) parent-domain walk: checks a.b.ad.com -> b.ad.com -> ad.com
        var cur = clean
        while (true) {
            if (blockedHosts.contains(cur)) return true
            val dot = cur.indexOf('.')
            if (dot < 0) break
            cur = cur.substring(dot + 1)
        }
        return false
    }

    fun shouldBlockRequest(url: String?, isMainFrame: Boolean): Boolean {
        if (url.isNullOrBlank()) return false
        // Never block subtitle files
        if (TranslatorEngine.isSubtitleUrl(url)) return false

        val host = try {
            Uri.parse(url).host?.lowercase()
        } catch (_: Exception) {
            null
        } ?: return false

        if (isHostBlocked(host)) {
            recordBlock()
            return true
        }

        // Check ad script / tracker path patterns (skip main frame HTML pages unless redirect trap)
        if (!isMainFrame && AD_PATH_REGEX.containsMatchIn(url)) {
            if (!isWhitelistedHost(host) || host.contains("youtube.com")) {
                recordBlock()
                return true
            }
        }

        if (isMainFrame && REDIRECT_AD_REGEX.containsMatchIn(url)) {
            recordBlock()
            return true
        }

        return false
    }

    fun recordBlock() {
        totalBlocked.incrementAndGet()
        pageBlocked.incrementAndGet()
    }

    fun resetPageCount() {
        pageBlocked.set(0)
    }

    fun getPageBlocked(): Int = pageBlocked.get()
    fun getTotalBlocked(): Int = totalBlocked.get()
    fun getRuleCount(): Int = blockedHosts.size
}
