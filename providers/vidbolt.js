/**
 * vidbolt - VidBolt (vidbolt.xyz) saglayicisi - Nuvio
 * Akis: TMDB -> /api/resolve?type={movie|tv}&id=..[&season=..&episode=..] JSON
 *   -> stream.sources[] -> HLS master (1080p/720p/480p + coklu ses + altyazi)
 *   -> medya istekleri Referer: https://vidbolt.xyz/ ile cekilir.
 * Sunucular: orion (img.rousav.tech), quantum/vega (proxy.vidbolt.xyz),
 *   callisto (dash-hls-bridge workers -> sacdn h265). Tum sunucular paralel
 *   denenir; sonuclar tek listede birlestirilir (bos/erisilemez sunucu varsa
 *   digerleri yine gorunur). Yedekli: bos donerse sirasiyla quantum -> vega ->
 *   callisto -> fastva denenir.
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
  var MAX_STREAMS = 12;
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

  function englishRank(en) {
    if (isEnglish(en.lang)) return 0;
    if (en.lang === "Multi" && (en.audio || []).some(function (a) { return isEnglish(a); })) return 0;
    return 1;
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

    // Varsayilan resolve + tum prefer sunuculari paralel denenir.
    var tasks = [resolve(qs)].concat(PREFERS.map(function (p) { return resolve(qs + "&prefer=" + p); }));
    tasks.push(tmdbLookup(tmdbId, isTv));

    return pAll(tasks).then(function (results) {
      var info = (results[results.length - 1] && results[results.length - 1].ok) ? results[results.length - 1].v : null;
      if (info) {
        display = info.title || info.name || "";
        var y = String(info.release_date || info.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);

      var collected = [];
      var seen = {};
      // Son eleman tmdb sonucu; digerleri resolve sonuclari.
      for (var i = 0; i < results.length - 1; i++) {
        var r = results[i];
        if (!r || !r.ok) continue;
        var j = r.v;
        var fs = sourcesOf(j);
        var srv = ((j || {}).stream || {}).server || (i === 0 ? "" : PREFERS[i - 1]);
        if (!srv) srv = i === 0 ? "orion" : PREFERS[i - 1];
        fs.forEach(function (x) {
          if (!x || !x.url || seen[x.url]) return;
          seen[x.url] = true;
          x._server = srv;
          collected.push(x);
        });
      }

      if (!collected.length) return [];

      var entries = collected.map(function (x, i) {
        var q = String(x.quality || x.name || "").trim() || "Auto";
        var kind = String(x.kind || "hls").toLowerCase();
        var lang = String(x.language || "").trim();
        var mi = mediaInfoFromMaster(x.master || "");
        if (!lang && mi.audio.length === 1) lang = mi.audio[0];
        if (!lang && mi.audio.length > 1) lang = "Multi";
        return { x: x, i: i, q: q, kind: kind, lang: lang, audio: mi.audio, subs: mi.subs, server: x._server };
      });

      // Orijinal/Ingilizce kaynak kosulsuz ilk sirada (kaliteden bagimsiz);
      // sonra kalite, sonra kaynak sirasi. Ilk satir her zaman orijinal olsun.
      entries.sort(function (a, b) {
        var ea = englishRank(a);
        var eb = englishRank(b);
        if (ea !== eb) return ea - eb;
        var d = qRank(b.q) - qRank(a.q);
        if (d) return d;
        return a.i - b.i;
      });

      var seenNames = {};
      var out = entries.slice(0, MAX_STREAMS).map(function (en) {
        var label = en.q === "Auto" ? "Auto" : en.q;
        var srvName = en.server ? (en.server.charAt(0).toUpperCase() + en.server.slice(1)) : "";
        var name = "VidBolt - " + (srvName ? srvName + " " : "") + (en.lang ? en.lang + " " : "") + label;
        if (seenNames[name]) { seenNames[name]++; name = name + " (" + seenNames[name] + ")"; }
        else seenNames[name] = 1;
        var meta = [];
        if (en.audio.length > 1) meta.push("ses: " + en.audio.join(", "));
        else if (en.audio.length === 1 && en.lang !== en.audio[0]) meta.push("ses: " + en.audio.join(", "));
        if (en.subs.length) meta.push("altyazi: " + en.subs.join(", "));
        return {
          name: name,
          title: display + "\n" + label + (en.lang ? " " + en.lang : "") +
            " [" + (en.kind === "mp4" ? "MP4" : "HLS") + (en.server ? " · " + en.server : "") + "]" +
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
