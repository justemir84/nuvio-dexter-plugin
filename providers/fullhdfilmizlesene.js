(function () {
  "use strict";

  var BASE = "https://fullhdfilmizlesene.co";
  var BASES = [BASE, "https://www.fullhdfilmizlesene.now"];
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_KEY_FALLBACK;
  }

  function atobSafe(str) {
    if (typeof atob === "function") {
      try { return atob(str); } catch (e) {}
    }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var output = "";
    str = String(str).replace(/[^A-Za-z0-9\+\/=]/g, "");
    for (var i = 0; i < str.length; ) {
      var enc1 = chars.indexOf(str.charAt(i++));
      var enc2 = chars.indexOf(str.charAt(i++));
      var enc3 = chars.indexOf(str.charAt(i++));
      var enc4 = chars.indexOf(str.charAt(i++));
      var chr1 = (enc1 << 2) | (enc2 >> 4);
      var chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      var chr3 = ((enc3 & 3) << 6) | enc4;
      output += String.fromCharCode(chr1);
      if (enc3 !== 64) output += String.fromCharCode(chr2);
      if (enc4 !== 64) output += String.fromCharCode(chr3);
    }
    return output;
  }

  function fetchText(url, headers) {
    var opts = { headers: headers || { "User-Agent": UA } };
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, TIMEOUT);
    });
    return Promise.race([fetch(url, opts), timeout])
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res || !res.ok) return null;
        return res.text();
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        return null;
      });
  }

  function fetchJson(url, headers) {
    return fetchText(url, headers).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    });
  }

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function decodeEntities(s) {
    s = String(s || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); });
    return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ");
  }

  function isTvType(t) { return t === "series"; }

  function searchSite(query) {
    var url = BASE + "/arama/?s=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/", Accept: "text/html" })
      .then(function (html) {
        if (!html) return [];
        var results = [];
        var seen = {};
        var re = /<a class="image" href="([^"]+)" title="([^"]+)"/g;
        var m;
        while ((m = re.exec(html))) {
          var href = m[1];
          var rawTitle = decodeEntities(m[2]).replace(/\s*izle\s*$/i, "").trim();
          if (!href || seen[href]) continue;
          seen[href] = true;
          results.push({ url: href, title: rawTitle, contentType: "unknown" });
        }
        return results;
      });
  }

  function findBestMatch(results, title, year, isTv) {
    var best = null, bestScore = -Infinity;
    (results || []).forEach(function (r) {
      var score = 0;
      var rt = norm(r.title);
      var t = norm(title);
      if (t && rt.indexOf(t) !== -1) score += 10;
      else {
        var words = t.split(" ").filter(function (w) { return w.length > 2; });
        if (words.length && words.every(function (w) { return rt.indexOf(w) !== -1; })) score += 5;
      }
      if (score > bestScore) { bestScore = score; best = r; }
    });
    if (best) return best;
    return (results && results.length) ? results[0] : null;
  }

  function rvali(s) { var o = ""; for (var i = s.length - 1; i >= 0; i--) o += s.charAt(i); return o; }

  function normalizeUrl(u) {
    u = String(u || "");
    if (/^\/\//.test(u)) u = "https:" + u;
    if (/^https?:\/\//i.test(u)) return u;
    var base = String(BASE || "https://fullhdfilmizlesene.co").replace(/\/$/, "");
    if (u.charAt(0) === "/") return base + u;
    return base + "/" + u;
  }

  function isPlayableMediaUrl(u) {
    u = String(u || "");
    if (!/^https?:\/\//i.test(u)) return false;
    if (/\/player\//i.test(u)) return false;
    if (/\/embed\//i.test(u)) return false;
    if (/\/iframe/i.test(u)) return false;
    if (/[?&]vr_set=/.test(u)) return false;
    if (/\.m3u8(\?|$)/i.test(u)) return true;
    if (/\.mp4(\?|$)/i.test(u)) return true;
    if (/\/playlist\//i.test(u)) return true;
    if (/\/vod\//i.test(u)) return true;
    return false;
  }

  function resolveStream(pageUrl) {
    return fetchText(pageUrl, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return null;
        var m = html.match(/rvali\('([^']+)'\)/);
        var prefix = m ? rvali(m[1]) : "";
        var re = /pdata\['prt_([^']+)'\]\s*=\s*'([^']+)'/g;
        var srcs = [];
        var seen = {};
        var em;
        while ((em = re.exec(html))) {
          if (String(em[1]).indexOf("fragman") !== -1) continue;
          var part = em[2];
          var say30 = part.substring(0, 30);
          var partkod = (say30 !== "PGltZyB3aWR0aD0iMTAwJSIgaGVpZ2") ? (prefix + part) : part;
          var decoded = null;
          try { decoded = atobSafe(partkod); } catch (e) { decoded = null; }
          if (!decoded) continue;
          var sm = decoded.match(/src="([^"]+)"/);
          if (sm && sm[1]) {
            var src = normalizeUrl(sm[1].trim());
            if (!seen[src] && isPlayableMediaUrl(src)) { seen[src] = true; srcs.push(src); }
          }
        }
        if (!srcs.length) {
          // Yeni site mimarisi iframe/embed döndürüyor; medya URL'si yoksa YouTube embed'i fallback olarak kullan
          var yt = (html.match(/https:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_\-]{6,})/i) || [])[1];
          if (yt) {
            srcs.push("https://www.youtube.com/embed/" + yt);
          }
        }
        if (!srcs.length) return null;
        return { urls: srcs, subtitles: [] };
      });
  }

  function tmdbInfo(tmdbId, isTv, apiKey) {
    var path = isTv ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) + "&language=tr-TR";
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;
      var title = isTv ? (d.name || "") : (d.title || "");
      var original = isTv ? (d.original_name || "") : (d.original_title || "");
      var year = String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4);
      return { title: title, original: original, year: year };
    });
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[fullhdfilmizlesene]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);
    if (!apiKey) { console.log(tag + " TMDB API key missing"); return []; }

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB details not found");
        return [];
      }
      console.log(tag + " Araniyor: " + info.title + (info.year ? " (" + info.year + ")" : ""));

      return searchSite(info.title).then(function (results) {
        var match = findBestMatch(results, info.title, info.year, isTv);
        if (!match) {
          console.log(tag + " No matching page found");
          return [];
        }
        console.log(tag + " Matched page: " + match.url);

        var pageUrl = match.url;
        if (isTv) {
          // .co sitesi dizi bölüm URL'leri farklı; basit akışta film odaklı
          console.log(tag + " Dizi destegi sinirli");
          return [];
        }

        return resolveStream(pageUrl).then(function (resolved) {
          if (!resolved) {
            console.log(tag + " Failed to resolve stream");
            return [];
          }
          var urls = resolved.urls || [];
          if (!urls.length) return [];

          var streams = urls.map(function (u, idx) {
            var isM3u8 = /\.m3u8(\?|$)/i.test(u);
            var isYt = /youtube\.com\/(embed|watch|shorts)/i.test(u);
            if (isYt) { isM3u8 = true; }
            return {
              name: "FullHDFilmizlesene",
              title: info.title + (info.year ? " (" + info.year + ")" : ""),
              url: u,
              quality: "Auto",
              isM3u8: isM3u8,
              type: isM3u8 ? "hls" : "mp4",
              language: "tr",
              provider: "fullhdfilmizlesene",
              headers: { "User-Agent": UA, "Referer": pageUrl },
              subtitles: [],
              behaviorHints: { bingeGroup: "fullhdfilmizlesene-" + info.title }
            };
          });
          console.log(tag + " Kaynak bulundu: " + streams.length + " kaynak");
          return streams;
        });
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message));
      return [];
    });
  }

  function onSettings() { return []; }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
