/**
 * vixsrc - VixSrc (vixsrc.to) saglayicisi - Nuvio
 * Akis: TMDB -> /api/movie/{id} | /api/tv/{id}/{s}/{e} (Referer sart) -> {src:"/embed/..."}
 *   -> embed sayfasi: window.masterPlaylist {token, expires, url}
 *   -> playlist/{id}?b=1&token=...&expires=...&h=1&lang=xx -> master m3u8
 *      (480p/720p/1080p varyantlari + cok dilli ses gruplari)
 *   -> TYPE=SUBTITLES satirlarindaki m3u8'lerden .vtt adresleri cikarilir.
 * Not: playlist token'i ~60 gun gecerli; medya istekleri Referer istemez (yine de gonderilir).
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var SITE = "https://vixsrc.to";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_SUBS = 12;

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

  function qualityFromHeight(h) {
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    return "Auto";
  }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function grab(block, key) {
    var m = block.match(new RegExp("['\"]?" + key + "['\"]?\\s*:\\s*'([^']+)'"));
    if (m) return m[1];
    m = block.match(new RegExp("['\"]?" + key + "['\"]?\\s*:\\s*\"([^\"]+)\""));
    if (m) return m[1];
    m = block.match(new RegExp("['\"]?" + key + "['\"]?\\s*:\\s*([0-9]+)"));
    return m ? m[1] : "";
  }

  function parseEmbed(html) {
    var i = String(html || "").indexOf("masterPlaylist");
    var seg = i >= 0 ? String(html).slice(i, i + 700) : "";
    return { url: grab(seg, "url"), token: grab(seg, "token"), expires: grab(seg, "expires") };
  }

  function parseSubTracks(master) {
    var lines = String(master || "").split("\n");
    var out = [], seen = {};
    lines.forEach(function (ln) {
      if (ln.indexOf("TYPE=SUBTITLES") < 0) return;
      var name = (ln.match(/NAME="([^"]+)"/) || [])[1] || "";
      var uri = (ln.match(/URI="([^"]+)"/) || [])[1] || "";
      if (!uri) return;
      var key = (name || uri).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ lang: name || "und", uri: uri });
    });
    return out;
  }

  function subVttUrl(sub) {
    return fetchTimeout(sub.uri, { headers: { "User-Agent": UA, Accept: "*/*" } }).then(function (r) {
      return r.ok ? r.text() : "";
    }, function () { return ""; }).then(function (txt) {
      var m = String(txt || "").match(/https?:\/\/[^\s"']+/);
      if (!m) return null;
      return { url: m[0], lang: sub.lang };
    });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[vixsrc]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var pageUrl = isTv ? SITE + "/tv/" + tmdbId + "/" + s + "/" + e : SITE + "/movie/" + tmdbId;
    var apiUrl = SITE + "/api/" + (isTv ? "tv/" + tmdbId + "/" + s + "/" + e : "movie/" + tmdbId);
    var display = "";

    return pAll([
      fetchTimeout(apiUrl, { headers: { "User-Agent": UA, Accept: "application/json", Referer: pageUrl } })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }),
      tmdbLookup(tmdbId, isTv)
    ]).then(function (res) {
      var j = (res[0] && res[0].ok) ? res[0].v : null;
      var info = (res[1] && res[1].ok) ? res[1].v : null;
      if (info) {
        display = info.title || info.name || "";
        var y = String(info.release_date || info.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      if (!j || !j.src) return { streams: [] };
      var embedUrl = j.src.indexOf("http") === 0 ? j.src : SITE + j.src;
      var lang = (embedUrl.match(/lang=([a-z]{2})/) || [])[1] || "en";
      return fetchTimeout(embedUrl, { headers: { "User-Agent": UA, Accept: "text/html", Referer: pageUrl } })
        .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
        .then(function (html) {
          var mp = parseEmbed(html);
          if (!mp.url) return { streams: [] };
          var sep = mp.url.indexOf("?") >= 0 ? "&" : "?";
          var playlistUrl = mp.url + sep + "token=" + mp.token + "&expires=" + mp.expires + "&h=1&lang=" + lang;
          return fetchTimeout(playlistUrl, { headers: { "User-Agent": UA, Accept: "*/*", Referer: embedUrl } })
            .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
            .then(function (master) {
              if (!master || master.indexOf("#EXTM3U") !== 0) return { streams: [] };
              var maxH = 0;
              (master.match(/RESOLUTION=\d+x(\d+)/g) || []).forEach(function (rs) {
                var h = Number((rs.match(/(\d+)$/) || [])[1]) || 0;
                if (h > maxH) maxH = h;
              });
              var q = qualityFromHeight(maxH);
              return pAll(parseSubTracks(master).slice(0, MAX_SUBS).map(subVttUrl)).then(function (subsRes) {
                var subs = subsRes.filter(function (x) { return x.ok && x.v; }).map(function (x) { return x.v; });
                var langs = subs.map(function (x) { return x.lang; });
                var extra = langs.length ? " | " + langs.slice(0, 6).join(", ") + (langs.length > 6 ? " +" + (langs.length - 6) : "") : "";
                var stream = {
                  name: "VixSrc - " + q,
                  title: display + "\n" + q + extra,
                  url: playlistUrl,
                  quality: q,
                  isM3u8: true,
                  type: "hls",
                  headers: { Referer: SITE + "/", "User-Agent": UA },
                  subtitles: subs,
                  provider: "vixsrc"
                };
                return { streams: [stream] };
              });
            });
        });
    }).then(function (payload) {
      var out = (payload && payload.streams) || [];
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
