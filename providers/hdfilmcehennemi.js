/**
 * hdfilmcehennemi - HD Film Cehennemi provider for Nuvio
 *
 * Akis:
 *   TMDB (tr-TR + en-US + alternative titles)
 *     -> site arama (/?s=)
 *     -> film / dizi / bolum sayfasi
 *     -> admin-ajax get_video_url
 *     -> setplay.sbs player
 *     -> SPG.cerceve decode -> fastplay.mom video sayfasi
 *     -> manifest URL (X-Sp proof) + altyazilar
 *
 * Domain notu (2026-11):
 *   .nl  -> resmi domain ama Cloudflare challenge donduruyor (HTTP 403).
 *   .land-> calisan mirror, arama (/?s=) ve oynatici zinciri saglikli.
 *   v7   -> yedek mirror; arama bazen ana sayfayi donduruyor, zincir calisir.
 *   Bu yuzden BASES sirasi calan mirror Once, resmi domain en sonda.
 *   Her adim kendi base'i ile yapilir (post_id'ler siteye ozel oldugu icin).
 *
 * Hermes/QuickJS uyumu:
 *   async/await, const/let, arrow function, template literal, Buffer,
 *   URL ve URLSearchParams KULLANILMAZ. Yalnizca ES5 + Promise.
 *
 * m3u8 URL'si gecicidir (verify imzali); her istekte yenilenir.
 * X-Sp kaniti fastplay.mom sayfasindaki SPG_A degerlerinden uretilir.
 */
(function () {
  "use strict";

  // Calisan mirror once; resmi .nl en sonda (Cloudflare 403).
  var BASES = [
    "https://www.hdfilmcehennemi.land",
    "https://hdfilmcehennemiv7.com",
    "https://www.hdfilmcehennemi.nl"
  ];
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;
  var TAG = "[hdfilmcehennemi]";

  var TR_MAP = {
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
    "â": "a", "Â": "a", "î": "i", "Î": "i", "û": "u", "Û": "u",
    "é": "e", "è": "e", "ê": "e", "á": "a", "à": "a", "ä": "a",
    "å": "a", "ñ": "n", "ø": "o", "æ": "ae", "ß": "ss"
  };

  // ---------------------------------------------------------------- helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function decodeEntities(s) {
    s = String(s || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); });
    return s.replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
  }

  function stripTags(s) {
    return decodeEntities(String(s || "").replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ").trim();
  }

  function stripMarks(s) {
    return String(s || "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  }

  function normTitle(s) {
    var src = stripMarks(decodeEntities(s)).toLowerCase().replace(/[\u0300-\u036f]/g, "");
    var out = "";
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (TR_MAP[ch] !== undefined) out += TR_MAP[ch];
      else if (/[a-z0-9]/.test(ch)) out += ch;
      else out += " ";
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function tokens(s) {
    var n = normTitle(s);
    return n ? n.split(" ") : [];
  }

  function unique(arr) {
    var out = [], seen = {};
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  function indexOfValue(arr, value) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === value) return i;
    return -1;
  }

  function isBlocked(html) {
    return /just a moment|cf-challenge|checking your browser|attention required|cloudflare ray|captcha/i
      .test(String(html || "").slice(0, 8000));
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

  function decodeXor(t, n) {
    var r = atobSafe(t), o = atobSafe(n), i = "", c;
    for (c = 0; c < r.length; c++) i += String.fromCharCode(r.charCodeAt(c) ^ o.charCodeAt(c % o.length));
    return i.split("|");
  }

  // FNV-1a 32-bit (fastplay.mom ile ayni)
  function hashFn(s) {
    var t = 2166136261;
    for (var n = 0; n < s.length; n++) { t ^= s.charCodeAt(n); t = Math.imul(t, 16777619) >>> 0; }
    return t.toString(16);
  }

  function fetchRaw(url, opts, timeout) {
    var timer = null;
    var to = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, timeout || TIMEOUT);
    });
    return Promise.race([fetch(url, opts || {}), to]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchText(url, headers, timeout) {
    return fetchRaw(url, { headers: headers || { "User-Agent": UA } }, timeout)
      .then(function (res) {
        if (!res || !res.ok) return null;
        return res.text();
      })
      .catch(function () { return null; });
  }

  function fetchJson(url, headers) {
    return fetchText(url, headers).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    });
  }

  function formEncode(obj) {
    var parts = [];
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
      }
    }
    return parts.join("&");
  }

  function resolveUrl(base, rel) {
    rel = String(rel || "").replace(/\\\//g, "/");
    if (/^https?:\/\//i.test(rel)) return rel;
    var schemeIdx = base.indexOf("://");
    var hostStart = schemeIdx === -1 ? 0 : schemeIdx + 3;
    var pathStart = base.indexOf("/", hostStart);
    if (pathStart === -1) return base + "/" + rel;
    if (rel.charAt(0) === "/") return base.slice(0, pathStart) + rel;
    var clean = base.split("#")[0].split("?")[0];
    return clean.slice(0, clean.lastIndexOf("/") + 1) + rel;
  }

  // -------------------------------------------------------------- TMDB bilgisi

  function fetchTmdbInfo(apiKey, tmdbId, isTv) {
    var kind = isTv ? "tv" : "movie";
    function url(lang) {
      return "https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + encodeURIComponent(apiKey) +
        "&language=" + lang + "&append_to_response=alternative_titles";
    }
    return Promise.all([
      fetchJson(url("tr-TR")),
      fetchJson(url("en-US"))
    ]).then(function (arr) {
      var en = arr[1], tr = arr[0];
      var d = en || tr;
      if (!d) return null;

      var titles = [];
      function add(value) {
        var clean = stripMarks(value);
        if (!normTitle(clean)) return;
        for (var i = 0; i < titles.length; i++) {
          if (normTitle(titles[i]) === normTitle(clean)) return;
        }
        titles.push(clean);
      }
      add(isTv ? d.original_name : d.original_title);
      add(isTv ? en && en.name : en && en.title);
      add(isTv ? tr && tr.name : tr && tr.title);
      var sources = [en, tr];
      for (var s = 0; s < sources.length; s++) {
        var list = sources[s] && sources[s].alternative_titles && sources[s].alternative_titles.results;
        if (!list) continue;
        for (var j = 0; j < list.length && titles.length < 24; j++) add(list[j].title);
      }

      var rawDate = isTv ? d.first_air_date : d.release_date;
      return {
        titles: titles,
        year: String(rawDate || "").slice(0, 4),
        originalLanguage: d.original_language || ""
      };
    });
  }

  // -------------------------------------------------------------- arama + eslesme

  function searchSite(base, query) {
    var url = base + "/?s=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, "Referer": base + "/", "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8" })
      .then(function (html) {
        if (!html || isBlocked(html) || html.indexOf("result-item") === -1) return [];
        var chunks = html.split(/<div class="result-item"/i);
        var out = [], seen = {};
        for (var i = 1; i < chunks.length; i++) {
          var c = chunks[i];
          if (c.length > 12000) c = c.slice(0, 12000);
          var urlMatch = c.match(/href="(https?:\/\/[^"]+\/(?:film|dizi)\/[^"?#]+)"/i);
          var title = stripTags((c.match(/<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || "");
          var year = (c.match(/<span class="year">\s*(\d{4})\s*<\/span>/i) || [])[1] || "";
          if (!urlMatch || !title) continue;
          var pageUrl = urlMatch[1].replace(/\/+$/, "") + "/";
          var m = pageUrl.match(/\/(film|dizi)\/([^\/]+)\/$/i);
          if (!m || seen[pageUrl]) continue;
          seen[pageUrl] = 1;
          out.push({
            url: pageUrl,
            type: m[1].toLowerCase(),
            slug: m[2],
            title: title,
            year: year
          });
        }
        return out;
      });
  }

  function scoreCandidate(c, info, isTv) {
    // Tur / turu katı ayirim (karisik sonuc donmesin).
    if (isTv ? c.type !== "dizi" : c.type !== "film") return -1000;

    var ct = tokens(c.title + " " + c.slug.replace(/-/g, " "));
    var joinedC = " " + ct.join(" ") + " ";
    var best = 0;

    for (var i = 0; i < info.titles.length; i++) {
      var tt = tokens(info.titles[i]);
      if (!tt.length) continue;
      var joinedT = " " + tt.join(" ") + " ";
      var s = 0;
      if (joinedC.indexOf(joinedT) !== -1) s = 100;
      else if (ct.length >= 2 && joinedT.indexOf(joinedC) !== -1) s = 85;
      else {
        var hit = 0;
        for (var j = 0; j < tt.length; j++) {
          if (tt[j].length >= 2 && joinedC.indexOf(" " + tt[j] + " ") !== -1) hit++;
        }
        if (hit === tt.length) s = 80;
        else if (hit > 0) s = Math.round(60 * hit / tt.length);
      }
      if (s > best) best = s;
    }

    // Yil, ayni adli yapimlari ayiran en onemli sinyal.
    if (info.year && c.year) {
      var diff = Math.abs(parseInt(c.year, 10) - parseInt(info.year, 10));
      if (diff === 0) best += 25;
      else if (diff === 1) best += 8;
      else best -= 100;
    }
    return best;
  }

  function findBestMatch(results, info, isTv) {
    var best = null, bestScore = 55; // esik altindaki eslesmeleri reddet
    for (var i = 0; i < (results || []).length; i++) {
      var sc = scoreCandidate(results[i], info, isTv);
      if (sc > bestScore) { bestScore = sc; best = results[i]; }
    }
    return best;
  }

  function searchAndMatch(base, info, isTv) {
    var queries = [];
    function addQ(t) {
      var clean = stripMarks(t);
      if (normTitle(clean) && indexOfValue(queries, clean) === -1 && queries.length < 3) queries.push(clean);
    }
    for (var i = 0; i < info.titles.length && queries.length < 3; i++) addQ(info.titles[i]);

    var idx = 0;
    function next() {
      if (idx >= queries.length) return Promise.resolve(null);
      var q = queries[idx++];
      return searchSite(base, q).then(function (results) {
        var match = findBestMatch(results, info, isTv);
        if (match) return { match: match, query: q };
        return next();
      });
    }
    return next();
  }

  // -------------------------------------------------------------- bolum bulma

  function findEpisodeUrl(html, base, slug, season, episode) {
    var links = [];
    var re = /href="(https?:\/\/[^"]+\/bolum\/[^"]+)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) links.push(decodeEntities(m[1]));
    links = unique(links);
    for (var i = 0; i < links.length; i++) {
      var mm = links[i].match(/(\d+)-sezon-(\d+)-bolum/i);
      if (mm && parseInt(mm[1], 10) === season && parseInt(mm[2], 10) === episode) {
        return links[i].replace(/\/+$/, "") + "/";
      }
    }
    // Yedek: slug'dan bolum URL'si uret (site listesi eksikse).
    var cleanSlug = slug.replace(/-izle(?:-\d+)?$/i, "");
    return base + "/bolum/" + cleanSlug + "-" + season + "-sezon-" + episode + "-bolum/";
  }

  // -------------------------------------------------------------- altyazi

  function langCode(s) {
    s = String(s || "").toLowerCase();
    if (s === "tr" || /^tur/.test(s) || /t.rk/.test(s)) return "tr";
    if (s === "en" || /^eng/.test(s) || /ingiliz/.test(s)) return "en";
    return s || "und";
  }

  function parseSubtitles(fhtml) {
    var tracks = [];
    try {
      var raw = (fhtml.match(/tracks:\s*(\[[^\]]*\])/i) || [])[1];
      if (raw) tracks = JSON.parse(raw);
    } catch (e) { tracks = []; }

    var out = [], seen = {};
    function push(url, language, name) {
      if (!url || seen[url]) return;
      if (/thumb|preview|onizleme/i.test(url)) return;
      if (/\.vtt($|\?)/i.test(url) === false) return;
      seen[url] = 1;
      out.push({
        url: url,
        language: language,
        lang: language,
        name: name,
        label: name
      });
    }

    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i] || {};
      if (t.kind === "thumbnails" || !t.file) continue;
      var lang = langCode(t.lang || t.language || "");
      push(t.file, lang, t.label || (lang === "tr" ? "Türkçe" : (lang === "en" ? "English" : lang)));
    }

    if (!out.length) {
      var urls = unique(fhtml.match(/https?:\/\/[^"'\s]+\.vtt/g) || []);
      for (var j = 0; j < urls.length; j++) {
        var u = urls[j];
        if (/thumb|preview/i.test(u)) continue;
        var lg = /tur(?:-forced)?\.vtt/i.test(u) ? "tr" : (/eng\.vtt/i.test(u) ? "en" : "und");
        push(u, lg, lg === "tr" ? "Türkçe" : (lg === "en" ? "English" : lg));
      }
    }
    return out;
  }

  // -------------------------------------------------------------- stream cozme

  function resolveStream(base, pageUrl) {
    return fetchText(pageUrl, { "User-Agent": UA, "Referer": base + "/" }).then(function (html) {
      if (!html || isBlocked(html)) return null;

      var ajaxurl = (html.match(/window\.videoAjax\s*=\s*\{[\s\S]*?ajaxurl:\s*'([^']+)'/i) || [])[1];
      var nonce = (html.match(/window\.videoAjax\s*=\s*\{[\s\S]*?nonce:\s*'([^']+)'/i) || [])[1];
      var postId = (html.match(/data-post-id="(\d+)"/i) || [])[1];
      var playerName = (html.match(/data-player-name="([^"]+)"/i) || [])[1] || "";
      if (!nonce || !postId) return null;
      ajaxurl = ajaxurl ? ajaxurl.replace(/\\\//g, "/") : (base + "/wp-admin/admin-ajax.php");

      var body = formEncode({
        action: "get_video_url",
        nonce: nonce,
        post_id: postId,
        player_name: playerName,
        part_key: ""
      });

      return fetchRaw(ajaxurl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Referer": pageUrl,
          "Origin": base,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: body
      }).then(function (res) {
        if (!res || !res.ok) return null;
        return res.text();
      }).catch(function () { return null; }).then(function (txt) {
        if (!txt) return null;
        var aj;
        try { aj = JSON.parse(txt); } catch (e) { return null; }
        if (!aj || !aj.success || !aj.data || !aj.data.url) return null;

        var setplayUrl = String(aj.data.url).replace(/\\\//g, "/");
        return fetchText(setplayUrl, { "User-Agent": UA, "Referer": pageUrl }).then(function (shtml) {
          if (!shtml) return null;
          var cer = shtml.match(/SPG\.cerceve\("([^"]+)","([^"]+)","([^"]+)"\)/);
          if (!cer) return null;
          var fastplayUrl = decodeXor(cer[2].replace(/\\\//g, "/"), cer[3])[0];
          if (!fastplayUrl || !/^https?:\/\//i.test(fastplayUrl)) return null;

          return fetchText(fastplayUrl, { "User-Agent": UA, "Referer": "https://setplay.sbs/" })
            .then(function (fhtml) {
              if (!fhtml) return null;
              var spgA = null;
              try { spgA = JSON.parse((fhtml.match(/window\.SPG_A\s*=\s*(\{[^}]+\})/i) || [])[1]); } catch (e) {}
              var streamPath = (fhtml.match(/stream:\s*"([^"]+)"/i) || [])[1];
              if (!streamPath) return null;

              var sp = (spgA && spgA.sp) || "";
              var spT = (spgA && spgA.spT) || 0;
              var r = Math.floor(2176782336 * Math.random()).toString(36);
              var proof = spT + "." + r + "." + hashFn(sp + "|" + spT + "|" + r);

              return {
                url: resolveUrl(fastplayUrl, streamPath),
                fastplayUrl: fastplayUrl,
                proof: proof,
                subtitles: parseSubtitles(fhtml)
              };
            });
        });
      });
    }).catch(function () { return null; });
  }

  // -------------------------------------------------------------- base fallbacks

  function tryOneBase(base, info, isTv, season, episode) {
    return searchAndMatch(base, info, isTv).then(function (found) {
      if (!found) return null;
      return fetchText(found.match.url, { "User-Agent": UA, "Referer": base + "/" }).then(function (html) {
        if (!html || isBlocked(html)) return null;
        var pageUrl = found.match.url;
        if (isTv) pageUrl = findEpisodeUrl(html, base, found.match.slug, season, episode);
        return resolveStream(base, pageUrl).then(function (resolved) {
          if (!resolved) return null;
          return { base: base, match: found.match, pageUrl: pageUrl, resolved: resolved };
        });
      });
    }).catch(function () { return null; });
  }

  function tryBases(info, isTv, season, episode) {
    var i = 0;
    function next() {
      if (i >= BASES.length) return Promise.resolve(null);
      var base = BASES[i++];
      return tryOneBase(base, info, isTv, season, episode).then(function (ctx) {
        if (ctx) return ctx;
        return next();
      });
    }
    return next();
  }

  // -------------------------------------------------------------- getStreams

  function buildStream(ctx, info, isTv, season, episode) {
    var display = (info.titles[0] || "") + (info.year ? " (" + info.year + ")" : "");
    if (isTv) display += " S" + season + "E" + episode;

    return {
      name: "HDFilmCehennemi",
      title: display,
      url: ctx.resolved.url,
      quality: "Auto",
      isM3u8: true,
      provider: "hdfilmcehennemi",
      type: "hls",
      language: "tr",
      subtitles: ctx.resolved.subtitles || [],
      headers: {
        "User-Agent": UA,
        "Referer": ctx.resolved.fastplayUrl,
        "X-Sp": ctx.resolved.proof
      },
      behaviorHints: { bingeGroup: "hdfilmcehennemi-" + ctx.match.slug }
    };
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10); if (isNaN(s)) s = 1;
    var e = parseInt(episode, 10); if (isNaN(e)) e = 1;
    var apiKey = getTmdbKey(settings);
    if (!apiKey) {
      console.log(TAG + " TMDB API key eksik");
      return Promise.resolve([]);
    }

    return fetchTmdbInfo(apiKey, tmdbId, isTv).then(function (info) {
      if (!info || !info.titles.length) {
        console.log(TAG + " TMDB bilgisi alinamadi");
        return [];
      }
      console.log(TAG + " Araniyor: " + info.titles[0] + (info.year ? " (" + info.year + ")" : ""));

      return tryBases(info, isTv, s, e).then(function (ctx) {
        if (!ctx) {
          console.log(TAG + " Uygun sayfa veya kaynak bulunamadi");
          return [];
        }
        console.log(TAG + " Sayfa: " + ctx.pageUrl + " | altyazi: " + ctx.resolved.subtitles.length);
        return [buildStream(ctx, info, isTv, s, e)];
      });
    }).catch(function (err) {
      console.log(TAG + " Hata: " + (err && err.message));
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
