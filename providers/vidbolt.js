/**
 * vidbolt - VidBolt (vidbolt.xyz) saglayicisi - Nuvio
 * Akis: TMDB -> /api/resolve?type={movie|tv}&id=..[&season=..&episode=..] JSON
 *   -> stream.sources[] -> HLS master (1080p/720p/480p + coklu ses + 5 altyazi)
 *   -> medya istekleri Referer: https://vidbolt.xyz/ ile cekilir.
 * Sunucular: orion (img.rousav.tech), quantum/vega (proxy.vidbolt.xyz),
 *   callisto (dash-hls-bridge workers -> sacdn h265). Yedekli: bos donerse
 *   sirasiyla quantum -> vega -> callisto -> fastva denenir.
 * Altyazilar HLS master icinde gruplu gelir (oynatici otomatik sunar).
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var SITE = "https://vidbolt.xyz";
  var RESOLVE = SITE + "/api/resolve";
  var REF = SITE + "/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_STREAMS = 3;
  var PREFERS = ["quantum", "vega", "callisto", "orion", "fastva"];

  function fetchTimeout(url, options, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var p = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([fetch(url, options || {}), p]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function pAll(list) {
    return Promise.all(list.map(function (p) {
      return p.then(function (v) { return { ok: true, v: v }; }, function () { return { ok: false, v: null }; });
    }));
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 2.5;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480|sd/.test(q)) return 1;
    return 0.5;
  }

  function resolve(qs) {
    return fetchTimeout(RESOLVE + "?" + qs, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: REF }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function sourcesOf(j) {
    var out = [];
    var seen = {};
    (((j || {}).stream || {}).sources || []).forEach(function (x) {
      if (!x || !x.url) return;
      if (seen[x.url]) return;
      seen[x.url] = true;
      out.push(x);
    });
    return out;
  }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[vidbolt]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var qs = "type=" + (isTv ? "tv" : "movie") + "&id=" + tmdbId + (isTv ? "&season=" + s + "&episode=" + e : "");
    var display = "";

    return pAll([
      resolve(qs),
      tmdbLookup(tmdbId, isTv)
    ]).then(function (results) {
      var boot = (results[0] && results[0].ok) ? results[0].v : null;
      var info = (results[1] && results[1].ok) ? results[1].v : null;
      if (info) {
        display = info.title || info.name || "";
        var y = String(info.release_date || info.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);

      var found = sourcesOf(boot);
      if (found.length) return { sources: found, server: ((boot || {}).stream || {}).server || "" };

      return pAll(PREFERS.map(function (p) { return resolve(qs + "&prefer=" + p); })).then(function (rs) {
        for (var i = 0; i < rs.length; i++) {
          var j = (rs[i] && rs[i].ok) ? rs[i].v : null;
          var fs = sourcesOf(j);
          if (fs.length) return { sources: fs, server: ((j || {}).stream || {}).server || PREFERS[i] };
        }
        return { sources: [], server: "" };
      });
    }).then(function (res) {
      var found = (res && res.sources) || [];
      var server = (res && res.server) || "";
      var out = found.slice(0, MAX_STREAMS).map(function (x, i) {
        var q = String(x.quality || x.name || "").trim() || "Auto";
        var label = q === "Auto" ? "Auto" : q;
        return {
          name: "VidBolt - " + label + (i > 0 ? " (mirror " + (i + 1) + ")" : ""),
          title: display + "\n" + label + " HLS [VidBolt" + (server ? " · " + server : "") + "] | 10 ses + 5 altyazi",
          url: x.url,
          quality: q,
          isM3u8: true,
          type: "hls",
          headers: { Referer: REF, "User-Agent": UA },
          subtitles: [],
          provider: "vidbolt"
        };
      });
      out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
      console.log(tag + " Found " + out.length + " streams");
      return out;
    }).catch(function (err) {
      console.log(tag + " Error: " + (err && err.message));
      return [];
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
