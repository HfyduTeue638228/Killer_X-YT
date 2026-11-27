(() => {
  if (window.__kxBraveAdBlockLoaded) return;
  window.__kxBraveAdBlockLoaded = true;

  function isShieldEnabled() {
    try {
      const root = document.documentElement;
      return !root || root.dataset.kxAdShield !== "0";
    } catch (e) {
      return true;
    }
  }

  function notifyPruned(count) {
    if (!count || count <= 0) return;
    try {
      window.postMessage({ __kxAdPruned: true, count }, "*");
    } catch (e) {}
  }

  const PLAYER_AD_KEYS = [
    "adPlacements",
    "playerAds",
    "adSlots",
    "adBreakHeartbeatParams",
    "adBreakParams",
    "adSafetyReason"
  ];

  const FEED_AD_KEYS = new Set([
    "adSlotRenderer",
    "promotedSparklesWebRenderer",
    "promotedSparklesTextSearchRenderer",
    "compactPromotedItemRenderer",
    "promotedVideoRenderer",
    "displayAdRenderer",
    "bannerPromoRenderer",
    "statementBannerRenderer",
    "mealbarPromoRenderer",
    "inFeedAdLayoutRenderer",
    "brandVideoSingletonRenderer",
    "adLayoutMetadata",
    "videoDisplayFullButtonedRenderer"
  ]);

  // Never walk into heavy media/caption subtrees (keeps pruning <1ms & 100% safe for CC/Video!)
  const SKIP_WALK_KEYS = new Set([
    "streamingData",
    "captions",
    "videoDetails",
    "storyboards",
    "microformat",
    "thumbnails",
    "thumbnail",
    "playbackTracking",
    "responseContext",
    "frameworkUpdates"
  ]);

  function isAdItem(item) {
    if (!item || typeof item !== "object") return false;
    for (const k of Object.keys(item)) {
      if (FEED_AD_KEYS.has(k)) return true;
    }
    // Mobile Home Feed: richItemRenderer.content.adSlotRenderer
    const ric = item.richItemRenderer && item.richItemRenderer.content;
    if (ric && typeof ric === "object") {
      for (const k of Object.keys(ric)) {
        if (FEED_AD_KEYS.has(k)) return true;
      }
    }
    // Shorts sponsored slides
    const rwe = item.command && item.command.reelWatchEndpoint;
    if (rwe && rwe.adClientParams) return true;
    if (item.adSlotRenderer) return true;

    // ItemSection containing ONLY ad items
    const isc = item.itemSectionRenderer && item.itemSectionRenderer.contents;
    if (Array.isArray(isc) && isc.length > 0 && isc.length <= 2) {
      let allAds = true;
      for (let i = 0; i < isc.length; i++) {
        const sub = isc[i];
        let subIsAd = false;
        if (sub && typeof sub === "object") {
          for (const sk of Object.keys(sub)) {
            if (FEED_AD_KEYS.has(sk)) {
              subIsAd = true;
              break;
            }
          }
        }
        if (!subIsAd) {
          allAds = false;
          break;
        }
      }
      if (allAds) return true;
    }
    return false;
  }

  function pruneYouTubeAds(root) {
    if (!isShieldEnabled() || !root || typeof root !== "object") return 0;
    let removed = 0;
    const seen = new WeakSet();

    function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 16 || seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        let writeIdx = 0;
        for (let i = 0; i < node.length; i++) {
          const el = node[i];
          if (isAdItem(el)) {
            removed++;
            continue;
          }
          node[writeIdx++] = el;
          if (el && typeof el === "object") {
            walk(el, depth + 1);
          }
        }
        if (writeIdx !== node.length) {
          node.length = writeIdx;
        }
        return;
      }

      // Strip player-level ad fields directly
      for (let i = 0; i < PLAYER_AD_KEYS.length; i++) {
        const ak = PLAYER_AD_KEYS[i];
        if (ak in node) {
          delete node[ak];
          removed++;
        }
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (SKIP_WALK_KEYS.has(k)) continue;
        if (FEED_AD_KEYS.has(k)) {
          delete node[k];
          removed++;
          continue;
        }
        const val = node[k];
        if (val && typeof val === "object") {
          walk(val, depth + 1);
        }
      }
    }

    walk(root, 0);
    if (removed > 0) notifyPruned(removed);
    return removed;
  }

  function mightContainYouTubeAds(str) {
    if (typeof str !== "string" || str.length < 40) return false;
    return (
      str.includes("adPlacements") ||
      str.includes("playerAds") ||
      str.includes("adSlots") ||
      str.includes("adSlotRenderer") ||
      str.includes("promotedSparkles") ||
      str.includes("inFeedAdLayoutRenderer") ||
      str.includes("adBreakHeartbeatParams")
    );
  }

  function isTargetApiUrl(url) {
    if (typeof url !== "string") return false;
    return (
      url.includes("/youtubei/v1/player") ||
      url.includes("/youtubei/v1/next") ||
      url.includes("/youtubei/v1/browse") ||
      url.includes("/youtubei/v1/search") ||
      url.includes("/youtubei/v1/reel/reel_watch_sequence")
    );
  }

  function isMidrollAdUrl(url) {
    if (typeof url !== "string") return false;
    return url.includes("/youtubei/v1/ad_break") || url.includes("/get_midroll_info");
  }

  // -------------------------------------------------------------------------
  // 1. Intercept window.ytInitialPlayerResponse & window.ytInitialData
  // -------------------------------------------------------------------------
  function trapGlobal(propName) {
    let currentVal = window[propName];
    if (currentVal && typeof currentVal === "object") {
      try { pruneYouTubeAds(currentVal); } catch (e) {}
    }
    try {
      Object.defineProperty(window, propName, {
        configurable: true,
        enumerable: true,
        get() {
          return currentVal;
        },
        set(val) {
          if (val && typeof val === "object") {
            try { pruneYouTubeAds(val); } catch (e) {}
          }
          currentVal = val;
        }
      });
    } catch (e) {}
  }
  trapGlobal("ytInitialPlayerResponse");
  trapGlobal("ytInitialData");

  // -------------------------------------------------------------------------
  // 2. Fast-path JSON.parse Hook (Catches m.youtube.com inline JSON.parse bootstrapping!)
  // -------------------------------------------------------------------------
  const origJsonParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const parsed = origJsonParse.call(this, text, reviver);
    if (isShieldEnabled() && parsed && typeof parsed === "object" && mightContainYouTubeAds(text)) {
      try {
        pruneYouTubeAds(parsed);
      } catch (e) {}
    }
    return parsed;
  };

  // -------------------------------------------------------------------------
  // 3. window.fetch Hook (Zero-delay SPA /youtubei/v1/player & ad_break interception!)
  // -------------------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";

      if (isShieldEnabled() && isMidrollAdUrl(url)) {
        notifyPruned(1);
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json; charset=UTF-8" }
          })
        );
      }

      const promise = origFetch.apply(this, arguments);

      if (!isShieldEnabled() || !isTargetApiUrl(url)) {
        return promise;
      }

      return promise.then(async (res) => {
        try {
          if (!res || !res.ok) return res;
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          if (!ct.includes("json")) return res;
          const rawText = await res.clone().text();
          if (!mightContainYouTubeAds(rawText)) return res;

          const data = origJsonParse(rawText);
          const count = pruneYouTubeAds(data);
          if (count <= 0) return res;

          const newHeaders = new Headers();
          res.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (lk !== "content-length" && lk !== "content-encoding") {
              newHeaders.append(k, v);
            }
          });
          return new Response(JSON.stringify(data), {
            status: res.status,
            statusText: res.statusText,
            headers: newHeaders
          });
        } catch (e) {
          return res;
        }
      });
    };
  }

  // -------------------------------------------------------------------------
  // 4. XMLHttpRequest Hook (Fallback for XHR-based player/browse calls!)
  // -------------------------------------------------------------------------
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const origRespTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
  const origRespDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__kxUrl = typeof url === "string" ? url : "";
      this.__kxPrunedReady = false;
      this.__kxPrunedText = null;
      this.__kxPrunedObj = null;
    } catch (e) {}
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const url = this.__kxUrl || "";
    if (isShieldEnabled() && isMidrollAdUrl(url)) {
      notifyPruned(1);
      try {
        Object.defineProperty(this, "status", { value: 200, configurable: true });
        Object.defineProperty(this, "readyState", { value: 4, configurable: true });
        Object.defineProperty(this, "responseText", { value: "{}", configurable: true });
        Object.defineProperty(this, "response", { value: "{}", configurable: true });
        setTimeout(() => {
          try { this.dispatchEvent(new Event("readystatechange")); } catch (e) {}
          try { this.dispatchEvent(new Event("load")); } catch (e) {}
          try { this.dispatchEvent(new Event("loadend")); } catch (e) {}
        }, 0);
        return;
      } catch (e) {}
    }
    return origXhrSend.apply(this, arguments);
  };

  function getPrunedXhrResult(xhr) {
    if (xhr.__kxPrunedReady) return true;
    if (!isShieldEnabled() || !isTargetApiUrl(xhr.__kxUrl || "")) return false;
    if (xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return false;

    try {
      const raw = origRespTextDesc ? origRespTextDesc.get.call(xhr) : "";
      if (!mightContainYouTubeAds(raw)) return false;
      const data = origJsonParse(raw);
      const count = pruneYouTubeAds(data);
      if (count > 0) {
        xhr.__kxPrunedObj = data;
        xhr.__kxPrunedText = JSON.stringify(data);
        xhr.__kxPrunedReady = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  if (origRespTextDesc && origRespTextDesc.get) {
    try {
      Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
        configurable: true,
        get() {
          if (getPrunedXhrResult(this)) return this.__kxPrunedText;
          return origRespTextDesc.get.call(this);
        }
      });
    } catch (e) {}
  }

  if (origRespDesc && origRespDesc.get) {
    try {
      Object.defineProperty(XMLHttpRequest.prototype, "response", {
        configurable: true,
        get() {
          if (getPrunedXhrResult(this)) {
            return this.responseType === "json" ? this.__kxPrunedObj : this.__kxPrunedText;
          }
          return origRespDesc.get.call(this);
        }
      });
    } catch (e) {}
  }
})();
