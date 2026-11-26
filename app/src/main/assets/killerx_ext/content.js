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
  const pendingTranslates = new Map();
  let reqSeq = 1;

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
  // 2. COSMETIC AD HIDER + YOUTUBE VIDEO AD AUTO-SKIPPER + SAFE CAPTION CSS
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

  // ONLY hides YouTube's built-in caption box visually when html.kx-si-active is set
  // (meaning Killer X YT's Sinhala overlay is ACTIVELY showing Sinhala text!)
  const SAFE_CC_DEDUP_CSS = `
    html.kx-si-active .ytp-caption-window-container,
    html.kx-si-active .caption-window {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;

  let lastActiveSinhalaMs = 0;

  function setDuplicateHideActive(active) {
    const el = document.documentElement;
    if (!el) return;
    if (active && config.ccEnabled && !config.dualSub) {
      lastActiveSinhalaMs = Date.now();
      el.classList.add("kx-si-active");
    } else {
      el.classList.remove("kx-si-active");
    }
  }

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

    if (!document.getElementById("kx-cc-dedup-css")) {
      const style = document.createElement("style");
      style.id = "kx-cc-dedup-css";
      style.textContent = SAFE_CC_DEDUP_CSS;
      root.appendChild(style);
    }

    // Auto-clear kx-si-active if no Sinhala subtitle was shown recently or if Dual Subtitles / CC OFF
    if (!config.ccEnabled || config.dualSub || (lastActiveSinhalaMs > 0 && Date.now() - lastActiveSinhalaMs > 7000)) {
      document.documentElement.classList.remove("kx-si-active");
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
      applyNativeYouTubeSinhala();
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
  // 5. NATIVE YOUTUBE PLAYER AUTO-TRANSLATE ENGINE (0 KB ANYTIME DATA + VALID POT!)
  // =========================================================================
  let directSinhalaCues = [];
  let directSinhalaVideoId = "";
  let lastSiLine = "";
  let lastDomText = "";
  let lastActiveVideoId = "";
  let nativeTranslateAttempts = 0;
  let lastNativeTranslateTime = 0;
  let nativeTranslateConfirmedVid = "";
  let reportedDomTrackVid = "";

  function getCurrentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v") || "";
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || "";
    } catch (e) {}
    return "";
  }

  function toPageObject(obj) {
    const pageWin = window.wrappedJSObject || window;
    if (typeof cloneInto === "function") {
      return cloneInto(obj, pageWin);
    }
    return obj;
  }

  function getYouTubePlayer() {
    const el = document.querySelector("#movie_player, .html5-video-player");
    if (!el) return null;
    return el.wrappedJSObject || el;
  }

  function isTrackAlreadySinhala(track) {
    if (!track) return false;
    try {
      if (String(track.languageCode || "").toLowerCase() === "si") return true;
      const tl = track.translationLanguage;
      if (tl && String(tl.languageCode || "").toLowerCase() === "si") return true;
    } catch (e) {}
    return false;
  }

  function cloneTrackFields(t) {
    const out = {};
    if (!t) return out;
    const keys = ["languageCode", "vss_id", "vssId", "kind", "id", "name", "displayName", "is_translateable", "isTranslatable"];
    for (const k of keys) {
      try {
        const val = t[k];
        if (typeof val === "string" || typeof val === "boolean" || typeof val === "number") {
          out[k] = val;
        }
      } catch (e) {}
    }
    return out;
  }

  function findSinhalaTranslationOption(player) {
    const fallback = { languageCode: "si", languageName: "Sinhala" };
    try {
      const langs = player.getOption("captions", "translationLanguages");
      if (langs && langs.length > 0) {
        for (let i = 0; i < langs.length; i++) {
          const item = langs[i];
          if (item && String(item.languageCode || "").toLowerCase() === "si") {
            const nameVal = item.languageName;
            if (typeof nameVal === "string" && nameVal) {
              return { languageCode: "si", languageName: nameVal };
            }
            if (nameVal && typeof nameVal.simpleText === "string") {
              return { languageCode: "si", languageName: nameVal.simpleText };
            }
            return fallback;
          }
        }
      }
    } catch (e) {}
    return fallback;
  }

  // Uses YouTube's OWN HTML5 player API to enable Auto-Translate -> Sinhala!
  // YouTube's own player generates valid POT tokens & fetches from m.youtube.com (0 KB Anytime Data!)
  function applyNativeYouTubeSinhala() {
    if (!config.ccEnabled || !config.ytPackageMode) return;
    const vid = getCurrentVideoId();
    if (!vid) return;
    if (nativeTranslateConfirmedVid === vid) return;
    if (directSinhalaVideoId === vid && directSinhalaCues.length > 0) return;

    const now = Date.now();
    if (nativeTranslateAttempts >= 14) return;
    if (now - lastNativeTranslateTime < 900) return;

    const player = getYouTubePlayer();
    if (!player || typeof player.getOption !== "function" || typeof player.setOption !== "function") {
      return;
    }

    lastNativeTranslateTime = now;
    nativeTranslateAttempts++;

    try {
      // Ensure captions module is loaded in YouTube's player
      if (typeof player.loadModule === "function") {
        player.loadModule("captions");
      }

      // Check if player is ALREADY set to Sinhala!
      const curTrack = player.getOption("captions", "track");
      if (isTrackAlreadySinhala(curTrack)) {
        if (typeof player.toggleSubtitlesOn === "function") {
          try { player.toggleSubtitlesOn(); } catch (e) {}
        }
        nativeTranslateConfirmedVid = vid;
        return;
      }

      // Read available caption tracks (including auto-generated ASR tracks!)
      let tracklist = null;
      try {
        tracklist = player.getOption("captions", "tracklist", toPageObject({ includeAsr: true }));
      } catch (e) {}
      if (!tracklist || tracklist.length === 0) {
        try {
          tracklist = player.getOption("captions", "tracklist");
        } catch (e) {}
      }

      // If tracklist isn't loaded yet, turn on captions once to wake up the captions module
      if (!tracklist || tracklist.length === 0) {
        if (typeof player.toggleSubtitlesOn === "function") {
          try { player.toggleSubtitlesOn(); } catch (e) {}
        }
        return;
      }

      // 1. Check if video already has a native Sinhala track
      let nativeSi = null;
      let bestSource = null;
      let firstTrack = null;

      for (let i = 0; i < tracklist.length; i++) {
        const t = tracklist[i];
        if (!t || !t.languageCode) continue;
        const code = String(t.languageCode).toLowerCase();
        if (!firstTrack) firstTrack = t;
        if (code === "si") {
          nativeSi = t;
          break;
        }
        if (!bestSource && code.startsWith("en")) {
          bestSource = t;
        }
      }

      if (nativeSi) {
        const target = cloneTrackFields(nativeSi);
        player.setOption("captions", "track", toPageObject(target));
        if (typeof player.toggleSubtitlesOn === "function") {
          try { player.toggleSubtitlesOn(); } catch (e) {}
        }
        return;
      }

      // 2. Otherwise use currently active track (if any), else English, else first available track + Auto-Translate to Sinhala!
      const chosenBase = (curTrack && curTrack.languageCode) ? curTrack : (bestSource || firstTrack);
      if (!chosenBase) return;

      const siLangObj = findSinhalaTranslationOption(player);
      const target = cloneTrackFields(chosenBase);
      target.translationLanguage = siLangObj;

      player.setOption("captions", "track", toPageObject(target));
      if (typeof player.toggleSubtitlesOn === "function") {
        try { player.toggleSubtitlesOn(); } catch (e) {}
      }

      // Verify after setting
      const updated = player.getOption("captions", "track");
      if (isTrackAlreadySinhala(updated)) {
        nativeTranslateConfirmedVid = vid;
      }
    } catch (e) {}
  }

  function applyDirectCues(videoId, cues) {
    const curVid = getCurrentVideoId();
    if (!Array.isArray(cues) || cues.length === 0) return;
    if (videoId && curVid && videoId !== curVid) return;

    if (curVid) lastActiveVideoId = curVid;
    directSinhalaVideoId = videoId || curVid;
    directSinhalaCues = cues.slice().sort((a, b) => a.start - b.start);
    lastSiLine = "";
    postBg({ type: "trackLoaded", count: cues.length });
    syncDirectTrack();
  }

  function syncDirectTrack() {
    if (!config.ccEnabled || directSinhalaCues.length === 0) return;
    const vid = getCurrentVideoId();
    if (!vid || (directSinhalaVideoId && directSinhalaVideoId !== vid)) return;

    const v = getMainVideo();
    if (!v) return;

    let currentOrig = "";
    const ytSegs = document.querySelectorAll(".ytp-caption-segment");
    if (ytSegs.length > 0) {
      const txt = Array.from(ytSegs).map((e) => (e.textContent || "").trim()).filter(Boolean).join(" ");
      if (txt && !/[\u0D80-\u0DFF]/.test(txt)) {
        currentOrig = txt;
      }
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
      setDuplicateHideActive(true);
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

  function readDomSubtitles() {
    if (!config.ccEnabled || directSinhalaCues.length > 0) return;
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (segs.length === 0) {
      if (lastDomText !== "") {
        lastDomText = "";
        postBg({ type: "hideSubtitle" });
      }
      return;
    }

    const clean = Array.from(segs).map((e) => (e.textContent || "").trim()).filter(Boolean).join(" ").trim();
    if (!clean) return;

    // 1. Sinhala text rendered natively by YouTube player (via Auto-Translate -> Sinhala, 0 KB Anytime Data!)
    if (/[\u0D80-\u0DFF]/.test(clean)) {
      const vid = getCurrentVideoId();
      if (vid && reportedDomTrackVid !== vid) {
        reportedDomTrackVid = vid;
        nativeTranslateConfirmedVid = vid;
        postBg({ type: "trackLoaded", count: 1 });
      }
      setDuplicateHideActive(true);
      if (clean !== lastDomText) {
        lastDomText = clean;
        postBg({ type: "showSubtitle", si: clean, orig: "", mode: "YouTube Native (YT Pkg)" });
      }
      return;
    }

    // 2. Non-Sinhala text visible in YouTube player:
    //    NEVER hide YouTube's caption box until Sinhala is actually active!
    if (config.ytPackageMode) {
      setDuplicateHideActive(false);
      // Re-arm native YouTube Sinhala switch if player fell back to non-Sinhala
      const vid = getCurrentVideoId();
      if (vid && nativeTranslateConfirmedVid === vid) {
        nativeTranslateConfirmedVid = "";
        nativeTranslateAttempts = Math.min(nativeTranslateAttempts, 10);
      }
      applyNativeYouTubeSinhala();
      return;
    }

    // 3. Package Mode OFF: translate via Google Translate fallback
    if (clean === lastDomText) return;
    lastDomText = clean;
    const id = reqSeq++;
    pendingTranslates.set(id, (translated) => {
      if (translated && lastDomText === clean) {
        postBg({ type: "showSubtitle", si: translated, orig: clean, mode: "YouTube CC" });
      }
    });
    postBg({ type: "translateSingle", reqId: id, text: clean });
  }

  function checkNavigation() {
    const vid = getCurrentVideoId();
    if (vid !== lastActiveVideoId) {
      lastActiveVideoId = vid;
      nativeTranslateAttempts = 0;
      lastNativeTranslateTime = 0;
      nativeTranslateConfirmedVid = "";
      reportedDomTrackVid = "";
      setDuplicateHideActive(false);

      if (directSinhalaVideoId !== vid) {
        directSinhalaCues = [];
        directSinhalaVideoId = "";
        lastSiLine = "";
        lastDomText = "";
        postBg({ type: "clearTrack", videoId: vid });
        postBg({ type: "hideSubtitle" });
      }
      userPaused = false;
      if (vid && config.ytPackageMode) {
        setTimeout(applyNativeYouTubeSinhala, 450);
      }
    }
  }

  window.addEventListener("yt-navigate-finish", () => {
    checkNavigation();
    setTimeout(applyNativeYouTubeSinhala, 600);
  }, true);
  window.addEventListener("popstate", () => {
    setTimeout(checkNavigation, 150);
  }, true);

  function handleBgMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config" && msg.config) {
      const prevPkg = config.ytPackageMode;
      config = Object.assign(config, msg.config);
      ensureAdCss();

      if (!config.ccEnabled) {
        lastSiLine = "";
        lastDomText = "";
        setDuplicateHideActive(false);
        postBg({ type: "hideSubtitle" });
      } else if (config.ytPackageMode && !prevPkg) {
        nativeTranslateAttempts = 0;
        lastNativeTranslateTime = 0;
        nativeTranslateConfirmedVid = "";
        applyNativeYouTubeSinhala();
      } else if (!config.ytPackageMode && prevPkg) {
        setDuplicateHideActive(false);
        lastDomText = "";
      }
    } else if (msg.type === "resync") {
      checkNavigation();
      lastSiLine = "";
      lastDomText = "";
      const vid = getCurrentVideoId();
      if (vid && directSinhalaVideoId === vid && directSinhalaCues.length > 0) {
        postBg({ type: "trackLoaded", count: directSinhalaCues.length });
        syncDirectTrack();
      } else if (vid && config.ytPackageMode) {
        nativeTranslateAttempts = 0;
        lastNativeTranslateTime = 0;
        nativeTranslateConfirmedVid = "";
        applyNativeYouTubeSinhala();
      }
    } else if (msg.type === "directSinhalaTrack" && Array.isArray(msg.cues) && msg.cues.length > 0) {
      checkNavigation();
      applyDirectCues(msg.videoId || getCurrentVideoId(), msg.cues);
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

  setInterval(checkNavigation, 300);
  setInterval(attachAntiAutoPauseGuard, 500);
  setInterval(applyNativeYouTubeSinhala, 1100);
  setInterval(skipYouTubeAds, 250);
  setInterval(reportMediaState, 500);
  setInterval(syncDirectTrack, 120);
  setInterval(readDomSubtitles, 140);
})();
