/**
 * streamo - Streamo provider for Nuvio
 * Flow: TMDB id -> guest-token -> resolve?ref= -> m3u8 master + subs
 * (torbox providerlar debrid ister, atlanir)
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://streamo.st/api/streaming";
  var REF = "https://streamw.st/";
  var SITE = "https://streamo.st/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_PROV = 4;

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

  function jpost(path, body) {
    return fetchTimeout(API + path, {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Referer: SITE },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }

  function jget(url) {
    return fetchTimeout(url, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE }
    }).then(function (r) {
      if (!r.ok) throw new Error("get " + r.status);
      return r.json();
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
    if (/2160|4k/.test(s)) return "2160p";
    if (/1080/.test(s)) return "1080p";
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
    var body = mediaType === "tv"
      ? { tmdbId: Number(tmdbId), type: "tv", season: season || 1, episode: episode || 1 }
      : { tmdbId: Number(tmdbId), type: "movie" };
    return jpost("/subtitles", body).then(function (d) {
      var out = [];
      (d.tracks || []).forEach(function (t) {
        if (t && t.url) out.push({ url: t.url, lang: t.title || t.language || "Unknown" });
      });
      return out;
    }).catch(function () { return []; });
  }

  function resolveRef(ref) {
    return jget(API + "/resolve?ref=" + encodeURIComponent(ref)).then(function (d) {
      if (d && typeof d.url === "string" && /^https?:\/\//.test(d.url)) return d.url;
      return null;
    }).catch(function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[Streamo]";
    var type = mediaType === "tv" ? "tv" : "movie";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId);
    var info = null, subs = [];
    return tmdbLookup(tmdbId, type).then(function (d) {
      info = d;
      return fetchSubs(tmdbId, type, season, episode);
    }).then(function (ss) {
      subs = ss;
      var body = { tmdbId: Number(tmdbId), type: type };
      if (type === "tv") { body.season = season || 1; body.episode = episode || 1; }
      return jpost("/guest-token", body);
    }).then(function (tok) {
      var provs = (tok && tok.data && tok.data.providers) || [];
      provs = provs.filter(function (p) {
        return p && p.url && String(p.kind || "").toLowerCase() !== "torbox";
      }).slice(0, MAX_PROV);
      if (!provs.length) { console.log(tag + " No providers"); return []; }
      var subLangs = subs.map(function (x) { return x.lang; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(",");
      var display = (info && info.title ? info.title : "Video") + (info && info.year ? " (" + info.year + ")" : "");
      if (type === "tv") {
        var s = season || 1, e = episode || 1;
        display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      }
      var chain = Promise.resolve([]);
      provs.forEach(function (p) {
        chain = chain.then(function (acc) {
          return resolveRef(p.url).then(function (playUrl) {
            if (!playUrl) return acc;
            var quals = p.allQualities || [];
            var best = "HD", i;
            for (i = 0; i < quals.length; i++) {
              var q = parseQuality(quals[i] && quals[i].quality);
              if (q === "2160p") { best = q; break; }
              if (q === "1080p" && best !== "1080p") best = q;
              if (best === "HD" && q !== "HD") best = q;
            }
            var fn = "";
            var hm = playUrl.match(/#fn=([^&]+)/);
            if (hm) fn = hm[1];
            var r = parseRelease(fn);
            var extra = [[r.codec, r.depth].join(" "), [r.hdr, r.audio].join(" ")].filter(Boolean).join(" | ");
            acc.push({
              name: "Streamo - " + best + " (" + (p.name || "srv") + ")",
              title: display + "\n" + best + (extra ? " | " + extra : "") + " [HLS]" + (subLangs ? " | " + subLangs : ""),
              url: playUrl, quality: best, isM3u8: /\.m3u8/i.test(playUrl.split("#")[0]), type: "hls",
              headers: { Referer: SITE, "User-Agent": UA },
              subtitles: subs, provider: "streamo"
            });
            return acc;
          });
        });
      });
      return chain.then(function (all) {
        all.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
        console.log(tag + " Found " + all.length + " streams");
        return all;
      });
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
