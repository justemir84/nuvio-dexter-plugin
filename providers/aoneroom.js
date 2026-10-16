/**
 * aoneroom - 123Movies (123moviesfree.club / aoneroom.com) saglayicisi - Nuvio
 * Akis: TMDB -> /search-result SSR (slug + subjectId) -> /wefeed-h5api-bff/subject/play
 *   -> dogrudan MP4 kaynaklari (360p/480p/1080p) + caption SRT altyazilar.
 * Onemli:
 *   - play istegi Referer: https://123moviesfree.club/movies/{slug} ister (yoksa bos doner).
 *   - medya (bcdnxw.hakunaymatata.com) Referer: https://123moviesfree.club/ ister (yoksa 429).
 *   - Filmlerde se/ep GONDERILMEZ; dizilerde &se=&ep= zorunlu.
 * Ayni baslikta muzik/klip girdileri olabildigi icin liste bos donerse siradaki
 * aday denenir (en fazla 4).
 * Hermes-safe: yalniz Promise zincirleri, bagimlilik yok.
 */
(function () {
  "use strict";

  var SITE = "https://123moviesfree.club";
  var PLAY = SITE + "/wefeed-h5api-bff/subject/play";
  var CAPTION = "https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/caption";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 15000;
  var MAX_STREAMS = 8;
  var MAX_SUBS = 30;
  var MAX_CANDS = 4;

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

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function slugify(t) {
    return String(t || "").toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function grabList(q) {
    return fetchTimeout(SITE + "/search-result?keyword=" + q, {
      headers: { "User-Agent": UA, Accept: "text/html", Referer: SITE + "/" }
    }).then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; }).then(function (html) {
      var out = [], seen = {}, m = null;
      var re = /href="\/detail\/([^"?]+)\?id=(\d+)/g;
      while ((m = re.exec(html)) && out.length < 28) {
        if (seen[m[1]]) continue;
        seen[m[1]] = 1;
        out.push({ slug: m[1], id: m[2] });
      }
      return out;
    });
  }

  function findCandidates(title, year) {
    return grabList(encodeURIComponent(title)).then(function (list) {
      if (list.length || !year) return list;
      return grabList(encodeURIComponent(title + " " + year));
    }).then(function (list) {
      var want = slugify(title);
      list.sort(function (a, b) {
        var pa = a.slug.indexOf(want) === 0 ? 0 : 1;
        var pb = b.slug.indexOf(want) === 0 ? 0 : 1;
        if (pa !== pb) return pa - pb;
        var ya = a.slug.indexOf(String(year)) >= 0 ? 0 : 1;
        var yb = b.slug.indexOf(String(year)) >= 0 ? 0 : 1;
        if (ya !== yb) return ya - yb;
        return a.slug.length - b.slug.length;
      });
      return list.slice(0, MAX_CANDS);
    });
  }

  function play(slug, id, isTv, s, e) {
    var u = PLAY + "?subjectId=" + id + "&detailPath=" + slug + (isTv ? "&se=" + s + "&ep=" + e : "");
    return fetchTimeout(u, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE + "/movies/" + slug }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (j) {
      return (j && j.data) ? j.data : null;
    });
  }

  function captionsFor(slug, subjectId, mediaId) {
    var u = CAPTION + "?format=MP4&id=" + mediaId + "&subjectId=" + subjectId + "&detailPath=" + slug;
    return fetchTimeout(u, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE + "/movies/" + slug }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (j) {
      var out = [];
      var list = (j && j.data && j.data.captions) || [];
      list.forEach(function (c) {
        if (c && c.url && out.length < MAX_SUBS) {
          out.push({ url: c.url, lang: c.lanName || c.lan || "und" });
        }
      });
      return out;
    });
  }

  function qFromRes(r) {
    var m = String(r || "").match(/\d{3,4}/);
    if (m) return m[0] + "p";
    if (/4k|2160/i.test(String(r || ""))) return "2160p";
    return "Auto";
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[aoneroom]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var display = "";
    var title = "";
    var year = "";

    return tmdbLookup(tmdbId, isTv).then(function (info) {
      if (info) {
        title = info.title || info.name || "";
        year = String(info.release_date || info.first_air_date || "").slice(0, 4);
        display = title;
        if (display && year) display += " (" + year + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + pad(s) + "E" + pad(e);
      if (!title) return null;
      return findCandidates(title, year);
    }).then(function (cands) {
      if (!cands || !cands.length) { console.log(tag + " No candidates"); return null; }
      var idx = 0;
      function tryNext() {
        if (idx >= cands.length) return Promise.resolve(null);
        var c = cands[idx++];
        return play(c.slug, c.id, isTv, s, e).then(function (data) {
          var usable = [];
          var seenU = {};
          if (data) {
            (data.streams || []).forEach(function (x) {
              if (x && x.url && !seenU[x.url]) { seenU[x.url] = 1; usable.push(x); }
            });
            (data.hls || []).forEach(function (x) {
              if (x && x.url && !seenU[x.url]) { seenU[x.url] = 1; x._hls = 1; usable.push(x); }
            });
          }
          if (!usable.length) return tryNext();
          return { c: c, usable: usable };
        });
      }
      return tryNext();
    }).then(function (hit) {
      if (!hit) { console.log(tag + " No streams"); return []; }
      var capP = (hit.usable[0] && hit.usable[0].id) ? captionsFor(hit.c.slug, hit.c.id, hit.usable[0].id) : Promise.resolve([]);
      return capP.then(function (subs) {
        var out = hit.usable.map(function (x) {
          var q = qFromRes(x.resolutions);
          var bits = [q];
          if (x.codecName) {
            var cn = String(x.codecName).toLowerCase();
            bits.push(cn === "h264" ? "H.264" : (cn === "hevc" || cn === "h265" ? "HEVC" : String(x.codecName).toUpperCase()));
          }
          if (x.size) bits.push((Number(x.size) / 1073741824).toFixed(1) + " GB");
          if (x.duration) bits.push(Math.round(Number(x.duration) / 60) + " min");
          if (subs.length) bits.push(subs.length + " subs");
          var isHls = !!x._hls || /\.m3u8/.test(String(x.url));
          return {
            name: "123Movies - " + q,
            title: display + "\n" + bits.join(" - "),
            url: x.url,
            quality: q,
            isM3u8: isHls,
            type: isHls ? "hls" : "mp4",
            headers: { Referer: SITE + "/", "User-Agent": UA },
            subtitles: subs,
            provider: "aoneroom"
          };
        });
        out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
        out = out.slice(0, MAX_STREAMS);
        console.log(tag + " Found " + out.length + " streams");
        return out;
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
