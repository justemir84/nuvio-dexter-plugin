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
          var subLangs = subtitles.map(function (s) { return s.lang; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join(",");

          if (isDirectLink) {
            streams.push({
              name: "Dexter - " + serverLabel,
              title: title + "\n" + (source.quality || "Auto") + " | " + serverLabel + (subLangs ? " | " + subLangs : ""),
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
              title: title + "\nAuto | " + serverLabel + (subLangs ? " | " + subLangs : ""),
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
                    title: title + "\n" + quality + " | " + serverLabel + (subLangs ? " | " + subLangs : ""),
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
              title: title + "\n" + (source.quality || "Auto") + " | " + serverLabel + (subLangs ? " | " + subLangs : ""),
              url: mainUrl,
              quality: source.quality || "Auto",
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


// src/idlix/extractor.js
var require_extractor = __commonJS({
  "src/idlix/extractor.js"(exports2, module2) {
    "use strict";

    function resolveUrl(base, relative) {
      if (!relative) return null;
      if (/^https?:\/\//i.test(relative)) return relative;
      if (relative.startsWith("//")) return "https:" + relative;
      try { return new URL(relative, base).href; } catch (e) { return null; }
    }

    function qualityLabel(width, height) {
      var ref = Math.max(width || 0, height || 0);
      if (ref >= 1900) return "1080p";
      if (ref >= 1200) return "720p";
      if (ref >= 800)  return "480p";
      if (ref >= 600)  return "360p";
      return "SD";
    }

    function parseMasterPlaylist(text, baseUrl) {
      var lines = text.split(/\r?\n/);
      var variants = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

        var bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        var resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        var bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        var width = resMatch ? parseInt(resMatch[1], 10) : 0;
        var height = resMatch ? parseInt(resMatch[2], 10) : 0;

        var k = i + 1;
        while (k < lines.length && (lines[k].trim() === "" || lines[k].trim().startsWith("#"))) k++;
        if (k >= lines.length) continue;

        var uri = lines[k].trim();
        var fullUrl = resolveUrl(baseUrl, uri);
        if (!fullUrl) continue;

        variants.push({
          url: fullUrl,
          bandwidth: bandwidth,
          width: width,
          height: height,
          quality: qualityLabel(width, height)
        });
      }
      return variants;
    }

    function buildStreams(variants, subtitles, title) {
      var best = {};
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        if (!best[v.quality] || v.bandwidth > best[v.quality].bandwidth) {
          best[v.quality] = v;
        }
      }

      var order = ["1080p", "720p", "480p", "360p", "SD"];
      var streams = [];
      var subLangs = (subtitles || []).map(function (s) { return s.lang; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join(",");
      for (var j = 0; j < order.length; j++) {
        var key = order[j];
        if (!best[key]) continue;
        var variant = best[key];
        streams.push({
          name: "IDLIX - " + variant.quality,
          title: title + "\n" + variant.quality + (subLangs ? " | " + subLangs : ""),
          url: variant.url,
          quality: variant.quality,
          isM3u8: true,
          provider: "idlix",
          type: "hls",
          subtitles: subtitles
        });
      }
      return streams;
    }

    module2.exports = {
      parseMasterPlaylist: parseMasterPlaylist,
      buildStreams: buildStreams
    };
  }
});


// src/idlix/index.js
var import_http = __toESM(require_http());
var import_tmdb = __toESM(require_tmdb());
var import_extractor = __toESM(require_extractor());

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    var tag = "[IDLIX]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + "E" + episode : ""));

    try {
      function readCfClearance() {
        try {
          if (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS && globalThis.SCRAPER_SETTINGS.cf_clearance_cookie) {
            return String(globalThis.SCRAPER_SETTINGS.cf_clearance_cookie).trim();
          }
        } catch (e) {}

        try {
          if (typeof global !== "undefined" && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.cf_clearance_cookie) {
            return String(global.SCRAPER_SETTINGS.cf_clearance_cookie).trim();
          }
        } catch (e) {}

        try {
          if (typeof window !== "undefined" && window.SCRAPER_SETTINGS && window.SCRAPER_SETTINGS.cf_clearance_cookie) {
            return String(window.SCRAPER_SETTINGS.cf_clearance_cookie).trim();
          }
        } catch (e) {}

        try {
          if (typeof process !== "undefined" && process.env && process.env.IDLIX_CF_CLEARANCE) {
            return process.env.IDLIX_CF_CLEARANCE;
          }
        } catch (e) {}

        return "";
      }

      var cf_clearance = readCfClearance();

      if (!cf_clearance) {
        console.log(tag + " cf_clearance cookie ayarlanmamış. Lütfen Nuvio ayarlarından girin.");
        return [];
      }

      var tmdbInfo = yield import_tmdb.lookup(tmdbId, mediaType);
      if (!tmdbInfo.title) { console.log(tag + " TMDB lookup failed"); return []; }
      console.log(tag + " TMDB: " + tmdbInfo.title + " (" + tmdbInfo.year + ")");

      var searchRes = yield import_http.search(tmdbInfo.title, cf_clearance);
      if (!searchRes || !Array.isArray(searchRes.results)) { console.log(tag + " Search failed"); return []; }

      var wantType = mediaType === "tv" ? "tv_series" : "movie";
      var candidates = searchRes.results.filter(function(r) {
        if (r.contentType !== wantType) return false;
        var dateStr = r.releaseDate || r.firstAirDate || "";
        var year = dateStr.substring(0, 4);
        if (tmdbInfo.year && year && year !== tmdbInfo.year) return false;
        return true;
      });

      if (candidates.length === 0) { console.log(tag + " No match"); return []; }
      var item = candidates[0];
      console.log(tag + " Match: " + item.title + " (" + item.slug + ")");

      var uuid, kind, displayTitle;

      if (mediaType === "tv") {
        var series = yield import_http.getSeries(item.slug, cf_clearance);
        if (!series || !Array.isArray(series.seasons)) { console.log(tag + " Series fetch failed"); return []; }

        var targetSeason = series.seasons.find(function(s) { return s.seasonNumber === parseInt(season); });
        if (!targetSeason) { console.log(tag + " Season not found"); return []; }

        var eps = null;
        if (series.defaultSeason && series.defaultSeason.seasonNumber === targetSeason.seasonNumber) {
          eps = series.defaultSeason.episodes;
        }
        if (!eps) {
          try {
            var seasonData = yield import_http.getSeriesSeason(item.slug, season, cf_clearance);
            eps = (seasonData && seasonData.episodes) || (seasonData && seasonData.season && seasonData.season.episodes) || null;
          } catch (e) { console.log(tag + " Season fetch error: " + e.message); }
        }
        if (!eps || !Array.isArray(eps)) { console.log(tag + " No episodes available"); return []; }

        var targetEp = eps.find(function(e) { return e.episodeNumber === parseInt(episode); });
        if (!targetEp) { console.log(tag + " Episode not found"); return []; }

        uuid = targetEp.id;
        kind = "episode";
        displayTitle = item.title + " - S" + season + "E" + episode + " - " + (targetEp.name || "");
      } else {
        uuid = item.id;
        kind = "movie";
        displayTitle = item.title;
      }

      var playInfo = yield import_http.getPlayInfo(kind, uuid, cf_clearance);
      if (!playInfo || !playInfo.gateToken) { console.log(tag + " No gateToken"); return []; }

      var waitMs = (playInfo.unlockAt || 0) - (playInfo.serverNow || Date.now());
      if (waitMs > 0 && waitMs < 60000) {
        console.log(tag + " Waiting " + Math.round(waitMs / 1000) + "s");
        yield new Promise(function(res) { setTimeout(res, waitMs + 500); });
      }

      var claimRes = yield import_http.claim(playInfo.gateToken, cf_clearance);
      if (!claimRes || !claimRes.claim) { console.log(tag + " Claim failed"); return []; }

      var redeemRes = yield import_http.redeem(claimRes.redeemUrl, claimRes.claim, cf_clearance);
      if (!redeemRes || !redeemRes.url) { console.log(tag + " Redeem failed"); return []; }

      var playlistRes = yield fetch(redeemRes.url, {
        headers: (function(){
          var h = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://z2.idlixku.com/"
          };
          if (cf_clearance) h["Cookie"] = "cf_clearance=" + cf_clearance;
          return h;
        })()
      });
      if (!playlistRes.ok) { console.log(tag + " Playlist HTTP " + playlistRes.status); return []; }
      var playlistText = yield playlistRes.text();

      var subtitles = [];
      if (Array.isArray(redeemRes.subtitles)) {
        redeemRes.subtitles.forEach(function(s) {
          if (s.path) subtitles.push({ url: s.path, lang: s.label || s.lang || "Unknown" });
        });
      }

      var base = redeemRes.url.replace(/[^/]*$/, "");
      var variants = import_extractor.parseMasterPlaylist(playlistText, base);
      var streams = import_extractor.buildStreams(variants, subtitles, displayTitle);

      console.log(tag + " Found " + streams.length + " streams");
      return streams;

    } catch (err) {
      console.log(tag + " Error: " + err.message);
      return [];
    }
  });
}

function onSettings() {
  return Promise.resolve([
    {
      type: "header",
      label: "IDLIX Configuration"
    },
    {
      type: "text",
      isPassword: true,
      key: "cf_clearance_cookie",
      label: "Cloudflare cf_clearance Cookie",
      placeholder: "cf_clearance değerini buraya yapıştırın...",
      description: "IDLIX sitesine erişmek için gerekli Cloudflare çerezi. README.md'de nasıl alınacağı anlatılmıştır."
    },
    {
      type: "header",
      label: "Not"
    },
    {
      type: "text",
      key: "info_note",
      label: "Cookie süresi",
      placeholder: "",
      description: "Cookie genellikle birkaç saat geçerlidir. Eklenti çalışmazsa yeni cookie alın."
    }
  ]);
}

module.exports = { getStreams, onSettings };


// src/idlix/http.js
var require_http = __commonJS({
  "src/idlix/http.js"(exports2, module2) {
    var BASE_URL = "https://z2.idlixku.com";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
    var TIMEOUT = 15000;

    function fetchWithTimeout(url, options, timeout) {
      timeout = timeout || TIMEOUT;
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

    function baseHeaders(cf_clearance) {
      var headers = {
        "User-Agent": UA,
        "Accept": "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/"
      };
      if (cf_clearance) {
        headers["Cookie"] = "cf_clearance=" + cf_clearance;
      }
      return headers;
    }

    function search(title, cf_clearance) {
      var url = BASE_URL + "/api/search?q=" + encodeURIComponent(title);
      return fetchWithTimeout(url, { headers: baseHeaders(cf_clearance) }).then(function(r) {
        if (!r.ok) throw new Error("Search " + r.status);
        return r.json();
      });
    }

    function getSeries(slug, cf_clearance) {
      var url = BASE_URL + "/api/series/" + encodeURIComponent(slug);
      return fetchWithTimeout(url, { headers: baseHeaders(cf_clearance) }).then(function(r) {
        if (!r.ok) throw new Error("Series " + r.status);
        return r.json();
      });
    }

    function getSeriesSeason(slug, seasonNumber, cf_clearance) {
      var url = BASE_URL + "/api/series/" + encodeURIComponent(slug) + "/season/" + encodeURIComponent(seasonNumber);
      return fetchWithTimeout(url, { headers: baseHeaders(cf_clearance) }).then(function(r) {
        if (!r.ok) throw new Error("Season " + r.status);
        return r.json();
      });
    }

    function getPlayInfo(kind, uuid, cf_clearance) {
      var url = BASE_URL + "/api/watch/play-info/" + kind + "/" + encodeURIComponent(uuid);
      return fetchWithTimeout(url, { headers: baseHeaders(cf_clearance) }).then(function(r) {
        if (!r.ok) throw new Error("PlayInfo " + r.status);
        return r.json();
      });
    }

    function claim(gateToken, cf_clearance) {
      var url = BASE_URL + "/api/watch/session/claim";
      var headers = baseHeaders(cf_clearance);
      headers["Content-Type"] = "application/json";
      headers["Origin"] = BASE_URL;
      var opts = {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ gateToken: gateToken })
      };
      return fetchWithTimeout(url, opts).then(function(r) {
        if (!r.ok) throw new Error("Claim " + r.status);
        return r.json();
      });
    }

    function redeem(redeemUrl, claimToken, cf_clearance) {
      var headers = baseHeaders(cf_clearance);
      headers["Content-Type"] = "application/json";
      headers["Origin"] = BASE_URL;
      var opts = {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ claim: claimToken, mode: "browser" })
      };
      return fetchWithTimeout(redeemUrl, opts).then(function(r) {
        if (!r.ok) throw new Error("Redeem " + r.status);
        return r.json();
      });
    }

    module2.exports = {
      BASE_URL: BASE_URL,
      search: search,
      getSeries: getSeries,
      getSeriesSeason: getSeriesSeason,
      getPlayInfo: getPlayInfo,
      claim: claim,
      redeem: redeem
    };
  }
});

// src/idlix/tmdb.js
var require_tmdb = __commonJS({
  "src/idlix/tmdb.js"(exports2, module2) {
    var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
    var TMDB_BASE = "https://api.themoviedb.org/3";

    function lookup(tmdbId, mediaType) {
      var type = mediaType === "tv" ? "tv" : "movie";
      var url = TMDB_BASE + "/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US";
      return fetch(url).then(function(r) {
        if (!r.ok) throw new Error("TMDB " + r.status);
        return r.json();
      }).then(function(d) {
        return {
          title: d.name || d.title || d.original_name || d.original_title || "",
          year: (d.first_air_date || d.release_date || "").substring(0, 4)
        };
      });
    }
    module2.exports = { lookup: lookup };
  }
});






