(() => {
  if (window.__kxGeckoContentLoaded) return;
  window.__kxGeckoContentLoaded = true;

  let config = {
    ccEnabled: true,
    ytPackageMode: true,
    adShield: true,
    bgPlayEnabled: true
  };

  browser.runtime.sendMessage({ type: "getConfig" }).then((res) => {
    if (res && res.config) config = Object.assign(config, res.config);
  }).catch(() => {});

  // =========================================================================
  // 1. TRUE BACKGROUND & SCREEN-OFF PLAY (Firefox wrappedJSObject + exportFunction)
  // =========================================================================
  try {
    const pageDoc = document.wrappedJSObject || document;
    const pageWin = window.wrappedJSObject || window;
    const getHidden = typeof exportFunction === "function"
      ? exportFunction(() => (config.bgPlayEnabled ? false : false), pageWin)
      : () => false;
    const getVis = typeof exportFunction === "function"
      ? exportFunction(() => "visible", pageWin)
      : () => "visible";

    Object.defineProperty(pageDoc, "hidden", { get: getHidden, configurable: true });
    Object.defineProperty(pageDoc, "webkitHidden", { get: getHidden, configurable: true });
    Object.defineProperty(pageDoc, "visibilityState", { get: getVis, configurable: true });
    Object.defineProperty(pageDoc, "webkitVisibilityState", { get: getVis, configurable: true });
  } catch (e) {}

  ["visibilitychange", "webkitvisibilitychange", "pagehide", "freeze"].forEach((evName) => {
    window.addEventListener(evName, (e) => {
      if (config.bgPlayEnabled) e.stopImmediatePropagation();
    }, true);
    document.addEventListener(evName, (e) => {
      if (config.bgPlayEnabled) e.stopImmediatePropagation();
    }, true);
  });

  // Auto-dismiss "Video paused. Continue watching?" prompt
  setInterval(() => {
    if (!config.bgPlayEnabled) return;
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
          browser.runtime.sendMessage({ type: "adBlocked" }).catch(() => {});
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
  // 3. PICTURE-IN-PICTURE (PiP) CLEAN VIDEO FIT
  // =========================================================================
  function setPipCss(inPip) {
    let style = document.getElementById("kx-pip-fit-css");
    if (inPip) {
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
    } else if (style) {
      style.remove();
    }
  }

  // =========================================================================
  // 4. MEDIA CONTROLS & LOCK SCREEN STATE REPORTER
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
      if (v && v.currentTime > 5) v.currentTime = 0;
      else {
        const prevBtn = document.querySelector(".ytp-prev-button, button[aria-label*='Previous video']");
        if (prevBtn) prevBtn.click();
        else history.back();
      }
    }
    reportMediaState();
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
      browser.runtime.sendMessage({ type: "mediaState", playing, title }).catch(() => {});
    }
  }

  // =========================================================================
  // 5. 0ms SINHALA CC SYNC ENGINE (Direct YouTube Native + Fallback)
  // =========================================================================
  let directSinhalaCues = [];
  let lastSiLine = "";
  let lastDomText = "";
  let lastUrl = location.href;

  function isYouTubeCcOff() {
    const btn = document.querySelector(".ytp-subtitles-button, button.ytm-closed-captioning-button, button[aria-label*='Captions']");
    return !!(btn && btn.getAttribute("aria-pressed") === "false");
  }

  function syncDirectTrack() {
    if (!config.ccEnabled || directSinhalaCues.length === 0) return;

    if (isYouTubeCcOff()) {
      if (lastSiLine !== "") {
        lastSiLine = "";
        browser.runtime.sendMessage({ type: "hideSubtitle" }).catch(() => {});
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
        browser.runtime.sendMessage({
          type: "showSubtitle",
          si: combined,
          orig: currentOrig,
          mode: "YouTube Native (YT Pkg)"
        }).catch(() => {});
      }
    } else if (lastSiLine !== "") {
      lastSiLine = "";
      browser.runtime.sendMessage({ type: "hideSubtitle" }).catch(() => {});
    }
  }

  function readDomFallback() {
    if (!config.ccEnabled || directSinhalaCues.length > 0 || config.ytPackageMode) return;
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (segs.length === 0) return;
    const clean = Array.from(segs).map((e) => (e.textContent || "").trim()).filter(Boolean).join(" ").trim();
    if (!clean || clean === lastDomText) return;
    lastDomText = clean;

    if (/[\u0D80-\u0DFF]/.test(clean)) {
      browser.runtime.sendMessage({ type: "showSubtitle", si: clean, orig: "", mode: "YouTube Sinhala CC" }).catch(() => {});
      return;
    }

    browser.runtime.sendMessage({ type: "translateSingle", text: clean }).then((res) => {
      if (res && res.translated && lastDomText === clean) {
        browser.runtime.sendMessage({
          type: "showSubtitle",
          si: res.translated,
          orig: clean,
          mode: "YouTube CC"
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  function checkNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      directSinhalaCues = [];
      lastSiLine = "";
      lastDomText = "";
      browser.runtime.sendMessage({ type: "hideSubtitle" }).catch(() => {});
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config" && msg.config) {
      config = Object.assign(config, msg.config);
      ensureAdCss();
      if (!config.ccEnabled) {
        lastSiLine = "";
        browser.runtime.sendMessage({ type: "hideSubtitle" }).catch(() => {});
      }
    } else if (msg.type === "directSinhalaTrack" && Array.isArray(msg.cues)) {
      directSinhalaCues = msg.cues.slice().sort((a, b) => a.start - b.start);
      lastSiLine = "";
      syncDirectTrack();
    } else if (msg.type === "mediaControl" && msg.cmd) {
      handleMediaControl(msg.cmd);
    } else if (msg.type === "setPip") {
      setPipCss(!!msg.inPip);
    }
  });

  setInterval(checkNavigation, 350);
  setInterval(skipYouTubeAds, 250);
  setInterval(reportMediaState, 600);
  setInterval(syncDirectTrack, 120);
  setInterval(readDomFallback, 160);
})();
