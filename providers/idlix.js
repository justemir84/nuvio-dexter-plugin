/**
 * idlix - IDLIX provider for Nuvio
 * Flow: TMDB -> title -> IDLIX search -> series/movie -> play-info -> claim -> majorplay -> m3u8
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
      try { step(generator.next(value)); } catch (e) { reject(e); }
    };
    var rejected = (value) => {
      try { step(generator.throw(value)); } catch (e) { reject(e); }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

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

    // Updated: accept optional cf_clearance value and include Cookie header when present
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
      // kind: "movie" | "episode"
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
      for (var j = 0; j < order.length; j++) {
        var key = order[j];
        if (!best[key]) continue;
        var variant = best[key];
        streams.push({
          name: "IDLIX - " + variant.quality,
          title: title,
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
      // Read setting from global Nuvio settings (fallback to empty)
      var cf_clearance = (typeof global !== 'undefined' && global.nuvio && global.nuvio.scraperSettings && global.nuvio.scraperSettings.cf_clearance_cookie) ? global.nuvio.scraperSettings.cf_clearance_cookie : (typeof process !== 'undefined' ? process.env.IDLIX_CF_CLEARANCE || "" : "");

      if (!cf_clearance) {
        console.log(tag + " cf_clearance cookie ayarlanmamış. Lütfen Nuvio ayarlarından girin.");
        return [];
      }

      // 1) TMDB -> title + year
      var tmdbInfo = yield import_tmdb.lookup(tmdbId, mediaType);
      if (!tmdbInfo.title) { console.log(tag + " TMDB lookup failed"); return []; }
      console.log(tag + " TMDB: " + tmdbInfo.title + " (" + tmdbInfo.year + ")");

      // 2) IDLIX search
      var searchRes = yield import_http.search(tmdbInfo.title, cf_clearance);
      if (!searchRes || !Array.isArray(searchRes.results)) { console.log(tag + " Search failed"); return []; }

      // 3) Filtrele: tür + yıl
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

      // 4) UUID bul
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

      // 5) Play-info
      var playInfo = yield import_http.getPlayInfo(kind, uuid, cf_clearance);
      if (!playInfo || !playInfo.gateToken) { console.log(tag + " No gateToken"); return []; }

      // 6) 15 sn bekle
      var waitMs = (playInfo.unlockAt || 0) - (playInfo.serverNow || Date.now());
      if (waitMs > 0 && waitMs < 60000) {
        console.log(tag + " Waiting " + Math.round(waitMs / 1000) + "s");
        yield new Promise(function(res) { setTimeout(res, waitMs + 500); });
      }

      // 7) Claim
      var claimRes = yield import_http.claim(playInfo.gateToken, cf_clearance);
      if (!claimRes || !claimRes.claim) { console.log(tag + " Claim failed"); return []; }

      // 8) Redeem
      var redeemRes = yield import_http.redeem(claimRes.redeemUrl, claimRes.claim, cf_clearance);
      if (!redeemRes || !redeemRes.url) { console.log(tag + " Redeem failed"); return []; }

      // 9) Master playlist
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

      // 10) Altyazılar
      var subtitles = [];
      if (Array.isArray(redeemRes.subtitles)) {
        redeemRes.subtitles.forEach(function(s) {
          if (s.path) subtitles.push({ url: s.path, lang: s.label || s.lang || "Unknown" });
        });
      }

      // 11) Parse + streams
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

module.exports = { getStreams };