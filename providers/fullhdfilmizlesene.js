/**
 * fullhdfilmizlesene - FullHDFilmizlesene provider for Nuvio
 * Flow: TMDB -> /autocomplete/q.php -> /film/<slug>/ -> var scx
 *       -> ROT13 + base64 embed URL -> RapidVid/Vidmoly/Vidmoxy -> HLS
 *
 * The site is Cloudflare-protected. Direct fetch works in Turkey; when it
 * returns a challenge we retry the same URL through r.jina.ai (HTML mode).
 * The movie page embeds sources in `var scx = {...}`; each entry is
 * base64(rot13(url)). RapidVid (imgz) masters are direct HLS and do not need
 * a token.
 *
 * Hermes-safe: Promise chains / async-await, no external deps.
 */
(function () {
  "use strict";

  var BASE = "https://www.fullhdfilmizlesene.now";
  var JINA = "https://r.jina.ai/http://";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 12000;
  var JINA_TIMEOUT = 25000;
  var MAX_SOURCES = 8;

  var SITE_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
    "Referer": BASE + "/"
  };

  function rot13(text) {
    return String(text || "").replace(/[a-z]/gi, function (ch) {
      var base = ch <= "Z" ? 65 : 97;
      return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
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

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); } catch (e) {}
    }
    var out = "", i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      else if (b < 0xf0) out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else {
        var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function base64DecodeUtf8(input) {
    return utf8Decode(base64ToBytes(input));
  }

  function decodeEntities(text) {
    return String(text || "")
      .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
      .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
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

  function isChallenge(text) {
    return /Just a moment|cf-browser-verification|Attention Required|cf-error-details/i.test(String(text || ""));
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

  function jinaUrl(url) {
    return JINA + String(url).replace(/^https?:\/\//i, "");
  }

  async function fetchJina(url) {
    var response = await fetchTimeout(jinaUrl(url), {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "X-Return-Format": "html"
      }
    }, JINA_TIMEOUT);
    var text = await response.text();
    if (isChallenge(text) || /Warning: Target URL returned error/i.test(text)) return null;
    return text;
  }

  async function fetchSite(url) {
    try {
      var response = await fetchTimeout(url, { headers: SITE_HEADERS }, TIMEOUT);
      var text = await response.text();
      if (response.ok && text && !isChallenge(text)) return text;
    } catch (e) {}
    try { return await fetchJina(url); } catch (e) { return null; }
  }

  function parseAutocomplete(text) {
    var value = String(text || "").trim();
    var pre = value.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (pre) value = decodeEntities(pre[1]).trim();
    if (value.charAt(0) !== "[") {
      var start = value.indexOf("[");
      var end = value.lastIndexOf("]");
      if (start >= 0 && end > start) value = value.slice(start, end + 1);
    }
    try { return JSON.parse(value); } catch (e) { return null; }
  }

  async function tmdbDetails(tmdbId) {
    try {
      var response = await fetchTimeout("https://api.themoviedb.org/3/movie/" + encodeURIComponent(tmdbId) +
        "?api_key=" + TMDB_KEY + "&language=en-US", {
        headers: { "User-Agent": UA, Accept: "application/json" }
      }, 10000);
      if (!response.ok) return null;
      var data = await response.json();
      return {
        title: data.title || data.original_title || "",
        originalTitle: data.original_title || "",
        year: String(data.release_date || "").slice(0, 4)
      };
    } catch (e) { return null; }
  }

  async function searchSite(title, year) {
    if (!title) return null;
    var url = BASE + "/autocomplete/q.php?q=" + encodeURIComponent(title);
    var text = await fetchSite(url);
    var rows = parseAutocomplete(text);
    if (!Array.isArray(rows) || !rows.length) return null;

    var best = null, bestScore = 0;
    rows.forEach(function (row) {
      if (!row || !row.dizilink) return;
      var rowYear = parseInt(row.yil, 10) || 0;
      var targetYear = parseInt(year, 10) || 0;
      var yearScore = 0;
      if (rowYear && targetYear) {
        var delta = Math.abs(rowYear - targetYear);
        if (delta === 0) yearScore = 40;
        else if (delta <= 1) yearScore = 20;
        else return;
      }
      var sim = Math.max(
        titleSimilarity(title, row.baslik),
        titleSimilarity(title, row.altbaslik)
      );
      if (!sim && !yearScore) return;
      var score = sim * 60 + yearScore;
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    });

    if (!best || bestScore < 25) return null;
    var prefix = best.prefix || "film";
    return {
      url: BASE + "/" + prefix + "/" + best.dizilink + "/",
      title: best.baslik || title,
      year: best.yil || year
    };
  }

  function extractScx(html) {
    var text = String(html || "");
    var anchor = text.search(/\bscx\s*=\s*\{/);
    if (anchor < 0) return null;
    var start = text.indexOf("{", anchor);
    var depth = 0, inString = false, quote = "", escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function langLabel(key) {
    if (key === "tr") return "Dublaj";
    if (key === "en") return "Altyazı";
    return "";
  }

  function flattenScx(scx) {
    var out = [];
    Object.keys(scx || {}).forEach(function (key) {
      if (/^advid/i.test(key)) return;
      var item = scx[key];
      if (!item || typeof item !== "object") return;
      var label = key;
      try { label = base64DecodeUtf8(item.tt || "") || key; } catch (e) {}
      var sx = item.sx || {};
      if (sx.t) {
        if (Array.isArray(sx.t)) {
          sx.t.forEach(function (enc) {
            if (typeof enc === "string" && enc) {
              out.push({ key: key, label: label, enc: enc, lang: "", part: null });
            }
          });
        } else if (typeof sx.t === "object") {
          Object.keys(sx.t).forEach(function (lk) {
            var enc = sx.t[lk];
            if (typeof enc === "string" && enc) {
              out.push({ key: key, label: label, enc: enc, lang: langLabel(lk), part: null });
            }
          });
        }
      }
      if (sx.p) {
        var parts = Array.isArray(sx.p) ? sx.p : Object.keys(sx.p).map(function (k) { return sx.p[k]; });
        parts.forEach(function (enc, index) {
          if (typeof enc === "string" && enc) {
            out.push({ key: key, label: label, enc: enc, lang: "", part: index + 1 });
          }
        });
      }
    });
    return out;
  }

  function decodeScxEntry(entry) {
    try {
      var url = base64DecodeUtf8(rot13(entry));
      return /^https?:\/\//i.test(url) ? url : null;
    } catch (e) { return null; }
  }

  function decodeImgzBlob(blob) {
    var reversed = String(blob || "").split("").reverse().join("");
    var bytes = base64ToBytes(reversed);
    var text = "";
    for (var i = 0; i < bytes.length; i++) {
      var k = "K9L".charCodeAt(i % 3);
      text += String.fromCharCode(bytes[i] - (k % 5 + 1));
    }
    return base64DecodeUtf8(text);
  }

  function matchMediaUrl(text) {
    var value = String(text || "");
    var match = value.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
      value.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
      value.match(/file:\s*["'](https?:\/\/[^"']+)["']/i);
    return match ? match[1] : null;
  }

  function captionLang(label) {
    var value = normalize(label);
    if (value.indexOf("ingiliz") !== -1 || value.indexOf("eng") !== -1) return "en";
    if (value.indexOf("turk") !== -1 || value.indexOf("tur") !== -1) return "tr";
    return "tr";
  }

  function parseJwSetupTracks(html) {
    var out = [];
    var match = String(html || "").match(/jwSetup\.tracks\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return out;
    var tracks;
    try { tracks = JSON.parse(match[1]); } catch (e) { return out; }
    (Array.isArray(tracks) ? tracks : []).forEach(function (track) {
      if (track && track.kind === "captions" && track.file && /^https?:\/\//i.test(track.file)) {
        out.push({ url: track.file, language: captionLang(track.label), name: String(track.label || "").trim() });
      }
    });
    return out;
  }

  async function resolveRapidvid(embedUrl) {
    var origin = new URL(embedUrl).origin;
    var response = await fetchTimeout(embedUrl, {
      headers: { "User-Agent": UA, "Referer": origin + "/" }
    }, TIMEOUT);
    if (!response.ok) return null;
    var html = await response.text();

    var p8 = html.match(/window\._p8\s*=\s*['"]([^'"]+)['"]/);
    if (p8) {
      var config = null;
      try { config = JSON.parse(decodeImgzBlob(p8[1])); } catch (e) {}
      if (config) {
        var master = config.cm || config.tm;
        if (master && /^https?:\/\//i.test(master)) {
          var subtitles = [];
          (Array.isArray(config.ct) ? config.ct : []).forEach(function (track) {
            if (track && track.file && /^https?:\/\//i.test(track.file)) {
              subtitles.push({
                url: track.file,
                language: captionLang(track.label),
                name: String(track.label || "").trim()
              });
            }
          });
          return { url: master, referer: origin + "/", origin: origin, subtitles: subtitles };
        }
      }
    }

    var fileMatch = html.match(/["']file["']\s*:\s*(?:av|_)\(\s*["']([^"']+)["']\s*\)/);
    var videoUrl = null;
    if (fileMatch) {
      try { videoUrl = decodeImgzBlob(fileMatch[1]); } catch (e) {}
    }
    if (!videoUrl) {
      var sourcesMatch = html.match(/jwSetup\.sources\s*=\s*(\[[\s\S]*?\]);/);
      if (sourcesMatch) videoUrl = matchMediaUrl(sourcesMatch[1]);
    }
    if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return null;
    return {
      url: videoUrl,
      referer: origin + "/",
      origin: origin,
      subtitles: parseJwSetupTracks(html)
    };
  }

  async function resolveVidmoly(embedUrl) {
    var origin = new URL(embedUrl).origin;
    var response = await fetchTimeout(embedUrl, {
      headers: { "User-Agent": UA, "Referer": BASE + "/" }
    }, TIMEOUT);
    if (!response.ok) return null;
    var html = await response.text();
    var match = html.match(/file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
    if (!match) return null;
    return { url: match[1], referer: origin + "/", origin: origin, subtitles: [] };
  }

  function unpackPacked(html) {
    var match = String(html || "").match(/\}\('(.+?)',(\d+),(\d+),'(.+?)'\.split\('\|'\)/s);
    if (!match) return null;
    var payload = match[1].replace(/\\(['"\\/])/g, "$1");
    var radix = parseInt(match[2], 10);
    var count = parseInt(match[3], 10);
    var dict = match[4].split("|");
    function toBase(n) {
      return (n < radix ? "" : toBase(Math.floor(n / radix))) +
        ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    }
    var table = {};
    for (var i = count - 1; i >= 0; i--) {
      var token = toBase(i);
      table[token] = dict[i] && dict[i].length ? dict[i] : token;
    }
    return payload.replace(/\b\w+\b/g, function (word) {
      return Object.prototype.hasOwnProperty.call(table, word) ? table[word] : word;
    });
  }

  function decodeHexEscapes(text) {
    return String(text || "").replace(/\\x([0-9a-fA-F]{2})/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }

  async function resolveVidmoxy(embedUrl) {
    var origin = new URL(embedUrl).origin;
    var response = await fetchTimeout(embedUrl, {
      headers: { "User-Agent": UA, "Referer": BASE + "/" }
    }, TIMEOUT);
    if (!response.ok) return null;
    var html = await response.text();
    var blockStart = /eval\(function\(p,a,c,k,e,[dr]\)/g;
    var block;
    while ((block = blockStart.exec(html))) {
      var unpacked = html.slice(block.index);
      for (var layer = 0; layer < 3; layer++) {
        var next = unpackPacked(unpacked);
        if (!next) break;
        unpacked = next;
        var fileMatch = unpacked.match(/["']file["']\s*:\s*["']([^"']+)["']/);
        if (fileMatch) {
          var decoded = decodeHexEscapes(fileMatch[1]);
          if (/^https?:\/\//i.test(decoded)) {
            return { url: decoded, referer: origin + "/", origin: origin, subtitles: [] };
          }
        }
        var media = matchMediaUrl(unpacked);
        if (media && /^https?:\/\//i.test(media)) {
          return { url: media, referer: origin + "/", origin: origin, subtitles: [] };
        }
      }
    }
    return null;
  }

  async function resolveEmbed(embedUrl) {
    if (/rapidvid|imgz\.me/i.test(embedUrl)) return resolveRapidvid(embedUrl);
    if (/vidmoly/i.test(embedUrl)) return resolveVidmoly(embedUrl);
    if (/vidmoxy/i.test(embedUrl)) return resolveVidmoxy(embedUrl);
    return resolveVidmoly(embedUrl);
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

  async function masterQuality(url, headers) {
    try {
      var response = await fetchTimeout(url, { headers: headers }, 8000);
      if (!response.ok) return "Auto";
      var text = await response.text();
      var heights = [];
      var match;
      var re = /RESOLUTION=\d+x(\d+)/gi;
      while ((match = re.exec(text))) heights.push(parseInt(match[1], 10));
      if (!heights.length) return "Auto";
      var height = Math.max.apply(null, heights);
      if (height >= 2000) return "2160p";
      if (height >= 1400) return "1440p";
      if (height >= 1000) return "1080p";
      if (height >= 700) return "720p";
      if (height >= 400) return "480p";
      return "Auto";
    } catch (e) { return "Auto"; }
  }

  async function getStreams(tmdbId, mediaType) {
    var tag = "[fullhdfilmizlesene]";
    if (mediaType === "tv" || mediaType === "series") {
      console.log(tag + " Movie-only provider");
      return [];
    }

    var info = await tmdbDetails(tmdbId);
    if (!info || !info.title) {
      console.log(tag + " TMDB details not found");
      return [];
    }

    var queries = [info.title];
    if (info.originalTitle && normalize(info.originalTitle) !== normalize(info.title)) {
      queries.push(info.originalTitle);
    }

    var page = null;
    for (var i = 0; i < queries.length && !page; i++) {
      page = await searchSite(queries[i], info.year);
    }
    if (!page) {
      console.log(tag + " No matching page found");
      return [];
    }
    console.log(tag + " Matched page: " + page.title + " -> " + page.url);

    var html = await fetchSite(page.url);
    if (!html) {
      console.log(tag + " Failed to fetch movie page");
      return [];
    }

    var scx = extractScx(html);
    if (!scx) {
      console.log(tag + " scx not found");
      return [];
    }

    var descriptors = flattenScx(scx).slice(0, MAX_SOURCES);
    if (!descriptors.length) {
      console.log(tag + " No source descriptors");
      return [];
    }

    var display = info.title + (info.year ? " (" + info.year + ")" : "");
    var streams = [], seen = {};

    for (var d = 0; d < descriptors.length; d++) {
      var descriptor = descriptors[d];
      var embedUrl = decodeScxEntry(descriptor.enc);
      if (!embedUrl) continue;
      var resolved = null;
      try { resolved = await resolveEmbed(embedUrl); } catch (e) {}
      if (!resolved || !resolved.url || seen[resolved.url]) continue;
      seen[resolved.url] = true;

      var headers = {
        "User-Agent": UA,
        "Referer": resolved.referer || (resolved.origin || "") + "/",
        "Origin": resolved.origin || ""
      };
      var quality = await masterQuality(resolved.url, headers);
      var tags = [quality, descriptor.label, descriptor.lang];
      if (descriptor.part) tags.push("Part " + descriptor.part);
      var name = "FullHDFilmizlesene - " + descriptor.label +
        (descriptor.lang ? " " + descriptor.lang : "") +
        (descriptor.part ? " Part " + descriptor.part : "") +
        (quality !== "Auto" ? " " + quality : "");

      streams.push({
        name: name,
        title: display + "\n" + tags.filter(Boolean).join(" - ") + " [HLS]",
        url: resolved.url,
        quality: quality,
        isM3u8: true,
        type: "hls",
        headers: headers,
        subtitles: resolved.subtitles || [],
        provider: "fullhdfilmizlesene"
      });
    }

    streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    console.log(tag + " Found " + streams.length + " streams");
    return streams;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
