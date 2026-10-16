/**
 * vidlove - Vidlove saglayicisi - Nuvio
 * Akis: TMDB -> api.vidlove.cc/{movie|tv}?mode=json&hevc=1&vh=1 (&sources=...)
 * Kaynaklar: moviebox2 (4K HEVC), moviebox (H.264), vidapi (H.264). "Best" modu
 * altyazilari (cache.vdrk.site VTT) getirir ve varsayilan kaynagi secer.
 * API ve medya istekleri tarayici benzeri baslik seti ister (Referer: player.vidlove.cc).
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://api.vidlove.cc";
  var PLAYER = "https://player.vidlove.cc/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TIMEOUT = 12000;
  var MAX_STREAMS = 4;
  var MAX_SUBS = 100;
  var API_HEADERS = {
    "User-Agent": UA,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: PLAYER,
    "sec-ch-ua": "\"Not?A_Brand\";v=\"24\", \"Chromium\";v=\"152\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site"
  };
  var MEDIA_HEADERS = { Referer: PLAYER, "User-Agent": UA };
  var LABELS = { best: "Best", moviebox2: "MovieBox2", moviebox: "MovieBox", vidapi: "VidAPI" };

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

  function codecTag(text) {
    if (/hvc1|hev1/i.test(text)) return "HEVC";
    if (/avc1/i.test(text)) return "H.264";
    return "";
  }

  function rangeTag(text) {
    if (/dvh1|dvhe|DOVI/i.test(text)) return " DV";
    if (/VIDEO-RANGE=(PQ|HLG)/i.test(text)) return " HDR";
    return "";
  }

  function buildSubs(list) {
    var subs = [], seen = {};
    (list || []).forEach(function (t) {
      if (!t || !t.file || subs.length >= MAX_SUBS) return;
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

  function apiJson(path) {
    return fetchTimeout(API + path, { headers: API_HEADERS })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[vidlove]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var qs = "mode=json&hevc=1&vh=1";
    var bestPath = isTv
      ? "/tv?id=" + tmdbId + "&season=" + s + "&episode=" + e + "&" + qs
      : "/movie?id=" + tmdbId + "&" + qs;

    function build(list) {
      var meta = null, bestSubs = [], found = [], seen = {};
      (list || []).forEach(function (item) {
        if (!item || !item.j) return;
        var j = item.j;
        if (meta === null && j.meta && (j.meta.title || j.meta.name)) meta = j.meta;
        if (j.subtitles && j.subtitles.length && (item.key === "best" || !bestSubs.length)) bestSubs = j.subtitles;
        var src = j.source;
        if (!src || !src.url || seen[src.url]) return;
        seen[src.url] = true;
        var man = String(src.manifest || "");
        found.push({
          key: item.key,
          url: src.url,
          q: qualityFromMaster(man),
          codec: codecTag(man),
          rng: rangeTag(man)
        });
      });
      var subs = buildSubs(bestSubs);
      var display = "";
      if (meta) {
        display = meta.title || meta.show_name || meta.name || "";
        var y = String(meta.release_date || meta.air_date || meta.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      var extra = subs.length ? " | " + langLabel(subs) : "";
      var out = found.map(function (f) {
        var label = LABELS[f.key] || f.key;
        return {
          name: "Vidlove - " + label + " " + f.q,
          title: display + "\n" + f.q + (f.codec ? " " + f.codec : "") + f.rng + " [" + label + "]" + extra,
          url: f.url,
          quality: f.q,
          isM3u8: true,
          type: "hls",
          headers: MEDIA_HEADERS,
          subtitles: subs,
          provider: "vidlove"
        };
      });
      out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
      out = out.slice(0, MAX_STREAMS);
      console.log(tag + " Found " + out.length + " streams");
      return out;
    }

    var cands = [
      { key: "best", path: bestPath },
      { key: "moviebox2", path: bestPath + "&sources=moviebox2" },
      { key: "moviebox", path: bestPath + "&sources=moviebox" },
      { key: "vidapi", path: bestPath + "&sources=vidapi" }
    ];

    return pAll(cands.map(function (c) { return apiJson(c.path); })).then(function (results) {
      var list = results.map(function (r, i) {
        return { key: cands[i].key, j: (r && r.ok && r.v) ? r.v : null };
      });
      var anySource = false, invalid = false;
      list.forEach(function (x) {
        if (!x.j) return;
        if (x.j.error) invalid = true;
        if (x.j.source && x.j.source.url) anySource = true;
      });
      if (anySource || invalid) return build(list);
      return apiJson(bestPath).then(function (j2) {
        if (j2 && j2.source && j2.source.url) list.push({ key: "best", j: j2 });
        return build(list);
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
