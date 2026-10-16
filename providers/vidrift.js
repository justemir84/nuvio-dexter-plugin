/**
 * vidrift - VidRift (embed.vidrift.net) saglayicisi - Nuvio
 * Akis: TMDB -> /api/boot/{movie/{id} | tv/{id}/{s}/{e}} JSON
 *   -> meta.orionStreams[] -> /api/orion/{md5}/master.m3u8 (fMP4 HLS, HEVC)
 *   -> medya istekleri Referer: https://embed.vidrift.net/ ister (yoksa 403).
 * Yedek: Orion yoksa /api/source/{path}?token=... (sunucu yarisi).
 * Altyazilar SSR HTML'e gomulu (subtitleTracks); HTML bazi aglarda kapali
 * olabilir, kapaliysa yalnizca akislar doner.
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var EMBED = "https://embed.vidrift.net";
  var SITE = EMBED + "/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_STREAMS = 8;
  var MAX_SUBS = 60;

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

  function rungInfo(rungs) {
    var maxW = 0, maxH = 0;
    (rungs || []).forEach(function (r) {
      if (!r) return;
      var w = Number(r.width) || 0;
      var h = Number(r.height) || 0;
      if (w > maxW) { maxW = w; maxH = h; }
    });
    return { w: maxW, h: maxH };
  }

  function qualityFromWidth(w) {
    if (w >= 3200) return "4K";
    if (w >= 1800) return "1080p";
    if (w >= 1200) return "720p";
    if (w >= 800) return "480p";
    if (w >= 600) return "360p";
    return "Auto";
  }

  function shortFlavor(name) {
    return String(name || "").replace(/^Orion\s*·\s*/, "").replace(/^Vela\s*·\s*/, "").replace(/^Lyra\s*·\s*/, "") || "Auto";
  }

  function parseSubs(html) {
    var i = html.indexOf("subtitleTracks");
    if (i < 0) return [];
    var s = html.indexOf("[", i);
    var e = html.indexOf("];", s);
    if (s < 0 || e < 0) return [];
    var arr = null;
    try { arr = JSON.parse(html.slice(s, e + 1)); } catch (err) { return []; }
    var subs = [], seen = {};
    (arr || []).forEach(function (t) {
      if (!t || !t.url || subs.length >= MAX_SUBS) return;
      var k = String(t.label || t.code || "").toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = true;
      subs.push({ url: t.url.indexOf("http") === 0 ? t.url : EMBED + t.url, lang: t.label || t.code || "und" });
    });
    return subs;
  }

  function langLabel(subs) {
    var names = subs.slice(0, 6).map(function (s) { return s.lang; });
    var extra = subs.length - names.length;
    return names.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function buildStream(f, display, subs, extra) {
    var q = f.q || "Auto";
    var res = f.w ? f.w + "x" + f.h + " · " : "";
    return {
      name: "VidRift - " + f.flavor + " " + q,
      title: display + "\n" + res + q + (f.hevc ? " HEVC" : "") + " [" + f.raw + "]" + extra,
      url: f.url,
      quality: q,
      isM3u8: true,
      type: "hls",
      headers: { Referer: SITE, "User-Agent": UA },
      subtitles: subs,
      provider: "vidrift"
    };
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[vidrift]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var path = isTv ? "/tv/" + tmdbId + "/" + s + "/" + e : "/movie/" + tmdbId;
    var bootUrl = EMBED + "/api/boot" + path;
    var pageUrl = EMBED + "/embed" + path;
    var display = "";

    return pAll([
      fetchTimeout(bootUrl, { headers: { "User-Agent": UA, Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }),
      tmdbLookup(tmdbId, isTv),
      fetchTimeout(pageUrl, { headers: { "User-Agent": UA, Accept: "text/html", Referer: SITE } })
        .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
    ]).then(function (results) {
      var boot = (results[0] && results[0].ok) ? results[0].v : null;
      var info = (results[1] && results[1].ok) ? results[1].v : null;
      var html = (results[2] && results[2].ok && results[2].v) ? results[2].v : "";
      var meta = (boot && boot.meta) ? boot.meta : null;
      if (info) {
        display = info.title || info.name || "";
        var y = String(info.release_date || info.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);

      var subs = html ? parseSubs(html) : [];
      var extra = subs.length ? " | " + langLabel(subs) : "";
      var found = [];
      var seen = {};

      ((meta && meta.orionStreams) || []).forEach(function (st) {
        if (!st || !st.url || seen[st.url]) return;
        seen[st.url] = true;
        var ri = rungInfo(st.rungs);
        found.push({
          url: EMBED + st.url,
          flavor: shortFlavor(st.name),
          raw: st.name || "Orion",
          q: qualityFromWidth(ri.w),
          w: ri.w,
          h: ri.h,
          hevc: true
        });
      });

      if (!found.length && meta && meta.playbackToken) {
        return fetchTimeout(EMBED + "/api/source" + path + "?token=" + encodeURIComponent(meta.playbackToken), {
          headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE }
        }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (j2) {
          ((j2 && j2.streams) || []).forEach(function (st) {
            if (!st) return;
            var u = st.url || st.proxyUrl || "";
            if (!u || seen[u]) return;
            if (u.indexOf("http") !== 0 && u.indexOf("/") !== 0) return;
            seen[u] = true;
            var ri = rungInfo(st.rungs);
            var prov = String(st.provider || (j2 && j2.provider) || "");
            var label = st.name ? shortFlavor(st.name) : (prov ? prov.charAt(0).toUpperCase() + prov.slice(1) : "Auto");
            found.push({
              url: u.indexOf("http") === 0 ? u : EMBED + u,
              flavor: label,
              raw: st.name || prov || "Auto",
              q: qualityFromWidth(ri.w),
              w: ri.w,
              h: ri.h,
              hevc: false
            });
          });
          return { found: found, subs: subs, extra: extra };
        });
      }
      return { found: found, subs: subs, extra: extra };
    }).then(function (payload) {
      var found = (payload && payload.found) || [];
      var subs = (payload && payload.subs) || [];
      var extra = (payload && payload.extra) || "";
      var out = found.map(function (f) { return buildStream(f, display, subs, extra); });
      out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
      out = out.slice(0, MAX_STREAMS);
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
