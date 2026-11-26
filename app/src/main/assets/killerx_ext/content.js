(() => {
  if (window.__kxGeckoContentLoaded) return;
  window.__kxGeckoContentLoaded = true;

  let config = {
    ccEnabled: true,
    ytPackageMode: true,
    dualSub: false,
    adShield: true,
    bgPlayEnabled: true
  };

  let bgPort = null;
  let inPipMode = false;
  let userPaused = false;
  let autoResumeGuardUntil = 0;
  let lastUserPointerTime = 0;

  function postBg(msg) {
    if (!bgPort) {
      connectBg();
      return;
    }
    try {
      bgPort.postMessage(msg);
    } catch (e) {
      bgPort = null;
      connectBg();
    }
  }

  function connectBg() {
    if (bgPort) return;
    try {
      const p = browser.runtime.connect({ name: "yt-content" });
      bgPort = p;
      p.onMessage.addListener(handleBgMessage);
      p.onDisconnect.addListener(() => {
        if (bgPort === p) bgPort = null;
        setTimeout(connectBg, 700);
      });
    } catch (e) {
      bgPort = null;
      setTimeout(connectBg, 700);
    }
  }
  connectBg();

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
    const root = document.head || document.documentElement;
    if (!root) return;

    const existing = document.getElementById("kx-adblock-css");
    if (!config.adShield) {
      if (existing) existing.remove();
    } else if (!existing) {
      const style = document.createElement("style");
      style.id = "kx-adblock-css";
      style.textContent = AD_CSS;
      root.appendChild(style);
    }
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
  // 5. LIVE YOUTUBE SUBTITLE TRANSLATOR (PLAYS YOUR CHOSEN YT LANGUAGE -> SINHALA CC!)
  // =========================================================================
  const localCache = new Map();
  const MAX_LOCAL_CACHE = 2000;
  const pendingTranslates = new Map();

  let reqSeq = 1;
  let latestSentReqId = 0;
  let lastSeenRawText = "";
  let lastShownSi = "";
  let lastActiveVideoId = "";
  let lastNonEmptyCaptionMs = 0;
  let lastTranslateDispatchMs = 0;
  let debounceTimer = null;
  let translatedLineCount = 0;
  let observedCaptionRoot = null;
  let captionObserver = null;

  function cachePut(orig, si) {
    if (!orig || !si) return;
    if (localCache.size >= MAX_LOCAL_CACHE) {
      const oldest = localCache.keys().next().value;
      if (oldest !== undefined) localCache.delete(oldest);
    }
    localCache.set(orig, si);
  }

  function getCurrentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v") || "";
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
    } catch (e) {}
    return "";
  }

  function readVisibleYouTubeCaption() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs || segs.length === 0) return "";
    const parts = [];
    for (let i = 0; i < segs.length; i++) {
      const t = (segs[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function showTranslatedLine(siText, origText, mode) {
    if (!config.ccEnabled || !siText) return;
    lastShownSi = siText;
    postBg({
      type: "showSubtitle",
      si: siText,
      orig: origText || "",
      mode: mode || "Live Sinhala CC"
    });
  }

  function dispatchTranslation(cleanText) {
    if (!config.ccEnabled || !cleanText) return;
    lastTranslateDispatchMs = Date.now();

    // Already Sinhala -> show directly
    if (/[\u0D80-\u0DFF]/.test(cleanText)) {
      showTranslatedLine(cleanText, "", "YouTube Sinhala CC");
      return;
    }

    // Local 0ms cache hit
    if (localCache.has(cleanText)) {
      showTranslatedLine(localCache.get(cleanText), cleanText, "Live Sinhala CC (0ms)");
      return;
    }

    const id = reqSeq++;
    latestSentReqId = id;
    pendingTranslates.set(id, { text: cleanText });

    // Clean up stale entries if map ever grows
    if (pendingTranslates.size > 40) {
      const firstKey = pendingTranslates.keys().next().value;
      if (firstKey !== undefined) pendingTranslates.delete(firstKey);
    }

    postBg({ type: "translateSingle", reqId: id, text: cleanText });
  }

  function scanYouTubeCaptions() {
    if (!config.ccEnabled) return;

    const clean = readVisibleYouTubeCaption();
    const now = Date.now();

    if (!clean) {
      // Only hide our Sinhala overlay if YouTube captions have stayed empty for >1.2 seconds (prevents flicker!)
      if (lastShownSi !== "" && lastNonEmptyCaptionMs > 0 && now - lastNonEmptyCaptionMs > 1200) {
        lastSeenRawText = "";
        lastShownSi = "";
        postBg({ type: "hideSubtitle" });
      }
      return;
    }

    lastNonEmptyCaptionMs = now;
    if (clean === lastSeenRawText) return;
    lastSeenRawText = clean;

    // Instant display for Sinhala or cached lines (0ms)
    if (/[\u0D80-\u0DFF]/.test(clean) || localCache.has(clean)) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      dispatchTranslation(clean);
      return;
    }

    // Smart anti-flicker debounce for rolling auto-generated captions:
    // Waits 110ms so multi-segment updates coalesce, OR dispatches immediately if >420ms elapsed since last call!
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (now - lastTranslateDispatchMs > 420) {
      dispatchTranslation(clean);
    } else {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (lastSeenRawText) {
          dispatchTranslation(lastSeenRawText);
        }
      }, 110);
    }
  }

  // Attach MutationObserver directly to YouTube's caption container for instant reaction!
  function ensureCaptionObserver() {
    const target = document.querySelector(".ytp-caption-window-container, #movie_player, .html5-video-player");
    if (!target || target === observedCaptionRoot) return;

    if (captionObserver) {
      try { captionObserver.disconnect(); } catch (e) {}
    }
    observedCaptionRoot = target;
    captionObserver = new MutationObserver(() => {
      scanYouTubeCaptions();
    });
    try {
      captionObserver.observe(target, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
  }

  function checkNavigation() {
    const vid = getCurrentVideoId();
    if (vid !== lastActiveVideoId) {
      lastActiveVideoId = vid;
      lastSeenRawText = "";
      lastShownSi = "";
      lastNonEmptyCaptionMs = 0;
      translatedLineCount = 0;
      userPaused = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      postBg({ type: "hideSubtitle" });
      ensureCaptionObserver();
    }
  }

  window.addEventListener("yt-navigate-finish", () => {
    checkNavigation();
    setTimeout(ensureCaptionObserver, 400);
  }, true);
  window.addEventListener("popstate", () => {
    setTimeout(checkNavigation, 150);
  }, true);

  function handleBgMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config" && msg.config) {
      config = Object.assign(config, msg.config);
      ensureAdCss();
      if (!config.ccEnabled) {
        lastSeenRawText = "";
        lastShownSi = "";
        postBg({ type: "hideSubtitle" });
      }
    } else if (msg.type === "resync") {
      checkNavigation();
      lastSeenRawText = "";
      ensureCaptionObserver();
      scanYouTubeCaptions();
    } else if (msg.type === "mediaControl" && msg.cmd) {
      handleMediaControl(msg.cmd);
    } else if (msg.type === "setPip") {
      setPipCss(!!msg.inPip);
    } else if (msg.type === "translateResult") {
      const entry = pendingTranslates.get(msg.reqId);
      pendingTranslates.delete(msg.reqId);
      const origText = (entry && entry.text) || msg.text || "";
      const translated = (msg.translated || "").trim();
      if (translated && origText) {
        cachePut(origText, translated);
        translatedLineCount++;
        postBg({ type: "trackLoaded", count: translatedLineCount });
        // Show if this is the latest caption or the latest request
        if (origText === lastSeenRawText || msg.reqId >= latestSentReqId) {
          showTranslatedLine(translated, origText, "Live Sinhala CC");
        }
      }
    }
  }

  setInterval(checkNavigation, 300);
  setInterval(ensureCaptionObserver, 1000);
  setInterval(attachAntiAutoPauseGuard, 500);
  setInterval(skipYouTubeAds, 250);
  setInterval(reportMediaState, 500);
  setInterval(scanYouTubeCaptions, 100);
})();
