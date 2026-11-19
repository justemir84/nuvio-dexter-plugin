(function () {
  "use strict";

  var BASE = "https://www.fullhdfilmizlesene.now";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;
  var DEBUG = true;

  function log(message) {
    if (!DEBUG) return;
    try { console.log("[fullhdfilmizlesene] " + message); } catch (e) {}
  }

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
    log("GET " + String(url).replace(/([?&]api_key=)[^&]+/i, "$1[redacted]"));
    return Promise.race([fetch(url, opts), timeout])
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res) { log("HTTP response null"); return null; }
        log("HTTP " + res.status + (res.ok ? " OK" : " FAIL"));
        if (!res.ok) return null;
        return res.text();
      })
      .then(function (text) {
        if (text) log("response bytes=" + text.length);
        return text;
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        log("request error: " + (err && err.message || err));
        return null;
      });
  }

  function fetchJson(url, headers) {
    return fetchText(url, headers).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    });
  }

  function norm(s) {
    return String(s || "").toLowerCase()
      .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
      .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function decodeEntities(s) {
    s = String(s || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); });
    return s.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&apos;/gi, "'").replace(/&nbsp;/gi, " ");
  }

  function absUrl(url) {
    url = decodeEntities(String(url || "").trim());
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/\//.test(url)) return "https:" + url;
    if (url.charAt(0) === "/") return BASE + url;
    return BASE + "/" + url;
  }

  function urlType(url) {
    var m = String(url || "").toLowerCase().replace(/^https?:\/\/[^/]+/i, "").match(/(?:^|\/)(film|dizi)(?:\/|$)/);
    if (!m) return "";
    return m[1] === "dizi" ? "series" : "movie";
  }

  function slugFromUrl(url) {
    var path = String(url || "").replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
    var m = path.match(/\/(?:film|dizi)\/([^/]+)/i);
    if (m) return m[1].replace(/\/$/, "");
    var parts = path.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1].replace(/-izle$/i, "") : "";
  }

  function parseSearchHtml(html) {
    var results = [];
    var seen = {};
    var re = /<a\b[^>]*href=(['\"])([^'\"]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var href = absUrl(m[2]);
      var type = urlType(href);
      if (!href || !type || seen[href]) continue;
      var tag = m[0];
      var titleMatch = tag.match(/\b(?:title|aria-label)=(['\"])(.*?)\1/i);
      var title = titleMatch ? decodeEntities(titleMatch[2]) : String(m[3] || "").replace(/<[^>]*>/g, " ");
      title = decodeEntities(title).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/\s*izle\s*$/i, "").trim();
      var slug = slugFromUrl(href);
      if (!title && slug) title = slug.replace(/[-_]+/g, " ");
      if (!title || norm(title).length < 2) continue;
      var ym = (title + " " + String(m[3] || "").replace(/<[^>]*>/g, " ")).match(/\b(19|20)\d{2}\b/);
      seen[href] = true;
      results.push({ url: href, slug: slug, title: title, year: ym ? parseInt(ym[0], 10) : 0, contentType: type });
    }
    return results;
  }

  function searchSite(query) {
    var encoded = encodeURIComponent(query);
    var urls = [BASE + "/?s=" + encoded, BASE + "/arama/?s=" + encoded];

    function tryEndpoint(index) {
      if (index >= urls.length) return Promise.resolve([]);
      return fetchText(urls[index], { "User-Agent": UA, Referer: BASE + "/", Accept: "text/html" })
        .then(function (html) {
          var results = html ? parseSearchHtml(html) : [];
          var q = norm(query);
          var relevant = results.some(function (r) {
            var t = norm(r.title);
            return q && (t.indexOf(q) !== -1 || q.indexOf(t) !== -1);
          });
          log("search query='" + query + "' endpoint=" + (index + 1) + " candidates=" + results.length);
          if (relevant || index === urls.length - 1) return results;
          log("search fallback endpoint");
          return tryEndpoint(index + 1);
        });
    }
    return tryEndpoint(0);
  }

  function titleScore(candidate, requested) {
    var a = norm(candidate), b = norm(requested);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 80;
    var aw = a.split(" ").filter(function (w) { return w.length > 2; });
    var bw = b.split(" ").filter(function (w) { return w.length > 2; });
    if (!aw.length || !bw.length) return 0;
    var matched = 0;
    for (var i = 0; i < bw.length; i++) {
      if (aw.indexOf(bw[i]) !== -1) matched++;
    }
    if (matched === bw.length) return 65;
    return Math.round((matched / bw.length) * 50);
  }

  function findBestMatch(results, titles, year, isTv) {
    var desiredType = isTv ? "series" : "movie";
    var requested = Array.isArray(titles) ? titles : [titles];
    var scored = [];
    (results || []).forEach(function (r) {
      var type = r.contentType || urlType(r.url);
      if (type !== desiredType) return;
      var score = 0;
      for (var i = 0; i < requested.length; i++) {
        var next = titleScore(r.title, requested[i]);
        if (next > score) score = next;
      }
      var foundYear = parseInt(r.year, 10) || 0;
      if (!foundYear) {
        var ym = String(r.title || "").match(/\b(19|20)\d{2}\b/);
        if (ym) foundYear = parseInt(ym[0], 10);
      }
      var wantedYear = parseInt(year, 10) || 0;
      if (wantedYear && foundYear) {
        var diff = Math.abs(foundYear - wantedYear);
        if (diff === 0) score += 30;
        else if (diff === 1) score += 10;
        else if (diff === 2) score -= 20;
        else score -= 50;
      } else if (wantedYear && !foundYear) {
        score -= 10;
      }
      scored.push({ item: r, score: score, year: foundYear });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    log("typed candidates=" + scored.length + "; top=" + JSON.stringify(scored.slice(0, 5).map(function (x) {
      return { title: x.item.title, year: x.year || "", score: x.score, url: x.item.url };
    })));
    if (!scored.length || scored[0].score < 40) return null;
    if (scored[1] && Math.abs(scored[0].score - scored[1].score) < 5 && !(parseInt(year, 10) || 0)) {
      log("ambiguous top results; refusing to choose");
      return null;
    }
    return scored[0].item;
  }

  function rvali(s) { var o = ""; for (var i = s.length - 1; i >= 0; i--) o += s.charAt(i); return o; }

  function resolveStream(pageUrl) {
    return fetchText(pageUrl, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) { log("player page empty"); return null; }
        log("player HTML bytes=" + html.length);
        var prefixMatch = html.match(/rvali\(['\"]([^'\"]+)['\"]\)/i);
        var prefix = prefixMatch ? rvali(prefixMatch[1]) : "";
        var urls = [];
        var seen = {};

        function addUrl(value) {
          var url = decodeEntities(String(value || "").trim()).replace(/\\\//g, "/");
          if (!url || /^(?:data:image|blob:)/i.test(url) || /(?:youtube|dailymotion|fragman|\.(?:jpg|jpeg|png|gif)(?:[?#]|$))/i.test(url)) return;
          if (/^\/\//.test(url)) url = "https:" + url;
          if (!/^https?:\/\//i.test(url)) return;
          if (!seen[url]) { seen[url] = true; urls.push(url); }
        }

        var pdata = /pdata\[['\"]prt_([^'\"]+)['\"]\]\s*=\s*['\"]([^'\"]+)['\"]/gi;
        var m;
        while ((m = pdata.exec(html))) {
          if (/fragman/i.test(m[1])) continue;
          var part = m[2];
          var candidates = prefix ? [prefix + part, part] : [part];
          for (var i = 0; i < candidates.length; i++) {
            var decoded = null;
            try { decoded = atobSafe(candidates[i]); } catch (e) { decoded = null; }
            if (!decoded) continue;
            var source = decoded.match(/(?:src|data-src|file)\s*[=:]\s*['\"]([^'\"]+)['\"]/i);
            if (source && source[1]) addUrl(source[1]);
            if (!source) {
              var directUrl = decoded.match(/https?:\/\/[^'\"\s<>]+(?:\.m3u8|\.mp4)(?:\?[^'\"\s<>]*)?/i);
              if (directUrl) addUrl(directUrl[0]);
            }
            if (source && source[1] && urls.length) break;
          }
        }

        if (!urls.length) {
          var direct = /<(?:iframe|source|video)\b[^>]*(?:src|data-src|file)\s*=\s*(['\"])(.*?)\1/gi;
          var dm;
          while ((dm = direct.exec(html))) addUrl(dm[2]);
        }
        if (!urls.length) { log("player source not found (pdata/direct fallback empty)"); return null; }
        log("player sources=" + urls.length);
        return { urls: urls, subtitles: [] };
      });
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var isTv = mediaType === "tv" || mediaType === "series";
    var seasonNum = parseInt(season, 10) || 1;
    var episodeNum = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);
    if (!apiKey) { log("TMDB API key missing"); return []; }

    var tmdbUrl = "https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" +
      encodeURIComponent(tmdbId) + "?api_key=" + encodeURIComponent(apiKey) +
      "&language=tr-TR&append_to_response=alternative_titles";

    return fetchJson(tmdbUrl, { "User-Agent": UA, Accept: "application/json" })
      .then(function (data) {
        if (!data) return null;
        var title = isTv ? (data.name || "") : (data.title || "");
        var original = isTv ? (data.original_name || "") : (data.original_title || "");
        var titles = [];
        function addTitle(value) {
          value = String(value || "").trim();
          if (!value) return;
          var key = norm(value);
          for (var i = 0; i < titles.length; i++) if (norm(titles[i]) === key) return;
          titles.push(value);
        }
        addTitle(title);
        addTitle(original);
        var alt = data.alternative_titles || {};
        var altList = isTv ? (alt.results || []) : (alt.titles || []);
        for (var i = 0; i < altList.length && titles.length < 8; i++) addTitle(altList[i] && (altList[i].title || altList[i].name));
        var rawDate = isTv ? data.first_air_date : data.release_date;
        return { title: title || original, titles: titles.slice(0, 5), year: rawDate ? String(rawDate).slice(0, 4) : "" };
      })
      .then(function (info) {
        if (!info || !info.titles.length) { log("TMDB details or titles unavailable"); return null; }
        log("TMDB titles=" + info.titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));
        var results = [];
        var seen = {};
        var attempts = info.titles.slice(0, 5);
        var chain = Promise.resolve();
        attempts.forEach(function (query) {
          chain = chain.then(function () {
            return searchSite(query).then(function (items) {
              (items || []).forEach(function (item) {
                var key = String(item.url || item.slug || item.title || "");
                if (key && !seen[key]) { seen[key] = true; results.push(item); }
              });
            });
          });
        });
        return chain.then(function () {
          var match = findBestMatch(results, info.titles, info.year, isTv);
          if (!match) { log("no confident matching page found"); return null; }
          log("matched page=" + match.url);
          var pageUrl = match.url;
          var display = info.title + (info.year ? " (" + info.year + ")" : "");
          if (!isTv) return { pageUrl: pageUrl, display: display, slug: match.slug || slugFromUrl(pageUrl) };
          return fetchText(pageUrl, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
            if (!html) { log("series detail page empty"); return null; }
            var epUrl = findEpisodeUrl(html, seasonNum, episodeNum);
            if (!epUrl) { log("episode URL not found S" + seasonNum + "E" + episodeNum); return null; }
            return { pageUrl: epUrl, display: display + " S" + seasonNum + "E" + episodeNum, slug: match.slug || slugFromUrl(pageUrl) };
          });
        });
      })
      .then(function (ctx) {
        if (!ctx || !ctx.pageUrl) return [];
        return resolveStream(ctx.pageUrl).then(function (resolved) {
          var urls = resolved && (resolved.urls || (resolved.url ? [resolved.url] : [])) || [];
          if (!urls.length) { log("no stream URLs resolved"); return []; }
          return urls.map(function (url, index) {
            var isM3u8 = /\.m3u8(?:[?#]|$)/i.test(url) || /(?:\/hls\/|playlist|master\.m3u8)/i.test(url);
            return {
              name: "FullHDFilmizlesene",
              title: urls.length > 1 ? (ctx.display + " [" + (index + 1) + "]") : ctx.display,
              url: url,
              quality: "Auto",
              isM3u8: isM3u8,
              type: isM3u8 ? "hls" : "mp4",
              language: "tr",
              provider: "fullhdfilmizlesene",
              headers: { "User-Agent": UA, "Referer": ctx.pageUrl },
              subtitles: resolved.subtitles || [],
              behaviorHints: { bingeGroup: "fullhdfilmizlesene-" + (ctx.slug || slugFromUrl(ctx.pageUrl) || norm(ctx.display).replace(/\s+/g, "-")) }
            };
          });
        });
      })
      .catch(function (err) { log("getStreams error: " + (err && err.message || err)); return []; });
  }

  function findEpisodeUrl(html, season, episode) {
    var candidates = [];
    var seen = {};
    var attrRe = /<(?:a|iframe|source)\b[^>]*(?:href|data-href|src|data-src)\s*=\s*(['\"])(.*?)\1[^>]*>/gi;
    var m;
    while ((m = attrRe.exec(html))) {
      var value = absUrl(m[2]);
      if (/\/bolum\//i.test(value) && !seen[value]) { seen[value] = true; candidates.push(value); }
    }
    var rawRe = /(?:https?:\/\/[^\s"'<>]+)?\/bolum\/[^\s"'<>]+/gi;
    while ((m = rawRe.exec(html))) {
      var raw = absUrl(decodeEntities(m[0]));
      if (raw && !seen[raw]) { seen[raw] = true; candidates.push(raw); }
    }
    log("episode link candidates=" + candidates.length);
    for (var i = 0; i < candidates.length; i++) {
      var route = candidates[i];
      var match = route.match(/(\d+)-sezon-(\d+)/i);
      if (!match) match = route.match(/sezon[-\/](\d+)[^?#]*?(?:bolum|episode)[-\/](\d+)/i);
      if (match && parseInt(match[1], 10) === season && parseInt(match[2], 10) === episode) return route;
    }
    return null;
  }

  function onSettings() { return []; }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
