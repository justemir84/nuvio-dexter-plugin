/**
 * filmekseni - FilmEkseni (filmekseni.vip) provider for Nuvio
 *
 * Flow:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> Filmekseni /api/search?q=  (movie results: id, title, slug, releaseYear)
 *   -> /{slug}/ movie page
 *   -> data-video-player x-data JSON (dual[] with link + base64 template)
 *   -> template decode: <iframe data-src="//eksenload.top/eplayer/{link}">
 *   -> /eplayer/{link} embed page -> JW Player config JSON
 *   -> file (m3u8) + tracks (VTT subtitles)
 *
 * Notlar:
 * - Arama API'si Meilisearch tabanli; TMDB basliklariyla eslestirme yapilir.
 * - Master m3u8 URL'si gecicidir (timestamp imzali), her istekte yenilenir.
 * - m3u8 isteminde Referer (eksenload.top) zorunludur (Cloudflare).
 * - Altyazilar JW Player tracks alanindan alinir (VTT).
 * - Hermes uyumlu: async/await kullanildi (diger providerlarla ayni).
 */
(function () {
  "use strict";

  var BASE = "https://filmekseni.vip";
  var EMBED_BASE = "https://eksenload.top";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;
  var MEDIA_HEADERS = { "User-Agent": UA, Referer: EMBED_BASE + "/" };

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

  function fetchJson(url, headers) {
    return fetchText(url, headers).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
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
      for (var i = 0; i < altList.length && altTitles.length < 8; i++) {
        var t = altList[i] && altList[i].title;
        if (t && norm(t) !== norm(main) && altTitles.indexOf(t) === -1) altTitles.push(t);
      }

      var year = String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4);

      // Ingilizce basligi da ekle
      var enUrl = "https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + encodeURIComponent(apiKey) +
        "&language=en-US&append_to_response=alternative_titles";
      return fetchText(enUrl, { "User-Agent": UA, Accept: "application/json" }).then(function (enTxt) {
        if (enTxt) {
          var en;
          try { en = JSON.parse(enTxt); } catch (e) { en = null; }
          if (en && en.success !== false) {
            var enMain = isTv ? (en.name || "") : (en.title || "");
            var enOrig = isTv ? (en.original_name || "") : (en.original_title || "");
            if (enMain && altTitles.indexOf(enMain) === -1 && norm(enMain) !== norm(main)) altTitles.push(enMain);
            if (enOrig && altTitles.indexOf(enOrig) === -1 && norm(enOrig) !== norm(main)) altTitles.push(enOrig);
            var enAltList = (en.alternative_titles && (isTv ? en.alternative_titles.results : en.alternative_titles.titles)) || [];
            for (var j = 0; j < enAltList.length && altTitles.length < 12; j++) {
              var at = enAltList[j] && enAltList[j].title;
              if (at && altTitles.indexOf(at) === -1 && norm(at) !== norm(main)) altTitles.push(at);
            }
          }
        }
        return {
          title: main,
          original: original,
          alternatives: altTitles,
          year: year
        };
      });
    });
  }

  // -------------------------------------------------------------- searching

  function searchSite(query) {
    var url = BASE + "/api/search?q=" + encodeURIComponent(query);
    return fetchJson(url, { "User-Agent": UA, Referer: BASE + "/", Accept: "application/json" })
      .then(function (d) {
        if (!d || !d.data || !Array.isArray(d.data)) return [];
        return d.data;
      });
  }

  function matchScore(itemTitle, title) {
    if (!itemTitle || !title) return 0;
    var a = norm(itemTitle), b = norm(title);
    if (!a || !b) return 0;
    if (a === b) return 12;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 7;
    var words = b.split(" ").filter(function (w) { return w.length > 2; });
    if (!words.length) return 0;
    for (var i = 0; i < words.length; i++) {
      if (a.indexOf(words[i]) === -1) return 0;
    }
    return 4;
  }

  function scoreItem(item, titles) {
    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!t) continue;
      var s = matchScore(item.title, t);
      if (s > best) best = s;
    }
    return best;
  }

  function findResult(titles, isTv) {
    var desiredType = isTv ? "App\\Models\\Series" : "App\\Models\\Movie";
    var best = null, bestScore = 0;
    var ordered = titles.filter(Boolean).slice(0, 10);

    function searchAll(idx) {
      if (idx >= ordered.length) {
        if (best) return Promise.resolve(best);
        return prefixAll(0, null);
      }
      return searchSite(ordered[idx]).then(function (items) {
        var pool = items.filter(function (it) { return it.contentableType === desiredType; });
        if (!pool.length) pool = items;
        for (var i = 0; i < pool.length; i++) {
          var s = scoreItem(pool[i], titles);
          if (s > bestScore) { bestScore = s; best = pool[i]; }
        }
        if (bestScore >= 10) return Promise.resolve(best);
        return searchAll(idx + 1);
      }).catch(function () { return searchAll(idx + 1); });
    }

    function prefixAll(pIdx, found) {
      if (found) return Promise.resolve(found);
      if (pIdx >= 2 || !ordered.length) return Promise.resolve(best);
      var words = String(ordered[0] || "").split(/\s+/).filter(Boolean);
      var prefix = null;
      if (pIdx === 0 && words.length > 2) prefix = words.slice(0, 3).join(" ");
      if (pIdx === 1 && words.length > 1) prefix = words.slice(0, 2).join(" ");
      if (!prefix) return prefixAll(pIdx + 1, null);
      return searchSite(prefix).then(function (items) {
        var pool = items.filter(function (it) { return it.contentableType === desiredType; });
        if (!pool.length) pool = items;
        var localBest = null, localScore = 0;
        for (var i = 0; i < pool.length; i++) {
          var s = scoreItem(pool[i], titles);
          if (s > localScore) { localScore = s; localBest = pool[i]; }
        }
        if (localBest && localScore > bestScore) { best = localBest; bestScore = localScore; }
        if (bestScore >= 7) return Promise.resolve(best);
        return prefixAll(pIdx + 1, null);
      }).catch(function () { return prefixAll(pIdx + 1, null); });
    }

    return searchAll(0);
  }

  function getMoviePage(slug) {
    var url = BASE + "/" + slug + "/";
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" });
  }

  function extractPlayerData(html) {
    // x-data="videoPlayerData(JSON.parse('{...}'), 'key', [])"
    var m = html.match(/x-data="videoPlayerData\(JSON\.parse\('([^']+)'\)/);
    if (!m) return null;
    var encoded = m[1].replace(/\\u0022/g, '"').replace(/\\u0027/g, "'").replace(/\\\\/g, "\\");
    try {
      return JSON.parse(encoded);
    } catch (e) {
      return null;
    }
  }

  function atobSafe(input) {
    var src = String(input || "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    while (src.length % 4) src += "=";
    if (typeof atob === "function") {
      try { return atob(src); } catch (e) {}
    }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "", acc = 0, bits = 0, i, value, ch;
    for (i = 0; i < src.length; i++) {
      ch = src.charAt(i);
      if (ch === "=") break;
      value = chars.indexOf(ch);
      if (value < 0) continue;
      acc = ((acc << 6) | value) & 0xFFFFFF;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 255);
        acc &= bits ? (1 << bits) - 1 : 0;
      }
    }
    return out;
  }

  function base64Decode(input) {
    return atobSafe(input);
  }

  function utf8Decode(bin) {
    bin = String(bin || "");
    try { return decodeURIComponent(escape(bin)); } catch (e) {}
    var out = "", i = 0;
    while (i < bin.length) {
      var b = bin.charCodeAt(i++);
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xE0) {
        out += String.fromCharCode(((b & 0x1F) << 6) | (bin.charCodeAt(i++) & 0x3F));
      } else if (b < 0xF0) {
        out += String.fromCharCode(((b & 0x0F) << 12) | ((bin.charCodeAt(i++) & 0x3F) << 6) | (bin.charCodeAt(i++) & 0x3F));
      } else {
        var cp = ((b & 0x07) << 18) | ((bin.charCodeAt(i++) & 0x3F) << 12)
          | ((bin.charCodeAt(i++) & 0x3F) << 6) | (bin.charCodeAt(i++) & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }

  function decodeTemplate(template) {
    try { return utf8Decode(base64Decode(template)); } catch (e) { return ""; }
  }

  function getEmbedUrl(playerData) {
    var dual = playerData && playerData.dual;
    if (!dual || !dual.length) return null;
    // Return all dual options (different languages/qualities)
    return dual.map(function (item) {
      var tmpl = decodeTemplate(item.template || "");
      var url = "";
      var uMatch = tmpl.match(/data-src="([^"]+)"/);
      if (uMatch) {
        url = uMatch[1].replace(/\{slug\}/g, item.service_slug || "").replace(/\{url\}/g, item.link || "");
      }
      if (url && !/^https?:\/\//i.test(url)) url = "https:" + url;
      return {
        link: item.link,
        serviceSlug: item.service_slug,
        serviceName: item.service_name,
        quality: item.quality,
        embedUrl: url
      };
    }).filter(function (o) { return o.embedUrl; });
  }

  function resolveStream(embedUrl) {
    return fetchText(embedUrl, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return null;
        // JW Player setup JSON: .setup(JSON.parse('{...}'))
        var m = html.match(/\.setup\(JSON\.parse\('([^']+)'\)\)/);
        if (!m) return null;
        var encoded = m[1].replace(/\\u0022/g, '"').replace(/\\\\\//g, "/").replace(/\\\\/g, "\\");
        try {
          var config = JSON.parse(encoded);
        } catch (e) {
          // try without extra unescaping
          try { config = JSON.parse(m[1]); } catch (e2) { return null; }
        }
        if (!config || !config.file) return null;

        var subtitles = [];
        if (Array.isArray(config.tracks)) {
          config.tracks.forEach(function (t) {
            if (!t || !t.file) return;
            var label = t.label || "";
            var fileLower = String(t.file || "").toLowerCase();
            var lang = "und";
            if (/tur/i.test(fileLower)) lang = "tr";
            else if (/eng/i.test(fileLower)) lang = "en";
            else if (/tr/i.test(label)) lang = "tr";
            else if (/en/i.test(label)) lang = "en";
            subtitles.push({
              url: t.file,
              language: lang,
              name: label || lang,
              lang: lang,
              headers: MEDIA_HEADERS
            });
          });
        }

        return {
          url: config.file,
          subtitles: subtitles,
          image: config.image || "",
          qualityLabels: config.qualityLabels || {}
        };
      });
  }

  function qualityFromLabels(qualityLabels, defaultQuality) {
    if (!qualityLabels || typeof qualityLabels !== "object") return defaultQuality || "Auto";
    var keys = Object.keys(qualityLabels);
    if (!keys.length) return defaultQuality || "Auto";
    // pick highest
    var maxKey = keys.reduce(function (a, b) { return parseInt(a, 10) > parseInt(b, 10) ? a : b; });
    return qualityLabels[maxKey] || defaultQuality || "Auto";
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[filmekseni]";
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

      return findResult(titles, isTv).then(function (result) {
        if (!result) {
          console.log(tag + " Eslesen sonuc bulunamadi");
          return [];
        }

        console.log(tag + " Bulundu: " + result.title + " (" + result.slug + ")");

        var pageSlug = result.slug;
        if (isTv) {
          pageSlug = "dizi/" + result.slug + "/sezon-" + s + "/bolum-" + e;
        }
        return getMoviePage(pageSlug).then(function (html) {
          if (!html) {
            console.log(tag + " Sayfa alinamadi");
            return [];
          }

          var playerData = extractPlayerData(html);
          if (!playerData) {
            console.log(tag + " Oynatici verisi bulunamadi");
            return [];
          }

          var embeds = getEmbedUrl(playerData);
          if (!embeds.length) {
            console.log(tag + " Embed URL olusturulamadi");
            return [];
          }

          // Use first embed (usually the best quality/language)
          var embed = embeds[0];
          console.log(tag + " Embed: " + embed.embedUrl);

          return resolveStream(embed.embedUrl).then(function (stream) {
            if (!stream) {
              console.log(tag + " Akis cozulumedi");
              return [];
            }

            var display = info.title + (info.year ? " (" + info.year + ")" : "");
            if (isTv) display += " S" + s + "E" + e;

            var quality = qualityFromLabels(stream.qualityLabels, embed.quality);
            var title = "FilmEkseni - " + quality + " " + info.title + (isTv ? " S" + s + "E" + e : "");

            var out = {
              name: "FilmEkseni" + (quality ? " " + quality : ""),
              title: title,
              url: stream.url,
              quality: quality || undefined,
              isM3u8: true,
              type: "hls",
              language: "tr",
              provider: "filmekseni",
              headers: MEDIA_HEADERS,
              subtitles: stream.subtitles || [],
              behaviorHints: { bingeGroup: "filmekseni-" + result.slug }
            };

            console.log(tag + " Kaynak bulundu: 1 kaynak (" + quality + ")");
            return [out];
          });
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
