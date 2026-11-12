/**
 * animexe - Animexe (animexe.com) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi (tr) + alternatifler + yil
 *   -> /search?q=  (kartlar: /anime/{slug})
 *   -> tv:    /watch/{slug}/{s}/{e}
 *     movie: /watch/{slug}/1/1
 *   -> sayfada VIDEO_SOURCES JSON -> proxy URL (m3u8/mp4)
 *   -> SUBS JSON -> VTT altyazilar
 *
 * Notlar:
 * - VIDEO_SOURCES url'si animexe proxy'si (/stream/proxy?u=<base64>); icindeki
 *   gercek URL kalite ve ses grubunu belirler (trdub/endub/original).
 * - Kalite URL yolundan alinir; site bazen 4K yazsa da URL 720p olabiliyor.
 * - Proxy segment'leri .mp2t icerigine sahip .png uzantili HLS segmentleri.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://animexe.com";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;

  // ---------------------------------------------------------------- helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_KEY_FALLBACK;
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

  function decodeEntities(text) {
    var s = String(text || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); });
    return s
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&");
  }

  function cleanText(html) {
    return decodeEntities(String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim());
  }

  var TR_MAP = {
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
    "â": "a", "Â": "a", "î": "i", "Î": "i", "û": "u", "Û": "u",
    "é": "e", "è": "e", "ê": "e", "á": "a", "à": "a", "ä": "a",
    "å": "a", "ñ": "n", "ø": "o", "æ": "ae", "ß": "ss",
    "'": "", "’": "", "&": " ve "
  };

  function slugify(title) {
    var src = String(title || "");
    var ascii = "";
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      ascii += TR_MAP[ch] !== undefined ? TR_MAP[ch] : ch;
    }
    return ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function norm(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9çğıöşü]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------------------------------------------------------- base64 (pure)

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

  // ------------------------------------------------------------------ TMDB

  function tmdbInfo(tmdbId, isTv, apiKey) {
    var path = isTv ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) +
      "&language=tr-TR&append_to_response=alternative_titles";
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;

      var main = isTv ? (d.name || "") : (d.title || "");
      var original = isTv ? (d.original_name || "") : (d.original_title || "");
      var altList = (d.alternative_titles && (isTv ? d.alternative_titles.results : d.alternative_titles.titles)) || [];
      var altTitles = [];
      for (var i = 0; i < altList.length && altTitles.length < 6; i++) {
        var t = altList[i] && altList[i].title;
        if (t && norm(t) !== norm(main) && altTitles.indexOf(t) === -1) altTitles.push(t);
      }

      return {
        title: main,
        original: original,
        alternatives: altTitles,
        year: String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4)
      };
    });
  }

  // -------------------------------------------------------------- searching

  function searchSite(query, isTv) {
    var url = BASE + "/search/suggest?q=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, "Accept": "application/json" }).then(function (txt) {
      if (!txt) return [];
      var d;
      try { d = JSON.parse(txt); } catch (e) { return []; }
      var list = (d && d.results) || [];
      var out = [], seen = {};
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!r || !r.slug) continue;
        if (seen[r.slug]) continue;
        seen[r.slug] = true;
        out.push({ slug: r.slug, title: r.title || r.slug, type: r.type || "", year: r.year });
      }
      // ture gore filtrele; sonuc yoksa filtresiz don
      var filtered = out.filter(function (it) {
        if (isTv) return it.type === "series";
        return it.type === "movie";
      });
      return filtered.length ? filtered : out;
    });
  }

  function matchScore(itemTitle, title) {
    if (!itemTitle || !title) return 0;
    if (itemTitle === title) return 12;
    if (itemTitle.indexOf(title) !== -1 || title.indexOf(itemTitle) !== -1) return 7;
    var words = title.split(" ").filter(function (w) { return w.length > 2; });
    if (!words.length) return 0;
    for (var i = 0; i < words.length; i++) {
      if (itemTitle.indexOf(words[i]) === -1) return 0;
    }
    return 4;
  }

  function score(item, titles) {
    var best = 0;
    var itemTitle = norm(item.title);
    for (var i = 0; i < titles.length; i++) {
      var t = norm(titles[i]);
      if (!t) continue;
      var s = matchScore(itemTitle, t);
      if (s > best) best = s;
    }
    return best;
  }

  function pickBest(items, titles) {
    var best = null, bestScore = 0;
    for (var i = 0; i < (items || []).length; i++) {
      var s = score(items[i], titles);
      if (s > bestScore) { bestScore = s; best = items[i]; }
    }
    return best;
  }

  var NON_LATIN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function findTarget(titles, isTv) {
    var latin = [], other = [];
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!t) continue;
      if (NON_LATIN_RE.test(t)) other.push(t); else latin.push(t);
    }
    var ordered = latin.concat(other).slice(0, 6);

    function searchAll(idx, best) {
      if (idx >= ordered.length) {
        if (best) return Promise.resolve({ slug: best.slug, title: best.title });
        return trySlug(0, null);
      }
      return searchSite(ordered[idx], isTv).then(function (cards) {
        var item = pickBest(cards, titles);
        if (item) {
          var s = score(item, titles);
          if (!best || s > score(best, titles)) best = item;
          if (s >= 7) return { slug: best.slug, title: best.title };
        }
        return searchAll(idx + 1, best);
      });
    }

    function trySlug(idx, found) {
      if (found) return Promise.resolve(found);
      if (idx >= ordered.length) return Promise.resolve(null);
      var slug = slugify(ordered[idx]);
      if (!slug) return trySlug(idx + 1, null);
      var url = BASE + "/watch/" + slug + "/1/1";
      return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
        return trySlug(idx + 1, html ? { slug: slug, title: ordered[idx] } : null);
      });
    }

    return searchAll(0, null);
  }

  // --------------------------------------------------------------- sources

  function extractJsonVar(html, name) {
    var m = String(html || "").match(new RegExp("const " + name + " = (\\[[\\s\\S]*?\\]);"));
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function decodeProxyUrl(url) {
    var m = String(url || "").match(/\/stream\/proxy\?u=([^&]+)/);
    if (!m) return null;
    try {
      return base64DecodeUtf8(decodeURIComponent(m[1]));
    } catch (e) { return null; }
  }

  function qualityFromUrl(url) {
    var m = String(url || "").match(/(2160p|1440p|1080p|720p|480p|360p)/i);
    return m ? m[1].toLowerCase() : "";
  }

  function audioFromUrl(url) {
    var u = String(url || "").toLowerCase();
    if (u.indexOf("trdub") !== -1) return "Türkçe Dublaj";
    if (u.indexOf("endub") !== -1) return "İngilizce Dublaj";
    if (u.indexOf("dub") !== -1) return "Dublaj";
    if (u.indexOf("original") !== -1) return "Orijinal (Japonca)";
    return "";
  }

  function qRank(q) {
    var n = parseInt(q, 10);
    return isNaN(n) ? 0 : n;
  }

  function buildSubtitles(subs) {
    var out = [], seen = {};
    for (var i = 0; i < (subs || []).length; i++) {
      var s = subs[i];
      if (!s || !s.url) continue;
      var lang = s.lang || "und";
      if (seen[lang]) continue;
      seen[lang] = true;
      out.push({ url: s.url, language: lang, name: s.label || lang, lang: lang });
    }
    return out;
  }

  function buildStreams(sources, subs, display, slug) {
    var out = [], seen = {};
    for (var i = 0; i < (sources || []).length; i++) {
      var s = sources[i];
      if (!s || !s.url) continue;
      var realUrl = decodeProxyUrl(s.url) || s.url;
      var quality = qualityFromUrl(realUrl) || s.quality || "";
      var audio = audioFromUrl(realUrl);
      var isM3u8 = s.type === "hls" || /\.m3u8($|\?)/i.test(realUrl) || /\/master\.m3u8/i.test(realUrl);
      if (seen[s.url]) continue;
      seen[s.url] = true;

      var q = quality || s.label || "Video";
      var name = "Animexe - " + q + (audio ? " " + audio : "");
      var title = display + " | " + q + (audio ? " | " + audio : "") + (isM3u8 ? " [HLS]" : " [MP4]");

      out.push({
        name: name,
        title: title,
        url: s.url,
        quality: quality || undefined,
        isM3u8: isM3u8,
        type: isM3u8 ? "hls" : "mp4",
        language: "tr",
        provider: "animexe",
        headers: { "User-Agent": UA, Referer: BASE + "/", Origin: BASE },
        subtitles: subs,
        behaviorHints: { bingeGroup: "animexe-" + slug }
      });
    }
    out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return out;
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[animexe]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }

      var titles = [info.title, info.original].concat(info.alternatives || []);
      titles = titles.filter(function (t, i) { return t && titles.indexOf(t) === i; });

      console.log(tag + " Araniyor: " + titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));

      return findTarget(titles, isTv).then(function (target) {
        if (!target) {
          console.log(tag + " Sayfa bulunamadi");
          return [];
        }

        var slug = target.slug;
        var display = (target.title || info.title) + (info.year ? " (" + info.year + ")" : "");
        if (isTv) display += " S" + s + "E" + e;

        var url = BASE + "/watch/" + slug + "/" + (isTv ? s : 1) + "/" + (isTv ? e : 1);
        console.log(tag + " Sayfa: " + url);

        return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
          if (!html) {
            console.log(tag + " Sayfa icerigi alinamadi");
            return [];
          }
          var sources = extractJsonVar(html, "VIDEO_SOURCES") || [];
          var subs = buildSubtitles(extractJsonVar(html, "SUBS") || []);
          if (!sources.length) {
            console.log(tag + " Kaynak bulunamadi");
            return [];
          }
          var streams = buildStreams(sources, subs, display, slug);
          console.log(tag + " Kaynak bulundu: " + streams.length + " kaynak, " + subs.length + " altyazi");
          return streams;
        });
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message));
      return [];
    });
  }

  function onSettings() {
    return [];
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
