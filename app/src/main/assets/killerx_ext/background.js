let config = {
  ccEnabled: true,
  ytPackageMode: true,
  dualSub: false,
  adShield: true,
  bgPlayEnabled: true
};

let nativePort = null;
let portVerified = false;
let lastPongTime = 0;

const contentPorts = new Set();
const ourFetchedUrls = new Set();
const recentTimedText = new Map();
const translateCache = new Map();
let latestTimedTextUrl = "";
let latestVideoId = "";
let latestDirectCues = [];

function applyConfig(msg) {
  if (!msg || typeof msg !== "object") return;
  if (typeof msg.ccEnabled === "boolean") config.ccEnabled = msg.ccEnabled;
  if (typeof msg.ytPackageMode === "boolean") config.ytPackageMode = msg.ytPackageMode;
  if (typeof msg.dualSub === "boolean") config.dualSub = msg.dualSub;
  if (typeof msg.adShield === "boolean") config.adShield = msg.adShield;
  if (typeof msg.bgPlayEnabled === "boolean") config.bgPlayEnabled = msg.bgPlayEnabled;
  broadcastToContent({ type: "config", config });
}

function broadcastToContent(msg) {
  for (const port of Array.from(contentPorts)) {
    try {
      port.postMessage(msg);
    } catch (e) {
      contentPorts.delete(port);
    }
  }
}

function tearDownNativePort() {
  const old = nativePort;
  nativePort = null;
  portVerified = false;
  if (old) {
    try {
      old.disconnect();
    } catch (e) {}
  }
}

function connectNative() {
  if (nativePort && portVerified) return;
  tearDownNativePort();

  try {
    const p = browser.runtime.connectNative("killerx");
    nativePort = p;
    portVerified = false;

    p.onMessage.addListener((msg) => {
      if (nativePort !== p) return;
      portVerified = true;
      lastPongTime = Date.now();
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "pong") return;

      if (msg.type === "config") {
        applyConfig(msg);
      } else if (msg.type === "resync") {
        recentTimedText.clear();
        broadcastToContent({ type: "config", config });
        broadcastToContent({ type: "resync" });
      } else if (msg.type === "mediaControl" || msg.type === "setPip") {
        broadcastToContent(msg);
      }
    });

    p.onDisconnect.addListener(() => {
      if (nativePort === p) {
        nativePort = null;
        portVerified = false;
      }
    });

    p.postMessage({ type: "ping" });
    p.postMessage({ type: "ready" });
  } catch (e) {
    tearDownNativePort();
  }
}

function sendToNative(obj) {
  if (nativePort && portVerified) {
    try {
      nativePort.postMessage(obj);
      return;
    } catch (e) {
      tearDownNativePort();
    }
  }

  try {
    browser.runtime.sendNativeMessage("killerx", obj).then((reply) => {
      if (reply && typeof reply === "object") {
        lastPongTime = Date.now();
        if (reply.type === "config") applyConfig(reply);
      }
    }).catch(() => {});
  } catch (e) {}

  connectNative();
}

connectNative();
setInterval(() => {
  const now = Date.now();
  if (!nativePort || !portVerified || (lastPongTime > 0 && now - lastPongTime > 7000)) {
    connectNative();
    try {
      browser.runtime.sendNativeMessage("killerx", { type: "getConfig" }).then((reply) => {
        if (reply && typeof reply === "object" && reply.type === "config") {
          lastPongTime = Date.now();
          applyConfig(reply);
        }
      }).catch(() => {});
    } catch (e) {}
  } else {
    try {
      nativePort.postMessage({ type: "ping" });
    } catch (e) {
      tearDownNativePort();
      connectNative();
    }
  }
}, 2500);

function extractVideoIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get("v") || "";
  } catch (e) {
    return "";
  }
}

function toYouTubeSinhalaUrl(url) {
  if (/[?&]lang=si(&|$)/i.test(url)) return url;
  if (/([?&])tlang=[^&]*/i.test(url)) {
    return url.replace(/([?&])tlang=[^&]*/i, "$1tlang=si");
  }
  return url + (url.includes("?") ? "&" : "?") + "tlang=si";
}

function publishCapturedCues(videoId, cues) {
  if (!Array.isArray(cues) || cues.length === 0) return;
  latestVideoId = videoId || latestVideoId;
  latestDirectCues = cues;
  broadcastToContent({ type: "directSinhalaTrack", videoId: latestVideoId, cues });
  sendToNative({ type: "trackLoaded", count: cues.length });
}

function fetchTimedTextBackup(siUrl, videoId) {
  if (!siUrl || !siUrl.includes("/api/timedtext")) return;
  ourFetchedUrls.add(siUrl);
  setTimeout(() => ourFetchedUrls.delete(siUrl), 10000);

  fetch(siUrl, { credentials: "include" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((txt) => {
      const cues = parseTimedText(txt);
      if (cues.length > 0) {
        publishCapturedCues(videoId || extractVideoIdFromUrl(siUrl), cues);
      }
    })
    .catch(() => {});
}

browser.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "yt-content") return;
  contentPorts.add(port);

  if (!nativePort || !portVerified) {
    connectNative();
  }

  try {
    port.postMessage({ type: "config", config });
    if (latestDirectCues.length > 0) {
      port.postMessage({ type: "directSinhalaTrack", videoId: latestVideoId, cues: latestDirectCues });
    }
  } catch (e) {}

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "clearTrack") {
      if (!msg.videoId || msg.videoId !== latestVideoId) {
        latestTimedTextUrl = "";
        latestVideoId = "";
        latestDirectCues = [];
        recentTimedText.clear();
      }
      return;
    }

    if (msg.type === "translateSingle") {
      if (config.ytPackageMode) {
        try {
          port.postMessage({ type: "translateResult", reqId: msg.reqId, translated: "" });
        } catch (e) {}
        return;
      }
      translateFallback(msg.text).then((translated) => {
        try {
          port.postMessage({ type: "translateResult", reqId: msg.reqId, translated });
        } catch (e) {}
      });
      return;
    }

    if (
      msg.type === "showSubtitle" ||
      msg.type === "hideSubtitle" ||
      msg.type === "mediaState" ||
      msg.type === "adBlocked" ||
      msg.type === "trackLoaded"
    ) {
      sendToNative(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    contentPorts.delete(port);
  });
});

// =========================================================================
// 1. REAL FIREFOX NETWORK AD BLOCKER (Never touches /api/timedtext!)
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
    // NEVER touch or redirect YouTube's own /api/timedtext requests!
    if (url.includes("/api/timedtext")) return {};

    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (isAdHost(host) || AD_PATH_RE.test(url)) {
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
// 2. PASSIVE POT-SIGNED TIMEDTEXT SNIFFER (Optional 0ms Sync Backup)
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

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (!config.ccEnabled) return;
    const url = details.url || "";
    if (!url.includes("/api/timedtext")) return;
    if (ourFetchedUrls.has(url)) return;

    const siUrl = toYouTubeSinhalaUrl(url);
    const vid = extractVideoIdFromUrl(siUrl);
    if (vid && vid === latestVideoId && latestDirectCues.length > 0) return;

    const now = Date.now();
    const prev = recentTimedText.get(siUrl);
    if (prev && now - prev < 5000) return;
    recentTimedText.set(siUrl, now);
    if (recentTimedText.size > 60) recentTimedText.clear();

    latestTimedTextUrl = siUrl;
    latestVideoId = vid;
    fetchTimedTextBackup(siUrl, vid);
  },
  { urls: ["*://*.youtube.com/api/timedtext*"] }
);

// =========================================================================
// 3. FALLBACK TRANSLATOR (When YT Package Mode is OFF)
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
