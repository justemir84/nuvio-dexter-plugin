/**
 * hdfilmcehennemi - HDFilmCehennemi provider for Nuvio
 * Flow: TMDB -> hdfilmcehennemi.land search -> movie/episode page
 *       -> admin-ajax get_video_url -> setplay -> fastplay -> HLS
 *
 * .nl is Cloudflare/geo protected; .land is the globally reachable mirror.
 * FastPlay requires a fresh single-use X-Sp proof for every playlist request,
 * which a normal player cannot generate. We therefore snapshot the master,
 * variant, audio and subtitle playlists into one self-contained data: URL.
 * Segment URLs point at srv.* and only need a fastplay Referer.
 *
 * Hermes-safe: Promise chains / async-await, no external deps.
 */
(function () {
  "use strict";

  var BASE = "https://www.hdfilmcehennemi.land";
  var FASTPLAY_ORIGIN = "https://fastplay.mom";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;
  var MAX_TITLES = 5;

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function cleanText(html) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function decodeEntities(text) {
    var s = String(text || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); });
    return s.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
      .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
      .replace(/â/g, "a").replace(/î/g, "i").replace(/û/g, "u")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function unique(list) {
    var out = [], seen = {};
    (list || []).forEach(function (item) {
      var value = String(item || "").trim();
      if (!value) return;
      var key = normalize(value);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(value);
    });
    return out;
  }

  function absolute(url, base) {
    try { return new URL(url, base || BASE).toString(); } catch (e) { return String(url || ""); }
  }

  function atobSafe(str) {
    if (typeof atob === "function") {
      try { return atob(str); } catch (e) {}
    }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var output = "";
    str = String(str).replace(/[^A-Za-z0-9\+\/=]/g, "");
    for (var i = 0; i < str.length;) {
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

  // UTF-8 -> base64 without btoa/unescape (QuickJS-safe).
  function base64Encode(str) {
    var text = String(str || "");
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      } else if (code < 0xd800 || code >= 0xe000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      } else {
        i++;
        var code2 = text.charCodeAt(i);
        var cp = 0x10000 + ((code & 0x3ff) << 10) + (code2 & 0x3ff);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    for (var j = 0; j < bytes.length; j += 3) {
      var b1 = bytes[j];
      var b2 = bytes[j + 1];
      var b3 = bytes[j + 2];
      out += chars[b1 >> 2];
      out += chars[((b1 & 3) << 4) | (b2 === undefined ? 0 : b2 >> 4)];
      out += b2 === undefined ? "=" : chars[((b2 & 15) << 2) | (b3 === undefined ? 0 : b3 >> 6)];
      out += b3 === undefined ? "=" : chars[b3 & 63];
    }
    return out;
  }

  function fnv1a(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  function buildXSp(sp) {
    var now = Math.floor(Date.now() / 1000);
    var random = Math.floor(2176782336 * Math.random()).toString(36);
    return now + "." + random + "." + fnv1a(sp + "|" + now + "|" + random);
  }

  function fetchText(url, options, timeout) {
    var timer = null;
    var opts = options || {};
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout || TIMEOUT);
    });
    return Promise.race([fetch(url, opts), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return res.text();
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchJson(url, options, timeout) {
    return fetchText(url, options, timeout).then(function (text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) { return null; }
    });
  }

  async function fetchJsonSafe(url, options, timeout) {
    try { return await fetchJson(url, options, timeout); } catch (e) { return null; }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function tmdbDetails(tmdbId, type, apiKey) {
    var isTv = type === "tv" || type === "series";
    var endpoint = isTv ? "tv" : "movie";
    var key = encodeURIComponent(apiKey);
    var base = "https://api.themoviedb.org/3/" + endpoint + "/" + encodeURIComponent(tmdbId) + "?api_key=" + key + "&language=en-US";
    var data = await fetchJsonSafe(base, { headers: { "User-Agent": UA, Accept: "application/json" } }, 10000);
    if (!data) return null;

    var title = isTv ? (data.name || data.original_name || "") : (data.title || data.original_title || "");
    var original = isTv ? (data.original_name || "") : (data.original_title || "");
    var rawDate = isTv ? data.first_air_date : data.release_date;
    var year = rawDate ? String(rawDate).slice(0, 4) : "";
    var titles = [title, original];

    var extraUrls = [
      "https://api.themoviedb.org/3/" + endpoint + "/" + encodeURIComponent(tmdbId) + "/translations?api_key=" + key,
      "https://api.themoviedb.org/3/" + endpoint + "/" + encodeURIComponent(tmdbId) + "/alternative_titles?api_key=" + key
    ];
    var extras = await Promise.all(extraUrls.map(function (url) {
      return fetchJsonSafe(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, 8000);
    }));

    // Turkish titles first: hdfilmcehennemi.land indexes Turkish names.
    var priorityTitles = [];
    var otherTitles = [];
    var translations = extras[0];
    if (translations && translations.translations) {
      translations.translations.forEach(function (item) {
        if (!item || !item.data) return;
        var name = isTv ? item.data.name : item.data.title;
        if (!name) return;
        if (item.iso_639_1 === "tr") priorityTitles.push(name);
        else otherTitles.push(name);
      });
    }

    var alternatives = extras[1];
    if (alternatives) {
      (alternatives.titles || alternatives.results || []).forEach(function (item) {
        if (!item || !item.title) return;
        if (item.iso_3166_1 === "TR") priorityTitles.push(item.title);
        else otherTitles.push(item.title);
      });
    }

    return {
      title: title,
      originalTitle: original,
      year: year,
      titles: unique([title, original].concat(priorityTitles, otherTitles)).slice(0, MAX_TITLES)
    };
  }

  function parseResults(html) {
    var out = [], seen = {};
    var articles = String(html || "").match(/<article[\s\S]*?<\/article>/gi) || [];
    articles.forEach(function (article) {
      var hrefMatch = article.match(/href="((?:https:\/\/www\.hdfilmcehennemi\.land)?\/(?:film|dizi)\/[^"]+)"/i);
      if (!hrefMatch) return;
      var url = absolute(decodeEntities(hrefMatch[1]), BASE);
      if (seen[url]) return;
      seen[url] = true;
      var titleMatch = article.match(/<div class="title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      var yearMatch = article.match(/<span class="year">(\d{4})<\/span>/i);
      var typeMatch = article.match(/<span class="(movies|tvshows)">\s*([^<]+)/i);
      out.push({
        url: url,
        title: cleanText(decodeEntities(titleMatch ? titleMatch[1] : "")),
        year: yearMatch ? yearMatch[1] : "",
        type: typeMatch ? cleanText(typeMatch[2]) : "",
        isTv: /\/dizi\//i.test(url) || (typeMatch && /tvshows/i.test(typeMatch[1]))
      });
    });
    return out;
  }

  function scoreResult(result, titles, year, isTv) {
    if (result.isTv !== isTv) return -Infinity;
    var resultTitle = normalize(result.title);
    if (!resultTitle) return -Infinity;
    var best = -Infinity;

    titles.forEach(function (candidate) {
      var query = normalize(candidate);
      if (!query) return;
      var score = -Infinity;

      if (resultTitle === query) score = 120;
      else if (resultTitle.indexOf(query) !== -1) score = 100;
      else if (query.indexOf(resultTitle) !== -1 && resultTitle.length > 4) score = 90;
      else {
        var words = query.split(" ").filter(function (word) { return word.length > 2; });
        if (!words.length) return;
        var hits = 0;
        words.forEach(function (word) { if (resultTitle.indexOf(word) !== -1) hits++; });
        var coverage = hits / words.length;
        if (coverage >= 0.75) score = 60;
        else if (coverage >= 0.5) score = 30;
      }

      if (score === -Infinity) return;
      if (year && result.year) {
        if (String(result.year) === String(year)) score += 40;
        else score -= 25;
      }
      if (score > best) best = score;
    });

    return best;
  }

  function findBestMatch(results, titles, year, isTv) {
    var best = null;
    var bestScore = 40;
    (results || []).forEach(function (result) {
      var score = scoreResult(result, titles, year, isTv);
      if (score > bestScore) {
        bestScore = score;
        best = result;
      }
    });
    if (best) return best;

    var typed = (results || []).filter(function (result) { return result.isTv === isTv; });
    return typed.length === 1 ? typed[0] : null;
  }

  async function searchSite(titles) {
    var all = [], seen = {};
    for (var i = 0; i < titles.length; i++) {
      var query = titles[i];
      if (!query) continue;
      var html = null;
      try {
        html = await fetchText(BASE + "/?s=" + encodeURIComponent(query), {
          headers: { "User-Agent": UA, "Referer": BASE + "/" }
        }, 12000);
      } catch (e) {}
      if (!html) continue;
      parseResults(html).forEach(function (result) {
        if (seen[result.url]) return;
        seen[result.url] = true;
        all.push(result);
      });
      if (all.length >= 12) break;
    }
    return all;
  }

  function findEpisodeUrl(html, season, episode) {
    var wantedSeason = parseInt(season, 10) || 1;
    var wantedEpisode = parseInt(episode, 10) || 1;
    var links = [];
    var re = /href="([^"]*\/bolum\/[^"]+)"/gi;
    var match;
    while ((match = re.exec(String(html || "")))) {
      var url = absolute(decodeEntities(match[1]), BASE);
      if (links.indexOf(url) === -1) links.push(url);
    }

    var best = null;
    links.forEach(function (url) {
      var parsed = url.match(/(\d+)-sezon-(\d+)-bolum/i);
      if (!parsed) return;
      if (parseInt(parsed[1], 10) !== wantedSeason) return;
      if (parseInt(parsed[2], 10) !== wantedEpisode) return;
      if (!best || /-izle\b/i.test(url)) best = url;
    });
    return best;
  }

  async function getPlayerUrl(pageUrl) {
    var html = null;
    try {
      html = await fetchText(pageUrl, { headers: { "User-Agent": UA, "Referer": BASE + "/" } }, TIMEOUT);
    } catch (e) {}
    if (!html) return null;

    var nonceMatch = html.match(/window\.videoAjax\s*=\s*\{[\s\S]*?nonce\s*:\s*'([^']+)'/);
    var nonce = nonceMatch ? nonceMatch[1] : (html.match(/videoAjax[\s\S]{0,200}?nonce\s*:\s*'([^']+)'/) || [])[1];
    if (!nonce) return null;

    var pairs = [], seen = {};
    var optionRe = /<a[^>]*class="[^"]*options[^"]*"[^>]*>/gi;
    var tag;
    while ((tag = optionRe.exec(html))) {
      var id = (tag[0].match(/data-post-id="(\d+)"/) || [])[1];
      var player = (tag[0].match(/data-player-name="([^"]*)"/) || [])[1] || "SetPlay";
      if (!id) continue;
      var key = id + "|" + player;
      if (seen[key]) continue;
      seen[key] = true;
      pairs.push({ id: id, player: player });
    }
    if (!pairs.length) {
      var fallbackId = (html.match(/data-post-id="(\d+)"/) || [])[1];
      if (fallbackId) pairs.push({ id: fallbackId, player: "SetPlay" });
    }

    for (var i = 0; i < pairs.length; i++) {
      var body = "action=get_video_url&nonce=" + encodeURIComponent(nonce) +
        "&post_id=" + encodeURIComponent(pairs[i].id) +
        "&player_name=" + encodeURIComponent(pairs[i].player) +
        "&part_key=";
      var response = null;
      try {
        response = await fetchText(BASE + "/wp-admin/admin-ajax.php", {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE,
            "Referer": pageUrl
          },
          body: body
        }, TIMEOUT);
      } catch (e) {}
      if (!response) continue;
      var parsed = null;
      try { parsed = JSON.parse(response); } catch (e) {}
      if (parsed && parsed.success && parsed.data && parsed.data.url) return parsed.data.url;
    }
    return null;
  }

  function decodeSetplay(html) {
    var match = String(html || "").match(/SPG\.cerceve\(\s*"b2"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
    if (!match) return null;
    var payload = atobSafe(match[1]);
    var key = atobSafe(match[2]);
    if (!payload || !key) return null;
    var out = "";
    for (var i = 0; i < payload.length; i++) {
      out += String.fromCharCode(payload.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  async function resolveSetplay(embedUrl) {
    if (/fastplay\.mom\/video\//i.test(embedUrl)) return embedUrl;
    var html = null;
    try {
      html = await fetchText(embedUrl, { headers: { "User-Agent": UA, "Referer": BASE + "/" } }, TIMEOUT);
    } catch (e) {}
    if (!html) return null;
    return decodeSetplay(html);
  }

  function absolutizePlaylist(text, baseUrl) {
    return String(text || "").split("\n").map(function (line) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) === "#") return line;
      return absolute(trimmed, baseUrl);
    }).join("\n");
  }

  function playlistQuality(master) {
    var heights = [];
    var re = /RESOLUTION=\d+x(\d+)/gi;
    var match;
    while ((match = re.exec(String(master || "")))) heights.push(parseInt(match[1], 10));
    if (!heights.length) return "Auto";
    var height = Math.max.apply(null, heights);
    if (height >= 2000) return "2160p";
    if (height >= 1400) return "1440p";
    if (height >= 1000) return "1080p";
    if (height >= 700) return "720p";
    if (height >= 400) return "480p";
    return height + "p";
  }

  async function fetchProtected(url, referer, sp, timeout) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var headers = {
        "User-Agent": UA,
        "Referer": referer,
        "Origin": FASTPLAY_ORIGIN,
        "X-Sp": buildXSp(sp)
      };
      try {
        var text = await fetchText(url, { headers: headers }, timeout || TIMEOUT);
        if (text && text.indexOf("#EXTM3U") !== -1) return text;
      } catch (e) {}
      if (attempt < 2) await sleep(350 + attempt * 350);
    }
    return null;
  }

  function dataPlaylist(text) {
    return "data:application/vnd.apple.mpegurl;base64," + base64Encode(text);
  }

  async function resolveFastplay(fastUrl) {
    var html = null;
    try {
      html = await fetchText(fastUrl, { headers: { "User-Agent": UA, "Referer": "https://setplay.sbs/" } }, TIMEOUT);
    } catch (e) {}
    if (!html) return null;

    var sp = (html.match(/"sp"\s*:\s*"([^"]+)"/) || [])[1];
    var stream = (html.match(/\bstream\s*:\s*"([^"]+)"/) || [])[1];
    if (!stream) return null;

    var masterUrl = absolute(stream, fastUrl);
    var master = await fetchProtected(masterUrl, fastUrl, sp, TIMEOUT);
    if (!master) return null;

    var lines = master.split("\n");
    var variants = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("#EXT-X-STREAM-INF") !== 0) continue;
      var uri = (lines[i + 1] || "").trim();
      if (uri && uri.charAt(0) !== "#") {
        variants.push({ index: i, line: lines[i], uri: absolute(uri, masterUrl) });
      }
    }

    var variantData = {};
    var workingVariants = 0;
    var subtitleBase = null;
    for (var v = 0; v < variants.length; v++) {
      var variantPlaylist = await fetchProtected(variants[v].uri, fastUrl, sp, TIMEOUT);
      if (!variantPlaylist) continue;
      variantData[variants[v].index] = dataPlaylist(absolutizePlaylist(variantPlaylist, variants[v].uri));
      workingVariants++;

      if (!subtitleBase) {
        var variantLines = variantPlaylist.split("\n");
        for (var k = 0; k < variantLines.length; k++) {
          var variantLine = variantLines[k].trim();
          if (!variantLine || variantLine.charAt(0) === "#") continue;
          var segmentUrl = absolute(variantLine, variants[v].uri);
          var baseMatch = segmentUrl.match(/^(.*)\/video\/[^/]+$/i);
          if (baseMatch) subtitleBase = baseMatch[1] + "/subtitle/";
          break;
        }
      }
    }

    if (!variants.length) {
      var mediaData = dataPlaylist(absolutizePlaylist(master, masterUrl));
      return {
        url: dataPlaylist("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1\n" + mediaData),
        quality: "Auto",
        subtitles: []
      };
    }
    if (!workingVariants) return null;

    var output = [];
    var mediaCache = {};
    var audioIncluded = 0;
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (line.indexOf("#EXT-X-I-FRAME-STREAM-INF") === 0) continue;
      if (line.indexOf("#EXT-X-MEDIA:") === 0) {
        if (/TYPE=SUBTITLES/i.test(line)) continue;
        var uriMatch = line.match(/URI="([^"]+)"/);
        if (!uriMatch) { output.push(line); continue; }
        var mediaUrl = absolute(uriMatch[1], masterUrl);
        if (!mediaCache[mediaUrl]) {
          await sleep(120);
          mediaCache[mediaUrl] = await fetchProtected(mediaUrl, fastUrl, sp, TIMEOUT);
        }
        var mediaPlaylist = mediaCache[mediaUrl];
        if (!mediaPlaylist) continue;
        output.push(line.replace(/URI="[^"]+"/, 'URI="' + dataPlaylist(absolutizePlaylist(mediaPlaylist, mediaUrl)) + '"'));
        audioIncluded++;
        continue;
      }
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
        var replacement = variantData[j];
        if (!replacement) { j++; continue; }
        output.push(line);
        output.push(replacement);
        j++;
        continue;
      }
      output.push(line);
    }

    // Subtitles are delivered as sidecar VTT tracks; keep the master clean.
    output = output.map(function (line) {
      if (line.indexOf("#EXT-X-STREAM-INF") !== 0) return line;
      var cleaned = line.replace(/,SUBTITLES="[^"]*"/, "");
      if (!audioIncluded) cleaned = cleaned.replace(/,AUDIO="[^"]*"/, "");
      return cleaned;
    });

    var finalMaster = output.join("\n");
    if (finalMaster.indexOf("#EXTM3U") === -1) return null;

    var subtitles = [];
    if (subtitleBase) {
      var subtitleCandidates = [
        { file: "tur.vtt", language: "tr", name: "Türkçe" },
        { file: "eng.vtt", language: "en", name: "English" }
      ];
      for (var c = 0; c < subtitleCandidates.length; c++) {
        var vttUrl = subtitleBase + subtitleCandidates[c].file;
        var vttText = null;
        try {
          vttText = await fetchText(vttUrl, {
            headers: { "User-Agent": UA, "Referer": "https://fastplay.mom/" }
          }, 8000);
        } catch (e) {}
        if (vttText && /^WEBVTT/i.test(vttText.trim())) {
          subtitles.push({
            url: vttUrl,
            language: subtitleCandidates[c].language,
            name: subtitleCandidates[c].name,
            headers: { "User-Agent": UA, "Referer": "https://fastplay.mom/" }
          });
        }
      }
    }

    return {
      url: dataPlaylist(finalMaster),
      quality: playlistQuality(master),
      subtitles: subtitles
    };
  }

  async function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[hdfilmcehennemi]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var apiKey = getTmdbKey(settings);
    if (!apiKey) {
      console.log(tag + " TMDB API key missing");
      return [];
    }

    var info = await tmdbDetails(tmdbId, isTv ? "tv" : "movie", apiKey);
    if (!info || !info.title) {
      console.log(tag + " TMDB details not found");
      return [];
    }

    var wantedSeason = parseInt(season, 10) || 1;
    var wantedEpisode = parseInt(episode, 10) || 1;
    var display = info.title + (info.year ? " (" + info.year + ")" : "");
    if (isTv) display += " S" + wantedSeason + "E" + wantedEpisode;

    console.log(tag + " Searching: " + info.titles.join(" | "));
    var results = await searchSite(info.titles);
    var match = findBestMatch(results, info.titles, info.year, isTv);
    if (!match) {
      console.log(tag + " No matching page found");
      return [];
    }
    console.log(tag + " Matched page: " + match.title + " -> " + match.url);

    var pageUrl = match.url;
    if (isTv) {
      var seriesHtml = null;
      try {
        seriesHtml = await fetchText(pageUrl, { headers: { "User-Agent": UA, "Referer": BASE + "/" } }, TIMEOUT);
      } catch (e) {}
      if (!seriesHtml) {
        console.log(tag + " Failed to fetch series page");
        return [];
      }
      var episodeUrl = findEpisodeUrl(seriesHtml, wantedSeason, wantedEpisode);
      if (!episodeUrl) {
        console.log(tag + " Episode not found: S" + wantedSeason + "E" + wantedEpisode);
        return [];
      }
      pageUrl = episodeUrl;
      console.log(tag + " Episode page: " + pageUrl);
    }

    var embedUrl = await getPlayerUrl(pageUrl);
    if (!embedUrl) {
      console.log(tag + " Player URL not found");
      return [];
    }
    console.log(tag + " Embed: " + String(embedUrl).slice(0, 120));

    var fastUrl = await resolveSetplay(embedUrl);
    if (!fastUrl) {
      console.log(tag + " Failed to resolve setplay");
      return [];
    }
    console.log(tag + " FastPlay: " + fastUrl);

    var resolved = await resolveFastplay(fastUrl);
    if (!resolved) {
      await sleep(900);
      resolved = await resolveFastplay(fastUrl);
    }
    if (!resolved) {
      console.log(tag + " Failed to resolve fastplay");
      return [];
    }
    console.log(tag + " Stream ready (" + resolved.quality + ", " + resolved.url.length + " chars, " + (resolved.subtitles || []).length + " subs)");

    return [{
      name: "HDFilmCehennemi - " + resolved.quality,
      title: display + "\n" + resolved.quality + " [HLS]",
      url: resolved.url,
      quality: resolved.quality,
      isM3u8: true,
      type: "hls",
      headers: {
        "User-Agent": UA,
        "Referer": "https://fastplay.mom/",
        "Origin": FASTPLAY_ORIGIN
      },
      subtitles: resolved.subtitles || [],
      provider: "hdfilmcehennemi"
    }];
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
