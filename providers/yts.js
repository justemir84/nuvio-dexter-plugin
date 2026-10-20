/**
 * yts - YTS torrent provider for Nuvio (yts.mx)
 * Flow: TMDB -> title/year -> ?api=torrents -> magnet list
 *
 * Returns magnet URIs (same contract as the Torrentio provider).
 * Magnets need a debrid service or a P2P-capable Nuvio build;
 * without one Nuvio reports "torrent streaming not supported".
 *
 * Hermes-safe: Promise chains only, no async/await, no generators, no deps.
 */
(function () {
  "use strict";

  var BASE = "https://yts.lt/";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TIMEOUT = 12000;
  var MAX_STREAMS = 12;

  function fetchTimeout(url, options, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function parseQuality(title) {
    var s = String(title || "").toLowerCase();
    if (/2160p/.test(s) || /\b4k\b/.test(s)) return "2160p";
    if (/1080p/.test(s)) return "1080p";
    if (/720p/.test(s)) return "720p";
    if (/480p/.test(s)) return "480p";
    return "HD";
  }

  function parseRelease(title) {
    var s = " " + String(title || "").toLowerCase().replace(/[^a-z0-9+.]+/g, " ") + " ";
    var codec = /x265|hevc|h265|h\.265/.test(s) ? "HEVC x265" : (/x264|h264|h\.264|avc/.test(s) ? "H.264" : (/av1/.test(s) ? "AV1" : ""));
    var depth = /10bit|10 bit|hi10/.test(s) ? "10bit" : "";
    var hdr = /dolby.?vision|\bdv\b|\bdovi\b/.test(s) ? "DV" : (/hdr10\+/.test(s) ? "HDR10+" : (/hdr10/.test(s) ? "HDR10" : (/hdr\b/.test(s) ? "HDR" : (/hlg/.test(s) ? "HLG" : (/ sdr/.test(s) ? "SDR" : "")))));
    var audio = /truehd/.test(s) ? "TrueHD" : (/dts/.test(s) ? "DTS" : (/atmos/.test(s) ? "Atmos" : ""));
    var ach = /ddp.?5\.1|dd.?5\.1|ac.?3|5\.1/.test(s) ? "5.1" : (/7\.1/.test(s) ? "7.1" : (/aac/.test(s) ? "AAC" : ""));
    var src = /remux/.test(s) ? "REMUX" : (/bluray|blu.?ray/.test(s) ? "BluRay" : (/web.?dl/.test(s) ? "WEB-DL" : (/webrip/.test(s) ? "WEBRip" : (/hdtv/.test(s) ? "HDTV" : (/dvdrip|dvd/.test(s) ? "DVD" : "")))));
    var lang = /dual/.test(s) ? "Dual Audio" : (/multi|hindi.*english|eng.*hin/.test(s) ? (/hindi/.test(s) ? "Multi (Hindi+Eng)" : "Multi Audio") : "");
    return { codec: codec, depth: depth, hdr: hdr, audio: (audio + (ach ? " " + ach : "")).trim(), src: src, lang: lang };
  }

  function fmtBytes(b) {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
    if (b >= 1048576) return Math.round(b / 1048576) + " MB";
    return b + " B";
  }

  function fmtSeeds(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  function pad2(n) {
    n = parseInt(n, 10);
    return (n < 10 ? "0" : "") + n;
  }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": UA, "Accept": "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("TMDB " + r.status);
        return r.json();
      })
      .then(function (d) {
        return {
          title: d.name || d.title || d.original_name || d.original_title || "",
          year: (d.first_air_date || d.release_date || "").substring(0, 4)
        };
      });
  }

  function torrentsApi(title, year, mediaType) {
    var mode = mediaType === "tv" ? "tv" : "movie";
    var path = mediaType === "tv" ? "/series/x" : "/movie/x";
    var url = BASE + path + "?api=torrents&mode=" + mode +
      "&name=" + encodeURIComponent(title) +
      "&year=" + encodeURIComponent(year || "") +
      "&quality=all";
    return fetchTimeout(url, { headers: { "User-Agent": UA, "Accept": "application/json", "Referer": BASE + "/" } })
      .then(function (r) {
        if (!r.ok) throw new Error("API " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (d && Array.isArray(d.hits)) return d.hits;
        return [];
      });
  }

  function epMatch(title, season, episode) {
    var s = pad2(season), e = pad2(episode);
    var t = " " + String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    var pats = [
      " s" + s + "e" + e + " ",
      " s" + parseInt(season, 10) + "e" + parseInt(episode, 10) + " ",
      " " + parseInt(season, 10) + "x" + pad2(episode) + " ",
      " season " + parseInt(season, 10) + " episode " + parseInt(episode, 10) + " "
    ];
    for (var i = 0; i < pats.length; i++) {
      if (t.indexOf(pats[i]) !== -1) return true;
    }
    return false;
  }

  function seasonMatch(title, season) {
    var t = " " + String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    var s = pad2(season);
    var pats = [
      " s" + s + " ", " s" + parseInt(season, 10) + " ",
      " season " + s + " ", " season " + parseInt(season, 10) + " ",
      " s" + s + "e", " complete ", " pack "
    ];
    for (var i = 0; i < pats.length; i++) {
      if (t.indexOf(pats[i]) !== -1) return true;
    }
    return false;
  }

  function toStream(hit, display, quality) {
    var seeds = fmtSeeds(hit.seeds);
    var size = fmtBytes(hit.bytes);
    var q = quality || parseQuality(hit.title);
    var r = parseRelease(hit.title);
    var line2 = [q, [r.codec, r.depth].filter(Boolean).join(" "), [r.hdr, r.audio].filter(Boolean).join(" "), r.src, r.lang].filter(Boolean).join(" | ");
    var text = display + "\n" + line2 + "\nSeeds " + seeds + " | " + size + " | " + (hit.source || "torrent");
    return {
      name: "YTS " + q + " (S" + seeds + ")",
      title: text,
      size: text,
      description: text,
      url: hit.magnetUrl,
      quality: q,
      provider: "yts"
    };
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 2.5;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480/.test(q)) return 1;
    return 0;
  }
  function qSort(list) {
    var hd = list.filter(function (s) { return qRank(s.quality) >= 2.5; });
    var base = hd.length ? hd : list;
    base.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return base;
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[YTS]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId +
      (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    var ctx = {};
    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      if (!info.title) { console.log(tag + " TMDB lookup failed"); return []; }
      ctx.title = info.title;
      ctx.year = info.year;
      console.log(tag + " TMDB: " + info.title + " (" + info.year + ")");
      return torrentsApi(info.title, info.year, mediaType);
    }).then(function (hits) {
      if (!hits || !hits.length) { console.log(tag + " No torrents"); return []; }
      var list = hits.filter(function (h) { return h && h.magnetUrl && h.magnetUrl.indexOf("magnet:") === 0; });
      var display = ctx.title + (ctx.year ? " (" + ctx.year + ")" : "");
      if (mediaType === "tv") {
        display += " S" + pad2(season || 1) + "E" + pad2(episode || 1);
        var eps = list.filter(function (h) { return epMatch(h.title, season || 1, episode || 1); });
        var picked = eps.length ? eps : list.filter(function (h) { return seasonMatch(h.title, season || 1); });
        picked.sort(function (a, b) {
          var r = qRank(parseQuality(b.title)) - qRank(parseQuality(a.title));
          return r || ((b.seeds || 0) - (a.seeds || 0));
        });
        var hd = picked.filter(function (h) { return qRank(parseQuality(h.title)) >= 2.5; });
        var streams = (hd.length ? hd : picked).slice(0, MAX_STREAMS).map(function (h) {
          return toStream(h, display + (eps.length ? "" : " Pack"));
        });
        console.log(tag + " Found " + streams.length + " streams");
        return streams;
      }
      list.sort(function (a, b) {
        var r = qRank(parseQuality(b.title)) - qRank(parseQuality(a.title));
        return r || ((b.seeds || 0) - (a.seeds || 0));
      });
      var hd = list.filter(function (h) { return qRank(parseQuality(h.title)) >= 2.5; });
      var out = (hd.length ? hd : list).slice(0, MAX_STREAMS).map(function (h) { return toStream(h, display); });
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
