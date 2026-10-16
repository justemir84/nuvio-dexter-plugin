/**
 * moviesapi - MoviesAPI (moviesapi.to / VidSpark) saglayicisi - Nuvio
 * Akis: TMDB id -> /api/vidora/v1/{movie|tv} (x-player-key) -> m3u8 master + VTT altyazilar
 * Kalite master m3u8 RESOLUTION'dan okunur. Oynatma icin Referer zorunlu.
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://moviesapi.to/api/vidora/v1";
  var SITE = "https://moviesapi.to/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var KEY = "3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13";
  var TIMEOUT = 12000;
  var MAX_SOURCES = 3;

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

  function qualityFromMaster(text) {
    var re = /RESOLUTION=(\d+)x(\d+)/g;
    var m, w = 0;
    while ((m = re.exec(text)) !== null) {
      var v = Number(m[1]);
      if (v > w) w = v;
    }
    if (w >= 3200) return "4K";
    if (w >= 1800) return "1080p";
    if (w >= 1100) return "720p";
    if (w >= 800) return "480p";
    if (w >= 600) return "360p";
    return "Auto";
  }

  function buildSubs(tracks) {
    var subs = [], seen = {};
    (tracks || []).forEach(function (t) {
      if (!t || !t.file) return;
      var lang = t.label || "und";
      var k = String(lang).toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      subs.push({ url: t.file, lang: lang });
    });
    return subs;
  }

  function langLabel(subs) {
    var names = subs.slice(0, 6).map(function (s) { return s.lang; });
    var extra = subs.length - names.length;
    return names.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[moviesapi]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var path = isTv ? "/tv/" + tmdbId + "/" + s + "/" + e : "/movie/" + tmdbId;
    var ref = SITE + (isTv ? "tv/" + tmdbId + "/" + s + "/" + e : "movie/" + tmdbId);
    var display = "";
    var subs = [];

    return fetchTimeout(API + path, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: ref, "x-player-key": KEY }
    }).then(function (r) {
      if (!r.ok) throw new Error("API " + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.result || !d.sources || !d.sources.length) return [];
      display = d.title || ("TMDB " + tmdbId);
      if (d.year) display += " (" + d.year + ")";
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      var allTracks = [];
      d.sources.forEach(function (src) {
        (src.tracks || []).forEach(function (t) { allTracks.push(t); });
      });
      subs = buildSubs(allTracks);
      var pick = d.sources.slice(0, MAX_SOURCES);
      return Promise.all(pick.map(function (src) {
        return fetchTimeout(src.url, { headers: { "User-Agent": UA, Referer: SITE } })
          .then(function (m) { return m.ok ? m.text() : ""; }, function () { return ""; })
          .then(function (txt) { return { src: src, quality: txt ? qualityFromMaster(txt) : "Auto" }; });
      }));
    }).then(function (list) {
      var out = [];
      (list || []).forEach(function (item) {
        if (!item || !item.src) return;
        var extra = subs.length ? " | " + langLabel(subs) : "";
        out.push({
          name: "MoviesAPI - " + item.quality,
          title: display + "\n" + item.quality + " [HLS]" + extra,
          url: item.src.url,
          quality: item.quality,
          isM3u8: true,
          type: "hls",
          headers: { Referer: SITE, "User-Agent": UA },
          subtitles: subs,
          provider: "moviesapi"
        });
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
