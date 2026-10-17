/**
 * popwatch - PopWatch saglayicisi - Nuvio
 * Akis: TMDB -> /api/scrape/sources -> /api/scrape/services -> (gerekirse) /api/scrape/embed
 * 7 kaynakli scraper agi (Laylah, Andromeda, Aster, Lilac, Lotus, Orchid, Azalea).
 * Yayin icin Referer: https://popwatch.to/ zorunlu (aksi halde reklam videosu doner).
 * Altyazilar /api/subtitle uzerinden (SRT).
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var BASE = "https://popwatch.to";
  var API = BASE + "/api";
  var SITE = BASE + "/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 9000;
  var MAX_EMBEDS = 8;
  var MAX_STREAMS = 6;

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

  function extend(a, b) {
    var o = {}, k;
    for (k in a) if (a.hasOwnProperty(k)) o[k] = a[k];
    for (k in b) if (b.hasOwnProperty(k)) o[k] = b[k];
    return o;
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

  function qualityFromNum(q) {
    q = Number(q) || 0;
    if (q >= 3000) return "4K";
    if (q >= 1000) return "1080p";
    if (q >= 700) return "720p";
    if (q >= 500) return "480p";
    if (q > 0) return "360p";
    return "Auto";
  }

  function buildSubs(caps) {
    var subs = [], seen = {};
    (caps || []).forEach(function (c) {
      if (!c || !c.url) return;
      var lang = c.language || "und";
      if (seen[lang]) return;
      seen[lang] = true;
      subs.push({ url: c.url.indexOf("http") === 0 ? c.url : BASE + c.url, lang: lang });
    });
    return subs;
  }

  function langLabel(subs) {
    var names = subs.slice(0, 6).map(function (s) { return s.lang; });
    var extra = subs.length - names.length;
    return names.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  function tmdbLookup(tmdbId, mediaType) {
    var path = mediaType === "tv" ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&append_to_response=external_ids&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
      .then(function (d) {
        if (!d) return null;
        return {
          title: d.title || d.name || d.original_title || d.original_name || "",
          year: String(d.release_date || d.first_air_date || "").substring(0, 4),
          imdbId: (d.external_ids && d.external_ids.imdb_id) || ""
        };
      });
  }

  function jpost(path, body) {
    return fetchTimeout(API + path, {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Referer: SITE },
      body: JSON.stringify(body)
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[popwatch]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var display = "";

    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      if (!info || !info.title) throw new Error("TMDB lookup failed");
      display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      var payload = {
        mediaType: mediaType,
        tmdbId: Number(tmdbId),
        title: info.title,
        releaseYear: info.year,
        imdbId: info.imdbId
      };
      if (isTv) { payload.season = s; payload.episode = e; }

      return fetchTimeout(API + "/scrape/sources?mediaType=" + mediaType, { headers: { "User-Agent": UA, Referer: SITE } })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
        .then(function (sd) {
          var sources = (sd && sd.sources) || [];
          if (!sources.length) return [];
          return pAll(sources.map(function (src) {
            return jpost("/scrape/services", extend({ sourceId: src.id }, payload));
          })).then(function (results) {
            var found = [];
            var queue = [];
            results.forEach(function (res) {
              var j = res && res.ok ? res.v : null;
              if (!j || !j.success) return;
              if (j.kind === "stream" && j.stream && j.stream.playlist) {
                found.push({ playlist: j.stream.playlist, q: j.quality, caps: j.stream.captions || [] });
              } else if (j.services && j.services.length) {
                var take = 0;
                j.services.forEach(function (sv) {
                  if (sv && sv.embedId && sv.url && take < 4 && queue.length < MAX_EMBEDS) { queue.push(sv); take++; }
                });
              }
            });
            if (!queue.length) return found;
            return pAll(queue.map(function (sv) {
              return jpost("/scrape/embed", { embedId: sv.embedId, url: sv.url }).then(function (j) {
                if (j && j.success && j.stream && j.stream.playlist) {
                  return { playlist: j.stream.playlist, q: j.quality, caps: j.stream.captions || j.captions || [] };
                }
                return null;
              }, function () { return null; });
            })).then(function (list) {
              list.forEach(function (item) { if (item && item.ok && item.v) found.push(item.v); });
              return found;
            });
          });
        });
    }).then(function (found) {
      var out = [], seen = {};
      (found || []).forEach(function (f) {
        if (!f || !f.playlist) return;
        var url = f.playlist.indexOf("http") === 0 ? f.playlist : BASE + f.playlist;
        var key = String(f.q) + "|" + url.substring(url.length - 40);
        if (seen[key]) return;
        seen[key] = true;
        var q = qualityFromNum(f.q);
        var subs = buildSubs(f.caps);
        var extra = subs.length ? " | " + langLabel(subs) : "";
        out.push({
          name: "PopWatch - " + q,
          title: display + "\n" + q + " [HLS]" + extra,
          url: url,
          quality: q,
          isM3u8: true,
          type: "hls",
          headers: { Referer: SITE, "User-Agent": UA },
          subtitles: subs,
          provider: "popwatch"
        });
      });
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
