/**
 * anihub - AniHub (anihub.com.tr) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> AniHub /v1/animes?q=  (series: series | movie: movie)
 *   -> /v1/animes/{slug}  (seasons + episodes)
 *   -> season slug secimi (season parametresi ile)
 *   -> episode id bul
 *   -> /v1/episodes/{id}/playback  (masterPlaylistUrl + subtitles)
 *   -> /v1/video-tokens  (token)
 *   -> master.m3u8?token=...  (HLS)
 *
 * Notlar:
 * - AniHub katalogu TMDB ile birebir degil; baslik eslestirme skor ile yapilir.
 * - Sezonlar bir series (group) altinda toplanir; season parametresi ile dogru sezon slug'i secilir.
 * - Altyazilar dogrudan media.anihub.com.tr uzerinden erisilebilir (token gerekmez).
 * - Master playlist ve segmentler token ile korunur; token ~24 saat gecerlidir.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var API = "https://api.anihub.com.tr/v1";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;
  var MEDIA_HEADERS = { "User-Agent": UA, Referer: "https://anihub.com.tr/", Origin: "https://anihub.com.tr" };

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

      // Ingilizce basligi da ekle (AniHub katalogu Ingilizce/Romaji basliklar kullanir)
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
    var url = API + "/animes?q=" + encodeURIComponent(query);
    return fetchJson(url, { "User-Agent": UA, Referer: "https://anihub.com.tr/", Accept: "application/json" })
      .then(function (d) {
        if (!d || !d.success || !d.data) return [];
        return d.data.items || [];
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

  function findAnime(titles, isTv) {
    var desiredType = isTv ? "series" : "movie";
    var best = null, bestScore = 0;
    var latin = [], other = [];
    var NON_LATIN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f\uac00-\ud7af]/;
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!t) continue;
      if (NON_LATIN_RE.test(t)) other.push(t); else latin.push(t);
    }
    var ordered = latin.concat(other).slice(0, 12);

    function searchAll(idx) {
      if (idx >= ordered.length) {
        if (best) return Promise.resolve(best);
        // prefix fallback for first title
        return prefixAll(0, null);
      }
      return searchSite(ordered[idx]).then(function (items) {
        var pool = items.filter(function (it) { return it.contentType === desiredType; });
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
        var pool = items.filter(function (it) { return it.contentType === desiredType; });
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

  function getAnimeDetail(slug) {
    var url = API + "/animes/" + encodeURIComponent(slug);
    return fetchJson(url, { "User-Agent": UA, Referer: "https://anihub.com.tr/", Accept: "application/json" })
      .then(function (d) {
        if (!d || !d.success || !d.data) return null;
        return d.data;
      });
  }

  function getPlayback(episodeId) {
    var url = API + "/episodes/" + encodeURIComponent(episodeId) + "/playback";
    return fetchJson(url, { "User-Agent": UA, Referer: "https://anihub.com.tr/", Accept: "application/json" })
      .then(function (d) {
        if (!d || !d.success || !d.data) return null;
        return d.data;
      });
  }

  function getVideoToken(masterPlaylistKey) {
    var url = API + "/video-tokens";
    return fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", Referer: "https://anihub.com.tr/", Origin: "https://anihub.com.tr" },
      body: JSON.stringify({ masterPlaylistKey: masterPlaylistKey })
    }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.text();
    }).then(function (txt) {
      if (!txt) return null;
      try {
        var d = JSON.parse(txt);
        if (d && d.success && d.data && d.data.token) return d.data.token;
      } catch (e) {}
      return null;
    }).catch(function () { return null; });
  }

  function pickSeasonSlug(detail, season) {
    var series = detail && detail.series;
    if (series && Array.isArray(series.seasons) && series.seasons.length) {
      // 1) label icindeki sezon numarasi (Film/OVA gibi numarasiz sezonlar atlanir)
      for (var i = 0; i < series.seasons.length; i++) {
        var m = String(series.seasons[i].label || "").match(/(\d+)/);
        if (m && parseInt(m[1], 10) === Number(season)) return series.seasons[i].slug;
      }
      // 2) order alani
      for (var i = 0; i < series.seasons.length; i++) {
        if (Number(series.seasons[i].order) === Number(season)) return series.seasons[i].slug;
      }
      // 3) numarasiz sezonlar dislanarak indeks
      var numbered = [];
      for (var i = 0; i < series.seasons.length; i++) {
        if (/(\d+)/.test(String(series.seasons[i].label || ""))) numbered.push(series.seasons[i]);
      }
      if (numbered.length >= Number(season)) return numbered[Number(season) - 1].slug;
      // 4) dogrudan indeks
      var idx = Number(season) - 1;
      if (idx >= 0 && idx < series.seasons.length) return series.seasons[idx].slug;
    }
    return detail && detail.anime ? detail.anime.slug : null;
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

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[anihub]";
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

      return findAnime(titles, isTv).then(function (animeItem) {
        if (!animeItem) {
          console.log(tag + " Anime bulunamadi");
          return [];
        }

        console.log(tag + " Anime: " + animeItem.title + " (" + animeItem.slug + ")");

        return getAnimeDetail(animeItem.slug).then(function (detail) {
          if (!detail || !detail.anime) {
            console.log(tag + " Anime detayi alinamadi");
            return [];
          }

          var seasonSlug = isTv ? pickSeasonSlug(detail, s) : detail.anime.slug;
          if (!seasonSlug) seasonSlug = detail.anime.slug;

          function loadSeason(d) {
            if (!d || !d.episodes || !d.episodes.length) {
              console.log(tag + " Bolum listesi alinamadi");
              return [];
            }
            var ep = null;
            for (var i = 0; i < d.episodes.length; i++) {
              if (Number(d.episodes[i].number) === Number(e)) { ep = d.episodes[i]; break; }
            }
            if (!ep) {
              console.log(tag + " Bolum bulunamadi: S" + s + "E" + e);
              return [];
            }

            console.log(tag + " Bolum: " + ep.slug + " (" + ep.id + ")");

            return getPlayback(ep.id).then(function (pb) {
              if (!pb || !pb.masterPlaylistUrl || !pb.masterPlaylistKey) {
                console.log(tag + " Playback alinamadi");
                return [];
              }

              return getVideoToken(pb.masterPlaylistKey).then(function (token) {
                if (!token) {
                  console.log(tag + " Video token alinamadi");
                  return [];
                }

                var masterUrl = pb.masterPlaylistUrl + "?token=" + encodeURIComponent(token);
                var headers = MEDIA_HEADERS;
                var displayTitle = d.anime.title || info.title;
                var display = displayTitle + (info.year ? " (" + info.year + ")" : "");
                if (isTv) display += " S" + s + "E" + e;

                var subtitles = [];
                if (Array.isArray(pb.subtitles)) {
                  for (var i = 0; i < pb.subtitles.length; i++) {
                    var sub = pb.subtitles[i];
                    if (!sub || !sub.url) continue;
                    var lang = sub.language || "und";
                    subtitles.push({
                      url: sub.url,
                      language: lang,
                      name: sub.label || lang,
                      lang: lang,
                      headers: headers
                    });
                  }
                }

                return fetchText(masterUrl, headers).then(function (master) {
                  var quality = master ? qualityFromMaster(master) : "";
                  var extras = [];
                  if (subtitles.length) extras.push(subtitles.length + " altyazi");
                  var q = quality || "Auto";
                  var title = "AniHub - " + (quality ? quality + " " : "") + (d.anime.title || info.title) + (isTv ? " S" + s + "E" + e : "");
                  var stream = {
                    name: "AniHub" + (quality ? " " + quality : ""),
                    title: title,
                    url: masterUrl,
                    quality: quality || undefined,
                    isM3u8: true,
                    type: "hls",
                    language: "tr",
                    provider: "anihub",
                    headers: headers,
                    subtitles: subtitles,
                    behaviorHints: { bingeGroup: "anihub-" + (d.anime.slug || animeItem.slug) }
                  };
                  console.log(tag + " Kaynak bulundu: 1 kaynak (" + (quality || "Auto") + ")");
                  return [stream];
                });
              });
            });
          }

          if (isTv && seasonSlug && seasonSlug !== detail.anime.slug) {
            return getAnimeDetail(seasonSlug).then(function (seasonDetail) {
              if (seasonDetail) return loadSeason(seasonDetail);
              return loadSeason(detail);
            });
          }
          return loadSeason(detail);
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
