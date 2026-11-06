/**
 * dizilla - Dizilla (dizilla.la) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi -> /dizi/{slug} veya /ara?q= aramasi
 *   -> /{base}-{s}-sezon-{e}-bolum-c02 (JSON-LD'den veya slug insasindan)
 *   -> sources: iframe.php (Pichive) -> window.NP_CONFIG
 *   -> nm.php master playlist (HLS m3u8) + nsub.php altyazilar
 *
 * Notlar:
 * - Site sadece dizi icerir (film yok); bu yuzden yalnizca tv desteklenir.
 * - Pichive, kisa UA'yi Cloudflare blokluyor; tam Chrome/Mobile UA sart.
 * - four.pichive.online calisir; pichive.online PUB+ kaynaklari
 *   cogu bolumde "Video bulunamadi" doner ve atlanir.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://dizilla.la";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_KEY_FALLBACK;
  }

  function fetchText(url, headers) {
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, TIMEOUT);
    });
    return Promise.race([fetch(url, { headers: headers || { "User-Agent": UA } }), timeout])
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

  function cleanText(html) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function decodeEntities(text) {
    var s = String(text || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); });
    return s.replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
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
    return String(text || "").toLowerCase().replace(/[^a-z0-9çğıöşü]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function tmdbInfo(tmdbId, apiKey) {
    var url = "https://api.themoviedb.org/3/tv/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) + "&language=tr-TR&append_to_response=alternative_titles";
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;
      var main = d.name || "", original = d.original_name || "";
      var altList = (d.alternative_titles && d.alternative_titles.results) || [];
      var altTitles = [];
      for (var i = 0; i < altList.length && altTitles.length < 4; i++) {
        var t = altList[i] && altList[i].title;
        if (t && norm(t) !== norm(main) && altTitles.indexOf(t) === -1) altTitles.push(t);
      }
      return { title: main, original: original, alternatives: altTitles, year: String(d.first_air_date || "").slice(0, 4) };
    });
  }

  function tryPage(slug) {
    var url = BASE + "/dizi/" + slug;
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      return html ? { slug: slug, url: url, html: html } : null;
    });
  }

  function searchSite(query) {
    var url = BASE + "/ara?q=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      if (!html) return [];
      var re = /<a href="\/dizi\/([^"]+)" class="pcard"[\s\S]*?<span class="mvk-t">([^<]+)<\/span><span class="mvk-m[^"]*">(\d{4})/g;
      var out = [], m;
      while ((m = re.exec(html)) !== null) {
        out.push({ slug: m[1], title: decodeEntities(cleanText(m[2])), year: m[3] });
      }
      return out;
    });
  }

  function score(item, titles, year) {
    var itemTitle = norm(item.title);
    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var t = norm(titles[i]);
      if (!t || !itemTitle) continue;
      var s = 0;
      if (itemTitle === t) s = 12;
      else if (itemTitle.indexOf(t) !== -1 || t.indexOf(itemTitle) !== -1) s = 7;
      else {
        var words = t.split(" ").filter(function (w) { return w.length > 2; });
        var all = words.length > 0;
        for (var w = 0; w < words.length; w++) if (itemTitle.indexOf(words[w]) === -1) { all = false; break; }
        if (all) s = 4;
      }
      if (s > best) best = s;
    }
    if (!best) return -1;
    if (year && item.year) best += item.year === year ? 6 : -5;
    return best;
  }

  function pickBest(items, titles, year) {
    var best = null, bestScore = 0;
    for (var i = 0; i < (items || []).length; i++) {
      var s = score(items[i], titles, year);
      if (s > bestScore) { bestScore = s; best = items[i]; }
    }
    return best;
  }

  function findTarget(titles, year) {
    var candidates = [];
    for (var i = 0; i < titles.length && i < 3; i++) {
      var slug = slugify(titles[i]);
      if (slug && candidates.indexOf(slug) === -1) candidates.push(slug);
    }
    function trySlug(idx) {
      if (idx >= candidates.length) return Promise.resolve(null);
      return tryPage(candidates[idx]).then(function (page) { return page || trySlug(idx + 1); });
    }
    return trySlug(0).then(function (page) {
      if (page) return page;
      function trySearch(idx, found) {
        if (idx >= titles.length || idx >= 2) {
          var best = pickBest(found, titles, year);
          return best ? tryPage(best.slug) : null;
        }
        return searchSite(titles[idx]).then(function (res) { return trySearch(idx + 1, found.concat(res || [])); });
      }
      return trySearch(0, []);
    });
  }

  function findEpisodeUrl(seriesHtml, baseTitle, season, episode) {
    // 1) JSON-LD episode listesi: https://dizilla.la/{base-...}-{s}-sezon-{e}-bolum-cNN
    var re = /https:\/\/dizilla\.la\/([a-z0-9\-]+-sezon-(\d+)-bolum-c\d+)/g;
    var m, found = null;
    while ((m = re.exec(String(seriesHtml))) !== null) {
      if (parseInt(m[2], 10) === episode) {
        // slug icindeki "-{s}-sezon-" kismini kontrol et
        var path = m[1];
        var sm = path.match(/-(\d+)-sezon-\d+-bolum-/);
        if (sm && parseInt(sm[1], 10) === season) { found = path; break; }
      }
    }
    if (found) return found;
    // 2) slug insasi
    var base = slugify(baseTitle);
    if (base) return base + "-" + season + "-sezon-" + episode + "-bolum-c02";
    return null;
  }

  function extractSources(epHtml) {
    var re = /https:\/\/[a-z0-9.\-]*pichive\.online\/iframe\.php\?v=[a-f0-9]+/gi;
    var seen = {}, out = [], m;
    while ((m = re.exec(String(epHtml))) !== null) {
      var u = m[0];
      if (!seen[u]) { seen[u] = true; out.push(u); }
    }
    return out;
  }

  function parseNPConfig(iframeHtml) {
    var m = String(iframeHtml || "").match(/window\.NP_CONFIG\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function qualityFromMaster(master) {
    var best = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g, mm;
    while ((mm = re.exec(String(master || ""))) !== null) {
      var side = Math.min(parseInt(mm[1], 10), parseInt(mm[2], 10));
      if (side > best) best = side;
    }
    if (!best) return "Auto";
    if (best >= 2000) return "4K";
    if (best >= 1000) return "1080p";
    if (best >= 700) return "720p";
    if (best >= 450) return "480p";
    return "360p";
  }

  function resolveIframe(iframeUrl, epUrl) {
    var origin;
    try { origin = new URL(iframeUrl).origin; } catch (e) { return Promise.resolve(null); }
    return fetchText(iframeUrl, {
      "User-Agent": UA,
      Referer: epUrl,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
    }).then(function (html) {
      if (!html || /Attention Required|Video bulunamadı/i.test(html)) return null;
      var cfg = parseNPConfig(html);
      if (!cfg || !cfg.sources || !cfg.sources.length || !cfg.sources[0].master) return null;
      var master = cfg.sources[0].master;
      var subs = [];
      (cfg.subtitles || []).forEach(function (s) {
        if (s && s.url) subs.push({ url: s.url, language: s.label || s.lang || "tr", name: s.label || s.lang || "tr", lang: s.label || s.lang || "tr", headers: { "User-Agent": UA, Referer: iframeUrl } });
      });
      return fetchText(master, { "User-Agent": UA, Referer: iframeUrl, Accept: "*/*" }).then(function (pl) {
        if (!pl || pl.indexOf("#EXTM3U") === -1) return null;
        return { master: master, iframeUrl: iframeUrl, origin: origin, quality: qualityFromMaster(pl), subtitles: subs, playlist: pl };
      });
    });
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[dizilla]";
    var isTv = mediaType === "tv" || mediaType === "series";
    if (!isTv) { console.log(tag + " yalnizca dizi desteklenir"); return Promise.resolve([]); }
    var s = parseInt(season, 10) || 1, e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);
    return tmdbInfo(tmdbId, apiKey).then(function (info) {
      if (!info || !info.title) { console.log(tag + " TMDB bilgisi alinamadi"); return []; }
      var display = info.title + (info.year ? " (" + info.year + ")" : "") + " S" + s + "E" + e;
      var titles = [info.title, info.original].concat(info.alternatives || []);
      titles = titles.filter(function (t, i) { return t && titles.indexOf(t) === i; });
      console.log(tag + " Araniyor: " + titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));
      return findTarget(titles, info.year).then(function (target) {
        if (!target) { console.log(tag + " Sayfa bulunamadi"); return []; }
        console.log(tag + " Sayfa: " + target.url);
        var epPath = findEpisodeUrl(target.html, titles[1] || titles[0], s, e);
        if (!epPath) { console.log(tag + " Bolum URL uydurulamadi"); return []; }
        var epUrl = BASE + "/" + epPath;
        return fetchText(epUrl, { "User-Agent": UA, Referer: target.url }).then(function (epHtml) {
          if (!epHtml) { console.log(tag + " Bolum sayfasi alinamadi: " + epUrl); return []; }
          var iframes = extractSources(epHtml);
          console.log(tag + " Bulunan iframe kaynagi: " + iframes.length);
          if (!iframes.length) return [];
          var promises = iframes.map(function (u) { return resolveIframe(u, epUrl); });
          return Promise.all(promises).then(function (resolved) {
            var out = [];
            resolved.forEach(function (r, idx) {
              if (!r) return;
              var headers = { "User-Agent": UA, Referer: r.iframeUrl, Origin: r.origin };
              var extras = [];
              if (r.subtitles.length) extras.push(r.subtitles.length + " altyazi");
              out.push({
                name: "Dizilla - " + r.quality,
                title: display + " | " + r.quality + " [HLS]" + (extras.length ? " | " + extras.join(", ") : ""),
                url: r.master,
                quality: r.quality,
                isM3u8: true,
                type: "hls",
                language: "tr",
                provider: "dizilla",
                headers: headers,
                subtitles: r.subtitles
              });
            });
            console.log(tag + " Kaynak bulundu: " + out.length);
            return out;
          });
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
