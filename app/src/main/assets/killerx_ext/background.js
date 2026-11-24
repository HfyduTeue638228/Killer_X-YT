let config = {
  ccEnabled: true,
  ytPackageMode: true,
  adShield: true,
  bgPlayEnabled: true
};

let nativePort = null;
const ourFetchedUrls = new Set();
const recentTimedText = new Map();
const translateCache = new Map();

function sendToNative(obj) {
  if (!nativePort) return;
  try {
    nativePort.postMessage(obj);
  } catch (e) {}
}

function broadcastToYouTubeTabs(msg) {
  browser.tabs.query({}).then((tabs) => {
    for (const t of tabs) {
      if (t && typeof t.id === "number") {
        browser.tabs.sendMessage(t.id, msg).catch(() => {});
      }
    }
  }).catch(() => {});
}

function connectNative() {
  try {
    nativePort = browser.runtime.connectNative("killerx");
    nativePort.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "config") {
        config.ccEnabled = !!msg.ccEnabled;
        config.ytPackageMode = !!msg.ytPackageMode;
        config.adShield = !!msg.adShield;
        config.bgPlayEnabled = !!msg.bgPlayEnabled;
        broadcastToYouTubeTabs({ type: "config", config });
      } else if (msg.type === "mediaControl" || msg.type === "setPip") {
        broadcastToYouTubeTabs(msg);
      }
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      setTimeout(connectNative, 1500);
    });
    sendToNative({ type: "ready" });
  } catch (e) {
    setTimeout(connectNative, 1500);
  }
}
connectNative();

// =========================================================================
// 1. REAL FIREFOX NETWORK AD BLOCKER (Zero Google Auth False Positives!)
// =========================================================================
const AD_HOSTS = new Set([
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "pagead2.googlesyndication.com",
  "imasdk.googleapis.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "mgid.com",
  "popads.net",
  "popcash.net",
  "exoclick.com",
  "adsterra.com",
  "propellerads.com",
  "moatads.com",
  "scorecardresearch.com"
]);

const NEVER_BLOCK_HOSTS = [
  "accounts.google.com",
  "accounts.youtube.com",
  "myaccount.google.com",
  "ssl.gstatic.com",
  "recaptcha.net",
  "googlevideo.com",
  "ytimg.com",
  "ggpht.com",
  "googleusercontent.com",
  "translate.googleapis.com"
];

const AD_PATH_RE = /(\/pagead\/|\/api\/stats\/ads|\/ptracking\?|\/youtubei\/v1\/log_event|\/adserver\/|\/ads\/vast|\/vast\.xml)/i;

function isAdHost(hostname) {
  let cur = hostname.toLowerCase();
  for (const safe of NEVER_BLOCK_HOSTS) {
    if (cur === safe || cur.endsWith("." + safe)) return false;
  }
  while (true) {
    if (AD_HOSTS.has(cur)) return true;
    const dot = cur.indexOf(".");
    if (dot < 0) break;
    cur = cur.slice(dot + 1);
  }
  return false;
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!config.adShield) return {};
    if (details.type === "main_frame") return {};
    const url = details.url || "";
    if (!url.startsWith("http")) return {};
    if (url.includes("/api/timedtext")) return {};

    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();

      if (isAdHost(host)) {
        sendToNative({ type: "adBlocked" });
        return { cancel: true };
      }

      if (AD_PATH_RE.test(url)) {
        sendToNative({ type: "adBlocked" });
        return { cancel: true };
      }
    } catch (e) {}

    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// =========================================================================
// 2. NATIVE YOUTUBE SINHALA CC SNIFFER (&tlang=si -> 0 KB Anytime Data!)
// =========================================================================
function cleanCue(text) {
  return (text || "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\\N|\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimestamp(str) {
  if (!str) return NaN;
  const s = str.trim().replace(",", ".");
  if (/^\d+(\.\d+)?s$/i.test(s)) return parseFloat(s);
  if (/^\d+(\.\d+)?ms$/i.test(s)) return parseFloat(s) / 1000;
  const parts = s.split(":").map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function parseTimedText(rawText) {
  const cues = [];
  if (!rawText || rawText.length < 12) return cues;
  const trimmed = rawText.replace(/^\uFEFF/, "").trim();

  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json.events)) {
        for (const ev of json.events) {
          if (!Array.isArray(ev.segs)) continue;
          const text = cleanCue(ev.segs.map((s) => s.utf8 || "").join(""));
          if (!text) continue;
          const start = (ev.tStartMs || 0) / 1000;
          const dur = (ev.dDurationMs || 3500) / 1000;
          cues.push({ start, end: start + Math.max(0.8, dur), text });
        }
        return cues;
      }
    } catch (e) {}
  }

  if (trimmed.startsWith("<")) {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "text/xml");
      doc.querySelectorAll("p, text").forEach((node) => {
        const text = cleanCue(node.textContent || "");
        if (!text) return;
        let start = NaN;
        let end = NaN;
        const startA = node.getAttribute("start");
        const durA = node.getAttribute("dur");
        const tA = node.getAttribute("t");
        const dA = node.getAttribute("d");
        const beginA = node.getAttribute("begin");
        const endA = node.getAttribute("end");
        if (beginA) {
          start = parseTimestamp(beginA);
          end = endA ? parseTimestamp(endA) : durA ? start + parseTimestamp(durA) : start + 3.5;
        } else if (startA) {
          start = parseFloat(startA);
          end = durA ? start + parseFloat(durA) : start + 3.5;
        } else if (tA) {
          start = parseFloat(tA) / 1000;
          end = dA ? start + parseFloat(dA) / 1000 : start + 3.5;
        }
        if (Number.isFinite(start)) {
          cues.push({ start, end: Number.isFinite(end) && end > start ? end : start + 3.5, text });
        }
      });
    } catch (e) {}
  }

  return cues;
}

function toYouTubeSinhalaUrl(url) {
  if (/[?&]lang=si(&|$)/i.test(url)) return url;
  if (/([?&])tlang=[^&]*/i.test(url)) {
    return url.replace(/([?&])tlang=[^&]*/i, "$1tlang=si");
  }
  return url + (url.includes("?") ? "&" : "?") + "tlang=si";
}

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (!config.ccEnabled) return;
    const url = details.url || "";
    if (!url.includes("/api/timedtext")) return;
    if (ourFetchedUrls.has(url)) return;

    const siUrl = toYouTubeSinhalaUrl(url);
    const now = Date.now();
    const prev = recentTimedText.get(siUrl);
    if (prev && now - prev < 10000) return;
    recentTimedText.set(siUrl, now);
    if (recentTimedText.size > 60) recentTimedText.clear();

    ourFetchedUrls.add(siUrl);
    setTimeout(() => ourFetchedUrls.delete(siUrl), 15000);

    fetch(siUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((txt) => {
        const cues = parseTimedText(txt);
        if (cues.length > 0) {
          const payload = { type: "directSinhalaTrack", cues };
          if (typeof details.tabId === "number" && details.tabId >= 0) {
            browser.tabs.sendMessage(details.tabId, payload).catch(() => {
              broadcastToYouTubeTabs(payload);
            });
          } else {
            broadcastToYouTubeTabs(payload);
          }
        }
      })
      .catch(() => {});
  },
  { urls: ["*://*.youtube.com/api/timedtext*"] }
);

// =========================================================================
// 3. CONTENT SCRIPT <-> NATIVE BRIDGE + FALLBACK TRANSLATOR
// =========================================================================
async function translateFallback(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (translateCache.has(clean)) return translateCache.get(clean);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=si&dt=t&q=${encodeURIComponent(clean)}`;
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = await res.json();
    const si = Array.isArray(data) && Array.isArray(data[0])
      ? data[0].map((item) => item[0]).filter(Boolean).join("").trim()
      : "";
    if (si) {
      if (translateCache.size > 1500) translateCache.delete(translateCache.keys().next().value);
      translateCache.set(clean, si);
    }
    return si;
  } catch (e) {
    return "";
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "getConfig") {
    sendResponse({ config });
    return false;
  }

  if (msg.type === "translateSingle") {
    if (config.ytPackageMode) {
      sendResponse({ translated: "" });
      return false;
    }
    translateFallback(msg.text).then((translated) => sendResponse({ translated }));
    return true;
  }

  if (
    msg.type === "showSubtitle" ||
    msg.type === "hideSubtitle" ||
    msg.type === "mediaState" ||
    msg.type === "adBlocked"
  ) {
    sendToNative(msg);
  }
  return false;
});
