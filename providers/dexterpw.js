/**
 * dexterpw - Built from src/dexterpw/
 * Generated: 2026-10-06T20:00:59.164Z
 * UPDATED: API timeout+retry, Turkish subtitle header, webm support, timer cleanup
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

// src/dexterpw/http.js
var require_http = __commonJS({
  "src/dexterpw/http.js"(exports2, module2) {
    var BASE_URL = "https://dexter.pw";
    var REQUEST_TIMEOUT = 12000;

    // Timeout wrapper; timer'i temizler ve timeout'ta promise'i reject eder
    function fetchWithTimeout(url, options, timeout) {
      timeout = timeout || REQUEST_TIMEOUT;
      var timer = null;
      var timeoutPromise = new Promise(function(_, reject) {
        timer = setTimeout(function() { reject(new Error("API Timeout")); }, timeout);
      });
      return Promise.race([fetch(url, options), timeoutPromise]).then(function(res) {
        if (timer) clearTimeout(timer);
        return res;
      }).catch(function(err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
    }

    function fetchDetails2(tmdbId, mediaType, season, episode, _retry) {
      _retry = _retry || 0;
      var url;
      if (mediaType === "tv") {
        if (season && episode) {
          url = BASE_URL + "/api/tv/" + encodeURIComponent(tmdbId) + "/episode/" + encodeURIComponent(season) + "/" + encodeURIComponent(episode) + "?site=dexter";
        } else if (season) {
          url = BASE_URL + "/api/tv/" + encodeURIComponent(tmdbId) + "/season/" + encodeURIComponent(season) + "?site=dexter";
        } else {
          url = BASE_URL + "/api/tv/" + encodeURIComponent(tmdbId) + "?site=dexter";
        }
      } else {
        url = BASE_URL + "/api/movie/" + encodeURIComponent(tmdbId) + "?site=dexter";
      }

      return fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
          "Referer": "https://dexter.pw"
        }
      }).then(function(res) {
        if (!res.ok) {
          console.log("[Dexter] API Error " + res.status + " for URL: " + url);
          return { sources: [], error: res.status };
        }
        return res.json();
      }).catch(function(err) {
        // Ag hatasi/timeout icin bir kez daha dene
        if (_retry < 1) {
          console.log("[Dexter] API retry (" + (_retry + 1) + "): " + err.message);
          return fetchDetails2(tmdbId, mediaType, season, episode, _retry + 1);
        }
        console.log("[Dexter] API Fetch Error: " + err);
        return { sources: [], error: err.message };
      });
    }
    module2.exports = { fetchDetails: fetchDetails2 };
  }
});

// src/dexterpw/extractor.js
var require_extractor = __commonJS({
  "src/dexterpw/extractor.js"(exports2, module2) {
    "use strict";
    var BASE_URL = "https://dexter.pw";
    var M3U8_TIMEOUT = 8000;

    function makeAbsoluteUrl(rawUrl) {
      if (typeof rawUrl !== "string" || !rawUrl.trim())
        return null;
      const value = rawUrl.trim();
      if (/^https?:\/\//i.test(value))
        return value;
      if (value.indexOf("//") === 0)
        return "https:" + value;
      if (value.charAt(0) === "/")
        return BASE_URL + value;
      return BASE_URL + "/" + value;
    }

    function resolveSubUrl(baseUrl, relativeUrl) {
      if (!relativeUrl) return null;
      relativeUrl = relativeUrl.trim();
      if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
      if (relativeUrl.startsWith("//")) return "https:" + relativeUrl;

      try {
        return new URL(relativeUrl, baseUrl).href;
      } catch (e) {
        if (relativeUrl.startsWith("/")) {
          const match = baseUrl.match(/^(https?:\/\/[^\/]+)/i);
          if (match) return match[1] + relativeUrl;
        }
        const lastSlash = baseUrl.lastIndexOf("/");
        if (lastSlash !== -1) {
          return baseUrl.substring(0, lastSlash + 1) + relativeUrl;
        }
        return relativeUrl;
      }
    }

    // FIXED: Fetch with timeout - artik timer temizleniyor
    function fetchWithTimeout(url, options, timeout) {
      timeout = timeout || M3U8_TIMEOUT;
      var timer = null;
      var timeoutPromise = new Promise(function(_, reject) {
        timer = setTimeout(function() { reject(new Error("Timeout")); }, timeout);
      });
      return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function(res) {
        if (timer) clearTimeout(timer);
        return res;
      }).catch(function(err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
    }

    function extractStreams2(details) {
      return __async(this, null, function* () {
        if (!details || !Array.isArray(details.sources) || details.sources.length === 0) {
          return [];
        }
        const episode = details.episode && typeof details.episode === "object" ? details.episode : null;
        const show = details.show && typeof details.show === "object" ? details.show : null;
        const episodeTitle = episode && (episode.title || episode.name);
        const showTitle = show && (show.title || show.name);
        const title = episodeTitle && showTitle ? showTitle + " - " + episodeTitle : episodeTitle || showTitle || details.title || "Video";

        // --- API'den gelen harici altyazilari ayikliyoruz ---
        const subtitles = [];
        const rawSubs = details.subtitles || details.tracks || [];
        if (Array.isArray(rawSubs)) {
          rawSubs.forEach(function(sub) {
            if (sub && typeof sub.url === "string") {
              const subUrl = makeAbsoluteUrl(sub.url);
              if (subUrl) {
                subtitles.push({
                  url: subUrl,
                  lang: sub.lang || sub.label || "Turkish"
                });
              }
            }
          });
        }

        const streams = [];

        for (let i = 0; i < details.sources.length; i++) {
          const source = details.sources[i];
          if (!source || typeof source.url !== "string")
            continue;

          const kind = String(source.kind || "").toLowerCase();
          const rawUrl = source.url;

          // FIXED: Desteklenen formatlar (webm dahil)
          const isHls = kind === "hls" || kind === "m3u8" || /\.m3u8(?:$|[?#])/i.test(rawUrl);
          const isDash = kind === "dash" || /\.mpd(?:$|[?#])/i.test(rawUrl);
          const isMp4 = kind === "mp4" || /\.mp4(?:$|[?#])/i.test(rawUrl);
          const isDirectLink = isMp4 || /\.(mp4|mkv|avi|mov|flv|webm)(?:$|[?#])/i.test(rawUrl);

          if (kind === "embed" || kind === "player" || kind === "html")
            continue;

          if (!isHls && !isDash && !isDirectLink)
            continue;

          const mainUrl = makeAbsoluteUrl(rawUrl);
          if (!mainUrl)
            continue;

          const serverLabel = source.label || "Server";

          if (isDirectLink) {
            streams.push({
              name: "Dexter - " + serverLabel,
              title,
              url: mainUrl,
              quality: source.quality || "Auto",
              isM3u8: false,
              provider: "dexter",
              type: "direct",
              subtitles: subtitles
            });
            continue;
          }

          if (isHls) {
            streams.push({
              name: "Dexter - " + serverLabel + " (Auto)",
              title,
              url: mainUrl,
              quality: "Auto",
              isM3u8: true,
              provider: "dexter",
              type: "hls",
              subtitles: subtitles
            });

            try {
              const res = yield fetchWithTimeout(mainUrl, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  "Referer": "https://dexter.pw"
                }
              }, M3U8_TIMEOUT);

              if (res.ok) {
                const text = yield res.text();
                const lines = text.split(/\r?\n/);
                const parsedVariants = {};

                for (let j = 0; j < lines.length; j++) {
                  const line = lines[j].trim();
                  if (line.startsWith("#EXT-X-STREAM-INF")) {
                    let resolutionLabel = "SD";
                    let bandwidth = 0;

                    const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
                    if (resMatch) {
                      const height = parseInt(resMatch[1], 10);
                      if (height >= 2160) resolutionLabel = "4K";
                      else if (height >= 1440) resolutionLabel = "2K";
                      else if (height >= 1080) resolutionLabel = "1080p";
                      else if (height >= 720) resolutionLabel = "720p";
                      else if (height >= 480) resolutionLabel = "480p";
                      else resolutionLabel = height + "p";
                    }

                    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
                    if (bwMatch) {
                      bandwidth = parseInt(bwMatch[1], 10);
                    }

                    let k = j + 1;
                    while (k < lines.length && (lines[k].trim() === "" || lines[k].trim().startsWith("#"))) {
                      k++;
                    }

                    if (k < lines.length) {
                      const rawSubUrl = lines[k].trim();
                      const subUrl = resolveSubUrl(mainUrl, rawSubUrl);
                      if (subUrl) {
                        if (!parsedVariants[resolutionLabel] || bandwidth > parsedVariants[resolutionLabel].bandwidth) {
                          parsedVariants[resolutionLabel] = { url: subUrl, bandwidth: bandwidth };
                        }
                      }
                    }
                  }
                }

                for (const [quality, variant] of Object.entries(parsedVariants)) {
                  streams.push({
                    name: "Dexter - " + quality,
                    title,
                    url: variant.url,
                    quality: quality,
                    isM3u8: true,
                    provider: "dexter",
                    type: "hls",
                    subtitles: subtitles
                  });
                }
              }
            } catch (err) {
              console.log("[Dexter] M3U8 parse hatasi: " + err.message);
            }
          } else if (isDash) {
            streams.push({
              name: "Dexter - " + serverLabel + " (DASH)",
              title,
              url: mainUrl,
              quality: "Auto",
              isM3u8: false,
              provider: "dexter",
              type: "dash",
              subtitles: subtitles
            });
          }
        }

        console.log("[Dexter] Found " + streams.length + " streams");
        return streams;
      });
    }
    module2.exports = { extractStreams: extractStreams2 };
  }
});

// src/dexterpw/index.js
var import_http = __toESM(require_http());
var import_extractor = __toESM(require_extractor());
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[Dexter] Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    try {
      const details = yield (0, import_http.fetchDetails)(tmdbId, mediaType, season, episode);
      if (!details || details.playable === false || !Array.isArray(details.sources) || details.sources.length === 0) {
        console.log("[Dexter] No sources available");
        return [];
      }
      const streams = yield (0, import_extractor.extractStreams)(details);
      return streams;
    } catch (err) {
      console.log("[Dexter] getStreams error: " + err.message);
      return [];
    }
  });
}
module.exports = { getStreams };
