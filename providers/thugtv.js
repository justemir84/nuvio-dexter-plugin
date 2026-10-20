/**
 * thugtv - ThugTV (thugtv.online) saglayicisi - Nuvio
 * Akis: TMDB -> GET {API_BASE}/stream/{movie/{tmdb}|tv/{tmdb}/{s}/{e}}
 *   API_BASES: api.thugtv.online + thuktv-*.onrender.com yedekleri.
 *   sources[]:
 *     - Castle: dogrudan HLS (quality + qualityVariants 720p/480p + audioStreams + subtitles VTT)
 *     - Bishop: resolvePath /stream/direct/moviebox/... -> direct-media.png?ticket= (MP4 1080p'ye kadar)
 *     - Knight: resolvePath /stream/direct/vaplayer/... -> direct-media.m3u8?ticket= (HLS)
 *     - geri kalanlar dis embed'ler (vixsrc/vidlink/videasy/... atlanir)
 *   Castle imzali URL'leri API onbellegi yuzunden bazen bayat gelebilir (403).
 *   Bu yuzden dogrudan URL'ler kisa bir GET ile dogrulanir; kesin hata (>=400)
 *   alanlar diger kaynaklar varken listeden dusurulur.
 *   Knight/vaplayer ara sira timeout verir; bir kez yeniden denenir.
 *   Knight master playlist'indeki RESOLUTION'dan gercek kalite (1080p/720p) okunur.
 * Medya: ticket URL'leri UA ile 206 doner; Referer: https://thugtv.online/ (yine de eklenir).
 * Hermes-safe: yalniz Promise zincirleri, bagimlilik yok.
 */
(function () {
  "use strict";

  // thugtv.online ayni API'yi birden fazla host uzerinden sunuyor.
  // Ana host engelli/oluysa siradaki host denenir.
  var API_BASES = [
    "https://api.thugtv.online/api",
    "https://thuktv-1.onrender.com/api",
    "https://thuktv-pmce.onrender.com/api",
    "https://thuktv-cuqn.onrender.com/api"
  ];
  var SITE = "https://thugtv.online/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var RTIMEOUT = 15000;
  var VTIMEOUT = 9000;
  var MIRROR_TIMEOUT = 6000;
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

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fetchApiJson(path, timeout, headers) {
    var i = 0;
    function attempt() {
      if (i >= API_BASES.length) return Promise.resolve(null);
      var base = API_BASES[i++];
      // Ilk host icin normal timeout, yedek hostlar icin daha kisa timeout.
      var t = i === 1 ? timeout : Math.min(timeout || TIMEOUT, MIRROR_TIMEOUT);
      return fetchTimeout(base + path, { headers: headers }, t).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).catch(function () {
        return attempt();
      });
    }
    return attempt();
  }

  function fetchStreamJson(path, headers) {
    return fetchApiJson(path, TIMEOUT, headers).then(function (j) {
      if (j && j.sources && j.sources.length) return j;
      // Butun hostlar basarisiz olduysa tekrar denemek sadece gecikme ekler.
      if (!j) return null;
      return fetchApiJson(path, TIMEOUT, headers);
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

  function qualityFromWidth(w) {
    w = parseInt(w, 10) || 0;
    if (w >= 3800) return "2160p";
    if (w >= 2500) return "1440p";
    if (w >= 1900) return "1080p";
    if (w >= 1200) return "720p";
    if (w >= 800) return "480p";
    if (w >= 600) return "360p";
    return "";
  }

  function directPath(kind, isTv, tmdbId, s, e) {
    return "/stream/direct/" + kind + "/" + (isTv ? "tv/" + tmdbId + "/" + s + "/" + e : "movie/" + tmdbId);
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

  function codecTags(cds, rng) {
    cds = String(cds || "").toLowerCase();
    var dv = /dvh[1e]|dvhe|dav1/.test(cds) ? "DV" : "";
    var v = dv ? "HEVC" : (/hvc1|hev1|hevc/.test(cds) ? "HEVC" : (/avc1|avc3|avc/.test(cds) ? "H.264" : (/av01/.test(cds) ? "AV1" : "")));
    var hdr = !dv && /^(PQ|HLG)$/i.test(String(rng || "")) ? "HDR" : "";
    var a = /ec-3|eac3|ddp/.test(cds) ? "DDP" : (/ac-3/.test(cds) ? "DD" : (/mp4a|aac/.test(cds) ? "AAC" : ""));
    return { v: v, extra: [dv || hdr, a].filter(function (x) { return !!x; }).join(" ") };
  }

  function masterTags(u) {
    return fetchTimeout(u, { headers: { "User-Agent": UA, Referer: SITE } }).then(function (r) {
      return r.ok ? r.text() : "";
    }, function () { return ""; }).then(function (t) {
      if (!t || t.indexOf("#EXTM3U") !== 0 || t.indexOf("#EXT-X-STREAM-INF") === -1) return null;
      var lines = t.split(/\r?\n/), bestW = -1, bestH = 0, bestLine = "", curLine = "", i;
      for (i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
          curLine = line;
        } else if (line && line.charAt(0) !== "#" && curLine) {
          var m = curLine.match(/RESOLUTION=(\d+)x(\d+)/);
          var w = m ? parseInt(m[1], 10) : 0;
          var h = m ? parseInt(m[2], 10) : 0;
          if (w >= bestW) { bestW = w; bestH = h; bestLine = curLine; }
          curLine = "";
        }
      }
      if (!bestLine) return null;
      var cds = (bestLine.match(/CODECS="([^"]+)"/i) || [])[1] || "";
      var rng = (bestLine.match(/VIDEO-RANGE=([A-Z0-9]+)/i) || [])[1] || "";
      var ct = codecTags(cds, rng);
      ct.width = bestW > 0 ? bestW : 0;
      ct.height = bestH;
      return ct;
    });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[thugtv]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var path = isTv ? "/stream/tv/" + tmdbId + "/" + s + "/" + e : "/stream/movie/" + tmdbId;
    var display = "";
    var headers = { "User-Agent": UA, Accept: "application/json", Referer: SITE, "Cache-Control": "no-cache", Pragma: "no-cache" };

    return pAll([
      fetchStreamJson(path, headers),
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
        } else if (!u && src.resolvePath && resolves.length < 4 && /\/direct\//.test(String(src.resolvePath))) {
          resolves.push(src);
        }
      });

      // Ana API bazen bos/504 donebilir veya Castle disinda kaynak
      // dondurmez. Bu durumda Knight/Bishop yollarini dogrudan dene.
      function addFallback(name, kind) {
        if (resolves.length >= 4) return;
        var p = directPath(kind, isTv, tmdbId, s, e);
        for (var i = 0; i < resolves.length; i++) {
          if (String(resolves[i].resolvePath) === p) return;
        }
        resolves.push({ name: name, resolvePath: p });
      }
      addFallback("Knight", "vaplayer");
      addFallback("Bishop", "moviebox");

      var resolveP = pAll(resolves.map(function (src) {
        function once() {
          return fetchApiJson(src.resolvePath, RTIMEOUT, headers).then(function (rj) {
            if (!rj) return { retry: false, v: null };
            if (rj.status === "ready" && rj.source && rj.source.url) {
              return { retry: false, v: fromSource(rj, src.name) };
            }
            // MovieBox 406 gibi kalici hatalarda tekrar denemek anlamsiz.
            var persistent = rj.status === "upstream_error" || /HTTP 406/.test(String(rj.error || ""));
            return { retry: !persistent, v: null };
          });
        }
        // Knight/vaplayer ara sira timeout/delivery_unavailable veriyor;
        // kisa bir beklemeden sonra bir kez daha dene.
        return once().then(function (r) {
          if (r.v) return r.v;
          if (!r.retry) return null;
          return delay(900).then(once).then(function (r2) { return r2.v; });
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

          var hlsKept = kept.filter(function (f) { return f.isHls; }).slice(0, 6);
          return pAll(hlsKept.map(function (f) { return masterTags(f.url); })).then(function (mtags) {
            var tmap = {};
            hlsKept.forEach(function (f, i) {
              var r = mtags[i];
              if (r && r.ok && r.v) tmap[f.url] = r.v;
            });
            var out = kept.map(function (f) {
              var mt = tmap[f.url];
              var q = f.q;
              // Knight gibi master playlist donduren kaynaklarda gercek
              // cozunurluk RESOLUTION satirindan okunur.
              if (mt && mt.width && (!q || q === "Auto" || qRank(q) < 1.5)) {
                q = qualityFromWidth(mt.width) || q;
              }
              var bits = [q];
              if (mt && mt.v) bits.push(mt.v);
              if (mt && mt.extra) bits.push(mt.extra);
              if (f.audio > 1) bits.push("Multi-Audio");
              if (f.subs.length) bits.push(f.subs.length + " subs");
              return {
                name: "ThugTV - " + f.name + " " + q + (mt && mt.v ? " " + mt.v : ""),
                title: display + "\n" + bits.join(" - "),
                url: f.url,
                quality: q,
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
