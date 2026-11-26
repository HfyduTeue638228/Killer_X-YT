let config = {
  ccEnabled: true,
  ytPackageMode: true,
  dualSub: false,
  adShield: true,
  bgPlayEnabled: true,
  sleepRemainingMin: 0
};

let nativePort = null;
let portVerified = false;
let lastPongTime = 0;

const contentPorts = new Set();
const translateCache = new Map();
const inflightTranslates = new Map();
const MAX_CACHE_SIZE = 3000;

function applyConfig(msg) {
  if (!msg || typeof msg !== "object") return;
  if (typeof msg.ccEnabled === "boolean") config.ccEnabled = msg.ccEnabled;
  if (typeof msg.ytPackageMode === "boolean") config.ytPackageMode = msg.ytPackageMode;
  if (typeof msg.dualSub === "boolean") config.dualSub = msg.dualSub;
  if (typeof msg.adShield === "boolean") config.adShield = msg.adShield;
  if (typeof msg.bgPlayEnabled === "boolean") config.bgPlayEnabled = msg.bgPlayEnabled;
  if (typeof msg.sleepRemainingMin === "number") config.sleepRemainingMin = msg.sleepRemainingMin;
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

// =========================================================================
// 1. REAL FIREFOX NETWORK AD BLOCKER (Never touches YouTube captions or translators!)
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
  "translate.googleapis.com",
  "clients5.google.com",
  "api.mymemory.translated.net"
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
// 2. ULTRA-FAST UNIVERSAL SINHALA TRANSLATOR (ANY LANGUAGE -> SINHALA)
// =========================================================================
function putCache(key, val) {
  if (!key || !val) return;
  if (translateCache.size >= MAX_CACHE_SIZE) {
    const oldest = translateCache.keys().next().value;
    if (oldest !== undefined) translateCache.delete(oldest);
  }
  translateCache.set(key, val);
}

async function translateGoogleGtx(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=si&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].map((item) => (Array.isArray(item) ? item[0] : "")).filter(Boolean).join("").trim();
  }
  return "";
}

async function translateGoogleClients5(text) {
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=si&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  if (Array.isArray(data)) {
    if (typeof data[0] === "string") return data[0].trim();
    if (Array.isArray(data[0]) && typeof data[0][0] === "string") return data[0][0].trim();
  }
  return "";
}

async function translateMyMemory(text) {
  // MyMemory works best for English/Latin source lines as a tertiary fallback
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  if (latinCount < text.length * 0.4) return "";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|si`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const data = await res.json();
  const out = data && data.responseData && data.responseData.translatedText;
  if (typeof out === "string" && out.trim() && !out.toUpperCase().includes("MYMEMORY WARNING")) {
    return out.trim();
  }
  return "";
}

function translateToSinhala(rawText) {
  const clean = (rawText || "").replace(/\s+/g, " ").trim();
  if (!clean) return Promise.resolve("");
  if (/[\u0D80-\u0DFF]/.test(clean)) return Promise.resolve(clean);
  if (translateCache.has(clean)) return Promise.resolve(translateCache.get(clean));
  if (inflightTranslates.has(clean)) return inflightTranslates.get(clean);

  const promise = (async () => {
    let result = "";
    try {
      result = await translateGoogleGtx(clean);
    } catch (e) {}

    if (!result) {
      try {
        result = await translateGoogleClients5(clean);
      } catch (e) {}
    }

    if (!result) {
      try {
        result = await translateMyMemory(clean);
      } catch (e) {}
    }

    if (result) {
      putCache(clean, result);
    }
    return result;
  })().finally(() => {
    inflightTranslates.delete(clean);
  });

  inflightTranslates.set(clean, promise);
  return promise;
}

// =========================================================================
// 3. CONTENT SCRIPT <-> NATIVE BRIDGE
// =========================================================================
browser.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "yt-content") return;
  contentPorts.add(port);

  if (!nativePort || !portVerified) {
    connectNative();
  }

  try {
    port.postMessage({ type: "config", config });
  } catch (e) {}

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "translateSingle") {
      translateToSinhala(msg.text).then((translated) => {
        try {
          port.postMessage({ type: "translateResult", reqId: msg.reqId, text: msg.text, translated });
        } catch (e) {}
      });
      return;
    }

    if (
      msg.type === "showSubtitle" ||
      msg.type === "hideSubtitle" ||
      msg.type === "mediaState" ||
      msg.type === "adBlocked" ||
      msg.type === "trackLoaded" ||
      msg.type === "uiAction"
    ) {
      sendToNative(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    contentPorts.delete(port);
  });
});
