/**
 * justflix - Diziyou (diziyou.love) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basliklari (orijinal + TR + EN) ve yapim yili
 *   -> baslik/yil dogrulamali dizi sayfasi (dogrudan slug + site aramasi)
 *   -> /{dizi-slug}-{sezon}-sezon-{bolum}-bolum/
 *   -> /player/{id}.html      (Orijinal ses, TR altyazili)
 *      /player/{id}_tr.html   (TR Dublaj)
 *      /player/{id}_enSub.html(EN altyazili, ayni video)
 *   -> storage.diziyou.love .../play.m3u8 -> medya playlist (HLS)
 *
 * Onemli notlar:
 * - Site yalnizca dizi icerir; film desteklenmez.
 * - Ayni isimli farkli diziler (orn. The Office US 2005 / UK 2001 / Ofis 2024)
 *   yil + baslik dogrulamasi ile ayrilir. Yil uyusmazsa sayfa reddedilir.
 * - Dublaj ve orijinal ses ayri player dosyalaridir; ikisi de kaynak olarak doner.
 * - Master playlist'te ayri ses rendisyonu yoksa dogrudan medya playlist
 *   (orn. 720p.m3u8) donulur; boylece bazi oynaticilarda yasanan "sessiz"
 *   master sorunu engellenir. Ayri ses rendisyonu varsa master donulur.
 * - Altyazilar yeni oynaticidaki DYSubtitles trUrl/enUrl alanlarindan alinir.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri ve ES5 sozdizimi.
 */
(function () {
  "use strict";

  var BASE = "https://www.diziyou.love";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 12000;

  var LANG_NAMES = {
    tr: "Türkçe", en: "İngilizce", ja: "Japonca", ko: "Korece", es: "İspanyolca",
    fr: "Fransızca", de: "Almanca", it: "İtalyanca", ru: "Rusça", ar: "Arapça",
    hi: "Hintçe", zh: "Çince", pt: "Portekizce", nl: "Felemenkçe", sv: "İsveççe",
    pl: "Lehçe", da: "Danca", no: "Norveççe", fi: "Fince", el: "Yunanca"
  };

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
    var h = {};
    var k;
    if (headers) {
      for (k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k];
      }
    }
    if (!h["User-Agent"]) h["User-Agent"] = UA;
    if (!h["Accept"]) h["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    if (!h["Accept-Language"]) h["Accept-Language"] = "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7";

    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, TIMEOUT);
    });
    return Promise.race([fetch(url, { headers: h }), timeout])
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

  function fetchJson(url) {
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
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
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&");
  }

  function stripMarks(text) {
    return String(text || "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  }

  function resolveUrl(base, rel) {
    var r = stripMarks(String(rel || "")).trim();
    if (!r) return "";
    if (/^https?:\/\//i.test(r)) return r;
    if (r.indexOf("//") === 0) return "https:" + r;
    if (r.charAt(0) === "/") return BASE + r;
    var b = String(base || "").split("#")[0].split("?")[0];
    var idx = b.lastIndexOf("/");
    return (idx >= 0 ? b.slice(0, idx + 1) : BASE + "/") + r;
  }

  function absoluteUrl(url) {
    var u = stripMarks(String(url || "")).trim();
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.indexOf("//") === 0) return "https:" + u;
    if (u.charAt(0) === "/") return BASE + u;
    return BASE + "/" + u.replace(/^\.?\//, "");
  }

  function slugFromUrl(url) {
    var path = String(url || "").split("#")[0].split("?")[0];
    var m = path.match(/\/([^\/]+)\/?$/);
    if (!m) return "";
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  var TR_MAP = {
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ü": "u", "Ü": "u",
    "ö": "o", "Ö": "o", "ç": "c", "Ç": "c", "â": "a", "Â": "a", "î": "i", "Î": "i",
    "û": "u", "Û": "u", "é": "e", "è": "e", "ê": "e", "á": "a", "à": "a", "ä": "a",
    "å": "a", "ñ": "n", "ø": "o", "æ": "ae", "ß": "ss", "'": "", "’": "", "&": ""
  };

  function slugify(title) {
    var src = stripMarks(decodeEntities(title)), ascii = "";
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      ascii += TR_MAP[ch] !== undefined ? TR_MAP[ch] : ch;
    }
    return ascii.toLowerCase()
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function norm(text) {
    var s = stripMarks(decodeEntities(text)).toLowerCase().replace(/[\u0300-\u036f]/g, "");
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (/[a-z0-9]/.test(ch) || "çğıöşü".indexOf(ch) !== -1) {
        out += ch;
      } else if (ch.charCodeAt(0) > 127 && "—–’‘“”…•·".indexOf(ch) === -1) {
        out += ch;
      } else {
        out += " ";
      }
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function titleScore(pageTitle, titles) {
    var p = norm(pageTitle);
    if (!p) return 0;
    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var t = norm(titles[i]);
      if (!t) continue;
      var s = 0;
      if (p === t) s = 100;
      else if (p.indexOf(t + " ") === 0 || t.indexOf(p + " ") === 0) s = 80;
      else if (p.indexOf(t) !== -1 || t.indexOf(p) !== -1) s = 60;
      if (s > best) best = s;
    }
    return best;
  }

  function yearScore(pageYear, tmdbYear) {
    var p = parseInt(pageYear, 10), t = parseInt(tmdbYear, 10);
    if (!p || !t) return 0;
    if (Math.abs(p - t) <= 1) return 20;
    return -1000;
  }

  function pageInfo(html) {
    var h = String(html || "");
    var h1 = (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "";
    var titleTag = (h.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
    var title = decodeEntities(cleanText(h1));
    if (!title) {
      title = decodeEntities(cleanText(titleTag))
        .replace(/\s+izle\b[\s\S]*$/i, "")
        .replace(/\s+-\s+[\s\S]*$/, "")
        .trim();
    }
    var ym = h.match(/Yap[^<]{0,40}<\/span>\s*(\d{4})/i) || h.match(/Yap[^<]{0,40}(\d{4})/i);
    var year = ym ? ym[1] : "";
    if (!year) {
      var ym2 = (h1 + " " + titleTag).match(/\((19|20)\d{2}\)/);
      if (ym2) year = ym2[0].slice(1, 5);
    }
    // Site bazi dizilerde yili baslige ekler: "Avatar: The Last Airbender (2024)".
    // Karsilastirma ve gosterim icin sondaki yil eki temizlenir.
    if (year) {
      title = title.replace(new RegExp("\\s*\\(\\s*" + year + "\\s*\\)\\s*$"), "").trim();
    }
    return { title: title, year: year };
  }

  // ------------------------------------------------------------------ TMDB

  function tmdbInfo(tmdbId, apiKey) {
    var base = "https://api.themoviedb.org/3/tv/" + encodeURIComponent(tmdbId);
    var q = "?api_key=" + encodeURIComponent(apiKey) + "&append_to_response=alternative_titles";
    return Promise.all([
      fetchJson(base + q + "&language=tr-TR"),
      fetchJson(base + q + "&language=en-US")
    ]).then(function (arr) {
      var tr = arr[0], en = arr[1];
      var d = tr || en;
      if (!d || d.success === false) return null;
      var trName = tr && tr.name ? stripMarks(tr.name) : "";
      var enName = en && en.name ? stripMarks(en.name) : "";
      var original = stripMarks(d.original_name || (en && en.original_name) || "");
      var year = String(d.first_air_date || (en && en.first_air_date) || "").slice(0, 4);
      var lang = d.original_language || (en && en.original_language) || "";
      var alts = [];
      var titles = [];

      function addUnique(list, value) {
        var n = norm(value);
        if (!n) return;
        for (var i = 0; i < list.length; i++) if (norm(list[i]) === n) return;
        list.push(value);
      }

      [tr, en].forEach(function (x) {
        var list = (x && x.alternative_titles && x.alternative_titles.results) || [];
        for (var i = 0; i < list.length && i < 10; i++) {
          if (list[i] && list[i].title) addUnique(alts, stripMarks(list[i].title));
        }
      });

      addUnique(titles, original);
      addUnique(titles, enName);
      addUnique(titles, trName);
      for (var a = 0; a < alts.length; a++) addUnique(titles, alts[a]);

      return {
        title: trName || enName || original,
        enTitle: enName || original,
        original: original,
        alternatives: alts,
        titles: titles,
        year: year,
        originalLanguage: lang
      };
    });
  }

  // --------------------------------------------------------- site matching

  function tryPage(slug) {
    var url = BASE + "/" + slug + "/";
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      return html ? { slug: slug, url: url, html: html } : null;
    });
  }

  function searchSite(query) {
    var url = BASE + "/?s=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      if (!html) return [];
      var out = [], seen = {};

      function add(slug, title, year, source) {
        if (!slug || seen[slug]) return;
        seen[slug] = true;
        out.push({ slug: slug, title: title || slug, year: year || "", source: source });
      }

      // Dizi sonuclari: <div id="categorytitle"><a href="...">Baslik</a>
      var re = /<div id="categorytitle">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/gi, m;
      while ((m = re.exec(html)) !== null) {
        var slug = slugFromUrl(decodeEntities(m[1]));
        var title = decodeEntities(cleanText(m[2]));
        var rest = html.slice(re.lastIndex, Math.min(html.length, re.lastIndex + 5000));
        var cut = rest.search(/id="categorytitle"|id="listehizala"/i);
        if (cut >= 0) rest = rest.slice(0, cut);
        var ym = rest.match(/Yap[^<]{0,40}<\/span>\s*(\d{4})/i);
        add(slug, title, ym ? ym[1] : "", "series");
      }

      // Bolum sonuclari: /dizi-slug-2-sezon-7-bolum/ -> dizi slug'i cikarilir
      var blocks = html.split('<div class="listepisodes">');
      for (var i = 1; i < blocks.length && i <= 40; i++) {
        var block = blocks[i];
        var href = (block.match(/<a\b[^>]*href="([^"]+)"/i) || [])[1];
        if (!href) continue;
        var epSlug = slugFromUrl(decodeEntities(href));
        var sm = epSlug.match(/^(.+?)-\d+-sezon-\d+-bolum$/i);
        if (!sm) continue;
        var seriesSlug = sm[1];
        var titleHtml = (block.match(/<div id="dizi-ismi"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
        var seriesTitle = decodeEntities(cleanText(titleHtml));
        var year = "";
        var ym2 = seriesTitle.match(/\((19|20)\d{2}\)/);
        if (ym2) year = ym2[0].slice(1, 5);
        add(seriesSlug, seriesTitle, year, "episode");
      }

      return out;
    });
  }

  function verifyPage(page, info, priority, source, tag) {
    var pi = pageInfo(page.html);
    var ts = titleScore(pi.title, info.titles);
    var ys = yearScore(pi.year, info.year);
    if (ys < 0) return null;
    if (ts < 60) return null;
    var result = {
      score: ts + ys + (priority || 0),
      title: pi.title || page.slug,
      year: pi.year,
      slug: page.slug,
      url: page.url,
      html: page.html,
      source: source
    };
    console.log(tag + " Aday: " + result.title + " (" + (result.year || "?") + ") " +
      result.url + " [" + source + ", puan=" + result.score + "]");
    return result;
  }

  function findTarget(info, tag) {
    var cache = {};
    var matches = [];

    function tryPageCached(slug) {
      if (!slug) return Promise.resolve(null);
      if (Object.prototype.hasOwnProperty.call(cache, slug)) return Promise.resolve(cache[slug]);
      return tryPage(slug).then(function (page) {
        cache[slug] = page;
        return page;
      });
    }

    function bestMatch() {
      var best = null;
      for (var i = 0; i < matches.length; i++) {
        if (!best || matches[i].score > best.score) best = matches[i];
      }
      return best;
    }

    function consider(page, priority, source) {
      var v = verifyPage(page, info, priority, source, tag);
      if (v) matches.push(v);
      return v;
    }

    function direct() {
      var cands = [];
      function addCandidate(title, priority) {
        var n = norm(title);
        if (!n) return;
        for (var i = 0; i < cands.length; i++) if (norm(cands[i].title) === n) return;
        cands.push({ title: title, priority: priority });
      }
      addCandidate(info.original, 30);
      addCandidate(info.enTitle, 20);
      addCandidate(info.title, 10);
      for (var a = 0; a < info.alternatives.length && a < 6; a++) addCandidate(info.alternatives[a], 5);

      var tasks = [], seen = {};
      for (var c = 0; c < cands.length && c < 5; c++) {
        var slug = slugify(cands[c].title);
        if (!slug) continue;
        var suffixes = c < 2 ? ["", "2", "3"] : [""];
        for (var s = 0; s < suffixes.length; s++) {
          var key = slug + suffixes[s];
          if (seen[key]) continue;
          seen[key] = true;
          tasks.push({ slug: key, priority: cands[c].priority });
        }
      }

      function run(i) {
        if (i >= tasks.length) return Promise.resolve();
        return tryPageCached(tasks[i].slug).then(function (page) {
          if (page) consider(page, tasks[i].priority, "slug");
          var best = bestMatch();
          if (best && best.score >= 140) return;
          return run(i + 1);
        });
      }
      return run(0);
    }

    function search() {
      var queries = [], qSeen = {};
      function addQuery(t) {
        var n = norm(t);
        if (!n || qSeen[n]) return;
        qSeen[n] = true;
        queries.push(t);
      }
      addQuery(info.original);
      addQuery(info.enTitle);
      addQuery(info.title);

      var results = [];
      function runQuery(i) {
        if (i >= queries.length || i >= 3) return Promise.resolve();
        return searchSite(queries[i]).then(function (items) {
          results = results.concat(items || []);
          return runQuery(i + 1);
        });
      }

      return runQuery(0).then(function () {
        var bySlug = {};
        for (var i = 0; i < results.length; i++) {
          var it = results[i];
          if (!it.slug || Object.prototype.hasOwnProperty.call(bySlug, it.slug)) continue;
          var ts = titleScore(it.title, info.titles);
          var ys = yearScore(it.year, info.year);
          if (ys < 0 || ts < 60) continue;
          bySlug[it.slug] = { slug: it.slug, score: ts + ys, source: it.source };
        }
        var cands = [];
        for (var k in bySlug) {
          if (Object.prototype.hasOwnProperty.call(bySlug, k)) cands.push(bySlug[k]);
        }
        cands.sort(function (a, b) { return b.score - a.score; });
        cands = cands.slice(0, 5);

        function runCandidate(i) {
          if (i >= cands.length) return Promise.resolve();
          return tryPageCached(cands[i].slug).then(function (page) {
            if (page) consider(page, 0, "arama:" + cands[i].source);
            return runCandidate(i + 1);
          });
        }
        return runCandidate(0);
      });
    }

    return direct().then(function () {
      var best = bestMatch();
      if (best && best.score >= 140) return best;
      return search().then(function () { return bestMatch(); });
    });
  }

  // --------------------------------------------------------------- episode

  function findEpisodePaths(seriesHtml, seriesSlug, season, episode) {
    var html = String(seriesHtml || "");
    var re = /href="([^"]+)"/gi, m;
    var preferred = [], fallback = [], seen = {};
    while ((m = re.exec(html)) !== null) {
      var href = decodeEntities(m[1]).split("#")[0].split("?")[0];
      var path = href.replace(/^https?:\/\/[^\/]+\//i, "").replace(/^\/+|\/+$/g, "");
      var mm = path.match(/^(.+)-(\d+)-sezon-(\d+)-bolum$/i);
      if (!mm) continue;
      if (parseInt(mm[2], 10) !== season || parseInt(mm[3], 10) !== episode) continue;
      var epSlug = mm[1] + "-" + mm[2] + "-sezon-" + mm[3] + "-bolum";
      if (seen[epSlug]) continue;
      seen[epSlug] = true;
      var item = { path: epSlug };
      if (epSlug === seriesSlug || epSlug.indexOf(seriesSlug + "-") === 0) preferred.push(item);
      else fallback.push(item);
    }
    return preferred.concat(fallback);
  }

  function verifyEpisode(html, info, season, episode) {
    var re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi, m;
    var foundLd = false;
    while ((m = re.exec(String(html || ""))) !== null) {
      foundLd = true;
      var data;
      try { data = JSON.parse(m[1]); } catch (e) { continue; }
      var objs = [];
      if (Array.isArray(data)) objs = data;
      else if (data && Array.isArray(data["@graph"])) objs = data["@graph"];
      else objs = [data];
      for (var i = 0; i < objs.length; i++) {
        var o = objs[i];
        if (!o) continue;
        var type = o["@type"];
        var isEp = type === "TVEpisode" || (Array.isArray(type) && type.indexOf("TVEpisode") !== -1);
        if (!isEp) continue;
        var sn = o.partOfSeason && o.partOfSeason.seasonNumber;
        var en = o.episodeNumber;
        if (sn !== undefined && sn !== null && parseInt(sn, 10) !== season) return false;
        if (en !== undefined && en !== null && parseInt(en, 10) !== episode) return false;
        var seriesName = o.partOfSeries && o.partOfSeries.name ? o.partOfSeries.name : "";
        if (seriesName && titleScore(seriesName, info.titles) < 60) return false;
        return true;
      }
    }
    if (foundLd) return false;

    var h1 = (String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "";
    var h1Text = decodeEntities(cleanText(h1));
    if (titleScore(h1Text, info.titles) < 60) return false;
    var re2 = new RegExp("\\b" + season + "\\.\\s*Sezon\\s*" + episode + "\\.\\s*B[^\\s]*", "i");
    return re2.test(h1Text);
  }

  function findEpisode(target, season, episode, info, tag) {
    var paths = findEpisodePaths(target.html, target.slug, season, episode);
    if (!paths.length) return Promise.resolve(null);

    function tryPath(i) {
      if (i >= paths.length || i >= 4) return Promise.resolve(null);
      var epUrl = BASE + "/" + paths[i].path + "/";
      return fetchText(epUrl, { "User-Agent": UA, Referer: target.url }).then(function (html) {
        if (!html) return tryPath(i + 1);
        if (!verifyEpisode(html, info, season, episode)) return tryPath(i + 1);
        return { url: epUrl, html: html, path: paths[i].path };
      });
    }
    return tryPath(0);
  }

  // ---------------------------------------------------------------- player

  function findPlayerIframe(html) {
    var re = /<iframe\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi, m;
    while ((m = re.exec(String(html || ""))) !== null) {
      var u = decodeEntities(m[1]);
      if (u.indexOf("/player/") !== -1) return absoluteUrl(u);
    }
    var m2 = String(html || "").match(/(https?:\/\/[^"'\s<>]+\/player\/[^"'\s<>]+\.html[^"'\s<>]*)/i);
    return m2 ? absoluteUrl(decodeEntities(m2[1])) : "";
  }

  function langFromUrl(url, fallback) {
    var u = String(url || "");
    if (/\/tr\.vtt/i.test(u) || /_tr\.vtt/i.test(u)) return "tr";
    if (/\/en\.vtt/i.test(u) || /_en\.vtt/i.test(u)) return "en";
    return fallback || "und";
  }

  function langName(lang) {
    return LANG_NAMES[String(lang || "").toLowerCase()] || String(lang || "").toUpperCase();
  }

  function parsePlayerPage(html, playerUrl) {
    var h = String(html || "");
    var src = (h.match(/<source\b[^>]*\bsrc\s*=\s*"([^"]+\.m3u8[^"]*)"/i) || [])[1] ||
      (h.match(/<source\b[^>]*\bsrc\s*=\s*'([^']+\.m3u8[^']*)'/i) || [])[1] ||
      (h.match(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/i) || [])[1] || "";
    src = src ? resolveUrl(playerUrl, src) : "";

    var subs = [], seen = {};
    function addSub(url, lang, name) {
      var u = resolveUrl(playerUrl, decodeEntities(url));
      if (!u || seen[u]) return;
      seen[u] = true;
      var l = lang || langFromUrl(u, "und");
      subs.push({
        url: u,
        language: l,
        name: name || (l === "tr" ? "Türkçe" : (l === "en" ? "English" : langName(l))),
        lang: l,
        headers: { "User-Agent": UA, Referer: playerUrl }
      });
    }

    var trUrl = (h.match(/trUrl\s*:\s*['"]([^'"]+)['"]/i) || [])[1] || "";
    var enUrl = (h.match(/enUrl\s*:\s*['"]([^'"]+)['"]/i) || [])[1] || "";
    if (trUrl) addSub(trUrl, langFromUrl(trUrl, "tr"), langFromUrl(trUrl, "tr") === "tr" ? "Türkçe" : "English");
    if (enUrl) addSub(enUrl, langFromUrl(enUrl, "en"), langFromUrl(enUrl, "en") === "tr" ? "Türkçe" : "English");

    var trackRe = /<track\b([^>]*)>/gi, tm;
    while ((tm = trackRe.exec(h)) !== null) {
      var attrs = tm[1];
      var trackSrc = (attrs.match(/\bsrc\s*=\s*"([^"]+)"/i) || attrs.match(/\bsrc\s*=\s*'([^']+)'/i) || [])[1];
      if (!trackSrc) continue;
      var label = (attrs.match(/\blabel\s*=\s*"([^"]*)"/i) || [])[1] || "";
      var srclang = (attrs.match(/\bsrclang\s*=\s*"([^"]*)"/i) || [])[1] || "";
      addSub(trackSrc, srclang || langFromUrl(trackSrc, "und"), label);
    }

    return { source: src, subtitles: subs };
  }

  function parseStreamVariants(master, baseUrl) {
    var lines = String(master || "").split(/\r?\n/);
    var out = [], pending = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) { pending = line; continue; }
      if (line.charAt(0) === "#") continue;
      if (pending) {
        var hm = pending.match(/RESOLUTION=\d+x(\d+)/i);
        var bm = pending.match(/BANDWIDTH=(\d+)/i);
        out.push({
          url: resolveUrl(baseUrl, line),
          height: hm ? parseInt(hm[1], 10) : 0,
          bandwidth: bm ? parseInt(bm[1], 10) : 0
        });
        pending = "";
      }
    }
    return out;
  }

  function parseAudioNames(master) {
    var out = [], seen = {}, re = /#EXT-X-MEDIA:TYPE=AUDIO([^\r\n]*)/gi, m;
    while ((m = re.exec(String(master || ""))) !== null) {
      var attrs = m[1];
      var name = (attrs.match(/NAME="([^"]*)"/i) || [])[1] || "";
      var lang = (attrs.match(/LANGUAGE="([^"]*)"/i) || [])[1] || "";
      var label = name || lang;
      if (!label || seen[label]) continue;
      seen[label] = true;
      out.push(label);
    }
    return out;
  }

  function qualityFromMedia(media, master) {
    var best = 0, re = /(\d{3,4})p[_\.\-]/gi, m;
    while ((m = re.exec(String(media || ""))) !== null) {
      var h = parseInt(m[1], 10);
      if (h >= 144 && h <= 4320 && h > best) best = h;
    }
    if (!best) {
      var re2 = /RESOLUTION=\d+x(\d+)/gi;
      while ((m = re2.exec(String(master || ""))) !== null) {
        var h2 = parseInt(m[1], 10);
        if (h2 > best) best = h2;
      }
    }
    if (!best) return "Auto";
    if (best >= 2000) return "4K";
    if (best >= 1000) return "1080p";
    if (best >= 700) return "720p";
    if (best >= 450) return "480p";
    return "360p";
  }

  function analyzePlaylist(playlist, sourceUrl, playerUrl) {
    var isMaster = /#EXT-X-STREAM-INF/i.test(String(playlist || ""));
    if (!isMaster) {
      return Promise.resolve({ mediaUrl: sourceUrl, media: playlist, returnUrl: sourceUrl });
    }

    var variants = parseStreamVariants(playlist, sourceUrl);
    if (!variants.length) return Promise.resolve(null);
    variants.sort(function (a, b) { return (b.height - a.height) || (b.bandwidth - a.bandwidth); });

    var hasAudioRenditions = /#EXT-X-MEDIA:TYPE=AUDIO/i.test(String(playlist || ""));

    function tryVariant(i) {
      if (i >= variants.length || i >= 3) return Promise.resolve(null);
      return fetchText(variants[i].url, { "User-Agent": UA, Referer: playerUrl, Accept: "*/*" }).then(function (media) {
        if (!media || media.indexOf("#EXTM3U") === -1) return tryVariant(i + 1);
        return {
          mediaUrl: variants[i].url,
          media: media,
          returnUrl: hasAudioRenditions ? sourceUrl : variants[i].url
        };
      });
    }
    return tryVariant(0);
  }

  function resolveVariant(playerUrl, epUrl, variant, info, display, tag) {
    return fetchText(playerUrl, { "User-Agent": UA, Referer: epUrl, Accept: "text/html,*/*" }).then(function (html) {
      if (!html) return null;
      var parsed = parsePlayerPage(html, playerUrl);
      if (!parsed.source) return null;
      // Dublaj oynaticisi orijinal EN altyaziyi da listeler; dublajda yalnizca TR kalsin.
      if (variant.dub) {
        parsed.subtitles = parsed.subtitles.filter(function (sub) { return sub.language === "tr"; });
      }

      return fetchText(parsed.source, { "User-Agent": UA, Referer: playerUrl, Accept: "*/*" }).then(function (playlist) {
        if (!playlist || playlist.indexOf("#EXTM3U") === -1) return null;
        return analyzePlaylist(playlist, parsed.source, playerUrl).then(function (analysis) {
          if (!analysis) return null;

          var quality = qualityFromMedia(analysis.media, playlist);
          var audioNames = parseAudioNames(playlist);
          var label = variant.label;
          if (audioNames.length > 1) label += " [" + audioNames.join(" / ") + "]";

          var subNames = [];
          for (var i = 0; i < parsed.subtitles.length; i++) {
            var sn = parsed.subtitles[i].name;
            if (sn && subNames.indexOf(sn) === -1) subNames.push(sn);
          }

          var title = display + " | " + quality + " [HLS] | " + label;
          if (subNames.length) title += " | Altyazı: " + subNames.join(", ");

          return {
            name: "JustFlix " + label + " - " + quality,
            title: title,
            url: analysis.returnUrl,
            quality: quality,
            isM3u8: true,
            type: "hls",
            language: variant.lang,
            provider: "justflix",
            headers: { "User-Agent": UA, Referer: playerUrl },
            subtitles: parsed.subtitles,
            _priority: variant.priority
          };
        });
      });
    }).catch(function (err) {
      console.log(tag + " " + variant.label + " hata: " + (err && err.message ? err.message : err));
      return null;
    });
  }

  function mergeSubtitles(target, source) {
    var seen = {};
    for (var i = 0; i < target.subtitles.length; i++) seen[target.subtitles[i].url] = true;
    for (var j = 0; j < source.subtitles.length; j++) {
      if (!seen[source.subtitles[j].url]) {
        target.subtitles.push(source.subtitles[j]);
        seen[source.subtitles[j].url] = true;
      }
    }
  }

  // ------------------------------------------------------------------ main

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[justflix]";
    var isTv = mediaType === "tv" || mediaType === "series";
    if (!isTv) {
      console.log(tag + " yalnızca dizi desteklenir");
      return Promise.resolve([]);
    }

    var s = parseInt(season, 10);
    var e = parseInt(episode, 10);
    if (isNaN(s)) s = 1;
    if (isNaN(e)) e = 1;
    var apiKey = getTmdbKey(settings);

    return tmdbInfo(tmdbId, apiKey).then(function (info) {
      if (!info || !info.titles.length) {
        console.log(tag + " TMDB bilgisi alınamadı");
        return [];
      }
      console.log(tag + " TMDB: " + info.titles.join(" | ") + " (" + (info.year || "?") + ")");

      return findTarget(info, tag).then(function (target) {
        if (!target) {
          console.log(tag + " Dizi sayfası bulunamadı (başlık/yıl uyuşmadı)");
          return [];
        }
        console.log(tag + " Seçilen: " + target.title + " (" + (target.year || "?") + ") " + target.url);

        return findEpisode(target, s, e, info, tag).then(function (ep) {
          if (!ep) {
            console.log(tag + " Bölüm bulunamadı: S" + s + "E" + e);
            return [];
          }
          console.log(tag + " Bölüm: " + ep.url);

          var iframe = findPlayerIframe(ep.html);
          if (!iframe) {
            console.log(tag + " Player iframe bulunamadı");
            return [];
          }
          var playerBase = iframe.split("#")[0].split("?")[0].replace(/\.html$/i, "");
          var display = target.title + (target.year ? " (" + target.year + ")" : "") + " S" + s + "E" + e;
          var origLang = info.originalLanguage || "en";

          var variants = [
            { suffix: "_tr", label: "TR Dublaj", lang: "tr", priority: 1, dub: true },
            { suffix: "", label: "Orijinal Ses (" + langName(origLang) + ")", lang: origLang, priority: 2 },
            { suffix: "_enSub", label: "Orijinal Ses (EN Altyazılı)", lang: origLang, priority: 3 }
          ];

          var jobs = variants.map(function (v) {
            return resolveVariant(playerBase + v.suffix + ".html", ep.url, v, info, display, tag);
          });

          return Promise.all(jobs).then(function (results) {
            var out = [], byUrl = {};
            for (var i = 0; i < results.length; i++) {
              var r = results[i];
              if (!r) continue;
              if (byUrl[r.url]) {
                mergeSubtitles(byUrl[r.url], r);
                continue;
              }
              byUrl[r.url] = r;
              out.push(r);
            }
            out.sort(function (a, b) { return (a._priority || 0) - (b._priority || 0); });
            for (var j = 0; j < out.length; j++) delete out[j]._priority;
            console.log(tag + " Kaynak: " + out.length +
              (out.length ? " (" + out.map(function (x) { return x.name; }).join(", ") + ")" : ""));
            return out;
          });
        });
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message ? err.message : err));
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
