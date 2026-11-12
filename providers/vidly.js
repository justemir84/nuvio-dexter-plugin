/**
 * vidly - Vidly.pro embed player provider for Nuvio
 *
 * Vidly.pro, film/dizi/anime içeriğini tek bir iframe embed ile sunan bir
 * aggregator servisidir. Kaynakları kendi sunucularında birleştirir (2embed,
 * vidsrc vb.), kalite seçimi ve altyazı yönetimi player içinde yapılır.
 *
 * Akis:
 *   TMDB id -> embed URL oluştur
 *     movie: https://vidly.pro/movie/{tmdb_id}
 *     tv:    https://vidly.pro/tv/{tmdb_id}/{s}/{e}
 *     anime: AniList araması -> https://vidly.pro/anime/{anilist_id}/{e}
 *
 * Notlar:
 * - Vidly.pro doğrudan m3u8/mp4 URL'si dönmez; embed (iframe) URL'si döner.
 *   Nuvio'nun iframe/embed desteği gereklidir.
 * - Film ve dizi için TMDB ID kullanılır; anime için AniList ID gereklidir.
 * - API key gerekmez.
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://vidly.pro";
  var ANILIST = "https://graphql.anilist.co";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;

  // ---------------------------------------------------------------- helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function fetchText(url, options) {
    var opts = options || {};
    var headers = opts.headers || { "User-Agent": UA };
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, TIMEOUT);
    });
    return Promise.race([fetch(url, { method: opts.method || "GET", headers: headers, body: opts.body }), timeout])
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
    return String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // -------------------------------------------------------------- TMDB

  function tmdbInfo(tmdbId, isTv, apiKey) {
    var path = isTv ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) +
      "&language=tr-TR&append_to_response=alternative_titles";
    return fetchText(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;

      var main = isTv ? (d.name || "") : (d.title || "");
      var original = isTv ? (d.original_name || "") : (d.original_title || "");
      return {
        title: main,
        original: original,
        year: String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4)
      };
    });
  }

  // -------------------------------------------------------------- AniList

  function searchAniList(title) {
    if (!title) return Promise.resolve(null);
    var query = "query ($search: String) { Media(search: $search, type: ANIME) { id title { romaji english } } }";
    var body = JSON.stringify({ query: query, variables: { search: title } });
    return fetchText(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: body
    }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      var media = d && d.data && d.data.Media;
      if (!media || !media.id) return null;
      return String(media.id);
    });
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[vidly]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getSettings(settings).tmdbApiKey || TMDB_KEY_FALLBACK;

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }

      var display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (isTv) display += " S" + s + "E" + e;

      var headers = { "User-Agent": UA, Referer: BASE + "/", Origin: BASE };

      if (isTv) {
        // Anime olup olmadigini AniList ile kontrol et
        return searchAniList(info.title).then(function (anilistId) {
          var streams = [];
          if (anilistId) {
            // Anime olarak oynat
            var animeUrl = BASE + "/anime/" + anilistId + "/" + e;
            streams.push({
              name: "Vidly - Anime",
              title: display + " [Vidly Embed]",
              url: animeUrl,
              quality: "Auto",
              isM3u8: false,
              type: "mp4",
              language: "en",
              provider: "vidly",
              headers: headers,
              subtitles: [],
              behaviorHints: { bingeGroup: "vidly-" + tmdbId }
            });
          } else {
            // Normal dizi
            var tvUrl = BASE + "/tv/" + tmdbId + "/" + s + "/" + e;
            streams.push({
              name: "Vidly - TV",
              title: display + " [Vidly Embed]",
              url: tvUrl,
              quality: "Auto",
              isM3u8: false,
              type: "mp4",
              language: "en",
              provider: "vidly",
              headers: headers,
              subtitles: [],
              behaviorHints: { bingeGroup: "vidly-" + tmdbId }
            });
          }
          console.log(tag + " Kaynak bulundu: " + streams.length);
          return streams;
        });
      } else {
        // Film
        var movieUrl = BASE + "/movie/" + tmdbId;
        var streams = [{
          name: "Vidly - Movie",
          title: display + " [Vidly Embed]",
          url: movieUrl,
          quality: "Auto",
          isM3u8: false,
          type: "mp4",
          language: "en",
          provider: "vidly",
          headers: headers,
          subtitles: [],
          behaviorHints: { bingeGroup: "vidly-" + tmdbId }
        }];
        console.log(tag + " Kaynak bulundu: " + streams.length);
        return streams;
      }
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
