(() => {
  if (window.__kxGeckoContentLoaded) return;
  window.__kxGeckoContentLoaded = true;

  let config = {
    ccEnabled: true,
    ytPackageMode: true,
    adShield: true,
    bgPlayEnabled: true
  };

  let bgPort = null;
  let inPipMode = false;
  let userPaused = false;
  let autoResumeGuardUntil = 0;
  let lastUserPointerTime = 0;
  const pendingTranslates = new Map();
  let reqSeq = 1;

  function postBg(msg) {
    if (!bgPort) return;
    try {
      bgPort.postMessage(msg);
    } catch (e) {}
  }

  function connectBg() {
    if (bgPort) return;
    try {
      const p = browser.runtime.connect({ name: "yt-content" });
      bgPort = p;
      p.onMessage.addListener(handleBgMessage);
      p.onDisconnect.addListener(() => {
        if (bgPort === p) bgPort = null;
        setTimeout(connectBg, 800);
      });
    } catch (e) {
      bgPort = null;
      setTimeout(connectBg, 800);
    }
  }
  connectBg();

  // Track real taps on screen so manual pause on the video player ALWAYS works
  ["touchstart", "pointerdown", "mousedown"].forEach((ev) => {
    window.addEventListener(ev, () => {
      lastUserPointerTime = Date.now();
    }, true);
  });

  // =========================================================================
  // 1. TRUE BACKGROUND, SCREEN-OFF & PiP PLAY ENGINE
  // =========================================================================
  try {
    const pageWin = window.wrappedJSObject || window;
    const pageDoc = document.wrappedJSObject || document;
    const docProto = pageWin.Document && pageWin.Document.prototype;

    const getHidden = typeof exportFunction === "function"
      ? exportFunction(() => false, pageWin)
      : () => false;
    const getVis = typeof exportFunction === "function"
      ? exportFunction(() => "visible", pageWin)
      : () => "visible";

    if (docProto) {
      try { Object.defineProperty(docProto, "hidden", { get: getHidden, configurable: true }); } catch (e) {}
      try { Object.defineProperty(docProto, "webkitHidden", { get: getHidden, configurable: true }); } catch (e) {}
      try { Object.defineProperty(docProto, "visibilityState", { get: getVis, configurable: true }); } catch (e) {}
      try { Object.defineProperty(docProto, "webkitVisibilityState", { get: getVis, configurable: true }); } catch (e) {}
    }
    try { Object.defineProperty(pageDoc, "hidden", { get: getHidden, configurable: true }); } catch (e) {}
    try { Object.defineProperty(pageDoc, "visibilityState", { get: getVis, configurable: true }); } catch (e) {}
  } catch (e) {}

  ["visibilitychange", "webkitvisibilitychange", "pagehide", "freeze", "blur"].forEach((evName) => {
    window.addEventListener(evName, (e) => {
      if (config.bgPlayEnabled || inPipMode) e.stopImmediatePropagation();
    }, true);
    document.addEventListener(evName, (e) => {
      if (config.bgPlayEnabled || inPipMode) e.stopImmediatePropagation();
    }, true);
  });

  // Auto-dismiss YouTube "Video paused. Continue watching?" prompt
  setInterval(() => {
    if (!config.bgPlayEnabled && !inPipMode) return;
    document.querySelectorAll("yt-confirm-dialog-renderer, .yt-confirm-dialog-renderer, ytm-confirm-dialog-renderer").forEach((dlg) => {
      const txt = (dlg.innerText || "").toLowerCase();
      if (txt.includes("continue watching") || txt.includes("video paused")) {
        const btn = dlg.querySelector("button[aria-label*='Yes'], button[aria-label*='Continue'], #confirm-button button, .yt-spec-button-shape-next");
        if (btn) btn.click();
      }
    });
  }, 2500);

  // =========================================================================
  // 2. COSMETIC AD HIDER + YOUTUBE VIDEO AD AUTO-SKIPPER
  // =========================================================================
  const AD_CSS = `
    ytd-ad-slot-renderer,
    ytd-banner-promo-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-display-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-action-companion-ad-renderer,
    ytm-promoted-sparkles-web-renderer,
    ytm-promoted-sparkles-text-search-renderer,
    ytm-companion-ad-renderer,
    ytm-statement-banner-renderer,
    ytm-mealbar-promo-renderer,
    ad-slot-renderer,
    .ad-container,
    .ytp-ad-overlay-container,
    .ytp-ad-text-overlay,
    .ytp-ad-image-overlay,
    .ytp-ad-message-container,
    .ytp-ad-preview-container,
    #player-ads,
    #masthead-ad,
    .ad-interrupting .ytp-ad-module {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      pointer-events: none !important;
    }
  `;

  function ensureAdCss() {
    const existing = document.getElementById("kx-adblock-css");
    if (!config.adShield) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    const style = document.createElement("style");
    style.id = "kx-adblock-css";
    style.textContent = AD_CSS;
    root.appendChild(style);
  }

  let wasMutedByAd = false;
  function skipYouTubeAds() {
    ensureAdCss();
    if (!config.adShield) return;

    const player = document.querySelector(".html5-video-player");
    const video = document.querySelector("video.html5-main-video, video");
    const isAd =
      (player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"))) ||
      !!document.querySelector(".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-survey");

    if (isAd) {
      const skipSelectors = [
        ".ytp-skip-ad-button",
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        ".ytp-ad-skip-button-container button",
        "button[id^='skip-button']"
      ];
      for (const sel of skipSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          postBg({ type: "adBlocked" });
        }
      }
      if (video) {
        if (!video.muted) {
          video.muted = true;
          wasMutedByAd = true;
        }
        try {
          if (Number.isFinite(video.duration) && video.duration > 0.5 && video.currentTime < video.duration - 0.15) {
            video.currentTime = video.duration;
          } else {
            video.playbackRate = 16;
          }
        } catch (e) {}
      }
    } else if (wasMutedByAd && video) {
      video.muted = false;
      video.playbackRate = 1;
      wasMutedByAd = false;
    }

    document.querySelectorAll("ytd-enforcement-message-view-model, tp-yt-paper-dialog, ytm-upsell-dialog-renderer").forEach((dlg) => {
      const txt = (dlg.innerText || "").toLowerCase();
      if (txt.includes("ad blocker") || txt.includes("open app") || txt.includes("youtube premium")) {
        dlg.remove();
      }
    });
  }

  // =========================================================================
  // 3. PICTURE-IN-PICTURE (PiP) CLEAN VIDEO FIT + ANTI-AUTOPAUSE GUARD
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

  const guardedVideos = new WeakSet();
  function attachAntiAutoPauseGuard() {
    const v = getMainVideo();
    if (!v || guardedVideos.has(v)) return;
    guardedVideos.add(v);

    v.addEventListener("play", () => {
      userPaused = false;
      reportMediaState();
    });

    v.addEventListener("pause", () => {
      const recentTap = Date.now() - lastUserPointerTime < 900;
      // If YouTube's background/PiP script forcefully pauses the video without user input, immediately resume!
      if (!userPaused && !recentTap && !v.ended && (inPipMode || Date.now() < autoResumeGuardUntil)) {
        setTimeout(() => {
          if (!userPaused && v.paused && !v.ended) {
            v.play().catch(() => {});
          }
        }, 60);
      } else {
        if (recentTap) userPaused = true;
        reportMediaState();
      }
    });
  }

  function setPipCss(inPip) {
    inPipMode = !!inPip;
    let style = document.getElementById("kx-pip-fit-css");
    if (inPip) {
      autoResumeGuardUntil = Date.now() + 4000;
      if (!style) {
        style = document.createElement("style");
        style.id = "kx-pip-fit-css";
        style.textContent = `
          html, body { overflow: hidden !important; background: #000 !important; margin: 0 !important; padding: 0 !important; }
          ytm-mobile-topbar-renderer, header, .mobile-topbar-header, ytm-watch-metadata, ytm-item-section-renderer, ytm-pivot-bar-renderer, #below, #secondary { display: none !important; }
          #player-container-id, .player-container, #movie_player, .html5-video-player {
            position: fixed !important; top: 0 !important; left: 0 !important;
            width: 100vw !important; height: 100vh !important; max-height: 100vh !important;
            z-index: 99999 !important; background: #000 !important;
          }
          video.html5-main-video, video {
            width: 100vw !important; height: 100vh !important; object-fit: contain !important;
            top: 0 !important; left: 0 !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }
      window.scrollTo(0, 0);
      const v = getMainVideo();
      if (v && !userPaused && v.paused && !v.ended) {
        v.play().catch(() => {});
      }
    } else if (style) {
      style.remove();
    }
  }

  // =========================================================================
  // 4. MEDIA CONTROLS & LOCK SCREEN STATE REPORTER
  // =========================================================================
  function getVideoTitle() {
    const sels = [
      "h2.slim-video-information-title",
      ".slim-video-information-title",
      "ytm-slim-video-metadata-section-renderer h2",
      "h1.ytd-watch-metadata"
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = (el && (el.innerText || el.textContent) || "").trim();
      if (t) return t;
    }
    return (document.title || "").replace(/\s*-\s*YouTube$/i, "").trim() || "Killer X YT";
  }

  function handleMediaControl(cmd) {
    const v = getMainVideo();
    if (cmd === "play") {
      userPaused = false;
      autoResumeGuardUntil = Date.now() + 3500;
      if (v && v.paused) v.play().catch(() => {});
    } else if (cmd === "toggle") {
      if (v) {
        if (v.paused) {
          userPaused = false;
          autoResumeGuardUntil = Date.now() + 3500;
          v.play().catch(() => {});
        } else {
          userPaused = true;
          v.pause();
        }
      }
    } else if (cmd === "pause" || cmd === "stop") {
      userPaused = true;
      if (v && !v.paused) v.pause();
    } else if (cmd === "next") {
      userPaused = false;
      const nextBtn = document.querySelector(".ytp-next-button, button[aria-label*='Next video'], a.ytp-next-button");
      if (nextBtn) nextBtn.click();
      else if (v) v.currentTime = Math.min(v.duration || v.currentTime + 15, v.currentTime + 15);
    } else if (cmd === "prev") {
      userPaused = false;
      if (v && v.currentTime > 5) v.currentTime = 0;
      else {
        const prevBtn = document.querySelector(".ytp-prev-button, button[aria-label*='Previous video']");
        if (prevBtn) prevBtn.click();
        else history.back();
      }
    }
    setTimeout(reportMediaState, 120);
  }

  let lastPlaying = null;
  let lastTitle = "";
  function reportMediaState() {
    const v = getMainVideo();
    const playing = !!(v && !v.paused && !v.ended && v.readyState >= 2);
    const title = getVideoTitle();
    if (playing !== lastPlaying || title !== lastTitle) {
      lastPlaying = playing;
      lastTitle = title;
      postBg({ type: "mediaState", playing, title });
    }
  }

  // =========================================================================
  // 5. 0ms SINHALA CC ENGINE (Same-Origin &tlang=si + Player Track Auto-Discovery + DOM Fallback!)
  // =========================================================================
  let directSinhalaCues = [];
  let lastSiLine = "";
  let lastDomText = "";
  let lastUrl = location.href;
  let lastDiscoveredVideoId = "";
  const fetchedUrls = new Set();

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

    if (trimmed.startsWith("WEBVTT") || trimmed.includes("-->")) {
      const lines = trimmed.split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        if (line.includes("-->")) {
          const idx = line.indexOf("-->");
          const start = parseTimestamp(line.slice(0, idx).trim().split(/\s+/)[0]);
          const end = parseTimestamp(line.slice(idx + 3).trim().split(/\s+/)[0]);
          i++;
          const body = [];
          while (i < lines.length && lines[i].trim() !== "") {
            body.push(lines[i].trim());
            i++;
          }
          const text = cleanCue(body.join(" "));
          if (text && Number.isFinite(start)) {
            cues.push({ start, end: Number.isFinite(end) && end > start ? end : start + 4, text });
          }
        } else {
          i++;
        }
      }
      if (cues.length > 0) return cues;
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

  function fetchSinhalaSameOrigin(rawUrl) {
    if (!config.ccEnabled || !rawUrl || !rawUrl.includes("/api/timedtext")) return;
    const siUrl = toYtSinhalaUrl(rawUrl);
    if (fetchedUrls.has(siUrl)) return;
    fetchedUrls.add(siUrl);
    if (fetchedUrls.size > 40) fetchedUrls.clear();

    // Same-origin fetch inside m.youtube.com — includes exact cookies + works on YouTube data packages!
    fetch(siUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((txt) => {
        const cues = parseTimedText(txt);
        if (cues.length > 0) {
          directSinhalaCues = cues.slice().sort((a, b) => a.start - b.start);
          lastSiLine = "";
          postBg({ type: "trackLoaded", count: cues.length });
          syncDirectTrack();
        }
      })
      .catch(() => {});
  }

  // Auto-discover captionTracks straight from YouTube's player object (works even before user taps CC!)
  function getCurrentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v") || "";
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
    } catch (e) {}
    return "";
  }

  function tryDiscoverCaptionTrackFromPlayer() {
    if (!config.ccEnabled || directSinhalaCues.length > 0) return;
    const vid = getCurrentVideoId();
    if (!vid || vid === lastDiscoveredVideoId) return;

    try {
      const pageWin = window.wrappedJSObject || window;
      const player = (document.getElementById("movie_player") || {}).wrappedJSObject;
      let resp = null;
      if (player && typeof player.getPlayerResponse === "function") {
        resp = player.getPlayerResponse();
      }
      if (!resp && pageWin.ytInitialPlayerResponse) {
        resp = pageWin.ytInitialPlayerResponse;
      }

      const tracks = resp &&
        resp.captions &&
        resp.captions.playerCaptionsTracklistRenderer &&
        resp.captions.playerCaptionsTracklistRenderer.captionTracks;

      if (tracks && tracks.length > 0) {
        // Verify track matches current video ID
        const respVid = resp.videoDetails && resp.videoDetails.videoId;
        if (respVid && respVid !== vid) return;

        // Prefer Sinhala -> English -> any available track
        let chosen = null;
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          if (t && t.languageCode === "si") { chosen = t; break; }
        }
        if (!chosen) {
          for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            if (t && t.languageCode && t.languageCode.startsWith("en")) { chosen = t; break; }
          }
        }
        if (!chosen) chosen = tracks[0];

        if (chosen && chosen.baseUrl) {
          lastDiscoveredVideoId = vid;
          fetchSinhalaSameOrigin(chosen.baseUrl);
        }
      }
    } catch (e) {}
  }

  function isYouTubeCcExplicitlyOff() {
    // Only consider CC off if there are NO visible captions AND the button explicitly says aria-pressed="false"
    if (document.querySelector(".ytp-caption-segment")) return false;
    const btn = document.querySelector(".ytp-subtitles-button, button.ytm-closed-captioning-button");
    return !!(btn && btn.getAttribute("aria-pressed") === "false");
  }

  function syncDirectTrack() {
    if (!config.ccEnabled || directSinhalaCues.length === 0) return;

    if (isYouTubeCcExplicitlyOff()) {
      if (lastSiLine !== "") {
        lastSiLine = "";
        postBg({ type: "hideSubtitle" });
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
      if (combined !== lastSiLine) {
        lastSiLine = combined;
        postBg({
          type: "showSubtitle",
          si: combined,
          orig: currentOrig,
          mode: "YouTube Native (YT Pkg)"
        });
      }
    } else if (lastSiLine !== "") {
      lastSiLine = "";
      postBg({ type: "hideSubtitle" });
    }
  }

  function readDomFallback() {
    if (!config.ccEnabled || directSinhalaCues.length > 0) return;
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (segs.length === 0) return;
    const clean = Array.from(segs).map((e) => (e.textContent || "").trim()).filter(Boolean).join(" ").trim();
    if (!clean || clean === lastDomText) return;
    lastDomText = clean;

    // Always display if captions are already Sinhala
    if (/[\u0D80-\u0DFF]/.test(clean)) {
      postBg({ type: "showSubtitle", si: clean, orig: "", mode: "YouTube Sinhala CC" });
      return;
    }

    // If YT Package Mode is OFF, fall back to Google Translate
    if (!config.ytPackageMode) {
      const id = reqSeq++;
      pendingTranslates.set(id, (translated) => {
        if (translated && lastDomText === clean) {
          postBg({ type: "showSubtitle", si: translated, orig: clean, mode: "YouTube CC" });
        }
      });
      postBg({ type: "translateSingle", reqId: id, text: clean });
    }
  }

  function checkNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      directSinhalaCues = [];
      lastSiLine = "";
      lastDomText = "";
      lastDiscoveredVideoId = "";
      fetchedUrls.clear();
      userPaused = false;
      postBg({ type: "clearTrack" });
      postBg({ type: "hideSubtitle" });
    }
  }

  function handleBgMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config" && msg.config) {
      config = Object.assign(config, msg.config);
      ensureAdCss();
      if (!config.ccEnabled) {
        lastSiLine = "";
        postBg({ type: "hideSubtitle" });
      }
    } else if (msg.type === "timedTextUrl" && msg.url) {
      fetchSinhalaSameOrigin(msg.url);
    } else if (msg.type === "directSinhalaTrack" && Array.isArray(msg.cues) && msg.cues.length > 0) {
      directSinhalaCues = msg.cues.slice().sort((a, b) => a.start - b.start);
      lastSiLine = "";
      syncDirectTrack();
    } else if (msg.type === "mediaControl" && msg.cmd) {
      handleMediaControl(msg.cmd);
    } else if (msg.type === "setPip") {
      setPipCss(!!msg.inPip);
    } else if (msg.type === "translateResult") {
      const cb = pendingTranslates.get(msg.reqId);
      if (cb) {
        pendingTranslates.delete(msg.reqId);
        cb(msg.translated || "");
      }
    }
  }

  setInterval(checkNavigation, 350);
  setInterval(attachAntiAutoPauseGuard, 500);
  setInterval(tryDiscoverCaptionTrackFromPlayer, 900);
  setInterval(skipYouTubeAds, 250);
  setInterval(reportMediaState, 500);
  setInterval(syncDirectTrack, 120);
  setInterval(readDomFallback, 160);
})();
