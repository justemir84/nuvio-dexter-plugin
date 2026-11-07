/**
 * justflix - Diziyou (diziyou.one) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi -> dogrudan slug veya /?s= aramasi
 *   -> /{base}-{s}-sezon-{e}-bolum/ (seri sayfasindaki baglantidan)
 *   -> /player/{id}_tr.html (Dublaj), /player/{id}.html (TR Altyazili),
 *      /player/{id}_enSub.html (EN Altyazili) -> storage.diziyou.one .../play.m3u8
 *   -> master playlist (HLS m3u8) + <track> altyazilari
 *
 * Notlar:
 * - Site yalnizca dizi icerir (film yok); yalnizca tv desteklenir.
 * - Cookie/proxy gerektirmez; tum akis Node/fetch ile dogrudan calisir.
 * - Dublaj ayri dosyadir (10551_tr), altyazili ayri (10551); ikisi de doner, dublaj once gelir.
 * - Hermes uyumlu: yalnizca Promise zinciri, dis bagimlilik yok.
 */
(function () {
  "use strict";

  var BASE = "https://www.diziyou.one";
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
    return Promise.race([fetch(url, { headers: headers || { "User-Agent": UA, Referer: BASE + "/" } }), timeout])
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
    "ı":"i","İ":"i","ş":"s","Ş":"s","ğ":"g","Ğ":"g","ü":"u","Ü":"u","ö":"o","Ö":"o","ç":"c","Ç":"c",
    "â":"a","Â":"a","î":"i","Î":"i","û":"u","Û":"u","é":"e","è":"e","ê":"e","á":"a","à":"a","ä":"a",
    "å":"a","ñ":"n","ø":"o","æ":"ae","ß":"ss","'":"","’":"","&":" ve "
  };

  function slugify(title) {
    var src = String(title || ""), ascii = "";
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
      var d; try { d = JSON.parse(txt); } catch (e) { return null; }
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
      // Arama sonuclari: <div id="list-series"> icindeki baslik baglantilari
      var re = /<div id="list-series">[\s\S]*?id="categorytitle">\s*<a href="https:\/\/www\.diziyou\.one\/([a-z0-9\-]+)\/">([\s\S]*?)<\/a>/g;
      var m;
      while ((m = re.exec(html)) !== null) {
        if (!seen[m[1]]) {
          seen[m[1]] = true;
          out.push({ slug: m[1], title: decodeEntities(cleanText(m[2])), year: "" });
        }
      }
      return out;
    });
  }

  function score(item, titles) {
    var itemTitle = norm(item.title), best = 0;
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

  function findTarget(titles) {
    var candidates = [];
    for (var i = 0; i < titles.length && i < 3; i++) {
      var slug = slugify(titles[i]);
      if (slug && candidates.indexOf(slug) === -1) candidates.push(slug);
    }
    // Diziyou cogunlukla sonuna 2 numarasini ekler (orn. breaking-bad2)
    var extended = [];
    for (var c = 0; c < candidates.length; c++) {
      extended.push(candidates[c]);
      extended.push(candidates[c] + "2");
      extended.push(candidates[c] + "3");
    }
    function trySlug(idx) {
      if (idx >= extended.length) return Promise.resolve(null);
      return tryPage(extended[idx]).then(function (page) { return page || trySlug(idx + 1); });
    }
    return trySlug(0).then(function (page) {
      if (page) return page;
      function trySearch(idx, found) {
        if (idx >= titles.length || idx >= 2) {
          var best = pickBest(found, titles);
          return best ? tryPage(best.slug) : null;
        }
        return searchSite(titles[idx]).then(function (res) { return trySearch(idx + 1, found.concat(res || [])); });
      }
      return trySearch(0, []);
    });
  }

  function findEpisodePath(seriesHtml, season, episode) {
    var re = /href="https:\/\/www\.diziyou\.one\/([a-z0-9\-]+)-(\d+)-sezon-(\d+)-bolum\/"/g;
    var m;
    while ((m = re.exec(String(seriesHtml))) !== null) {
      if (parseInt(m[2], 10) === season && parseInt(m[3], 10) === episode) return m[1] + "-" + m[2] + "-sezon-" + m[3] + "-bolum";
    }
    return null;
  }

  function qualityFromMaster(master) {
    var best = 0, re = /RESOLUTION=(\d+)x(\d+)/g, mm;
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

  function resolvePlayer(playerUrl, epUrl, label, display, tag) {
    return fetchText(playerUrl, { "User-Agent": UA, Referer: epUrl }).then(function (playerHtml) {
      if (!playerHtml) return null;
      var src = playerHtml.match(/<source[^>]+src="(https:\/\/storage\.diziyou\.one\/[^"]+\.m3u8)"/i);
      if (!src) return null;
      var master = src[1];
      var subs = [];
      var trackRe = /<track[^>]+src="([^"]+)"[^>]*label="([^"]*)"/gi, tm;
      while ((tm = trackRe.exec(playerHtml)) !== null) {
        subs.push({ url: tm[1], language: tm[2], name: tm[2], lang: tm[2], headers: { "User-Agent": UA, Referer: playerUrl } });
      }
      return fetchText(master, { "User-Agent": UA, Referer: playerUrl, Accept: "*/*" }).then(function (pl) {
        if (!pl || pl.indexOf("#EXTM3U") === -1) return null;
        var quality = qualityFromMaster(pl);
        var headers = { "User-Agent": UA, Referer: playerUrl };
        return {
          name: "JustFlix " + label + " - " + quality,
          title: display + " | " + quality + " [HLS] | " + label + (subs.length ? " | " + subs.length + " altyazi" : ""),
          url: master,
          quality: quality,
          isM3u8: true,
          type: "hls",
          language: "tr",
          provider: "justflix",
          headers: headers,
          subtitles: subs
        };
      });
    });
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[justflix]";
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
      return findTarget(titles).then(function (target) {
        if (!target) { console.log(tag + " Sayfa bulunamadi"); return []; }
        console.log(tag + " Sayfa: " + target.url);
        var epPath = findEpisodePath(target.html, s, e);
        if (!epPath) { console.log(tag + " Bolum baglantisi bulunamadi"); return []; }
        var epUrl = BASE + "/" + epPath + "/";
        return fetchText(epUrl, { "User-Agent": UA, Referer: target.url }).then(function (epHtml) {
          if (!epHtml) { console.log(tag + " Bolum sayfasi alinamadi: " + epUrl); return []; }
          var iframe = epHtml.match(/<iframe[^>]+src="(https:\/\/www\.diziyou\.one\/player\/[^"]+)"/i);
          if (!iframe) { console.log(tag + " Player iframe bulunamadi"); return []; }
          var basePlayer = iframe[1].split("?")[0];
          var baseNoExt = basePlayer.replace(/\.html$/, "");
          var variants = [
            { url: baseNoExt + "_tr.html", label: "TR Dublaj" },
            { url: baseNoExt + ".html", label: "TR Altyazili" },
            { url: baseNoExt + "_enSub.html", label: "EN Altyazili" }
          ];
          var promises = variants.map(function (v) { return resolvePlayer(v.url, epUrl, v.label, display, tag); });
          return Promise.all(promises).then(function (results) {
            var out = [], seen = {};
            results.forEach(function (r) {
              if (!r) return;
              var key = r.url;
              if (seen[key]) return;
              seen[key] = true;
              out.push(r);
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
