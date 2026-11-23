/**
 * filmekseni - FilmEkseni (filmekseni.pro) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> filmekseni /api/search?q=  (data[]: title, slug, contentableType, releaseYear)
 *   -> /<slug>/ film sayfasi
 *   -> data-video-player x-data JSON (dual[]: link + base64 template)
 *   -> template decode: <iframe data-src="//eksenload.top/eplayer/{link}">
 *   -> /eplayer/{link} -> JW Player config JSON
 *   -> file (m3u8) + tracks (VTT altyazi)
 *
 * Notlar:
 * - Eski filmekseni.vip domain'i kapandi; .cc/.org -> .pro yonlendiriyor.
 * - Buffer/URL/onSettings disinda ES5 + Promise; base64 cozucu elle yazildi.
 * - m3u8 URL'si imzali/gecicidir, her istekte yenilenir.
 * - m3u8 isteminde Referer (eksenload.top) gereklidir.
 */
(function () {
  "use strict";

  var BASE = "https://filmekseni.pro";
  var EMBED_BASE = "https://eksenload.top";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var MEDIA_HEADERS = { "User-Agent": UA, Referer: EMBED_BASE + "/" };
  var TAG = "[filmekseni]";
  var seriesSlugCache = null;

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
    return ascii.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function norm(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9çğıöşü]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Buffer yok; Nuvio/QuickJS icinelle base64 + UTF-8 cozucu.
  function decodeBase64(input) {
    var s = String(input || "").replace(/\s/g, "");
    var out = "", i = 0, e1, e2, e3, e4, ch3, ch4;
    while (i < s.length) {
      e1 = B64.indexOf(s.charAt(i++));
      if (e1 < 0) break;
      e2 = i < s.length ? B64.indexOf(s.charAt(i++)) : 64;
      if (e2 < 0) break;
      ch3 = i < s.length ? s.charAt(i++) : "=";
      e3 = ch3 === "=" ? 64 : B64.indexOf(ch3);
      ch4 = i < s.length ? s.charAt(i++) : "=";
      e4 = ch4 === "=" ? 64 : B64.indexOf(ch4);
      out += String.fromCharCode((e1 << 2) | (e2 >> 4));
      if (e3 !== 64) {
        out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
        if (e4 !== 64) out += String.fromCharCode(((e3 & 3) << 6) | e4);
      }
    }
    return out;
  }

  function utf8Decode(binary) {
    var out = "", i = 0, c, c2, c3;
    while (i < binary.length) {
      c = binary.charCodeAt(i++);
      if (c < 0x80) {
        out += String.fromCharCode(c);
      } else if (c < 0xE0 && i < binary.length) {
        c2 = binary.charCodeAt(i++);
        out += String.fromCharCode(((c & 0x1F) << 6) | (c2 & 0x3F));
      } else if (i + 1 < binary.length) {
        c2 = binary.charCodeAt(i++);
        c3 = binary.charCodeAt(i++);
        out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F));
      }
    }
    return out;
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
      var enUrl = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
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
        return { title: main, original: original, alternatives: altTitles, year: year };
      });
    });
  }

  // -------------------------------------------------------------- searching

  function searchSite(query) {
    var url = BASE + "/api/search?q=" + encodeURIComponent(query);
    return fetchJson(url, { "User-Agent": UA, Referer: BASE + "/", Accept: "application/json" })
      .then(function (d) {
        if (!d || !d.data || Object.prototype.toString.call(d.data) !== "[object Array]") return [];
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

  function scoreItem(item, titles, isTv, year) {
    // Tip ayrimi kritik: arama API'si dizi ararken film, film ararken dizi
    // dondurebiliyor (orn. "Breaking Bad" -> "El Camino" filmi).
    var type = item.contentableType || "";
    if (isTv ? !/series/i.test(type) : !/movie/i.test(type)) return 0;

    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var s = matchScore(item.title, titles[i]);
      if (s > best) best = s;
    }
    if (!best) return 0;
    if (year && item.releaseYear && Math.abs(parseInt(item.releaseYear, 10) - parseInt(year, 10)) > 1) best -= 5;
    return best;
  }

  // Arama API'sinde dizisi olmayan ama sitede bulunan yapimlar icin
  // sitemap.series listesinden slug ile eslestirme (TMDB basliklari uzerinden).
  function loadSeriesSlugs() {
    if (seriesSlugCache) return Promise.resolve(seriesSlugCache);
    return fetchText(BASE + "/sitemap.series.1.xml", { "User-Agent": UA }).then(function (xml) {
      var out = [], re = /<loc>https:\/\/filmekseni\.pro\/dizi\/([a-z0-9-]+)\/?<\/loc>/gi, m;
      while ((m = re.exec(xml || "")) !== null) {
        if (out.indexOf(m[1]) === -1) out.push(m[1]);
      }
      seriesSlugCache = out;
      return out;
    }).catch(function () {
      seriesSlugCache = [];
      return [];
    });
  }

  function findSeriesInSitemap(titles) {
    return loadSeriesSlugs().then(function (slugs) {
      var wanted = [];
      for (var i = 0; i < titles.length; i++) {
        var sl = slugify(titles[i]);
        if (sl && wanted.indexOf(sl) === -1) wanted.push(sl);
      }
      var prefix = null;
      for (var j = 0; j < slugs.length; j++) {
        for (var k = 0; k < wanted.length; k++) {
          if (slugs[j] === wanted[k]) return { title: titles[k], slug: "dizi/" + slugs[j] };
          if (!prefix && slugs[j].indexOf(wanted[k]) === 0) {
            prefix = { title: titles[k], slug: "dizi/" + slugs[j] };
          }
        }
      }
      return prefix;
    });
  }

  function findResult(titles, isTv, year) {
    var best = null, bestScore = 0;
    var ordered = [];
    for (var i = 0; i < titles.length && ordered.length < 10; i++) {
      if (titles[i] && ordered.indexOf(titles[i]) === -1) ordered.push(titles[i]);
    }

    function consider(items) {
      for (var i = 0; i < items.length; i++) {
        var s = scoreItem(items[i], titles, isTv, year);
        if (s > bestScore) { bestScore = s; best = items[i]; }
      }
    }

    function finish() {
      if (best && bestScore > 0) return Promise.resolve(best);
      return isTv ? findSeriesInSitemap(titles) : Promise.resolve(null);
    }

    function searchAll(idx) {
      if (idx >= ordered.length) return prefixAll(0);
      return searchSite(ordered[idx]).then(function (items) {
        consider(items);
        if (bestScore >= 10) return finish();
        return searchAll(idx + 1);
      }).catch(function () { return searchAll(idx + 1); });
    }

    function prefixAll(pIdx) {
      if (pIdx >= 2 || !ordered.length) return finish();
      var words = String(ordered[0] || "").split(/\s+/);
      var prefix = null;
      if (pIdx === 0 && words.length > 2) prefix = words.slice(0, 3).join(" ");
      if (pIdx === 1 && words.length > 1) prefix = words.slice(0, 2).join(" ");
      if (!prefix) return prefixAll(pIdx + 1);
      return searchSite(prefix).then(function (items) {
        consider(items);
        return prefixAll(pIdx + 1);
      }).catch(function () { return prefixAll(pIdx + 1); });
    }

    return searchAll(0);
  }

  function getPage(slug) {
    return fetchText(BASE + "/" + slug + "/", { "User-Agent": UA, Referer: BASE + "/" });
  }

  // Dizi: /dizi/<slug>/sezon-S/bolum-E/ sayfasini acar.
  // Istisna S/E yoksa dizi sayfasindaki mevcut bolum listesinden en yakinini secer.
  function getEpisodeData(slug, s, e) {
    var headers = { "User-Agent": UA, Referer: BASE + "/" };
    return fetchText(BASE + "/" + slug + "/sezon-" + s + "/bolum-" + e + "/", headers)
      .then(function (html) {
        if (html && extractPlayerData(html)) return { html: html, season: s, episode: e };
        return getPage(slug).then(function (seriesHtml) {
          // Bazi dizilerde arama slug'i ile bolum slug'i farklidir
          // (orn. the-last-of-us-izle -> /dizi/the-last-of-us/sezon-1/bolum-1).
          // Bu yuzden tam href'yi kullanmak zorunludur.
          var links = [], re = /href="([^"]*\/dizi\/[a-z0-9-]+\/sezon-(\d+)\/bolum-(\d+)[^"]*)"/gi, m;
          while ((m = re.exec(seriesHtml || "")) !== null) {
            var ls = parseInt(m[2], 10), le = parseInt(m[3], 10);
            if (!ls || !le) continue;
            var href = m[1].replace(/&amp;/g, "&");
            if (!/^https?:\/\//i.test(href)) href = BASE + (href.charAt(0) === "/" ? "" : "/") + href;
            links.push({ url: href, s: ls, e: le });
          }
          if (!links.length) return { html: html, season: s, episode: e };
          var pick = links[0], bestDist = 1e9;
          for (var i = 0; i < links.length; i++) {
            var dist = links[i].s === s
              ? Math.abs(links[i].e - e)
              : 1000 + Math.abs(links[i].s - s) * 100 + links[i].e;
            if (dist < bestDist) { bestDist = dist; pick = links[i]; }
          }
          console.log(TAG + " Bolum fallback: S" + pick.s + "E" + pick.e + " (istenen S" + s + "E" + e + ") -> " + pick.url);
          return fetchText(pick.url, headers).then(function (h2) {
            return { html: h2, season: pick.s, episode: pick.e };
          });
        });
      });
  }

  function extractPlayerData(html) {
    var m = html.match(/x-data="videoPlayerData\(JSON\.parse\('([^']+)'\)/);
    if (!m) return null;
    var encoded = m[1].replace(/\\u0022/g, '"').replace(/\\u0027/g, "'").replace(/\\\\/g, "\\");
    try { return JSON.parse(encoded); } catch (e) { return null; }
  }

  function getEmbedUrls(playerData) {
    var dual = playerData && playerData.dual;
    if (!dual || !dual.length) return [];
    var out = [], seen = {};
    for (var i = 0; i < dual.length && out.length < 4; i++) {
      var item = dual[i];
      var tmpl = utf8Decode(decodeBase64(item.template || ""));
      var uMatch = tmpl.match(/data-src="([^"]+)"/);
      if (!uMatch) continue;
      var url = uMatch[1]
        .replace(/\{slug\}/g, item.service_slug || "")
        .replace(/\{url\}/g, item.link || "");
      if (url && !/^https?:\/\//i.test(url)) url = "https:" + url;
      if (!url || seen[url]) continue;
      seen[url] = 1;
      out.push({
        link: item.link,
        serviceName: item.service_name || "",
        note: item.note || "",
        quality: item.quality || "",
        embedUrl: url
      });
    }
    return out;
  }

  function resolveStream(embedUrl) {
    return fetchText(embedUrl, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return null;
        var m = html.match(/\.setup\(JSON\.parse\('([^']+)'\)\)/);
        if (!m) return null;
        var encoded = m[1].replace(/\\u0022/g, '"').replace(/\\\\\//g, "/").replace(/\\\\/g, "\\");
        var config;
        try {
          config = JSON.parse(encoded);
        } catch (e) {
          try { config = JSON.parse(m[1]); } catch (e2) { return null; }
        }
        if (!config || !config.file) return null;

        var subtitles = [], langs = [];
        if (Object.prototype.toString.call(config.tracks) === "[object Array]") {
          config.tracks.forEach(function (t) {
            if (!t || !t.file) return;
            var fileLower = String(t.file).toLowerCase();
            var label = String(t.label || "");
            var lang = "und";
            if (/tur|_tr\b|\.tr\./i.test(fileLower) || /türk|turk|tr/i.test(label)) lang = "tr";
            else if (/eng|_en\b|\.en\./i.test(fileLower) || /ingiliz|english|\ben\b/i.test(label)) lang = "en";
            if (lang !== "und" && langs.indexOf(lang) === -1) langs.push(lang);
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
          subtitleLangs: langs,
          image: config.image || "",
          qualityLabels: config.qualityLabels || {}
        };
      });
  }

  function qualityFromLabels(qualityLabels, fallback) {
    var keys = qualityLabels && typeof qualityLabels === "object" ? Object.keys(qualityLabels) : [];
    if (!keys.length) return fallback || "Auto";
    var maxKey = keys.reduce(function (a, b) { return parseInt(a, 10) > parseInt(b, 10) ? a : b; });
    return qualityLabels[maxKey] || fallback || "Auto";
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

      return findResult(titles, isTv, info.year).then(function (result) {
        if (!result) {
          console.log(tag + " Eslesen sonuc bulunamadi");
          return [];
        }
        console.log(tag + " Bulundu: " + result.title + " (" + result.slug + ")");

        var pagePromise = isTv
          ? getEpisodeData(result.slug, s, e)
          : getPage(result.slug).then(function (html) { return { html: html, season: s, episode: e }; });
        return pagePromise.then(function (page) {
          var html = page.html;
          if (!html) return [];
          var playerData = extractPlayerData(html);
          if (!playerData) {
            console.log(tag + " Oynatici verisi bulunamadi");
            return [];
          }
          var embeds = getEmbedUrls(playerData);
          if (!embeds.length) {
            console.log(tag + " Embed URL olusturulamadi");
            return [];
          }

          function next(i, out) {
            if (i >= embeds.length) return Promise.resolve(out);
            var embed = embeds[i];
            return resolveStream(embed.embedUrl).then(function (stream) {
              if (stream) {
                var quality = qualityFromLabels(stream.qualityLabels, embed.quality);
                var hay = embed.serviceName + " " + embed.note;
                var tags = [];
                if (/dublaj|dual/i.test(hay)) tags.push("TR Dublaj");
                if (stream.subtitleLangs.length) tags.push("Alt: " + stream.subtitleLangs.join("/"));
                if (quality) tags.push(quality);

                var display = info.title + (info.year ? " (" + info.year + ")" : "");
                if (isTv) display += " S" + page.season + "E" + page.episode;
                var title = display + (tags.length ? " [" + tags.join(" | ") + "]" : "");

                out.push({
                  name: "FilmEkseni " + (quality || ""),
                  title: title,
                  url: stream.url,
                  quality: quality || undefined,
                  isM3u8: true,
                  type: "hls",
                  language: "tr",
                  provider: "filmekseni",
                  headers: MEDIA_HEADERS,
                  subtitles: stream.subtitles,
                  behaviorHints: {
                    bingeGroup: "filmekseni-" + result.slug + (isTv ? "-s" + page.season + "e" + page.episode : "")
                  },
                  _dub: /dublaj|dual/i.test(hay),
                  _sub: stream.subtitleLangs.length > 0,
                  _quality: quality
                });
              }
              return next(i + 1, out);
            });
          }
          return next(0, []);
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
