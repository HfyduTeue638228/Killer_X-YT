package com.killerx.yt

import org.json.JSONArray
import org.json.JSONObject
import java.util.regex.Pattern

object SubtitleParser {

    data class Cue(val start: Double, val end: Double, val text: String)

    private val BRACE_TAG_REGEX = Regex("""\{[^}]*\}""")
    private val HTML_TAG_REGEX = Regex("""<[^>]*>""")
    private val MULTI_SPACE_REGEX = Regex("""\s+""")
    private val NEWLINE_REGEX = Regex("""\r?\n""")
    private val XML_CUE_PATTERN = Pattern.compile(
        """<(?:p|text)\b([^>]*)>([\s\S]*?)</(?:p|text)>""",
        Pattern.CASE_INSENSITIVE
    )

    fun cleanText(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        return raw
            .replace(BRACE_TAG_REGEX, "")
            .replace(HTML_TAG_REGEX, "")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .replace("&nbsp;", " ")
            .replace("\\N", " ")
            .replace("\\n", " ")
            .replace(MULTI_SPACE_REGEX, " ")
            .trim()
    }

    private fun parseTimestamp(str: String?): Double {
        if (str.isNullOrBlank()) return Double.NaN
        val s = str.trim().replace(",", ".")
        if (s.endsWith("ms", ignoreCase = true)) {
            return s.dropLast(2).toDoubleOrNull()?.div(1000.0) ?: Double.NaN
        }
        if (s.endsWith("s", ignoreCase = true)) {
            return s.dropLast(1).toDoubleOrNull() ?: Double.NaN
        }
        val parts = s.split(":").map { it.toDoubleOrNull() }
        if (parts.any { it == null }) return Double.NaN
        return when (parts.size) {
            3 -> parts[0]!! * 3600.0 + parts[1]!! * 60.0 + parts[2]!!
            2 -> parts[0]!! * 60.0 + parts[1]!!
            else -> Double.NaN
        }
    }

    fun parseAny(rawText: String?): List<Cue> {
        if (rawText.isNullOrBlank() || rawText.length < 12 || rawText.length > 5_000_000) {
            return emptyList()
        }
        val trimmed = rawText.removePrefix("\uFEFF").trim()
        if (trimmed.startsWith("WEBVTT") || trimmed.contains("-->")) {
            val vtt = parseVttOrSrt(trimmed)
            if (vtt.isNotEmpty()) return vtt
        }
        if (trimmed.contains("[Events]") && trimmed.contains("Dialogue:")) {
            val ass = parseAss(trimmed)
            if (ass.isNotEmpty()) return ass
        }
        if (trimmed.startsWith("{")) {
            return parseJson(trimmed)
        }
        if (trimmed.startsWith("<")) {
            return parseXml(trimmed)
        }
        return emptyList()
    }

    private fun parseVttOrSrt(text: String): List<Cue> {
        val cues = mutableListOf<Cue>()
        val lines = text.split(NEWLINE_REGEX)
        var i = 0
        while (i < lines.size) {
            val line = lines[i].trim()
            if (line.contains("-->")) {
                val idx = line.indexOf("-->")
                val startToken = line.substring(0, idx).trim().split(MULTI_SPACE_REGEX).firstOrNull()
                val endToken = line.substring(idx + 3).trim().split(MULTI_SPACE_REGEX).firstOrNull()
                val start = parseTimestamp(startToken)
                val end = parseTimestamp(endToken)
                i++
                val body = mutableListOf<String>()
                while (i < lines.size && lines[i].trim().isNotEmpty()) {
                    body.add(lines[i].trim())
                    i++
                }
                val clean = cleanText(body.joinToString(" "))
                if (clean.isNotEmpty() && !start.isNaN()) {
                    val validEnd = if (!end.isNaN() && end > start) end else start + 4.0
                    cues.add(Cue(start, validEnd, clean))
                }
            } else {
                i++
            }
        }
        return cues
    }

    private fun parseAss(text: String): List<Cue> {
        val cues = mutableListOf<Cue>()
        for (line in text.split(NEWLINE_REGEX)) {
            if (!line.startsWith("Dialogue:")) continue
            val parts = line.removePrefix("Dialogue:").trim().split(",", limit = 10)
            if (parts.size < 10) continue
            val start = parseTimestamp(parts[1])
            val end = parseTimestamp(parts[2])
            val clean = cleanText(parts[9])
            if (clean.isNotEmpty() && !start.isNaN()) {
                val validEnd = if (!end.isNaN() && end > start) end else start + 4.0
                cues.add(Cue(start, validEnd, clean))
            }
        }
        return cues
    }

    private fun parseJson(text: String): List<Cue> {
        val cues = mutableListOf<Cue>()
        try {
            val obj = JSONObject(text)
            val events = obj.optJSONArray("events")
            if (events != null) {
                for (i in 0 until events.length()) {
                    val ev = events.optJSONObject(i) ?: continue
                    val segs = ev.optJSONArray("segs") ?: continue
                    val sb = StringBuilder()
                    for (j in 0 until segs.length()) {
                        sb.append(segs.optJSONObject(j)?.optString("utf8", "") ?: "")
                    }
                    val clean = cleanText(sb.toString())
                    if (clean.isEmpty()) continue
                    val start = ev.optDouble("tStartMs", 0.0) / 1000.0
                    val dur = ev.optDouble("dDurationMs", 3500.0) / 1000.0
                    cues.add(Cue(start, start + maxOf(0.8, dur), clean))
                }
                return cues
            }
            val body = obj.optJSONArray("body")
            if (body != null) {
                for (i in 0 until body.length()) {
                    val item = body.optJSONObject(i) ?: continue
                    val clean = cleanText(item.optString("content", item.optString("text", "")))
                    if (clean.isEmpty()) continue
                    val start = item.optDouble("from", item.optDouble("start", Double.NaN))
                    val end = item.optDouble("to", item.optDouble("end", start + 3.5))
                    if (!start.isNaN()) {
                        cues.add(Cue(start, if (!end.isNaN() && end > start) end else start + 3.5, clean))
                    }
                }
            }
        } catch (_: Exception) {
        }
        return cues
    }

    private fun extractAttr(attrs: String, name: String): String? {
        val p = Pattern.compile("\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE)
        val m = p.matcher(attrs)
        return if (m.find()) m.group(1) else null
    }

    private fun parseXml(text: String): List<Cue> {
        val cues = mutableListOf<Cue>()
        try {
            val matcher = XML_CUE_PATTERN.matcher(text)
            while (matcher.find()) {
                val attrs = matcher.group(1) ?: ""
                val clean = cleanText(matcher.group(2))
                if (clean.isEmpty()) continue

                var start = Double.NaN
                var end = Double.NaN
                val beginA = extractAttr(attrs, "begin")
                val endA = extractAttr(attrs, "end")
                val startA = extractAttr(attrs, "start")
                val durA = extractAttr(attrs, "dur")
                val tA = extractAttr(attrs, "t")
                val dA = extractAttr(attrs, "d")

                when {
                    beginA != null -> {
                        start = parseTimestamp(beginA)
                        end = when {
                            endA != null -> parseTimestamp(endA)
                            durA != null -> start + parseTimestamp(durA)
                            else -> start + 3.5
                        }
                    }
                    startA != null -> {
                        start = startA.toDoubleOrNull() ?: Double.NaN
                        end = durA?.toDoubleOrNull()?.let { start + it } ?: (start + 3.5)
                    }
                    tA != null -> {
                        start = (tA.toDoubleOrNull() ?: Double.NaN) / 1000.0
                        end = dA?.toDoubleOrNull()?.let { start + it / 1000.0 } ?: (start + 3.5)
                    }
                }

                if (!start.isNaN()) {
                    cues.add(Cue(start, if (!end.isNaN() && end > start) end else start + 3.5, clean))
                }
            }
        } catch (_: Exception) {
        }
        return cues
    }

    fun cuesToJsonArray(cues: List<Cue>): JSONArray {
        val arr = JSONArray()
        for (c in cues) {
            val o = JSONObject()
            o.put("start", c.start)
            o.put("end", c.end)
            o.put("text", c.text)
            arr.put(o)
        }
        return arr
    }
}
