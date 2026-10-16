/**
 * thugtv - ThugTV (thugtv.online) saglayicisi - Nuvio
 * Akis: TMDB -> GET https://api.thugtv.online/api/stream/{movie/{tmdb}|tv/{tmdb}/{s}/{e}}
 *   sources[]:
 *     - Castle: dogrudan HLS (quality + qualityVariants 720p/480p + audioStreams + subtitles VTT)
 *     - Bishop: resolvePath /stream/direct/moviebox/... -> direct-media.png?ticket= (MP4 1080p'ye kadar)
 *     - Knight: resolvePath /stream/direct/vaplayer/... -> direct-media.m3u8?ticket= (HLS)
 *     - geri kalanlar dis embed'ler (vixsrc/vidlink/videasy/... atlanir)
 *   Castle imzali URL'leri API onbellegi yuzunden bazen bayat gelebilir (403).
 *   Bu yuzden dogrudan URL'ler kisa bir GET ile dogrulanir; kesin hata (>=400)
 *   alanlar diger kaynaklar varken listeden dusurulur.
 * Medya: ticket URL'leri UA ile 206 doner; Referer: https://thugtv.online/ (yine de eklenir).
 * Hermes-safe: yalniz Promise zincirleri, bagimlilik yok.
 */
(function () {
  "use strict";

  var API = "https://api.thugtv.online";
  var SITE = "https://thugtv.online/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var RTIMEOUT = 15000;
  var VTIMEOUT = 9000;
  var MAX_STREAMS = 12;
  var MAX_SUBS = 40;

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

  function normQuality(l) {
    l = String(l || "").toLowerCase();
    if (/2160|4k|uhd/.test(l)) return "2160p";
    if (/1440|2k/.test(l)) return "1440p";
    if (/1080|fhd/.test(l)) return "1080p";
    if (/720/.test(l)) return "720p";
    if (/480/.test(l)) return "480p";
    if (/360/.test(l)) return "360p";
    return "Auto";
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function mapSubs(arr) {
    var out = [], seen = {};
    (arr || []).forEach(function (s) {
      if (!s || !s.url || out.length >= MAX_SUBS) return;
      var k = String(s.lang || s.label || "und").toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push({ url: s.url, lang: s.label || s.lang || "und" });
    });
    return out;
  }

  function fromSource(src, fallbackName) {
    var st = src.source || src;
    if (!st || !st.url) return null;
    return {
      url: st.url,
      name: st.name || src.name || fallbackName || "Direct",
      q: normQuality(st.quality),
      isHls: /\.m3u8/.test(String(st.url)),
      subs: mapSubs(st.subtitles),
      audio: (st.audioStreams || []).length
    };
  }

  function verifyUrl(u) {
    return fetchTimeout(u, {
      method: "GET",
      headers: { "User-Agent": UA, Referer: SITE, Range: "bytes=0-200" }
    }, VTIMEOUT).then(function (r) {
      return { url: u, ok: r.status < 400 };
    }, function () {
      return { url: u, ok: true, unknown: true };
    });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[thugtv]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var path = isTv ? "/api/stream/tv/" + tmdbId + "/" + s + "/" + e : "/api/stream/movie/" + tmdbId;
    var display = "";
    var headers = { "User-Agent": UA, Accept: "application/json", Referer: SITE };

    return pAll([
      fetchTimeout(API + path, { headers: headers }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }),
      tmdbLookup(tmdbId, isTv)
    ]).then(function (results) {
      var j = (results[0] && results[0].ok) ? results[0].v : null;
      var info = (results[1] && results[1].ok) ? results[1].v : null;
      if (info) {
        display = info.title || info.name || "";
        var y = String(info.release_date || info.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + pad(s) + "E" + pad(e);

      var sources = (j && j.sources) || [];
      var direct = [];
      var seen = {};
      var resolves = [];

      sources.forEach(function (src) {
        if (!src) return;
        var u = String(src.url || "");
        if (u.indexOf("http") === 0 && src.type !== "embed") {
          var variants = (src.qualityVariants && src.qualityVariants.length) ? src.qualityVariants : [{ label: src.quality, url: u }];
          variants.forEach(function (v) {
            if (!v || !v.url || seen[v.url]) return;
            seen[v.url] = true;
            direct.push({
              url: v.url,
              name: src.name || "Castle",
              q: normQuality(v.label || src.quality),
              isHls: /\.m3u8/.test(String(v.url)),
              subs: mapSubs(src.subtitles),
              audio: (src.audioStreams || []).length
            });
          });
        } else if (!u && src.resolvePath && resolves.length < 2 && /direct\/(moviebox|vaplayer)\//.test(String(src.resolvePath))) {
          resolves.push(src);
        }
      });

      var resolveP = pAll(resolves.map(function (src) {
        return fetchTimeout(API + "/api" + src.resolvePath, { headers: headers }, RTIMEOUT)
          .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
          .then(function (rj) {
            if (!rj || rj.status !== "ready" || !rj.source || !rj.source.url) return null;
            return fromSource(rj, src.name);
          });
      }));

      return resolveP.then(function (resolved) {
        var all = direct.slice();
        resolved.forEach(function (x) {
          if (x && x.ok && x.v && !seen[x.v.url]) {
            seen[x.v.url] = true;
            all.push(x.v);
          }
        });
        if (!all.length) { console.log(tag + " No streams"); return []; }
        return pAll(all.map(function (f) { return verifyUrl(f.url); })).then(function (ver) {
          var verMap = {};
          ver.forEach(function (x) {
            if (x && x.ok && x.v) verMap[x.v.url] = x.v.ok;
          });
          var kept = [];
          all.forEach(function (f) {
            if (verMap[f.url] === false) { console.log(tag + " drop " + f.name + " " + f.q); return; }
            kept.push(f);
          });
          // Hepsi mi olu? Yine de listeyi bos birakma.
          if (!kept.length) kept = all;

          var out = kept.map(function (f) {
            var bits = [f.q];
            if (f.audio > 1) bits.push("Multi-Audio");
            if (f.subs.length) bits.push(f.subs.length + " subs");
            return {
              name: "ThugTV - " + f.name + " " + f.q,
              title: display + "\n" + bits.join(" - "),
              url: f.url,
              quality: f.q,
              isM3u8: !!f.isHls,
              type: f.isHls ? "hls" : "mp4",
              headers: { Referer: SITE, "User-Agent": UA },
              subtitles: f.subs,
              provider: "thugtv"
            };
          });
          out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
          out = out.slice(0, MAX_STREAMS);
          console.log(tag + " Found " + out.length + " streams");
          return out;
        });
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
