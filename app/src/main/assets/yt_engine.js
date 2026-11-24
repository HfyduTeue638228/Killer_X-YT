(() => {
  if (window.__kxYtEngineLoaded) return;
  window.__kxYtEngineLoaded = true;

  // =========================================================================
  // 1. BACKGROUND PLAY & SCREEN-OFF PLAY ENGINE (Page Visibility Spoof!)
  // =========================================================================
  try {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "webkitHidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "webkitVisibilityState", { get: () => "visible", configurable: true });
  } catch (e) {}

  ["visibilitychange", "webkitvisibilitychange", "pagehide", "freeze"].forEach((evName) => {
    window.addEventListener(evName, (e) => {
      if (!window.KillerX || window.KillerX.isBgPlayEnabled()) {
        e.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener(evName, (e) => {
      if (!window.KillerX || window.KillerX.isBgPlayEnabled()) {
        e.stopImmediatePropagation();
      }
    }, true);
  });

  // Auto-dismiss YouTube "Video paused. Continue watching?" prompt during long background listening
  setInterval(() => {
    if (window.KillerX && !window.KillerX.isBgPlayEnabled()) return;
    document.querySelectorAll("yt-confirm-dialog-renderer, .yt-confirm-dialog-renderer, ytm-confirm-dialog-renderer").forEach((dlg) => {
      const txt = (dlg.innerText || "").toLowerCase();
      if (txt.includes("continue watching") || txt.includes("video paused")) {
        const btn = dlg.querySelector("button[aria-label*='Yes'], button[aria-label*='Continue'], #confirm-button button, .yt-spec-button-shape-next");
        if (btn) btn.click();
      }
    });
  }, 2500);

  // =========================================================================
  // 2. PICTURE-IN-PICTURE (PiP) CLEAN VIDEO FIT MODE
  // =========================================================================
  window.__kxSetPipMode = function (inPip) {
    let style = document.getElementById("kx-pip-fit-css");
    if (inPip) {
      if (!style) {
        style = document.createElement("style");
        style.id = "kx-pip-fit-css";
        style.textContent = `
          html, body {
            overflow: hidden !important;
            background: #000 !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          ytm-mobile-topbar-renderer,
          header,
          .mobile-topbar-header,
          ytm-watch-metadata,
          ytm-item-section-renderer,
          ytm-pivot-bar-renderer,
          #below,
          #secondary {
            display: none !important;
          }
          #player-container-id,
          .player-container,
          #movie_player,
          .html5-video-player {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            max-height: 100vh !important;
            z-index: 99999 !important;
            background: #000 !important;
          }
          video.html5-main-video, video {
            width: 100vw !important;
            height: 100vh !important;
            object-fit: contain !important;
            top: 0 !important;
            left: 0 !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }
      window.scrollTo(0, 0);
    } else if (style) {
      style.remove();
    }
  };

  // =========================================================================
  // 3. MEDIA PLAYBACK BRIDGE (Notification & PiP Remote Controls)
  // =========================================================================
  function getMainVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    let best = null;
    let maxScore = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const score = (!v.paused && v.currentTime > 0 ? 5000000 : 0) + (r.width * r.height) + (v.duration > 0 ? 1000 : 0);
      if (score > maxScore) {
        maxScore = score;
        best = v;
      }
    }
    return best;
  }

  function getCurrentVideoTitle() {
    const selList = [
      "h2.slim-video-information-title",
      ".slim-video-information-title",
      "ytm-slim-video-metadata-section-renderer h2",
      "h1.ytd-watch-metadata"
    ];
    for (const sel of selList) {
      const el = document.querySelector(sel);
      const t = (el && (el.innerText || el.textContent) || "").trim();
      if (t) return t;
    }
    const dt = (document.title || "").replace(/\s*-\s*YouTube$/i, "").trim();
    return dt || "Killer X YT";
  }

  window.__kxMediaControl = function (cmd) {
    const v = getMainVideo();
    if (cmd === "toggle") {
      if (v) {
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      }
    } else if (cmd === "pause" || cmd === "stop") {
      if (v && !v.paused) v.pause();
    } else if (cmd === "next") {
      const nextBtn = document.querySelector(".ytp-next-button, button[aria-label*='Next video'], a.ytp-next-button");
      if (nextBtn) nextBtn.click();
      else if (v) v.currentTime = Math.min(v.duration || v.currentTime + 15, v.currentTime + 15);
    } else if (cmd === "prev") {
      if (v && v.currentTime > 5) {
        v.currentTime = 0;
      } else {
        const prevBtn = document.querySelector(".ytp-prev-button, button[aria-label*='Previous video']");
        if (prevBtn) prevBtn.click();
        else history.back();
      }
    }
    reportMediaState();
  };

  let lastReportedPlaying = null;
  let lastReportedTitle = "";
  function reportMediaState() {
    if (!window.KillerX) return;
    const v = getMainVideo();
    const playing = !!(v && !v.paused && !v.ended && v.readyState >= 2);
    const title = getCurrentVideoTitle();
    if (playing !== lastReportedPlaying || title !== lastReportedTitle) {
      lastReportedPlaying = playing;
      lastReportedTitle = title;
      window.KillerX.onMediaStateChanged(playing, title);
    }
  }

  // =========================================================================
  // 4. UNIVERSAL SINHALA CC + YOUTUBE PACKAGE MODE (&tlang=si -> 0 Anytime Data!)
  // =========================================================================
  const localCache = new Map();
  const MAX_CACHE = 3000;

  let ccEnabled = true;
  let ytPackageMode = true;
  let directSinhalaCues = [];
  let directSinhalaVia = "YouTube Native (YT Pkg)";
  let lastDirectSiLine = "";
  let lastOriginalText = "";
  let lastPageUrl = location.href;

  const fetchedYtSiUrls = new Set();
  const pendingSingle = new Map();
  let reqSeq = 1;

  try {
    if (window.KillerX) {
      ccEnabled = window.KillerX.isCcEnabled();
      ytPackageMode = window.KillerX.isYtPackageMode();
    }
  } catch (e) {}

  window.__kxSetConfig = function (isCcEnabled, isYtPkg) {
    ccEnabled = !!isCcEnabled;
    ytPackageMode = !!isYtPkg;
    if (!ccEnabled && window.KillerX) {
      window.KillerX.hideSubtitle();
    }
  };

  function cachePut(orig, si) {
    if (!orig || !si) return;
    if (localCache.size >= MAX_CACHE) localCache.delete(localCache.keys().next().value);
    localCache.set(orig, si);
  }

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

  function toYtSinhalaUrl(url) {
    if (/[?&]lang=si(&|$)/i.test(url)) return url;
    if (/([?&])tlang=[^&]*/i.test(url)) {
      return url.replace(/([?&])tlang=[^&]*/i, "$1tlang=si");
    }
    return url + (url.includes("?") ? "&" : "?") + "tlang=si";
  }

  function isAlreadySinhalaYtUrl(url) {
    return /[?&](tlang|lang)=si(&|$)/i.test(url || "");
  }

  function ingestDirectSinhalaTrack(cues, via) {
    if (!Array.isArray(cues) || cues.length === 0) return;
    directSinhalaCues = cues.slice().sort((a, b) => a.start - b.start);
    directSinhalaVia = via || "YouTube Native (YT Pkg)";
    lastDirectSiLine = "";
    syncDirectSinhalaTrack();
  }

  window.__kxReceiveDirectSinhalaTrack = function (payload) {
    try {
      const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (obj && Array.isArray(obj.cues)) {
        ingestDirectSinhalaTrack(obj.cues, "YouTube Native (YT Pkg)");
      }
    } catch (e) {}
  };

  window.__kxOnTranslateResult = function (reqId, translated) {
    const cb = pendingSingle.get(reqId);
    if (cb) {
      pendingSingle.delete(reqId);
      cb(translated || "");
    }
  };

  const origFetch = window.fetch;
  function fetchYouTubeSinhalaDirect(rawUrl) {
    if (!rawUrl || !rawUrl.includes("/api/timedtext")) return;
    const siUrl = toYtSinhalaUrl(rawUrl);
    if (fetchedYtSiUrls.has(siUrl)) return;
    fetchedYtSiUrls.add(siUrl);
    if (fetchedYtSiUrls.size > 40) fetchedYtSiUrls.clear();

    if (typeof origFetch === "function") {
      origFetch(siUrl, { credentials: "include" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((txt) => {
          const cues = parseTimedText(txt);
          if (cues.length > 0) ingestDirectSinhalaTrack(cues, "YouTube Native (YT Pkg)");
        })
        .catch(() => {});
    }
  }

  function handleTimedTextCapture(url, rawText) {
    if (!url || !url.includes("/api/timedtext")) return;
    if (isAlreadySinhalaYtUrl(url)) {
      const cues = parseTimedText(rawText);
      if (cues.length > 0) ingestDirectSinhalaTrack(cues, "YouTube Native (YT Pkg)");
      return;
    }
    fetchYouTubeSinhalaDirect(url);
  }

  // Hook fetch & XHR for YouTube /api/timedtext
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (url.includes("/api/timedtext")) {
          res.clone().text().then((txt) => handleTimedTextCapture(url, txt)).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url, ...rest) {
    this.__kxUrl = typeof url === "string" ? url : "";
    return origOpen.call(this, m, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__kxUrl || this.responseURL || "";
        if (url.includes("/api/timedtext") && typeof this.responseText === "string") {
          handleTimedTextCapture(url, this.responseText);
        }
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

  function isYouTubeCcOff() {
    const btn = document.querySelector(".ytp-subtitles-button, button.ytm-closed-captioning-button, button[aria-label*='Captions']");
    return !!(btn && btn.getAttribute("aria-pressed") === "false");
  }

  function syncDirectSinhalaTrack() {
    if (!ccEnabled || directSinhalaCues.length === 0 || !window.KillerX) return;
    if (!location.hostname.includes("youtube.com")) return;

    if (isYouTubeCcOff()) {
      if (lastDirectSiLine !== "") {
        lastDirectSiLine = "";
        window.KillerX.hideSubtitle();
      }
      return;
    }

    const v = getMainVideo();
    if (!v) return;

    let currentOrig = "";
    const ytSegs = document.querySelectorAll(".ytp-caption-segment");
    if (ytSegs.length > 0) {
      currentOrig = Array.from(ytSegs).map((e) => (e.textContent || "").trim()).filter(Boolean).join(" ");
    }

    const now = v.currentTime;
    const lines = [];
    for (let i = 0; i < directSinhalaCues.length; i++) {
      const c = directSinhalaCues[i];
      if (now >= c.start - 0.15 && now <= c.end + 0.15) {
        if (!lines.includes(c.text)) lines.push(c.text);
      } else if (c.start > now + 1) break;
    }

    const combined = lines.join(" ").trim();
    if (combined) {
      if (combined !== lastDirectSiLine) {
        lastDirectSiLine = combined;
        window.KillerX.showSubtitle(combined, currentOrig, directSinhalaVia);
      }
    } else if (lastDirectSiLine !== "") {
      lastDirectSiLine = "";
      window.KillerX.hideSubtitle();
    }
  }

  // Fallback DOM CC reader when YT Package Mode is OFF and direct track isn't loaded
  function readDomFallback() {
    if (!ccEnabled || !window.KillerX) return;
    if (directSinhalaCues.length > 0 || ytPackageMode) return;
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (segs.length === 0) return;
    const clean = cleanCue(Array.from(segs).map((e) => e.textContent || "").join(" "));
    if (!clean || clean === lastOriginalText) return;
    lastOriginalText = clean;

    if (/[\u0D80-\u0DFF]/.test(clean)) {
      window.KillerX.showSubtitle(clean, "", "YouTube Sinhala CC");
      return;
    }
    if (localCache.has(clean)) {
      window.KillerX.showSubtitle(localCache.get(clean), clean, "YouTube CC (0ms)");
      return;
    }
    const id = reqSeq++;
    pendingSingle.set(id, (translated) => {
      if (translated) {
        cachePut(clean, translated);
        if (lastOriginalText === clean) window.KillerX.showSubtitle(translated, clean, "YouTube CC");
      }
    });
    window.KillerX.translateSingle(id, clean);
  }

  // Reset subtitle state on YouTube SPA video navigation
  function checkNavigation() {
    if (location.href !== lastPageUrl) {
      lastPageUrl = location.href;
      directSinhalaCues = [];
      lastDirectSiLine = "";
      lastOriginalText = "";
      fetchedYtSiUrls.clear();
      if (window.KillerX) window.KillerX.hideSubtitle();
    }
  }

  setInterval(checkNavigation, 350);
  setInterval(reportMediaState, 600);
  setInterval(syncDirectSinhalaTrack, 120);
  setInterval(readDomFallback, 150);
})();
