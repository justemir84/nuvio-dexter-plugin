/**
 * justanime - Anizume (anizume.com) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> /api/search?q=  (tv: animes | movie: films)
 *   -> tv:    /anime/{slug}/sezon-{s}/bolum-{e}
 *     movie: /film/{slug}
 *   -> <script type="application/json" id="anime-sources"> -> SourceUrl
 *   -> video.anizume.com master.m3u8 -> kalite (RESOLUTION) + altyazi (tek VTT)
 *
 * Notlar:
 * - Arama API'si substring tabanli ve noktalama hassas; anime basliklari
 *   TMDB'de Japonca anahtar/alternatif olarak gelebilir. Bu yuzden tum aday
 *   basliklar sirayla denenir (tam arama, slug ile dogrudan sayfa, onecek).
 * - master playlist 480p-2160p arasi varyantlar icerir; en yuksek cozunurluk
 *   kalite etiketi olarak kullanilir. Site kendi oynaticisinda 2K/4K secimini
 *   misafirlere kilitler ama HLS dosyalari herkese aciktir; bu yuzden hesap
 *   girmeden 4K calinabilir.
 * - Altyazilar HLS icinde tek bir VTT dosyasidir; altyazi playlisti cozulur.
 * - Var olmayan bolum/film sayfasi 404 doner; bos liste ile geri donulur.
 * - video.anizume.com kaynaklarina Referer/Origin gerekir.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://www.anizume.com";
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

  function searchSite(query) {
    var url = BASE + "/api/search?q=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/", Accept: "application/json" })
      .then(function (txt) {
        if (!txt) return null;
        var d;
        try { d = JSON.parse(txt); } catch (e) { return null; }
        return d || null;
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
    var itemTitles = [item.title, item.subtitle].filter(Boolean);
    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var t = norm(titles[i]);
      if (!t) continue;
      for (var j = 0; j < itemTitles.length; j++) {
        var s = matchScore(norm(itemTitles[j]), t);
        if (s > best) best = s;
      }
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

  function slugFromUrl(url) {
    var m = String(url || "").match(/^\/(?:anime|film)\/([^\/?#]+)/);
    return m ? m[1] : "";
  }

  function targetFromItem(item, isTv) {
    var slug = slugFromUrl(item.url);
    if (!slug) return null;
    return { slug: slug, kind: isTv ? "anime" : "film", title: item.title };
  }

  // Arama API'si substring tabanli ve noktalama hassas; anime basliklari
  // ozellikle TMDB'de Japonca anahtar ve alternatiflerde yer alabilir.
  // Bu yuzden tum aday basliklari sirayla deniyoruz: tam arama, slug ile
  // dogrudan sayfa, en son kisa oneceler.
  var NON_LATIN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function prefixQueries(title) {
    var words = String(title || "").split(/\s+/).filter(Boolean);
    var out = [];
    if (words.length > 2) out.push(words.slice(0, 3).join(" "));
    if (words.length > 1) out.push(words.slice(0, 2).join(" "));
    return out;
  }

  function findTarget(titles, isTv) {
    var latin = [], other = [];
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!t) continue;
      if (NON_LATIN_RE.test(t)) other.push(t); else latin.push(t);
    }
    var ordered = latin.concat(other).slice(0, 6);

    function pick(data) {
      var list = data && (isTv ? data.animes : data.films);
      return pickBest(list, titles);
    }

    function slugTarget(title) {
      var slug = slugify(title);
      return slug ? { slug: slug, url: BASE + (isTv ? "/anime/" : "/film/") + slug } : null;
    }

    function searchAll(idx, best) {
      if (idx >= ordered.length) {
        if (best && score(best, titles) >= 7) return Promise.resolve(targetFromItem(best, isTv));
        return slugAll(0, null).then(function (found) {
          if (found) return found;
          if (best) return targetFromItem(best, isTv);
          return prefixAll(0, 0, null);
        });
      }
      return searchSite(ordered[idx]).then(function (data) {
        var item = pick(data);
        if (item) {
          var s = score(item, titles);
          if (!best || s > score(best, titles)) best = item;
          if (s >= 7) return targetFromItem(best, isTv);
        }
        return searchAll(idx + 1, best);
      });
    }

    function slugAll(idx, found) {
      if (found) return Promise.resolve(found);
      if (idx >= ordered.length) return Promise.resolve(null);
      var target = slugTarget(ordered[idx]);
      if (!target) return slugAll(idx + 1, null);
      return fetchText(target.url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
        return slugAll(idx + 1, html ? { slug: target.slug, kind: isTv ? "anime" : "film", title: ordered[idx] } : null);
      });
    }

    function prefixAll(idx, pIdx, best) {
      if (idx >= ordered.length || idx >= 3) {
        return Promise.resolve(best ? targetFromItem(best, isTv) : null);
      }
      var prefixes = prefixQueries(ordered[idx]);
      if (pIdx >= prefixes.length) return prefixAll(idx + 1, 0, best);
      return searchSite(prefixes[pIdx]).then(function (data) {
        var item = pick(data);
        if (item) {
          var s = score(item, titles);
          if (!best || s > score(best, titles)) best = item;
        }
        return prefixAll(idx, pIdx + 1, best);
      });
    }

    return searchAll(0, null);
  }

  // --------------------------------------------------------------- sources

  function extractSources(html) {
    var m = String(html || "").match(/<script[^>]*id="anime-sources"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return [];
    var data;
    try { data = JSON.parse(m[1]); } catch (e) { return []; }
    if (!data || !data.length) return [];
    var out = [];
    for (var i = 0; i < data.length; i++) {
      var s = data[i];
      if (!s || !s.SourceUrl) continue;
      out.push({ url: s.SourceUrl, name: s.Name || ("Kaynak " + (i + 1)) });
    }
    return out;
  }

  function qualityFromMaster(master) {
    var best = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g;
    var m;
    while ((m = re.exec(String(master || ""))) !== null) {
      var side = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
      if (side > best) best = side;
    }
    if (!best) return "";
    if (best >= 2000) return "4K";
    if (best >= 1400) return "1440p";
    if (best >= 1000) return "1080p";
    if (best >= 700) return "720p";
    if (best >= 450) return "480p";
    return best + "p";
  }

  function parseSubtitleMedia(master) {
    var out = [];
    var lines = String(master || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("#EXT-X-MEDIA:") !== 0) continue;
      if (line.indexOf("TYPE=SUBTITLES") === -1) continue;
      var name = (line.match(/NAME="([^"]*)"/) || [])[1] || "";
      var lang = (line.match(/LANGUAGE="([^"]*)"/) || [])[1] || "";
      var uri = (line.match(/URI="([^"]*)"/) || [])[1] || "";
      if (uri) out.push({ name: name, lang: lang, uri: uri });
    }
    return out;
  }

  function resolveSubtitle(sub, masterUrl, headers) {
    var playlistUrl = resolveUrl(masterUrl, sub.uri);
    return fetchText(playlistUrl, headers).then(function (txt) {
      if (!txt) return null;
      var lines = txt.split(/\r?\n/);
      var vtt = null, segCount = 0;
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (!l || l.charAt(0) === "#") continue;
        segCount++;
        if (!vtt) vtt = l;
      }
      // Altyazilar tek VTT dosyasidir; segmentli playlist direkt kullanilamaz.
      if (segCount !== 1 || !vtt) return null;
      var label = sub.lang || sub.name || "und";
      return {
        url: resolveUrl(playlistUrl, vtt),
        language: label,
        name: sub.name || label,
        lang: label,
        headers: headers
      };
    });
  }

  function enrichSource(source, display, slug) {
    var headers = { "User-Agent": UA, Referer: BASE + "/", Origin: BASE };
    return fetchText(source.url, headers).then(function (master) {
      var quality = master ? qualityFromMaster(master) : "";
      var subs = master ? parseSubtitleMedia(master) : [];

      function resolveAll(idx, acc) {
        if (idx >= subs.length) return Promise.resolve(acc);
        return resolveSubtitle(subs[idx], source.url, headers).then(function (sub) {
          if (sub) acc.push(sub);
          return resolveAll(idx + 1, acc);
        });
      }

      return resolveAll(0, []).then(function (subtitles) {
        var extras = [];
        if (subtitles.length) extras.push(subtitles.length + " altyazi");
        var q = quality || "Auto";
        var title = display + " | " + q + " [HLS]" + (extras.length ? " | " + extras.join(", ") : "");
        return {
          name: "JustAnime - " + source.name + (quality ? " " + quality : ""),
          title: title,
          url: source.url,
          quality: quality || undefined,
          isM3u8: true,
          type: "hls",
          language: "tr",
          provider: "justanime",
          headers: headers,
          subtitles: subtitles,
          behaviorHints: { bingeGroup: "justanime-" + slug }
        };
      });
    });
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[justanime]";
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

        // Goruntulenen ad: site tarafindaki eslesen baslik (yoksa TMDB adi).
        var displayTitle = target.title || info.title;
        var display = displayTitle + (info.year ? " (" + info.year + ")" : "");
        if (isTv) display += " S" + s + "E" + e;
        console.log(tag + " Sayfa: " + BASE + "/" + target.kind + "/" + target.slug);

        var pageUrl = isTv
          ? BASE + "/anime/" + target.slug + "/sezon-" + s + "/bolum-" + e
          : BASE + "/film/" + target.slug;

        return fetchText(pageUrl, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
          if (!html) {
            console.log(tag + " Sayfa icerigi alinamadi (bolum yok?)");
            return [];
          }
          var sources = extractSources(html);
          if (!sources.length) {
            console.log(tag + " Oynatilabilir kaynak yok");
            return [];
          }

          var streams = [];
          function buildNext(idx) {
            if (idx >= sources.length) return Promise.resolve(streams);
            return enrichSource(sources[idx], display, target.slug).then(function (stream) {
              streams.push(stream);
              return buildNext(idx + 1);
            });
          }

          return buildNext(0).then(function (out) {
            console.log(tag + " Kaynak bulundu: " + out.length + " kaynak");
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
