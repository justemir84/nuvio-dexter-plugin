/**
 * vaplayer - VAplayer provider for Nuvio (streamdata.vaplayer.ru)
 * Akis: TMDB id -> api.php -> file_name (kalite/codec) + stream_urls[] HLS master aynalari + vdrk altyazilar
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://streamdata.vaplayer.ru/api.php";
  var SUBS = "https://sub.vdrk.site";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_MIRRORS = 3;

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

  function parseRelease(s) {
    try { s = decodeURIComponent(s); } catch (e) {}
    s = " " + String(s || "").toLowerCase().replace(/[^a-z0-9+.]+/g, " ") + " ";
    var codec = /x265|hevc|h265/.test(s) ? "HEVC x265" : (/x264|h264|avc/.test(s) ? "H.264" : "");
    var depth = /10bit|10 bit|hi10/.test(s) ? "10bit" : "";
    var hdr = /dolby.?vision|\bdv\b|\bdovi\b/.test(s) ? "DV" : (/hdr10\+/.test(s) ? "HDR10+" : (/hdr10/.test(s) ? "HDR10" : (/hdr\b/.test(s) ? "HDR" : "")));
    var audio = /truehd/.test(s) ? "TrueHD" : (/atmos/.test(s) ? "Atmos" : (/dts/.test(s) ? "DTS" : ""));
    var ach = /ddp.?5\.1|dd.?5\.1|ac.?3|5\.1/.test(s) ? "5.1" : (/7\.1/.test(s) ? "7.1" : "");
    return { codec: codec, depth: depth, hdr: hdr, audio: (audio + (ach ? " " + ach : "")).trim() };
  }

  function parseQuality(v) {
    var s = String(v || "").toLowerCase();
    if (/2160|4k|uhd/.test(s)) return "2160p";
    if (/1080|fhd/.test(s)) return "1080p";
    if (/720/.test(s)) return "720p";
    if (/480/.test(s)) return "480p";
    if (/360/.test(s)) return "360p";
    return "HD";
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

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return r.json();
    }).then(function (d) {
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4)
      };
    });
  }

  function fetchSubs(tmdbId, mediaType, season, episode) {
    var url = mediaType === "tv"
      ? SUBS + "/v1/tv/" + encodeURIComponent(tmdbId) + "/" + (season || 1) + "/" + (episode || 1)
      : SUBS + "/v1/movie/" + encodeURIComponent(tmdbId);
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("subs " + r.status);
      return r.json();
    }).then(function (d) {
      var out = [];
      (Array.isArray(d) ? d : []).forEach(function (s) {
        if (s && s.file) out.push({ url: s.file, lang: s.label || s.language || "Unknown" });
      });
      return out;
    }).catch(function () { return []; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[VAplayer]";
    var type = mediaType === "tv" ? "tv" : "movie";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId);
    var info = null, subs = [];
    return tmdbLookup(tmdbId, type).then(function (d) {
      info = d;
      return fetchSubs(tmdbId, type, season, episode);
    }).then(function (ss) {
      subs = ss;
      var url = API + "?type=" + type + "&tmdb=" + encodeURIComponent(tmdbId);
      if (type === "tv") url += "&season=" + (season || 1) + "&episode=" + (episode || 1);
      return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
        if (!r.ok) throw new Error("api " + r.status);
        return r.json();
      });
    }).then(function (d) {
      var data = d && d.data;
      var urls = (data && Array.isArray(data.stream_urls)) ? data.stream_urls : [];
      if (!urls.length) { console.log(tag + " No sources"); return []; }
      var fileName = data.file_name || "";
      var quality = parseQuality(fileName);
      var rel = parseRelease(fileName);
      var extra = [];
      if (rel.codec || rel.depth) extra.push((rel.codec + " " + rel.depth).trim());
      var aura = (rel.hdr + " " + rel.audio).trim();
      if (aura) extra.push(aura);
      extra = extra.join(" | ");
      var langs = subs.map(function (x) { return x.lang; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      var subLangs = langs.slice(0, 6).join(",") + (langs.length > 6 ? " +" + (langs.length - 6) : "");
      var display = (info && info.title ? info.title : (data.title || "Video")) + (info && info.year ? " (" + info.year + ")" : "");
      if (type === "tv") {
        var s = season || 1, e = episode || 1;
        display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      }
      var out = [];
      urls.slice(0, MAX_MIRRORS).forEach(function (u, i) {
        if (!u || typeof u !== "string") return;
        var mi = i === 0 ? "" : " (M" + (i + 1) + ")";
        out.push({
          name: "VAplayer - " + quality + mi,
          title: display + "\n" + quality + (extra ? " | " + extra : "") + " [HLS]" + (subLangs ? " | " + subLangs : ""),
          url: u,
          quality: quality,
          isM3u8: true,
          type: "hls",
          headers: { "User-Agent": UA },
          subtitles: subs,
          provider: "vaplayer"
        });
      });
      console.log(tag + " Found " + out.length + " streams");
      return qSort(out);
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
