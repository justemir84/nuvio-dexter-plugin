/**
 * dizibal - DiziBal (dizibal.org) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi (tr/en) -> site aramasi (/ara?q=) veya dogrudan slug
 *   -> /movie/{slug} veya /series/{slug}/season/{s}/episode/{e}
 *   -> data-pv slug -> pilavyer player (core.js) -> s.php?s=slug
 *   -> window.__PLAYER__.stream -> HLS master/media playlist
 *
 * Notlar:
 * - Sayfalarda kaynak yoksa data-player-type="none" olur; bu durumda bos liste doner.
 * - Oynatma adresi tokenlidir (birkac gun gecerli), AES-128 HLS'tir; token playlist
 *   icindeki segment/key adreslerine gomuludur.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://dizibal.org";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;
  var PROBE_TIMEOUT = 4000;

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

  function cleanText(html) {    return String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
      for (var i = 0; i < altList.length && altTitles.length < 4; i++) {
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

  // ------------------------------------------------------------- page fetch

  function tryPage(kind, slug) {
    var url = BASE + "/" + kind + "/" + slug;
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      return html ? { kind: kind, slug: slug, url: url, html: html } : null;
    });
  }

  function searchSite(query) {
    var url = BASE + "/ara?q=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      if (!html) return [];
      var re = /<a href="https:\/\/dizibal\.org\/(movie|series)\/([^"\/]+)"[^>]*class="[^"]*group block[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([^<]*)<\/p>/g;
      var out = [], m;
      while ((m = re.exec(html)) !== null) {
        out.push({
          kind: m[1],
          slug: m[2],
          title: decodeEntities(cleanText(m[3])),
          year: cleanText(m[4]).slice(0, 4)
        });
      }
      return out;
    });
  }

  function score(item, titles, year, isTv) {
    if ((item.kind === "series") !== !!isTv) return -1;
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
        for (var w = 0; w < words.length; w++) {
          if (itemTitle.indexOf(words[w]) === -1) { all = false; break; }
        }
        if (all) s = 4;
      }
      if (s > best) best = s;
    }
    if (!best) return -1;
    if (year && item.year) best += item.year === year ? 6 : -5;
    return best;
  }

  function pickBest(items, titles, year, isTv) {
    var best = null, bestScore = 0;
    for (var i = 0; i < (items || []).length; i++) {
      var s = score(items[i], titles, year, isTv);
      if (s > bestScore) { bestScore = s; best = items[i]; }
    }
    return best;
  }

  // ----------------------------------------------------------- find target

  function findTarget(titles, year, isTv) {
    var kind = isTv ? "series" : "movie";
    var candidates = [];
    for (var i = 0; i < titles.length && i < 3; i++) {
      var slug = slugify(titles[i]);
      if (slug && candidates.indexOf(slug) === -1) candidates.push(slug);
    }

    function trySlug(idx) {
      if (idx >= candidates.length) return Promise.resolve(null);
      return tryPage(kind, candidates[idx]).then(function (page) {
        return page || trySlug(idx + 1);
      });
    }

    return trySlug(0).then(function (page) {
      if (page) return page;
      // dogrudan slug tutmadi -> site aramasi
      function trySearch(idx, found) {
        if (idx >= titles.length || idx >= 2) {
          var best = pickBest(found, titles, year, isTv);
          return best ? tryPage(kind, best.slug) : null;
        }
        return searchSite(titles[idx]).then(function (res) {
          return trySearch(idx + 1, found.concat(res || []));
        });
      }
      return trySearch(0, []);
    });
  }

  // -------------------------------------------------------------- resolve

  function episodePageUrl(slug, season, episode) {
    return {
      kind: "series",
      url: BASE + "/series/" + slug + "/season/" + season + "/episode/" + episode,
      slug: slug
    };
  }

  function findEpisodeOnSeriesPage(slug, season, episode) {
    return fetchText(BASE + "/series/" + slug, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      if (!html) return null;
      var needle = "/series/" + slug + "/season/" + season + "/episode/" + episode;
      return html.indexOf(needle) !== -1 ? episodePageUrl(slug, season, episode) : null;
    });
  }

  function extractPlayer(html) {
    var box = html.match(/data-player-type="([^"]*)"[\s\S]{0,6000}?data-pv="([^"]+)"/i);
    if (box) {
      if (box[1] === "none") return null;
      return { pv: box[2] };
    }
    if (/data-player-type="none"/i.test(html)) return null;
    var any = html.match(/data-pv="([^"]+)"/);
    return any ? { pv: any[1] } : null;
  }

  function playerBase(html) {
    var m = html.match(/<script[^>]+src="(https:\/\/[^"]+)\/assets\/js\/core\.js[^"]*"/i);
    return m ? m[1] : "https://pilavyerplay.top";
  }

  // ---- CDN erisim testi ------------------------------------------------
  // Site, bazi ISS'lerin pilavyer1-6.top CDN alan adlarini engelledigini
  // varsayar ve engel durumunda stream.php'ye "cdn=0" ekleyerek segmentleri
  // origin sunucusundan servis eder. Nuvio'nun oynaticisi bu geri donusu
  // kendisi yapamadigi icin testi burada yapip dogru URL'yi secmek gerekir.

  function resolveUrl(base, rel) {
    rel = String(rel || "");
    if (/^https?:\/\//i.test(rel)) return rel;
    var schemeIdx = base.indexOf("://");
    var hostStart = schemeIdx === -1 ? 0 : schemeIdx + 3;
    var pathStart = base.indexOf("/", hostStart);
    if (pathStart === -1) return base + "/" + rel;
    if (rel.charAt(0) === "/") return base.slice(0, pathStart) + rel;
    var clean = base.split("#")[0].split("?")[0];
    return clean.slice(0, clean.lastIndexOf("/") + 1) + rel;
  }

  function probeUrl(url, headers, method) {
    if (!url) return Promise.resolve(true);
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("probe timeout")); }, PROBE_TIMEOUT);
    });
    var opts = { method: method || "HEAD", headers: headers || { "User-Agent": UA } };
    return Promise.race([fetch(url, opts), timeout])
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res) return false;
        // 405: HEAD desteklenmiyor ama host ayakta.
        return !!res.ok || res.status === 405;
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        return false;
      });
  }

  function quickText(url, headers) {
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("probe timeout")); }, PROBE_TIMEOUT);
    });
    return Promise.race([fetch(url, { headers: headers }), timeout])
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

  function firstSegmentUrl(playlist, playlistUrl, headers) {
    var lines = String(playlist || "").split(/\r?\n/);
    var variantUri = null, mediaUri = null, afterVariant = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) { afterVariant = true; continue; }
      if (line.charAt(0) === "#") { afterVariant = false; continue; }
      if (afterVariant && !variantUri) { variantUri = line; break; }
      if (!mediaUri) mediaUri = line;
    }

    if (variantUri) {
      var variantUrl = resolveUrl(playlistUrl, variantUri);
      return quickText(variantUrl, headers).then(function (txt) {
        if (!txt) return null;
        var vlines = txt.split(/\r?\n/);
        for (var j = 0; j < vlines.length; j++) {
          var l = vlines[j].trim();
          if (l && l.charAt(0) !== "#") return resolveUrl(variantUrl, l);
        }
        return null;
      });
    }
    return Promise.resolve(mediaUri ? resolveUrl(playlistUrl, mediaUri) : null);
  }

  function cdnReachable(cfg, master, base) {
    var headers = { "User-Agent": UA, Referer: base + "/", Origin: base };
    var checks = [];
    if (cfg.cdnProbe) checks.push(probeUrl(cfg.cdnProbe, headers, "GET"));
    checks.push(
      firstSegmentUrl(master, cfg.stream, headers).then(function (seg) {
        return seg ? probeUrl(seg, { "User-Agent": UA, Referer: base + "/" }, "HEAD") : true;
      })
    );
    return Promise.all(checks).then(function (results) {
      for (var i = 0; i < results.length; i++) {
        if (!results[i]) return false;
      }
      return true;
    });
  }

  function addParam(url, param) {
    return url + (url.indexOf("?") === -1 ? "?" : "&") + param;
  }

  function resolvePlayer(pageHtml) {
    var player = extractPlayer(pageHtml);
    if (!player) return Promise.resolve(null);

    var base = playerBase(pageHtml);
    var sUrl = base + "/assets/js/s.php?s=" + encodeURIComponent(player.pv);
    return fetchText(sUrl, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
      if (!html) return null;
      var m = html.match(/window\.__PLAYER__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/);
      if (!m) return null;
      var cfg;
      try { cfg = JSON.parse(m[1]); } catch (e) { return null; }
      if (!cfg || !cfg.stream) return null;

      return fetchText(cfg.stream, {
        "User-Agent": UA,
        Referer: base + "/",
        Origin: base
      }).then(function (master) {
        master = master || "";
        return cdnReachable(cfg, master, base).then(function (cdnOk) {
          // CDN engelliyse segmentleri origin sunucusundan al.
          var url = cdnOk ? cfg.stream : addParam(cfg.stream, "cdn=0&r=probe");
          console.log("[dizibal] CDN erisimi: " + (cdnOk ? "OK" : "engelli -> cdn=0"));
          return { cfg: cfg, base: base, master: master, url: url, cdnOk: cdnOk };
        });
      });
    });
  }

  function qualityFromMaster(master) {
    var best = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g;
    var m;
    while ((m = re.exec(String(master || ""))) !== null) {
      var side = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
      if (side > best) best = side;
    }
    if (!best) return "Auto";
    if (best >= 2000) return "4K";
    if (best >= 1000) return "1080p";
    if (best >= 700) return "720p";
    if (best >= 450) return "480p";
    return "360p";
  }

  function buildSubtitles(cfg, base) {
    var out = [], seen = {};
    var list = (cfg && cfg.subs) || [];
    var headers = { "User-Agent": UA, Referer: base + "/", Origin: base };
    for (var i = 0; i < list.length; i++) {
      var sub = list[i];
      if (!sub || !sub.src) continue;
      var label = sub.label || sub.lang || "und";
      var key = String(label).toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      // Nuvio "language" bekler; eski istemciler icin "lang" da yazilir.
      out.push({ url: sub.src, language: label, name: label, lang: label, headers: headers });
    }
    return out;
  }

  function audioLabel(cfg) {
    var audios = (cfg && cfg.audios) || [];
    return audios.length && audios[0].label ? audios[0].label : "";
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[dizibal]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }

      var display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (isTv) display += " S" + s + "E" + e;

      var titles = [info.title, info.original].concat(info.alternatives || []);
      titles = titles.filter(function (t, i) { return t && titles.indexOf(t) === i; });

      console.log(tag + " Araniyor: " + titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));

      return findTarget(titles, info.year, isTv).then(function (target) {
        if (!target) {
          console.log(tag + " Sayfa bulunamadi");
          return [];
        }
        console.log(tag + " Sayfa: " + target.url);

        var pagePromise;
        if (isTv) {
          pagePromise = fetchText(
            BASE + "/series/" + target.slug + "/season/" + s + "/episode/" + e,
            { "User-Agent": UA, Referer: BASE + "/" }
          ).then(function (html) {
            if (html) return html;
            return findEpisodeOnSeriesPage(target.slug, s, e).then(function (alt) {
              return alt
                ? fetchText(alt.url, { "User-Agent": UA, Referer: BASE + "/" })
                : null;
            });
          });
        } else {
          pagePromise = Promise.resolve(target.html).then(function (html) {
            if (extractPlayer(html)) return html;
            return fetchText(target.url + "/izle", { "User-Agent": UA, Referer: BASE + "/" });
          });
        }

        return pagePromise.then(function (html) {
          if (!html) {
            console.log(tag + " Sayfa icerigi alinamadi (bolum yok?)");
            return [];
          }
          return resolvePlayer(html).then(function (resolved) {
            if (!resolved) {
              console.log(tag + " Oynatilabilir kaynak yok");
              return [];
            }

            var cfg = resolved.cfg;
            var quality = qualityFromMaster(resolved.master);
            var subs = buildSubtitles(cfg, resolved.base);
            var audio = audioLabel(cfg);
            var extras = [];
            if (subs.length) extras.push(subs.length + " altyazi");
            if (audio) extras.push(audio);

            var headers = {
              "User-Agent": UA,
              "Referer": resolved.base + "/",
              "Origin": resolved.base
            };
            var titleBase = display + " | " + quality + " [HLS]" + (extras.length ? " | " + extras.join(", ") : "");

            function makeStream(url, isOrigin) {
              return {
                name: "DiziBal" + (isOrigin ? " (Sunucu)" : "") + " - " + quality,
                title: titleBase + (isOrigin ? " | Sunucu" : ""),
                url: url,
                quality: quality,
                isM3u8: true,
                type: "hls",
                language: "tr",
                provider: "dizibal",
                headers: headers,
                subtitles: subs
              };
            }

            var out = [makeStream(resolved.url, !resolved.cdnOk)];
            // CDN secildiyse takilma ihtimaline karsi origin alternatifini de sun.
            if (resolved.cdnOk) out.push(makeStream(addParam(cfg.stream, "cdn=0&r=alt"), true));

            console.log(tag + " Kaynak bulundu: " + quality + " (" + subs.length + " altyazi)");
            return out;
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
