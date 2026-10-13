/**
 * idlix - IDLIX provider for Nuvio
 * Based on IDLIX internal API and majorplay.net
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/idlix/http.js
var require_http = __commonJS({
  "src/idlix/http.js"(exports2, module2) {
    var BASE_URL = "https://z2.idlixku.com";
    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
    var REQUEST_TIMEOUT = 15000;

    function fetchWithTimeout(url, options, timeout) {
      timeout = timeout || REQUEST_TIMEOUT;
      var timer = null;
      var timeoutPromise = new Promise(function(_, reject) {
        timer = setTimeout(function() { reject(new Error("Timeout")); }, timeout);
      });
      return Promise.race([fetch(url, options), timeoutPromise]).then(function(res) {
        if (timer) clearTimeout(timer);
        return res;
      }).catch(function(err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
    }

    // TMDB ID -> IDLIX slug
    function searchByTmdbId(tmdbId, mediaType) {
      var url = BASE_URL + "/api/search?q=" + encodeURIComponent(tmdbId) + "&type=" + (mediaType === "tv" ? "series" : "movie");
      return fetchWithTimeout(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          "Referer": BASE_URL + "/"
        }
      }).then(function(res) {
        if (!res.ok) throw new Error("Search failed: " + res.status);
        return res.json();
      });
    }

    // Get series/movie details by slug
    function getDetails(slug, mediaType, season) {
      var url;
      if (mediaType === "tv") {
        url = BASE_URL + "/api/series/" + encodeURIComponent(slug) + "/season/" + encodeURIComponent(season);
      } else {
        url = BASE_URL + "/api/movies/" + encodeURIComponent(slug);
      }
      return fetchWithTimeout(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          "Referer": BASE_URL + "/"
        }
      }).then(function(res) {
        if (!res.ok) throw new Error("Details failed: " + res.status);
        return res.json();
      });
    }

    // Get play info (gateToken)
    function getPlayInfo(uuid, type) {
      var url = BASE_URL + "/api/watch/play-info/" + (type === "tv" ? "episode" : "movie") + "/" + uuid;
      return fetchWithTimeout(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          "Referer": BASE_URL + "/"
        }
      }).then(function(res) {
        if (!res.ok) throw new Error("Play info failed: " + res.status);
        return res.json();
      });
    }

    // Claim session
    function claimSession(gateToken) {
      var url = BASE_URL + "/api/watch/session/claim";
      return fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Origin": BASE_URL,
          "Referer": BASE_URL + "/"
        },
        body: JSON.stringify({ gateToken: gateToken })
      }).then(function(res) {
        if (!res.ok) throw new Error("Claim failed: " + res.status);
        return res.json();
      });
    }

    // Redeem claim at majorplay
    function redeemClaim(claim, redeemUrl) {
      return fetchWithTimeout(redeemUrl, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ claim: claim, mode: "browser" })
      }).then(function(res) {
        if (!res.ok) throw new Error("Redeem failed: " + res.status);
        return res.json();
      });
    }

    module2.exports = {
      searchByTmdbId: searchByTmdbId,
      getDetails: getDetails,
      getPlayInfo: getPlayInfo,
      claimSession: claimSession,
      redeemClaim: redeemClaim
    };
  }
});

// src/idlix/extractor.js
var require_extractor = __commonJS({
  "src/idlix/extractor.js"(exports2, module2) {
    "use strict";

    function extractStreams(config, title) {
      return __async(this, null, function* () {
        if (!config || !config.sources) return [];

        var streams = [];
        var subtitles = [];

        // Extract subtitles
        if (config.subtitles && Array.isArray(config.subtitles)) {
          config.subtitles.forEach(function(sub) {
            if (sub.path) {
              subtitles.push({
                url: sub.path,
                lang: sub.label || sub.lang || "Unknown"
              });
            }
          });
        }

        // Extract streams
        if (config.sources && Array.isArray(config.sources)) {
          config.sources.forEach(function(source) {
            if (!source.file) return;

            var isHls = source.type === "hls" || source.file.indexOf(".m3u8") !== -1;
            var quality = source.label || source.quality || "Auto";

            streams.push({
              name: "IDLIX - " + quality,
              title: title,
              url: source.file,
              quality: quality,
              isM3u8: isHls,
              provider: "idlix",
              type: isHls ? "hls" : "direct",
              subtitles: subtitles
            });
          });
        }

        return streams;
      });
    }

    module2.exports = { extractStreams: extractStreams };
  }
});

// src/idlix/index.js
var import_http = __toESM(require_http());
var import_extractor = __toESM(require_extractor());

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[IDLIX] Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    try {
      // 1. Search for content by TMDB ID
      var searchResults = yield import_http.searchByTmdbId(tmdbId, mediaType);
      if (!searchResults || !searchResults.data || searchResults.data.length === 0) {
        console.log("[IDLIX] No results found for TMDB ID: " + tmdbId);
        return [];
      }

      var item = searchResults.data[0];
      var slug = item.slug;

      // 2. Get details to find UUID
      var details;
      var uuid;
      var title;

      if (mediaType === "tv") {
        details = yield import_http.getDetails(slug, "tv", season);
        if (!details || !details.episodes) return [];
        var ep = details.episodes.find(function(e) { return e.episodeNumber === parseInt(episode); });
        if (!ep) {
          console.log("[IDLIX] Episode not found");
          return [];
        }
        uuid = ep.id;
        title = details.series.title + " - S" + season + "E" + episode + " - " + ep.name;
      } else {
        details = yield import_http.getDetails(slug, "movie");
        uuid = details.id;
        title = details.title;
      }

      // 3. Get play info (gateToken)
      var playInfo = yield import_http.getPlayInfo(uuid, mediaType === "tv" ? "tv" : "movie");
      if (!playInfo || !playInfo.gateToken) {
        console.log("[IDLIX] No gate token received");
        return [];
      }

      // 4. Wait for unlockAt (anti-scraping delay)
      var delay = (playInfo.unlockAt || 0) - Math.floor(Date.now() / 1000);
      if (delay > 0) {
        console.log("[IDLIX] Waiting " + delay + " seconds for unlock...");
        yield new Promise(function(resolve) { setTimeout(resolve, delay * 1000); });
      }

      // 5. Claim session
      var claimResult = yield import_http.claimSession(playInfo.gateToken);
      if (!claimResult || !claimResult.claim) {
        console.log("[IDLIX] Failed to claim session");
        return [];
      }

      // 6. Redeem claim at majorplay
      var redeemResult = yield import_http.redeemClaim(claimResult.claim, claimResult.redeemUrl);
      if (!redeemResult || !redeemResult.url) {
        console.log("[IDLIX] Failed to redeem claim");
        return [];
      }

      // 7. Fetch config.json
      var configRes = yield fetch(redeemResult.url);
      var config = yield configRes.json();

      // 8. Extract streams
      var streams = yield import_extractor.extractStreams(config, title);
      console.log("[IDLIX] Found " + streams.length + " streams");
      return streams;

    } catch (err) {
      console.log("[IDLIX] Error: " + err.message);
      return [];
    }
  });
}

module.exports = { getStreams };
