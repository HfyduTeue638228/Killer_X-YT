(() => {
  if (window.__kxGeckoContentLoaded) return;
  window.__kxGeckoContentLoaded = true;

  let config = {
    ccEnabled: true,
    ytPackageMode: true,
    dualSub: false,
    adShield: true,
    bgPlayEnabled: true,
    sleepRemainingMin: 0
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
    window.addEventListener(ev, (e) => {
      lastUserPointerTime = Date.now();
      try {
        const tgt = e.target && e.target.closest && e.target.closest(".ytp-subtitles-button, button.ytm-closed-captioning-button");
        if (tgt) {
          const vid = getCurrentVideoId();
          if (vid) userManuallyToggledCcVids.add(vid);
        }
      } catch (err) {}
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
  // 2. OFFICIAL APP UI SKIN + KILLER X YT BRANDING + BULLETPROOF CC/PIP/SLEEP CONTROLS
  // =========================================================================
  const NATIVE_APP_UI_CSS = `
    html, body {
      background-color: #0f0f0f !important;
      overscroll-behavior-y: contain !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    * {
      scrollbar-width: none !important;
      -webkit-touch-callout: none !important;
    }
    *::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    body, button, a, span, div, h1, h2, h3, h4, ytm-rich-item-renderer, ytm-compact-video-renderer {
      -webkit-user-select: none !important;
      user-select: none !important;
    }
    input, textarea, [contenteditable="true"] {
      -webkit-user-select: text !important;
      user-select: text !important;
    }

    ytm-mobile-topbar-renderer,
    header.mobile-topbar-header {
      background-color: #0f0f0f !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
    }
    .mobile-topbar-header-content {
      overflow: visible !important;
      display: flex !important;
      align-items: center !important;
    }
    ytm-pivot-bar-renderer {
      background-color: #0f0f0f !important;
      border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
    }

    /* Hide mobile web "Open in App" banners & upsells */
    ytm-upsell-dialog-renderer,
    ytm-mealbar-promo-renderer,
    .open-in-app-banner,
    .ytm-open-app-button,
    ytm-topbar-menu-button-renderer a[href*="intent://"],
    a[href*="intent://"] {
      display: none !important;
    }

    /* Sticky video player on Watch pages */
    ytm-watch .player-container.sticky-player,
    .player-container.sticky-player {
      position: sticky !important;
      top: 0 !important;
      z-index: 4 !important;
      background: #000 !important;
    }

    /* Make YouTube's built-in subtitles noticeably smaller than Sinhala CC */
    .ytp-caption-segment,
    .captions-text .ytp-caption-segment {
      font-size: 11px !important;
      line-height: 1.22 !important;
      padding: 1px 4px !important;
    }
    .html5-video-player.ytp-fullscreen .ytp-caption-segment,
    :fullscreen .ytp-caption-segment {
      font-size: 13px !important;
      line-height: 1.25 !important;
    }
    .ytp-caption-window-container .caption-window {
      margin-bottom: 6px !important;
    }

    /* Hide YouTube's original wordmark SVGs once Killer X YT brand is attached */
    .kx-brand-host {
      pointer-events: auto !important;
      position: relative !important;
      z-index: 60 !important;
      cursor: pointer !important;
    }
    .kx-brand-host > *:not(#kx-brand-badge) {
      display: none !important;
    }
    #kx-brand-badge {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 4px 8px 4px 2px !important;
      text-decoration: none !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      position: relative !important;
      z-index: 65 !important;
      flex-shrink: 0 !important;
      white-space: nowrap !important;
    }
    #kx-brand-badge * {
      pointer-events: none !important;
    }
    .kx-brand-icon {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 26px !important;
      height: 19px !important;
      border-radius: 5px !important;
      background: #e50914 !important;
      flex-shrink: 0 !important;
    }
    .kx-brand-icon svg {
      width: 11px !important;
      height: 11px !important;
      fill: #ffffff !important;
    }
    .kx-brand-text {
      font-family: Roboto, Arial, sans-serif !important;
      font-size: 15px !important;
      font-weight: 800 !important;
      letter-spacing: -0.3px !important;
      color: #ffffff !important;
      line-height: 1 !important;
    }
    .kx-brand-yt {
      font-family: Roboto, Arial, sans-serif !important;
      font-size: 11px !important;
      font-weight: 800 !important;
      color: #ff3b30 !important;
      margin-left: 2px !important;
      line-height: 1 !important;
    }

    /* Native Killer X Controls next to Search icon */
    #kx-header-controls {
      display: inline-flex !important;
      align-items: center !important;
      gap: 4px !important;
      margin-right: 4px !important;
      flex-shrink: 0 !important;
      z-index: 50 !important;
    }
    .kx-hdr-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      height: 30px !important;
      min-width: 30px !important;
      padding: 0 7px !important;
      border: none !important;
      border-radius: 15px !important;
      background: rgba(255, 255, 255, 0.12) !important;
      color: #f1f1f1 !important;
      font-family: Roboto, Arial, sans-serif !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      line-height: 1 !important;
      cursor: pointer !important;
      box-sizing: border-box !important;
      gap: 3px !important;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
    }
    .kx-hdr-btn:active {
      background: rgba(255, 255, 255, 0.26) !important;
      transform: scale(0.94) !important;
    }
    .kx-hdr-btn svg {
      width: 15px !important;
      height: 15px !important;
      fill: currentColor !important;
      flex-shrink: 0 !important;
      pointer-events: none !important;
    }
    .kx-hdr-btn.kx-cc-on {
      background: #e50914 !important;
      color: #ffffff !important;
      padding: 0 9px !important;
    }
    .kx-hdr-btn.kx-cc-off {
      background: rgba(255, 255, 255, 0.14) !important;
      color: #aaaaaa !important;
      padding: 0 9px !important;
    }
    .kx-hdr-btn.kx-sleep-on {
      background: rgba(229, 9, 20, 0.28) !important;
      border: 1px solid #ff3b30 !important;
      color: #ffae52 !important;
      padding: 0 8px !important;
    }

    /* Guaranteed fallback pill (auto-shown if header controls aren't visible, e.g., Shorts) */
    #kx-shorts-fallback {
      position: fixed !important;
      top: 9px !important;
      right: 52px !important;
      display: none !important;
      align-items: center !important;
      gap: 4px !important;
      z-index: 2147483640 !important;
      background: rgba(15, 15, 15, 0.88) !important;
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 18px !important;
      padding: 3px 5px !important;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5) !important;
    }
    #kx-shorts-fallback.kx-show {
      display: inline-flex !important;
    }
  `;

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

  // Pure DOM SVG factory — ZERO innerHTML, 100% immune to YouTube Trusted Types CSP!
  const SVG_NS = "http://www.w3.org/2000/svg";
  function makeSvgIcon(pathData) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  const PATH_MOON = "M12.1 22c-5.5 0-10-4.5-10-10 0-4.2 2.6-7.8 6.4-9.3.5-.2 1.1.3.9.9-.5 1.1-.8 2.3-.8 3.6 0 4.6 3.7 8.3 8.3 8.3 1.3 0 2.5-.3 3.6-.8.6-.2 1.1.4.9.9-1.5 3.8-5.1 6.4-9.3 6.4z";
  const PATH_PIP = "M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z";
  const PATH_PLAY = "M8 5v14l11-7z";

  function ensureYouTubeDarkMode() {
    try {
      if (!document.cookie.includes("f6=400")) {
        document.cookie = "PREF=f6=400&tz=Asia.Colombo; domain=.youtube.com; path=/; max-age=31536000";
      }
      if (document.documentElement) {
        document.documentElement.setAttribute("dark", "");
      }
    } catch (e) {}
  }

  function ensureStyles() {
    try {
      const root = document.head || document.documentElement;
      if (!root) return;

      if (!document.getElementById("kx-native-ui-css")) {
        const style = document.createElement("style");
        style.id = "kx-native-ui-css";
        style.textContent = NATIVE_APP_UI_CSS;
        root.appendChild(style);
      }

      const existingAd = document.getElementById("kx-adblock-css");
      if (!config.adShield) {
        if (existingAd) existingAd.remove();
      } else if (!existingAd) {
        const style = document.createElement("style");
        style.id = "kx-adblock-css";
        style.textContent = AD_CSS;
        root.appendChild(style);
      }
    } catch (e) {}
  }

  let lastHomeNavMs = 0;
  function goToYouTubeHomeNow() {
    const now = Date.now();
    if (now - lastHomeNavMs < 500) return;
    lastHomeNavMs = now;

    const onHome = location.pathname === "/" && !location.search.includes("v=") && !location.search.includes("search_query=");
    if (onHome && window.scrollY > 80) {
      try {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (e) {
        window.scrollTo(0, 0);
      }
      return;
    }

    const beforeHref = location.href;
    try {
      window.location.assign("https://m.youtube.com/");
    } catch (e) {
      postBg({ type: "uiAction", action: "goHome" });
      return;
    }

    // Safety fallback via native MainActivity if SPA blocked same-origin assign
    setTimeout(() => {
      if (location.href === beforeHref && !onHome) {
        postBg({ type: "uiAction", action: "goHome" });
      }
    }, 300);
  }

  // Document-level capture listener (works even if YouTube puts disabled button / overlay above the logo!)
  let brandTouchStartX = 0;
  let brandTouchStartY = 0;
  let brandTouchHit = false;

  function isPointOnBrandBadge(x, y) {
    const badge = document.getElementById("kx-brand-badge");
    if (!badge || !badge.isConnected) return false;
    try {
      const r = badge.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
    } catch (e) {
      return false;
    }
  }

  document.addEventListener("touchstart", (e) => {
    try {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      brandTouchStartX = t.clientX;
      brandTouchStartY = t.clientY;
      brandTouchHit =
        !!(e.target && e.target.closest && e.target.closest("#kx-brand-badge, .kx-brand-host")) ||
        isPointOnBrandBadge(t.clientX, t.clientY);
    } catch (err) {
      brandTouchHit = false;
    }
  }, true);

  document.addEventListener("touchend", (e) => {
    if (!brandTouchHit) return;
    brandTouchHit = false;
    try {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = Math.abs(t.clientX - brandTouchStartX);
      const dy = Math.abs(t.clientY - brandTouchStartY);
      if (dx < 18 && dy < 18) {
        e.preventDefault();
        e.stopImmediatePropagation();
        goToYouTubeHomeNow();
      }
    } catch (err) {}
  }, true);

  document.addEventListener("click", (e) => {
    try {
      const hitTarget = !!(e.target && e.target.closest && e.target.closest("#kx-brand-badge, .kx-brand-host"));
      const hitRect = typeof e.clientX === "number" && isPointOnBrandBadge(e.clientX, e.clientY);
      if (hitTarget || hitRect) {
        e.preventDefault();
        e.stopImmediatePropagation();
        goToYouTubeHomeNow();
      }
    } catch (err) {}
  }, true);

  function createKillerXBrandBadge() {
    const badge = document.createElement("div");
    badge.id = "kx-brand-badge";
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-label", "Killer X YT Home");

    const iconBox = document.createElement("span");
    iconBox.className = "kx-brand-icon";
    iconBox.appendChild(makeSvgIcon(PATH_PLAY));

    const labelMain = document.createElement("span");
    labelMain.className = "kx-brand-text";
    labelMain.textContent = "Killer X";

    const labelYt = document.createElement("span");
    labelYt.className = "kx-brand-yt";
    labelYt.textContent = "YT";

    badge.appendChild(iconBox);
    badge.appendChild(labelMain);
    badge.appendChild(labelYt);
    return badge;
  }

  // Replaces "YouTube" logo & page title inside the app with "Killer X YT"
  function ensureKillerXBranding(header) {
    try {
      if (document.title && document.title.includes("YouTube")) {
        document.title = document.title.replace(/YouTube/g, "Killer X YT");
      }

      if (!header) return;

      // Find YouTube's top-left home logo container
      const logoHost = header.querySelector(
        "button.mobile-topbar-header-endpoint, a.mobile-topbar-header-endpoint, ytm-home-logo, #home-icon, [aria-label='YouTube Home'], [aria-label*='YouTube']"
      );

      if (logoHost) {
        logoHost.classList.add("kx-brand-host");
        if (logoHost.hasAttribute("disabled")) logoHost.removeAttribute("disabled");
        if (logoHost.parentElement && logoHost.parentElement.hasAttribute("disabled")) {
          logoHost.parentElement.removeAttribute("disabled");
        }
        if (!logoHost.querySelector("#kx-brand-badge")) {
          logoHost.appendChild(createKillerXBrandBadge());
        }
      }
    } catch (e) {}
  }

  function createControlButtons(prefix) {
    const frag = document.createDocumentFragment();

    // 1. Sleep Timer Button (🌙 + live remaining min when active)
    const btnSleep = document.createElement("button");
    btnSleep.id = prefix + "-sleep";
    btnSleep.type = "button";
    btnSleep.className = "kx-hdr-btn";
    btnSleep.title = "Sleep Timer";
    btnSleep.appendChild(makeSvgIcon(PATH_MOON));
    const sleepText = document.createElement("span");
    sleepText.id = prefix + "-sleep-txt";
    sleepText.style.display = "none";
    btnSleep.appendChild(sleepText);
    btnSleep.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      postBg({ type: "uiAction", action: "openSleepTimer" });
    }, true);

    // 2. Picture-in-Picture Button
    const btnPip = document.createElement("button");
    btnPip.id = prefix + "-pip";
    btnPip.type = "button";
    btnPip.className = "kx-hdr-btn";
    btnPip.title = "Picture-in-Picture";
    btnPip.appendChild(makeSvgIcon(PATH_PIP));
    btnPip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      postBg({ type: "uiAction", action: "enterPip" });
    }, true);

    // 3. CC / Killer X Settings Button
    const btnCc = document.createElement("button");
    btnCc.id = prefix + "-cc";
    btnCc.type = "button";
    btnCc.className = "kx-hdr-btn kx-cc-on";
    btnCc.title = "Killer X YT Settings & CC";
    btnCc.textContent = "CC";
    btnCc.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      postBg({ type: "uiAction", action: "openSettings" });
    }, true);

    frag.appendChild(btnSleep);
    frag.appendChild(btnPip);
    frag.appendChild(btnCc);
    return frag;
  }

  function updateControlButtonsAppearance() {
    try {
      const isCcOn = !!config.ccEnabled;
      const sleepMin = Number(config.sleepRemainingMin) || 0;

      ["kx-hdr", "kx-fb"].forEach((prefix) => {
        const btnCc = document.getElementById(prefix + "-cc");
        if (btnCc) {
          btnCc.className = "kx-hdr-btn " + (isCcOn ? "kx-cc-on" : "kx-cc-off");
        }

        const btnSleep = document.getElementById(prefix + "-sleep");
        const sleepTxt = document.getElementById(prefix + "-sleep-txt");
        if (btnSleep && sleepTxt) {
          if (sleepMin > 0) {
            btnSleep.className = "kx-hdr-btn kx-sleep-on";
            sleepTxt.textContent = sleepMin + "m";
            sleepTxt.style.display = "inline";
          } else {
            btnSleep.className = "kx-hdr-btn";
            sleepTxt.textContent = "";
            sleepTxt.style.display = "none";
          }
        }
      });
    } catch (e) {}
  }

  function isElementVisibleOnScreen(el) {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 12) return false;
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return false;
      const st = window.getComputedStyle(el);
      return st.display !== "none" && st.visibility !== "hidden" && parseFloat(st.opacity || "1") > 0.1;
    } catch (e) {
      return false;
    }
  }

  function isSearchInputActuallyVisible() {
    try {
      const inputs = document.querySelectorAll("input.searchbox-input, input[name='search_query'], form.searchbox input");
      for (let i = 0; i < inputs.length; i++) {
        if (isElementVisibleOnScreen(inputs[i])) return true;
      }
    } catch (e) {}
    return false;
  }

  function ensureHeaderControls() {
    try {
      if (inPipMode || document.fullscreenElement) {
        const fb = document.getElementById("kx-shorts-fallback");
        if (fb) fb.classList.remove("kx-show");
        return;
      }

      const header = document.querySelector("ytm-mobile-topbar-renderer, header.mobile-topbar-header, header");
      ensureKillerXBranding(header);

      const searchInputOpen = isSearchInputActuallyVisible();
      let hdrControls = document.getElementById("kx-header-controls");

      if (header && !searchInputOpen) {
        // Find YouTube's visible Search button inside the top header
        let searchBtn = null;
        const candidates = header.querySelectorAll(
          "button[aria-label*='Search'], button[aria-label*='search'], button.icon-button.topbar-menu-button-avatar-button, .mobile-topbar-header-content button"
        );
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (c.closest("#kx-header-controls") || c.closest(".kx-brand-host")) continue;
          if (isElementVisibleOnScreen(c)) {
            searchBtn = c;
            break;
          }
        }

        const contentBox =
          (searchBtn && searchBtn.parentElement) ||
          header.querySelector(".mobile-topbar-header-content");

        if (contentBox) {
          if (!hdrControls) {
            hdrControls = document.createElement("div");
            hdrControls.id = "kx-header-controls";
            hdrControls.appendChild(createControlButtons("kx-hdr"));
          }

          if (searchBtn && searchBtn.parentElement === contentBox) {
            if (hdrControls.nextSibling !== searchBtn) {
              contentBox.insertBefore(hdrControls, searchBtn);
            }
          } else if (hdrControls.parentElement !== contentBox) {
            contentBox.insertBefore(hdrControls, contentBox.firstChild);
          }
          hdrControls.style.display = "inline-flex";
        }
      } else if (hdrControls) {
        hdrControls.style.display = "none";
      }

      // Guaranteed fallback pill ONLY if header controls are NOT visibly on screen (e.g., Shorts / scrolled header)
      let fb = document.getElementById("kx-shorts-fallback");
      if (!fb && document.body) {
        fb = document.createElement("div");
        fb.id = "kx-shorts-fallback";
        fb.appendChild(createControlButtons("kx-fb"));
        document.body.appendChild(fb);
      }

      if (fb) {
        const hdrVisible = isElementVisibleOnScreen(hdrControls);
        if (!hdrVisible && !searchInputOpen && !inPipMode && !document.fullscreenElement) {
          fb.classList.add("kx-show");
        } else {
          fb.classList.remove("kx-show");
        }
      }

      updateControlButtonsAppearance();
    } catch (e) {}
  }

  let wasMutedByAd = false;
  function skipYouTubeAds() {
    ensureYouTubeDarkMode();
    ensureStyles();
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
          ytm-mobile-topbar-renderer, header, .mobile-topbar-header, ytm-watch-metadata, ytm-item-section-renderer, ytm-pivot-bar-renderer, #below, #secondary, #kx-header-controls, #kx-shorts-fallback { display: none !important; }
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
    ensureHeaderControls();
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
    return (document.title || "").replace(/\s*-\s*(YouTube|Killer X YT)$/i, "").trim() || "Killer X YT";
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
  const ccEnableTriedVids = new Set();
  const ccCycleTriedVids = new Set();
  const userManuallyToggledCcVids = new Set();
  let ccWatchStartMs = 0;
  let ccRenderedForCurrentVid = false;

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

    if (/[\u0D80-\u0DFF]/.test(cleanText)) {
      showTranslatedLine(cleanText, "", "Sinhala CC");
      return;
    }

    if (localCache.has(cleanText)) {
      showTranslatedLine(localCache.get(cleanText), cleanText, "Live Sinhala CC (0ms)");
      return;
    }

    const id = reqSeq++;
    latestSentReqId = id;
    pendingTranslates.set(id, { text: cleanText });

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
      if (lastShownSi !== "" && lastNonEmptyCaptionMs > 0 && now - lastNonEmptyCaptionMs > 1200) {
        lastSeenRawText = "";
        lastShownSi = "";
        postBg({ type: "hideSubtitle" });
      }
      return;
    }

    ccRenderedForCurrentVid = true;
    lastNonEmptyCaptionMs = now;
    if (clean === lastSeenRawText) return;
    lastSeenRawText = clean;

    if (/[\u0D80-\u0DFF]/.test(clean) || localCache.has(clean)) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      dispatchTranslation(clean);
      return;
    }

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

  // Auto-kickstart YouTube's CC module on new videos so BOTH YouTube CC & Sinhala CC work immediately
  // without the user manually turning CC OFF and back ON!
  function kickstartYouTubeCaptions() {
    if (!config.ccEnabled) return;
    const vid = getCurrentVideoId();
    if (!vid) return;
    if (ccRenderedForCurrentVid || userManuallyToggledCcVids.has(vid)) return;
    if (readVisibleYouTubeCaption()) {
      ccRenderedForCurrentVid = true;
      return;
    }

    const v = getMainVideo();
    if (!v || v.paused || v.ended || v.readyState < 2 || v.currentTime < 0.35) return;

    // Ignore ads while an ad is playing
    const playerEl = document.querySelector(".html5-video-player");
    if (playerEl && (playerEl.classList.contains("ad-showing") || playerEl.classList.contains("ad-interrupting"))) {
      return;
    }

    const now = Date.now();
    if (ccWatchStartMs === 0) ccWatchStartMs = now;
    const elapsed = now - ccWatchStartMs;

    const ccBtn = document.querySelector(".ytp-subtitles-button, button.ytm-closed-captioning-button");
    const player = playerEl ? (playerEl.wrappedJSObject || playerEl) : null;

    // Step 1 (~450ms): Wake YouTube captions module & turn CC ON if it is currently OFF
    if (!ccEnableTriedVids.has(vid) && elapsed >= 450) {
      ccEnableTriedVids.add(vid);
      try {
        if (player && typeof player.loadModule === "function") {
          player.loadModule("captions");
        }
        if (player && typeof player.toggleSubtitlesOn === "function") {
          player.toggleSubtitlesOn();
        }
      } catch (e) {}

      if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {
        try { ccBtn.click(); } catch (e) {}
      }
      ensureCaptionObserver();
      return;
    }

    // Step 2 (~2.0s): If YouTube CC is stuck ON from previous video and still not rendering segments,
    // automatically perform ONE clean OFF -> ON cycle!
    if (!ccCycleTriedVids.has(vid) && elapsed >= 2000) {
      ccCycleTriedVids.add(vid);
      if (readVisibleYouTubeCaption()) {
        ccRenderedForCurrentVid = true;
        return;
      }

      if (ccBtn) {
        const pressed = ccBtn.getAttribute("aria-pressed");
        if (pressed === "true") {
          try { ccBtn.click(); } catch (e) {}
          setTimeout(() => {
            if (getCurrentVideoId() === vid && !userManuallyToggledCcVids.has(vid)) {
              const btn2 = document.querySelector(".ytp-subtitles-button, button.ytm-closed-captioning-button");
              if (btn2 && btn2.getAttribute("aria-pressed") === "false") {
                try { btn2.click(); } catch (e) {}
              }
              ensureCaptionObserver();
            }
          }, 220);
        } else if (pressed === "false") {
          try { ccBtn.click(); } catch (e) {}
        }
      } else if (player && typeof player.toggleSubtitles === "function") {
        try {
          player.toggleSubtitles();
          setTimeout(() => {
            if (getCurrentVideoId() === vid && !userManuallyToggledCcVids.has(vid)) {
              try {
                if (typeof player.toggleSubtitlesOn === "function") player.toggleSubtitlesOn();
                else player.toggleSubtitles();
              } catch (e) {}
              ensureCaptionObserver();
            }
          }, 220);
        } catch (e) {}
      }
    }
  }

  function checkNavigation() {
    const vid = getCurrentVideoId();
    if (vid !== lastActiveVideoId) {
      lastActiveVideoId = vid;
      lastSeenRawText = "";
      lastShownSi = "";
      lastNonEmptyCaptionMs = 0;
      translatedLineCount = 0;
      ccWatchStartMs = 0;
      ccRenderedForCurrentVid = false;
      ccEnableTriedVids.delete(vid);
      ccCycleTriedVids.delete(vid);
      userManuallyToggledCcVids.delete(vid);
      userPaused = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      postBg({ type: "hideSubtitle" });
      ensureCaptionObserver();
      ensureHeaderControls();
    }
  }

  window.addEventListener("yt-navigate-finish", () => {
    checkNavigation();
    setTimeout(ensureCaptionObserver, 350);
    setTimeout(ensureHeaderControls, 250);
  }, true);
  window.addEventListener("popstate", () => {
    setTimeout(checkNavigation, 150);
    setTimeout(ensureHeaderControls, 200);
  }, true);
  document.addEventListener("fullscreenchange", ensureHeaderControls, true);

  function handleBgMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config" && msg.config) {
      config = Object.assign(config, msg.config);
      ensureStyles();
      updateControlButtonsAppearance();
      if (!config.ccEnabled) {
        lastSeenRawText = "";
        lastShownSi = "";
        postBg({ type: "hideSubtitle" });
      }
    } else if (msg.type === "resync") {
      checkNavigation();
      lastSeenRawText = "";
      ensureCaptionObserver();
      ensureHeaderControls();
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
        if (origText === lastSeenRawText || msg.reqId >= latestSentReqId) {
          showTranslatedLine(translated, origText, "Live Sinhala CC");
        }
      }
    }
  }

  ensureYouTubeDarkMode();
  ensureStyles();
  setInterval(ensureHeaderControls, 350);
  setInterval(checkNavigation, 300);
  setInterval(ensureCaptionObserver, 1000);
  setInterval(attachAntiAutoPauseGuard, 500);
  setInterval(skipYouTubeAds, 250);
  setInterval(reportMediaState, 500);
  setInterval(kickstartYouTubeCaptions, 450);
  setInterval(scanYouTubeCaptions, 100);
})();
