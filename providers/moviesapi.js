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
  var ORIGIN = "https://moviesapi.to";
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

  function codecTag(cds, rng) {
    cds = String(cds || "").toLowerCase();
    var dv = /dvh[1e]|dvhe|dav1/.test(cds) ? "DV" : "";
    var v = dv ? "HEVC" : (/hvc1|hev1|hevc/.test(cds) ? "HEVC" : (/avc1|avc3|avc/.test(cds) ? "H.264" : (/av01/.test(cds) ? "AV1" : "")));
    var hdr = !dv && /^(PQ|HLG)$/i.test(String(rng || "")) ? "HDR" : "";
    var a = /ec-3|eac3|ddp/.test(cds) ? "DDP" : (/ac-3/.test(cds) ? "DD" : (/mp4a|aac/.test(cds) ? "AAC" : ""));
    var full = [v, dv || hdr, a].filter(function (x) { return !!x; }).join(" ");
    return { v: v, tag: full };
  }

  function masterInfo(text) {
    text = String(text || "");
    var lines = text.split(/\r?\n/), bestW = -1, bestLine = "", curLine = "", i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
        curLine = line;
      } else if (line && line.charAt(0) !== "#" && curLine) {
        var m = curLine.match(/RESOLUTION=(\d+)x(\d+)/);
        var w = m ? parseInt(m[1], 10) : 0;
        if (w >= bestW) { bestW = w; bestLine = curLine; }
        curLine = "";
      }
    }
    var wmax = bestW > 0 ? bestW : 0;
    if (bestW < 0) {
      var re = /RESOLUTION=(\d+)x(\d+)/g, mm;
      while ((mm = re.exec(text)) !== null) { var vv = Number(mm[1]); if (vv > wmax) wmax = vv; }
    }
    var q = wmax >= 3200 ? "4K" : (wmax >= 1800 ? "1080p" : (wmax >= 1100 ? "720p" : (wmax >= 800 ? "480p" : (wmax >= 600 ? "360p" : "Auto"))));
    var cds = (bestLine.match(/CODECS="([^"]+)"/i) || [])[1] || "";
    var rng = (bestLine.match(/VIDEO-RANGE=([A-Z0-9]+)/i) || [])[1] || "";
    var ct = codecTag(cds, rng);
    return { q: q, v: ct.v, tag: ct.tag };
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
        return fetchTimeout(src.url, { headers: { "User-Agent": UA, Referer: SITE, Origin: ORIGIN } })
          .then(function (m) { return m.ok ? m.text() : ""; }, function () { return ""; })
          .then(function (txt) { var mi = txt ? masterInfo(txt) : null; return { src: src, quality: (mi && mi.q) || "Auto", vtag: mi ? mi.v : "", tags: mi ? mi.tag : "" }; });
      }));
    }).then(function (list) {
      var out = [];
      (list || []).forEach(function (item) {
        if (!item || !item.src) return;
        var extra = subs.length ? " | " + langLabel(subs) : "";
        var vtag = item.vtag ? " " + item.vtag : "";
        var ttag = item.tags ? " " + item.tags : "";
        out.push({
          name: "MoviesAPI - " + item.quality + vtag,
          title: display + "\n" + item.quality + ttag + " [HLS]" + extra,
          url: item.src.url,
          quality: item.quality,
          isM3u8: true,
          type: "hls",
          headers: { Referer: SITE, Origin: ORIGIN, "User-Agent": UA },
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
