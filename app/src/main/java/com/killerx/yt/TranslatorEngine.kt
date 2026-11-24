package com.killerx.yt

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

object TranslatorEngine {

    private val executor = Executors.newFixedThreadPool(4)
    private val cache = ConcurrentHashMap<String, String>()
    private val recentSniffed = ConcurrentHashMap<String, Long>()
    private const val MAX_CACHE = 3000

    private val MULTI_SPACE = Regex("""\s+""")
    private val NEWLINE = Regex("""\r?\n""")
    private val NON_SUB_EXT = Regex("""\.(mp4|m3u8|ts|mp3|jpg|jpeg|png|webp|gif|svg|css|js|woff2?|ttf)(\?|$|#)""")
    private val SUB_EXT = Regex("""\.(vtt|srt|ass|ssa|ttml|dfxp|sbv)(\?|$|#)""")
    private val SUB_KEYWORD = Regex("""[/?&_](sub|subs|subtitle|subtitles|caption|captions)[/?&_=.]""")
    private val HLS_SEG_NUM = Regex("""[-_/]\d+\.(vtt|webvtt|srt)$""", RegexOption.IGNORE_CASE)
    private val TLANG_PARAM = Regex("""([?&])tlang=[^&]*""", RegexOption.IGNORE_CASE)
    private val LANG_SI_PARAM = Regex("""[?&]lang=si(&|$)""", RegexOption.IGNORE_CASE)

    fun cacheSize(): Int = cache.size

    private fun putCache(key: String, value: String) {
        if (key.isBlank() || value.isBlank()) return
        if (cache.size >= MAX_CACHE) {
            val first = cache.keys.firstOrNull()
            if (first != null) cache.remove(first)
        }
        cache[key] = value
    }

    private fun httpGet(urlStr: String, headers: Map<String, String> = emptyMap(), timeoutMs: Int = 6000): String {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = true
            setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
            )
            for ((k, v) in headers) {
                if (!k.equals("Accept-Encoding", ignoreCase = true) && v.isNotBlank()) {
                    setRequestProperty(k, v)
                }
            }
        }
        return try {
            if (conn.responseCode !in 200..299) {
                throw RuntimeException("HTTP ${conn.responseCode}")
            }
            BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    fun isYouTubeTimedTextUrl(url: String): Boolean {
        val u = url.lowercase()
        return (u.contains("youtube.com/api/timedtext") || u.contains("m.youtube.com/api/timedtext"))
    }

    fun toYouTubeSinhalaUrl(url: String): String {
        if (LANG_SI_PARAM.containsMatchIn(url)) return url
        return if (TLANG_PARAM.containsMatchIn(url)) {
            url.replace(TLANG_PARAM, "$1tlang=si")
        } else {
            val sep = if (url.contains("?")) "&" else "?"
            "${url}${sep}tlang=si"
        }
    }

    private fun translateGoogleSync(text: String): String {
        val encoded = URLEncoder.encode(text, "UTF-8")
        val url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=si&dt=t&q=$encoded"
        val body = httpGet(url)
        val root = JSONArray(body)
        val sentences = root.optJSONArray(0) ?: return ""
        val sb = StringBuilder()
        for (i in 0 until sentences.length()) {
            val part = sentences.optJSONArray(i)?.optString(0, "") ?: ""
            sb.append(part)
        }
        return sb.toString().trim()
    }

    private fun translateFallbackSync(text: String): String {
        val encoded = URLEncoder.encode(text, "UTF-8")
        val url = "https://api.mymemory.translated.net/get?q=$encoded&langpair=en|si"
        val body = httpGet(url)
        val obj = JSONObject(body)
        return obj.optJSONObject("responseData")?.optString("translatedText", "")?.trim() ?: ""
    }

    fun translateSingleSync(raw: String): String {
        val clean = raw.replace(MULTI_SPACE, " ").trim()
        if (clean.isEmpty()) return ""
        cache[clean]?.let { return it }

        val translated = try {
            translateGoogleSync(clean)
        } catch (_: Exception) {
            try {
                translateFallbackSync(clean)
            } catch (_: Exception) {
                ""
            }
        }
        if (translated.isNotEmpty()) {
            putCache(clean, translated)
        }
        return translated
    }

    fun translateSingleAsync(raw: String, callback: (String) -> Unit) {
        val clean = raw.replace(MULTI_SPACE, " ").trim()
        if (clean.isEmpty()) {
            callback("")
            return
        }
        cache[clean]?.let {
            callback(it)
            return
        }
        executor.execute {
            val result = translateSingleSync(clean)
            callback(result)
        }
    }

    fun translateBatchAsync(lines: List<String>, callback: (Map<String, String>) -> Unit) {
        executor.execute {
            val result = LinkedHashMap<String, String>()
            val toFetch = mutableListOf<String>()

            for (raw in lines) {
                val clean = raw.replace(MULTI_SPACE, " ").trim()
                if (clean.isEmpty() || clean.length > 320) continue
                val cached = cache[clean]
                if (cached != null) {
                    result[clean] = cached
                } else if (!toFetch.contains(clean)) {
                    toFetch.add(clean)
                }
            }

            if (toFetch.isNotEmpty()) {
                var batchSucceeded = false
                try {
                    val joined = toFetch.joinToString("\n")
                    val translatedJoined = translateGoogleSync(joined)
                    val outLines = translatedJoined.split(NEWLINE).map { it.trim() }.filter { it.isNotEmpty() }
                    if (outLines.size == toFetch.size) {
                        for (i in toFetch.indices) {
                            putCache(toFetch[i], outLines[i])
                            result[toFetch[i]] = outLines[i]
                        }
                        batchSucceeded = true
                    }
                } catch (_: Exception) {
                }

                if (!batchSucceeded) {
                    for (line in toFetch) {
                        val t = translateSingleSync(line)
                        if (t.isNotEmpty()) result[line] = t
                    }
                }
            }
            callback(result)
        }
    }

    fun isSubtitleUrl(url: String): Boolean {
        val u = url.lowercase()
        if (!u.startsWith("http")) return false
        if (u.contains("translate.googleapis.com") || u.contains("mymemory.translated.net")) return false
        if (NON_SUB_EXT.containsMatchIn(u)) return false
        return SUB_EXT.containsMatchIn(u) ||
            u.contains("/api/timedtext") ||
            u.contains("timedtext") ||
            u.contains("webvtt") ||
            SUB_KEYWORD.containsMatchIn(u)
    }

    fun sniffSubtitleAsync(
        url: String,
        headers: Map<String, String>,
        onParsed: (trackKey: String, isChunk: Boolean, cuesJson: JSONArray) -> Unit
    ) {
        val now = System.currentTimeMillis()
        val prev = recentSniffed[url]
        if (prev != null && now - prev < 15_000L) return
        recentSniffed[url] = now
        if (recentSniffed.size > 150) {
            recentSniffed.clear()
        }

        executor.execute {
            try {
                val raw = httpGet(url, headers, 7000)
                val cues = SubtitleParser.parseAny(raw)
                if (cues.isEmpty()) return@execute

                val spanSec = cues.last().end - cues.first().start
                val isChunk = cues.size <= 30 && spanSec <= 50.0
                val trackKey = try {
                    val parsed = URL(url)
                    val cleanPath = parsed.path.replace(HLS_SEG_NUM, ".$1")
                    "${parsed.protocol}://${parsed.host}$cleanPath"
                } catch (_: Exception) {
                    url
                }
                onParsed(trackKey, isChunk, SubtitleParser.cuesToJsonArray(cues))
            } catch (_: Exception) {
            }
        }
    }
}
