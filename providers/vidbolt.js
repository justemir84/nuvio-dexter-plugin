/**
 * vidbolt - VidBolt (vidbolt.xyz) saglayicisi - Nuvio
 * Akis: TMDB -> /api/resolve?type={movie|tv}&id=..[&season=..&episode=..] JSON
 *   -> stream.sources[] -> HLS master (1080p/720p/480p + coklu ses + altyazi)
 *   -> medya istekleri Referer: https://vidbolt.xyz/ ile cekilir.
 * Sunucular: orion (img.rousav.tech), quantum/vega (proxy.vidbolt.xyz),
 *   callisto (dash-hls-bridge workers -> sacdn h265). Yedekli: bos donerse
 *   sirasiyla quantum -> vega -> callisto -> fastva denenir.
 * Kaynak dili: callisto kaynaklari "language" alanini doner; orion tek master
 *   icinde EXT-X-MEDIA ile coklu ses/altyazi tasir, gercek dil listesi baslığa
 *   yazilir. Orijinal/Ingilizce kaynak kosulsuz ilk sirada gosterilir; "mirror"
 *   etiketi yerine dil adi yazilir.
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

  // Inline HLS master'dan ses/altyazi adlarini cikar (orion kaynaklari).
  function mediaInfoFromMaster(txt) {
    var out = { audio: [], subs: [] };
    if (!txt) return out;
    var re = /#EXT-X-MEDIA:TYPE=(AUDIO|SUBTITLES)([^\n]*)/g;
    var m;
    while ((m = re.exec(txt)) !== null) {
      var nm = m[2].match(/NAME="([^"]+)"/);
      if (!nm) continue;
      var arr = m[1] === "AUDIO" ? out.audio : out.subs;
      if (arr.indexOf(nm[1]) === -1) arr.push(nm[1]);
    }
    return out;
  }

  function isEnglish(s) {
    return /english|original/i.test(String(s || ""));
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
      var entries = found.map(function (x, i) {
        var q = String(x.quality || x.name || "").trim() || "Auto";
        var kind = String(x.kind || "hls").toLowerCase();
        var lang = String(x.language || "").trim();
        var mi = mediaInfoFromMaster(x.master || "");
        if (!lang && mi.audio.length === 1) lang = mi.audio[0];
        return { x: x, i: i, q: q, kind: kind, lang: lang, audio: mi.audio, subs: mi.subs };
      });
      // Orijinal/Ingilizce kaynak kosulsuz ilk sirada (kaliteden bagimsiz);
      // sonra kalite, sonra kaynak sirasi. Ilk satir her zaman orijinal olsun.
      entries.sort(function (a, b) {
        var ea = isEnglish(a.lang) ? 0 : 1;
        var eb = isEnglish(b.lang) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        var d = qRank(b.q) - qRank(a.q);
        if (d) return d;
        return a.i - b.i;
      });
      var seenNames = {};
      var out = entries.slice(0, MAX_STREAMS).map(function (en) {
        var label = en.q === "Auto" ? "Auto" : en.q;
        var name = "VidBolt - " + (en.lang ? en.lang + " " : "") + label;
        if (seenNames[name]) { seenNames[name]++; name = name + " (" + seenNames[name] + ")"; }
        else seenNames[name] = 1;
        var meta = [];
        if (en.audio.length > 1) meta.push("ses: " + en.audio.join(", "));
        else if (en.audio.length === 1 && en.lang !== en.audio[0]) meta.push("ses: " + en.audio.join(", "));
        if (en.subs.length) meta.push("altyazi: " + en.subs.join(", "));
        return {
          name: name,
          title: display + "\n" + label + (en.lang ? " " + en.lang : "") +
            " [" + (en.kind === "mp4" ? "MP4" : "HLS") + (server ? " · " + server : "") + "]" +
            (meta.length ? " | " + meta.join(" | ") : ""),
          url: en.x.url,
          quality: en.q,
          isM3u8: en.kind !== "mp4",
          type: en.kind === "mp4" ? "mp4" : "hls",
          headers: { Referer: REF, "User-Agent": UA },
          subtitles: [],
          provider: "vidbolt"
        };
      });
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
