/**
 * selcukflix - Selcukflix provider for Nuvio
 * Flow: TMDB -> /api/bg/searchContent -> Next.js page __NEXT_DATA__
 *       -> AES-256-CBC secureData -> source_content iframe
 *       -> Pichive (ContentX) -> HLS
 *
 * Selcukflix encrypts every page payload with AES-256-CBC. Key derivation and
 * IV were recovered from the site's client bundle:
 *   key = sha256("!!22xx!!90!!").digest("base64").substr(0, 32)
 *   iv  = 16 zero bytes
 * The page embeds <script id="__NEXT_DATA__"> with secureData; decrypting it
 * gives content metadata plus getMoviePartSourcesById_... and getEpisodeSources.
 *
 * Sources are Pichive iframes. Pichive is Cloudflare-protected; the same
 * ContentX extraction used by CloudStream is implemented here. If the device
 * can play Selcukflix in a browser, it can normally reach Pichive too.
 *
 * Hermes-safe: Promise chains / async-await, no external deps.
 */
(function () {
  "use strict";

  var BASE = "https://selcukflix.app";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var SECRET = "!!22xx!!90!!";
  var TIMEOUT = 15000;
  var SITE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Referer": BASE + "/"
  };

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function fetchTimeout(url, options, timeout) {
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout || TIMEOUT);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function base64ToBytes(input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var str = String(input || "").replace(/[^A-Za-z0-9\+\/=]/g, "");
    var bytes = [];
    for (var i = 0; i < str.length;) {
      var e1 = chars.indexOf(str.charAt(i++));
      var e2 = chars.indexOf(str.charAt(i++));
      var e3 = chars.indexOf(str.charAt(i++));
      var e4 = chars.indexOf(str.charAt(i++));
      bytes.push((e1 << 2) | (e2 >> 4));
      if (e3 !== 64) bytes.push(((e2 & 15) << 4) | (e3 >> 2));
      if (e4 !== 64) bytes.push(((e3 & 3) << 6) | e4);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b1 = bytes[i];
      var b2 = bytes[i + 1];
      var b3 = bytes[i + 2];
      out += chars[b1 >> 2];
      out += chars[((b1 & 3) << 4) | (b2 === undefined ? 0 : b2 >> 4)];
      out += b2 === undefined ? "=" : chars[((b2 & 15) << 2) | (b3 === undefined ? 0 : b3 >> 6)];
      out += b3 === undefined ? "=" : chars[b3 & 63];
    }
    return out;
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
      .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function titleSimilarity(a, b) {
    var ta = normalize(a).split(" ").filter(Boolean);
    var tb = normalize(b).split(" ").filter(Boolean);
    if (!ta.length || !tb.length) return 0;
    var setB = {};
    tb.forEach(function (w) { setB[w] = true; });
    var hits = 0;
    ta.forEach(function (w) { if (setB[w]) hits++; });
    return hits / (ta.length + tb.length - hits);
  }

  function getCryptoJS() {
    if (typeof CryptoJS !== "undefined" && CryptoJS) return CryptoJS;
    if (typeof require === "function") {
      try {
        var mod = require("crypto-js");
        if (mod) return mod;
      } catch (e) {}
    }
    return null;
  }

  function decryptWithCryptoJS(encoded) {
    var C = getCryptoJS();
    if (!C) throw new Error("CryptoJS unavailable");
    var ciphertext = C.enc.Base64.parse(encoded);
    var params = C.lib.CipherParams.create({ ciphertext: ciphertext });
    var keyText = C.SHA256(SECRET).toString(C.enc.Base64).substring(0, 32);
    var key = C.enc.Utf8.parse(keyText);
    var iv = C.enc.Utf8.parse("\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0");
    var decrypted = C.AES.decrypt(params, key, {
      iv: iv,
      mode: C.mode.CBC,
      padding: C.pad.Pkcs7
    });
    return JSON.parse(decrypted.toString(C.enc.Utf8));
  }

  async function decryptSecureData(encoded) {
    if (!encoded) return null;
    try {
      var raw = new Uint8Array(base64ToBytes(encoded));
      var hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SECRET));
      var keyBase64 = bytesToBase64(new Uint8Array(hash)).substring(0, 32);
      var key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(keyBase64),
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      var plain = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: new Uint8Array(16) },
        key,
        raw
      );
      var text = new TextDecoder("utf-8").decode(new Uint8Array(plain));
      return JSON.parse(text);
    } catch (e) {
      console.log("[selcukflix] crypto.subtle failed (" + (e && e.message) + "), trying CryptoJS");
      return decryptWithCryptoJS(encoded);
    }
  }

  async function fetchText(url, options) {
    try {
      var response = await fetchTimeout(url, options || { headers: SITE_HEADERS }, TIMEOUT);
      if (!response.ok) return null;
      var text = await response.text();
      if (/Just a moment|cf-browser-verification|Attention Required/i.test(text)) return null;
      return text;
    } catch (e) { return null; }
  }

  async function tmdbDetails(tmdbId, isTv) {
    var type = isTv ? "tv" : "movie";
    try {
      var response = await fetchTimeout("https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_KEY + "&language=en-US", {
        headers: { "User-Agent": UA, Accept: "application/json" }
      }, 10000);
      if (!response.ok) return null;
      var data = await response.json();
      return {
        title: isTv ? (data.name || data.original_name || "") : (data.title || data.original_title || ""),
        originalTitle: isTv ? (data.original_name || "") : (data.original_title || ""),
        year: String((isTv ? data.first_air_date : data.release_date) || "").slice(0, 4)
      };
    } catch (e) { return null; }
  }

  async function searchSite(title, year, isTv) {
    if (!title) return null;
    var url = BASE + "/api/bg/searchContent?searchterm=" + encodeURIComponent(title);
    var text = null;
    try {
      var response = await fetchTimeout(url, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": BASE + "/",
          "Origin": BASE
        }
      }, TIMEOUT);
      if (response.ok) text = await response.text();
    } catch (e) {}
    if (!text) return null;

    var payload = null;
    try { payload = JSON.parse(text); } catch (e) { return null; }
    if (!payload || !payload.response) return null;

    var decoded = null;
    try { decoded = await decryptSecureData(payload.response); } catch (e) { return null; }
    var rows = decoded && Array.isArray(decoded.result) ? decoded.result : [];
    if (!rows.length) return null;

    var best = null, bestScore = 0;
    rows.forEach(function (row) {
      if (!row || !row.used_slug) return;
      var rowIsTv = String(row.used_type || "").toLowerCase().indexOf("series") !== -1 ||
        row.used_slug.indexOf("dizi/") === 0;
      if (rowIsTv !== isTv) return;
      var targetYear = parseInt(year, 10) || 0;
      var rowYear = parseInt(row.object_release_year, 10) || 0;
      var yearScore = 0;
      if (targetYear && rowYear) {
        var delta = Math.abs(targetYear - rowYear);
        if (delta === 0) yearScore = 40;
        else if (delta <= 1) yearScore = 20;
        else return;
      }
      var sim = Math.max(
        titleSimilarity(title, row.object_name),
        titleSimilarity(title, row.object_alternative_name)
      );
      if (!sim && !yearScore) return;
      var score = sim * 60 + yearScore;
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    });

    if (!best || bestScore < 25) {
      console.log("[selcukflix] Search no match: " + title + " (" + year + ")");
      return null;
    }
    console.log("[selcukflix] Search match: " + (best.object_name || title) + " -> " + best.used_slug);
    return {
      slug: best.used_slug,
      title: best.object_name || title,
      year: best.object_release_year || year,
      isTv: isTv
    };
  }

  function extractNextData(html) {
    var match = String(html || "").match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch (e) { return null; }
  }

  async function getPageData(pageUrl) {
    console.log("[selcukflix] Fetch page: " + pageUrl);
    var html = await fetchText(pageUrl, { headers: SITE_HEADERS });
    if (!html) {
      console.log("[selcukflix] Page fetch failed");
      return null;
    }
    var nextData = extractNextData(html);
    if (!nextData || !nextData.props || !nextData.props.pageProps) {
      console.log("[selcukflix] __NEXT_DATA__ missing");
      return null;
    }
    var pageProps = nextData.props.pageProps;
    if (!pageProps.secureData) {
      console.log("[selcukflix] secureData missing");
      return null;
    }
    try {
      var decoded = await decryptSecureData(pageProps.secureData);
      console.log("[selcukflix] secureData decrypted");
      return decoded;
    } catch (e) {
      console.log("[selcukflix] secureData decrypt failed: " + e.message);
      return null;
    }
  }

  function extractIframeUrl(sourceContent) {
    var match = String(sourceContent || "").match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!match) return null;
    var url = match[1];
    if (url.indexOf("//") === 0) url = "https:" + url;
    return url;
  }

  function unescapeSlash(text) {
    return String(text || "").replace(/\\\//g, "/").replace(/\\"/g, '"');
  }

  function pichiveLang(label) {
    var value = normalize(label);
    if (value.indexOf("dublaj") !== -1) return "tr";
    if (value.indexOf("ingiliz") !== -1) return "en";
    if (value.indexOf("turk") !== -1) return "tr";
    return "tr";
  }

  async function fetchPichive(url, headers, settings) {
    settings = getSettings(settings);
    var target = url;
    var proxy = settings.pichiveProxy ? String(settings.pichiveProxy).trim() : "";
    if (proxy) {
      target = proxy.indexOf("{url}") !== -1
        ? proxy.replace("{url}", encodeURIComponent(url))
        : proxy + (proxy.indexOf("?") !== -1 ? "&" : "?") + "url=" + encodeURIComponent(url);
    }
    var finalHeaders = {};
    Object.keys(headers || {}).forEach(function (key) { finalHeaders[key] = headers[key]; });
    if (settings.pichiveCookie) {
      finalHeaders.Cookie = String(settings.pichiveCookie).trim();
    }
    return fetchTimeout(target, { headers: finalHeaders }, TIMEOUT);
  }

  async function source2Stream(origin, token, iframeUrl, settings) {
    var url = origin + "/source2.php?v=" + encodeURIComponent(token);
    var response = null;
    try {
      response = await fetchPichive(url, {
        "User-Agent": UA, "Referer": iframeUrl, "Accept": "*/*"
      }, settings);
    } catch (e) {
      console.log("[selcukflix] source2 fetch error: " + e.message);
      return null;
    }
    console.log("[selcukflix] source2 HTTP " + response.status);
    if (!response.ok) return null;
    var text = await response.text();
    if (!text) return null;
    var match = text.match(/file["']?\s*:\s*["']([^"']+)["']/i);
    if (!match) return null;
    var streamUrl = unescapeSlash(match[1]);
    if (!/^https?:\/\//i.test(streamUrl)) return null;
    return streamUrl;
  }

  async function resolvePichive(iframeUrl, pageUrl, settings) {
    var origin;
    try { origin = new URL(iframeUrl).origin; } catch (e) { return null; }
    console.log("[selcukflix] Pichive iframe: " + iframeUrl);

    var response = null;
    try {
      response = await fetchPichive(iframeUrl, {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
        "Referer": pageUrl
      }, settings);
    } catch (e) {
      console.log("[selcukflix] Pichive fetch error: " + e.message);
      return null;
    }
    console.log("[selcukflix] Pichive HTTP " + response.status);
    if (!response.ok) return null;
    var html = await response.text();
    if (/Attention Required|Just a moment|cf-browser-verification/i.test(html)) {
      console.log("[selcukflix] Pichive Cloudflare block");
      return null;
    }

    var token = html ? (html.match(/window\.openPlayer\(\s*['"]([^'"]+)['"]/) || [])[1] : null;
    var subtitles = [];
    if (html) {
      var subRe = /"file"\s*:\s*"([^"]+)"\s*,\s*"label"\s*:\s*"([^"]+)"/g;
      var subMatch;
      var seen = {};
      while ((subMatch = subRe.exec(html))) {
        var subUrl = unescapeSlash(subMatch[1]);
        if (!/^https?:\/\//i.test(subUrl) || seen[subUrl]) continue;
        seen[subUrl] = true;
        subtitles.push({
          url: subUrl,
          language: pichiveLang(subMatch[2]),
          name: subMatch[2],
          headers: { "User-Agent": UA, "Referer": iframeUrl }
        });
      }
    }

    if (!token) {
      // Fallback: some mirrors accept the iframe's ?v= value directly.
      var vMatch = iframeUrl.match(/[?&]v=([^&]+)/);
      if (vMatch) token = vMatch[1];
    }
    console.log("[selcukflix] Pichive token: " + (token ? "yes" : "no"));
    if (!token) return null;

    var streamUrl = await source2Stream(origin, token, iframeUrl, settings);
    if (!streamUrl) return null;

    var streams = [{
      url: streamUrl,
      referer: iframeUrl,
      origin: origin,
      language: "Altyazı",
      subtitles: subtitles
    }];

    // Turkish dublaj token (ContentX layout): ,"<token>","Türkçe"
    var dublajMatch = html ? html.match(/,\s*["']([^"']+)["']\s*,\s*["']Türkçe/i) : null;
    if (dublajMatch && dublajMatch[1] !== token) {
      var dublajUrl = await source2Stream(origin, dublajMatch[1], iframeUrl, settings);
      if (dublajUrl && dublajUrl !== streamUrl) {
        streams.push({
          url: dublajUrl,
          referer: iframeUrl,
          origin: origin,
          language: "Dublaj",
          subtitles: subtitles
        });
      }
    }

    return streams;
  }

  function qualityFromName(name) {
    var value = String(name || "").toLowerCase();
    if (/2160|4k|uhd/.test(value)) return "2160p";
    if (/1440|2k/.test(value)) return "1440p";
    if (/1080|fhd/.test(value)) return "1080p";
    if (/720/.test(value)) return "720p";
    if (/480/.test(value)) return "480p";
    return "Auto";
  }

  function qRank(quality) {
    var q = String(quality || "").toLowerCase();
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480|sd/.test(q)) return 1;
    return 0.5;
  }

  async function streamsFromSources(sources, display, pageUrl, settings) {
    var streams = [], seen = {};
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i] || {};
      var iframeUrl = extractIframeUrl(source.source_content);
      if (!iframeUrl || seen[iframeUrl]) continue;
      seen[iframeUrl] = true;
      console.log("[selcukflix] Source iframe: " + iframeUrl);
      var resolved = null;
      try { resolved = await resolvePichive(iframeUrl, pageUrl, settings); } catch (e) {
        console.log("[selcukflix] Pichive resolve error: " + e.message);
      }
      console.log("[selcukflix] Pichive streams: " + (resolved ? resolved.length : 0));
      if (!resolved || !resolved.length) continue;

      var quality = qualityFromName(source.quality_name);
      resolved.forEach(function (item, index) {
        var language = item.language || source.language_name || "Kaynak";
        var name = "Selcukflix - " + language + (quality !== "Auto" ? " " + quality : "");
        var tags = [quality, language];
        if (source.source_name) tags.push(source.source_name);
        streams.push({
          name: name,
          title: display + "\n" + tags.filter(Boolean).join(" - ") + " [HLS]",
          url: item.url,
          quality: quality,
          isM3u8: true,
          type: "hls",
          headers: {
            "User-Agent": UA,
            "Referer": item.referer || iframeUrl,
            "Origin": item.origin
          },
          subtitles: item.subtitles || [],
          provider: "selcukflix"
        });
      });
    }
    streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return streams;
  }

  async function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[selcukflix]";
    settings = getSettings(settings);
    var isTv = mediaType === "tv" || mediaType === "series";
    var wantedSeason = parseInt(season, 10) || 1;
    var wantedEpisode = parseInt(episode, 10) || 1;

    var info = await tmdbDetails(tmdbId, isTv);
    if (!info || !info.title) {
      console.log(tag + " TMDB details not found");
      return [];
    }

    var queries = [info.title];
    if (info.originalTitle && normalize(info.originalTitle) !== normalize(info.title)) {
      queries.push(info.originalTitle);
    }

    var match = null;
    for (var i = 0; i < queries.length && !match; i++) {
      try { match = await searchSite(queries[i], info.year, isTv); } catch (e) {}
    }
    if (!match) {
      console.log(tag + " No matching content");
      return [];
    }
    console.log(tag + " Matched: " + match.title + " -> " + match.slug);

    var display = info.title + (info.year ? " (" + info.year + ")" : "");
    if (isTv) display += " S" + wantedSeason + "E" + wantedEpisode;

    var pageUrl = BASE + "/" + match.slug.replace(/^\/+/, "");
    var pageData = await getPageData(pageUrl);
    if (!pageData) {
      console.log(tag + " Page data could not be decrypted");
      return [];
    }

    var related = pageData.RelatedResults || {};
    var sources = [];

    if (isTv) {
      var seasons = related.getSerieSeasonAndEpisodes && related.getSerieSeasonAndEpisodes.result;
      var episodeSlug = null;
      (Array.isArray(seasons) ? seasons : []).forEach(function (seasonItem) {
        if (!seasonItem || parseInt(seasonItem.season_no, 10) !== wantedSeason) return;
        (seasonItem.episodes || []).forEach(function (ep) {
          if (ep && parseInt(ep.episode_no, 10) === wantedEpisode && ep.used_slug) {
            episodeSlug = ep.used_slug;
          }
        });
      });
      if (!episodeSlug) {
        episodeSlug = match.slug.replace(/\/+$/, "") + "/sezon-" + wantedSeason + "/bolum-" + wantedEpisode;
      }
      var episodeUrl = BASE + "/" + episodeSlug.replace(/^\/+/, "");
      var episodeData = await getPageData(episodeUrl);
      if (!episodeData) {
        console.log(tag + " Episode page could not be decrypted: " + episodeUrl);
        return [];
      }
      pageUrl = episodeUrl;
      sources = (episodeData.RelatedResults && episodeData.RelatedResults.getEpisodeSources &&
        episodeData.RelatedResults.getEpisodeSources.result) || [];
    } else {
      var parts = (related.getMoviePartsById && related.getMoviePartsById.result) || [];
      if (!Array.isArray(parts) || !parts.length) {
        sources = (related.getMovieSourcesById && related.getMovieSourcesById.result) || [];
      } else {
        parts.forEach(function (part) {
          if (!part || !part.id) return;
          var key = "getMoviePartSourcesById_" + part.id;
          var partSources = related[key] && related[key].result;
          if (Array.isArray(partSources)) {
            partSources.forEach(function (item) {
              sources.push(item);
            });
          }
        });
      }
    }

    console.log(tag + " Sources in page data: " + sources.length);
    if (!sources.length) {
      console.log(tag + " No sources in page data");
      return [];
    }

    var streams = await streamsFromSources(sources, display, pageUrl, settings);
    console.log(tag + " Found " + streams.length + " streams");
    return streams;
  }

  function onSettings() {
    return [
      { type: "header", label: "Selcukflix" },
      {
        type: "text",
        key: "pichiveCookie",
        label: "Pichive cf_clearance cookie",
        placeholder: "cf_clearance=...",
        description: "Pichive Cloudflare engeli icin opsiyonel. Tarayicida four.pichive.online acildiktan sonra cf_clearance cerezini buraya yapistir."
      },
      {
        type: "text",
        key: "pichiveProxy",
        label: "Pichive proxy URL",
        placeholder: "https://proxy.example/?url={url}",
        description: "Pichive isteklerini proxy uzerinden gecirmek icin opsiyonel. {url} yerine hedef adres yerlestirilir; yoksa sonuna ?url=... eklenir."
      }
    ];
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
