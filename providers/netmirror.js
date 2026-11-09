/**
 * netmirror - NetMirror provider for Nuvio
 * Flow: TMDB -> title -> NetMirror search -> post -> player
 *       -> HLS master m3u8 (coklu ses + coklu altyazi icinde)
 *
 * Notlar:
 * - Master playlist EXT-X-MEDIA ile coklu ses tasir; ornek Fight Club:
 *   10 ses (German/English/Spanish x2/French/Italian/Japanese/Polish/
 *   Portuguese/Turkish) + 5 altyazi. Turkce dublaj bu listede gosterilir.
 * - Player m3u8'i tek masterdir; kalite RESOLUTION'dan okunur.
 * - Hermes uyumlu: yalnizca Promise zinciri, bagimlilik yok.
 */
(function () {
  "use strict";

  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TMDB_BASE = "https://api.themoviedb.org/3";
  var TIMEOUT = 15000;

  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0";
  var BASE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Requested-With": "NetmirrorNewTV v1.0",
    "User-Agent": UA + " /OS.GatuNewTV v1.0",
    "Accept": "application/json, text/plain, */*"
  };

  var OTT_MAP = { netflix: "nf", primevideo: "pv", hotstar: "hs", disney: "hs" };
  var PLATFORMS = ["netflix", "primevideo", "hotstar", "disney"];

  var DOMAINS_B64 = [
    "aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==",
    "aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=",
    "aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo="
  ];

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function fetchTimeout(url, options, timeout) {
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("API Timeout")); }, timeout || TIMEOUT);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function safeAtob(encoded) {
    if (typeof atob === "function") return atob(encoded);
    return Buffer.from(encoded, "base64").toString("binary");
  }

  function norm(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9çğıöşü]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function tmdbInfo(tmdbId, mediaType, apiKey) {
    var path = mediaType === "tv" ? "tv" : "movie";
    var url = TMDB_BASE + "/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) + "&language=tr-TR&append_to_response=alternative_titles";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, 10000)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (!d || d.success === false) return null;
        var main = mediaType === "tv" ? (d.name || "") : (d.title || "");
        var original = mediaType === "tv" ? (d.original_name || "") : (d.original_title || "");
        var altList = (d.alternative_titles && (mediaType === "tv" ? d.alternative_titles.results : d.alternative_titles.titles)) || [];
        var alts = [];
        for (var i = 0; i < altList.length && alts.length < 4; i++) {
          var t = altList[i] && altList[i].title;
          if (t && norm(t) !== norm(main) && alts.indexOf(t) === -1) alts.push(t);
        }
        return { title: main, original: original, alternatives: alts, year: String(mediaType === "tv" ? d.first_air_date : d.release_date || "").slice(0, 4) };
      })
      .catch(function () { return null; });
  }

  var resolvedApiUrl = "";

  function resolveApiUrl() {
    if (resolvedApiUrl) return Promise.resolve(resolvedApiUrl);
    function tryNext(idx) {
      if (idx >= DOMAINS_B64.length) return Promise.reject(new Error("Failed to resolve NewTV API base URL"));
      var base = safeAtob(DOMAINS_B64[idx]).replace(/\/$/, "");
      return fetchTimeout(base + "/checknewtv.php", { headers: BASE_HEADERS }, 8000)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && data.token_hash) {
            resolvedApiUrl = safeAtob(data.token_hash).replace(/\/$/, "");
            return resolvedApiUrl;
          }
          return tryNext(idx + 1);
        })
        .catch(function () { return tryNext(idx + 1); });
    }
    return tryNext(0);
  }

  function ottHeaders(ott, extra) {
    var h = {};
    for (var k in BASE_HEADERS) h[k] = BASE_HEADERS[k];
    h["Ott"] = ott;
    if (extra) for (var k2 in extra) h[k2] = extra[k2];
    return h;
  }

  function jsonGet(url, headers) {
    return fetchTimeout(url, { headers: headers || BASE_HEADERS }, 10000)
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  function pickSearchResult(results, titles, year) {
    if (!results || !results.length) return null;
    var best = null, bestScore = -1;
    results.forEach(function (r) {
      if (!r || !r.id) return;
      var score = 0;
      var itemTitle = norm(r.t);
      var base = titles[0];
      if (itemTitle && norm(base) && (itemTitle === norm(base) || itemTitle.indexOf(norm(base)) !== -1)) score += 10;
      else if (itemTitle && norm(base)) {
        var all = true;
        norm(base).split(" ").forEach(function (w) { if (w.length > 2 && itemTitle.indexOf(w) === -1) all = false; });
        if (all) score += 5;
      }
      if (score > bestScore) { bestScore = score; best = r; }
    });
    if (bestScore <= 0) best = results[0];
    return best;
  }

  function parseEpisodes(postData) {
    var episodes = [];
    if (!postData) return episodes;
    var selectedIdx = -1;
    if (postData.season) {
      for (var i = 0; i < postData.season.length; i++) {
        if (postData.season[i] && postData.season[i].selected === true) selectedIdx = i;
      }
    }
    var selectedNum = selectedIdx >= 0 ? selectedIdx + 1 : null;
    if (postData.episodes) {
      postData.episodes.filter(function (e) { return e !== null; }).forEach(function (ep) {
        var epNum = ep.ep ? parseInt(ep.ep) : (ep.epNum ? parseInt(String(ep.epNum).replace("E", "")) : null);
        var sNum = selectedNum || (ep.sNum ? parseInt(String(ep.sNum).replace("S", "")) : null);
        if (ep.id) episodes.push({ id: ep.id, s: sNum, ep: epNum });
      });
    }
    return episodes;
  }

  function fetchEpisodesPage(seasonId, page, seasonNumber, apiBase, ott) {
    var episodes = [];
    var url = apiBase + "/newtv/episodes.php?id=" + encodeURIComponent(seasonId) + "&page=" + page;
    return jsonGet(url, ottHeaders(ott)).then(function (data) {
      if (!data) return episodes;
      if (data.episodes) {
        data.episodes.filter(function (e) { return e !== null; }).forEach(function (ep) {
          var epNum = ep.ep ? parseInt(ep.ep) : (ep.epNum ? parseInt(String(ep.epNum).replace("E", "")) : null);
          var sNum = seasonNumber || (ep.sNum ? parseInt(String(ep.sNum).replace("S", "")) : null);
          if (ep.id) episodes.push({ id: ep.id, s: sNum, ep: epNum });
        });
      }
      if (data.nextPageShow === 1) {
        return fetchEpisodesPage(seasonId, page + 1, seasonNumber, apiBase, ott).then(function (more) { return episodes.concat(more); });
      }
      return episodes;
    });
  }

  function getAllEpisodes(contentId, postData, ott, apiBase, tag) {
    var episodes = parseEpisodes(postData);
    var selectedIdx = -1, selectedId = null;
    if (postData && postData.season) {
      for (var i = 0; i < postData.season.length; i++) {
        if (postData.season[i] && postData.season[i].selected === true) selectedIdx = i;
      }
      if (selectedIdx >= 0) selectedId = postData.season[selectedIdx].id;
      else if (postData.nextPageSeason) selectedId = postData.nextPageSeason;
    }
    var selectedNum = selectedIdx >= 0 ? selectedIdx + 1 : null;
    var chain = Promise.resolve(episodes);
    if (postData && postData.nextPageShow === 1 && selectedId) {
      chain = chain.then(function (eps) {
        return fetchEpisodesPage(selectedId, 2, selectedNum, apiBase, ott).then(function (more) { return eps.concat(more); });
      });
    }
    if (postData && postData.season) {
      postData.season.forEach(function (season, index) {
        if (!season || !season.id || season.id === selectedId) return;
        chain = chain.then(function (eps) {
          return fetchEpisodesPage(season.id, 1, index + 1, apiBase, ott).then(function (more) { return eps.concat(more); });
        });
      });
    }
    return chain;
  }

  function parseMaster(pl) {
    var text = String(pl || "");
    var best = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g, m;
    while ((m = re.exec(text)) !== null) {
      var side = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
      if (side > best) best = side;
    }
    var quality = "Auto";
    if (best >= 2000) quality = "2160p";
    else if (best >= 1000) quality = "1080p";
    else if (best >= 700) quality = "720p";
    else if (best >= 450) quality = "480p";

    var audios = [], subs = [];
    var mediaRe = /#EXT-X-MEDIA:([^\n]+)/g, mm;
    while ((mm = mediaRe.exec(text)) !== null) {
      var line = mm[1];
      var type = (line.match(/TYPE=([A-Z]+)/) || [])[1] || "";
      var name = ((line.match(/NAME="([^"]+)"/) || [])[1] || "").trim();
      var lang = ((line.match(/LANGUAGE="([^"]+)"/) || [])[1] || "").trim();
      var uri = ((line.match(/URI="([^"]+)"/) || [])[1] || "").trim();
      if (type === "AUDIO" && name) audios.push({ name: name, lang: lang || "und", uri: uri });
      if (type === "SUBTITLES" && uri) subs.push({ label: name || lang, lang: lang, url: uri });
    }
    var hasTurkishAudio = audios.some(function (a) { return /turkish/i.test(a.name) || a.lang === "tur"; });
    return { quality: quality, audios: audios, subs: subs, hasTurkishAudio: hasTurkishAudio };
  }

  function fetchFromPlatform(platformKey, titles, year, mediaType, season, episode, display) {
    var ott = OTT_MAP[platformKey];
    return resolveApiUrl().then(function (apiBase) {
      function trySearch(idx) {
        if (idx >= titles.length) return Promise.resolve(null);
        return jsonGet(apiBase + "/newtv/search.php?s=" + encodeURIComponent(titles[idx]), ottHeaders(ott)).then(function (searchData) {
          if (searchData && searchData.searchResult && searchData.searchResult.length) {
            var result = pickSearchResult(searchData.searchResult, titles, year);
            if (result) return { result: result, searchData: searchData };
          }
          return trySearch(idx + 1);
        });
      }
      return trySearch(0).then(function (found) {
        if (!found) return null;
        var result = found.result;
        var contentId = result.id;
        return jsonGet(apiBase + "/newtv/post.php?id=" + contentId, ottHeaders(ott, { Lastep: "", Usertoken: "" })).then(function (postData) {
          if (!postData) return null;
          var isSeries = postData.type === "t" || (postData.episodes && postData.episodes.filter(function (e) { return e !== null; }).length > 0);
          if (!isSeries && mediaType === "tv") return null;
          if (isSeries && mediaType === "movie" && postData.type === "t") return null;
          var targetId = postData.main_id || contentId;
          var chain = Promise.resolve(targetId);
          if (mediaType === "tv") {
            chain = getAllEpisodes(contentId, postData, ott, apiBase).then(function (episodes) {
              var targetEp = null;
              episodes.forEach(function (ep) {
                if (ep && ep.s === season && ep.ep === episode) targetEp = ep;
              });
              if (!targetEp) return null;
              return targetEp.id;
            });
          } else {
            if (isSeries) return null;
          }
          return chain.then(function (tid) {
            if (!tid) return null;
            return jsonGet(apiBase + "/newtv/player.php?id=" + tid, ottHeaders(ott, { Usertoken: "" })).then(function (response) {
              if (!response || !response.video_link) return null;
              var masterUrl = response.video_link;
              var referer = response.referer || apiBase;
              return fetchTimeout(masterUrl, { headers: { "User-Agent": UA, Referer: referer, Accept: "*/*" } }, 10000)
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (pl) {
                  if (!pl || pl.indexOf("#EXTM3U") === -1) return null;
                  var meta = parseMaster(pl);
                  var subs = meta.subs.map(function (s) {
                    return { url: s.url, language: s.label, name: s.label, lang: s.lang, headers: { "User-Agent": UA, Referer: referer } };
                  });
                  var extras = [];
                  if (meta.audios.length) extras.push(meta.audios.length + " ses");
                  if (meta.subs.length) extras.push(meta.subs.length + " altyazi");
                  var langs = meta.audios.map(function (a) { return a.name; }).join(", ");
                  var platformName = platformKey.charAt(0).toUpperCase() + platformKey.slice(1);
                  return {
                    name: "NetMirror (" + platformName + ") - " + meta.quality + (meta.hasTurkishAudio ? " [TR Dublaj]" : ""),
                    title: display + "\n" + meta.quality + " [HLS]" + (extras.length ? " | " + extras.join(", ") : "") + (langs ? "\nSes: " + langs : ""),
                    url: masterUrl,
                    quality: meta.quality,
                    isM3u8: true,
                    type: "hls",
                    language: "en",
                    provider: "netmirror",
                    headers: { "User-Agent": UA, Referer: referer },
                    subtitles: subs
                  };
                })
                .catch(function () { return null; });
            });
          });
        });
      });
    }).catch(function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[netmirror]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var mt = isTv ? "tv" : "movie";
    var s = parseInt(season, 10) || 1, e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);
    return tmdbInfo(tmdbId, mt, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }
      var titles = [info.title, info.original].concat(info.alternatives || []);
      titles = titles.filter(function (t, i) { return t && titles.indexOf(t) === i; });
      var display = info.title + (info.year ? " (" + info.year + ")" : "") + (isTv ? " S" + s + "E" + e : "");
      console.log(tag + " Araniyor: " + titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));
      var promises = PLATFORMS.map(function (pk) { return fetchFromPlatform(pk, titles, info.year, mt, s, e, display); });
      return Promise.all(promises).then(function (results) {
        var out = [], seen = {};
        results.forEach(function (r) {
          if (!r || !r.url || seen[r.url]) return;
          seen[r.url] = true;
          out.push(r);
        });
        function qRank(q) {
          q = String(q || "").toLowerCase();
          if (/2160|4k|uhd/.test(q)) return 5;
          if (/1080|fhd/.test(q)) return 3;
          if (/720|hd/.test(q)) return 2;
          if (/480|sd/.test(q)) return 1;
          return 0;
        }
        out.sort(function (a, b) {
          var at = /dublaj/i.test(a.name) ? 1 : 0, bt = /dublaj/i.test(b.name) ? 1 : 0;
          if (at !== bt) return bt - at;
          return qRank(b.quality) - qRank(a.quality);
        });
        console.log(tag + " Kaynak bulundu: " + out.length);
        return out;
      });
    }).catch(function () { return []; });
  }

  function onSettings() { return []; }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
