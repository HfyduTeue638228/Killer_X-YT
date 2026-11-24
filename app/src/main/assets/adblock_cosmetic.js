(() => {
  if (window.__kxAdShieldLoaded) return;
  window.__kxAdShieldLoaded = true;

  try {
    const nativeOpen = window.open;
    window.open = function () {
      if (window.KillerX && window.KillerX.isAdShieldEnabled()) {
        window.KillerX.onJsAdBlocked();
        return null;
      }
      return nativeOpen.apply(this, arguments);
    };
  } catch (e) {}

  const YT_AD_CSS = `
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

  function ensureCss() {
    if (document.getElementById("kx-adblock-css")) return;
    const style = document.createElement("style");
    style.id = "kx-adblock-css";
    style.textContent = YT_AD_CSS;
    (document.head || document.documentElement).appendChild(style);
  }
  ensureCss();

  let wasMutedByAd = false;
  function skipYouTubeAds() {
    if (!location.hostname.includes("youtube.com")) return;
    if (window.KillerX && !window.KillerX.isAdShieldEnabled()) return;

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
          if (window.KillerX) window.KillerX.onJsAdBlocked();
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

    // Dismiss YouTube ad-blocker / "Open in YouTube App" annoying promo dialogs
    document.querySelectorAll("ytd-enforcement-message-view-model, tp-yt-paper-dialog, ytm-upsell-dialog-renderer").forEach((dlg) => {
      const txt = (dlg.innerText || "").toLowerCase();
      if (txt.includes("ad blocker") || txt.includes("open app") || txt.includes("youtube premium")) {
        dlg.remove();
      }
    });
  }

  setInterval(skipYouTubeAds, 220);
})();
