/**
 * moviesapi - VidSpark / MoviesAPI provider for Nuvio
 * Flow: TMDB id -> cdn.vidspark.to/api/vidora/v1/{movie|tv}/...?source=KEY
 *       -> HLS master/media playlist + VTT subtitles
 *
 * VidSpark exposes several source backends (Alpha, Beta, Nebula, Zephyr,
 * Cobalt, Vega). The old moviesapi.to endpoint only had one backend and
 * returned "No Vidora link found" for many TV episodes; the CDN endpoint
 * with the ?source= key has much wider coverage.
 *
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://cdn.vidspark.to/api/vidora/v1";
  var SITE = "https://cdn.vidspark.to/";
  var ORIGIN = "https://cdn.vidspark.to";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var KEY = "f3b72e73c80c9a996574379798703796a1936efa3516a7105cb0e43048b46b5a";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 6000;
  var MAX_SOURCES = 12;
  var MAX_SUCCESSFUL_BACKENDS = 4;

  var BACKENDS = [
    { key: "k2mq", label: "Alpha" },
    { key: "b4tz", label: "Beta" },
    { key: "w7dn", label: "Nebula" },
    { key: "nzv4", label: "Zephyr" },
    { key: "fq1k", label: "Cobalt" },
    { key: "vjej", label: "Vega" }
  ];

  function fetchTimeout(url, options, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 2.5;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480|sd/.test(q)) return 1;
    return 0.5;
  }

  function qualityFromHeight(height) {
    height = parseInt(height, 10) || 0;
    if (height >= 2000) return "2160p";
    if (height >= 1400) return "1440p";
    if (height >= 1000) return "1080p";
    if (height >= 700) return "720p";
    if (height >= 400) return "480p";
    return height > 0 ? height + "p" : "Auto";
  }

  function qualityFromText(text) {
    var value = String(text || "").toLowerCase();
    if (/2160|4k|uhd/.test(value)) return "2160p";
    if (/1440|2k/.test(value)) return "1440p";
    if (/1080|fhd/.test(value)) return "1080p";
    if (/720|hd/.test(value)) return "720p";
    if (/480|sd/.test(value)) return "480p";
    return "Auto";
  }

  function buildSubs(tracks) {
    var subs = [], seen = {};
    (tracks || []).forEach(function (track) {
      if (!track || !track.file) return;
      var language = track.language || track.label || "und";
      var key = String(language).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      var subtitleUrl = String(track.file);
      if (subtitleUrl.charAt(0) === "/") subtitleUrl = ORIGIN + subtitleUrl;
      subs.push({
        url: subtitleUrl,
        language: language,
        name: track.label || language,
        headers: {
          "User-Agent": UA,
          Referer: SITE,
          Origin: ORIGIN
        }
      });
    });
    return subs;
  }

  function langLabel(subs) {
    var names = subs.slice(0, 6).map(function (sub) { return sub.language; });
    var extra = subs.length - names.length;
    return names.join(", ") + (extra > 0 ? " +" + extra : "");
  }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_KEY + "&language=en-US&append_to_response=external_ids";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } })
      .then(function (response) { return response.ok ? response.json() : null; }, function () { return null; })
      .then(function (data) {
        if (!data) return null;
        var external = data.external_ids || {};
        return {
          title: data.name || data.title || data.original_name || data.original_title || "",
          year: (data.first_air_date || data.release_date || "").substring(0, 4),
          imdbId: external.imdb_id || null
        };
      });
  }

  function requestBackend(backend, path) {
    var url = API + path + "?source=" + encodeURIComponent(backend.key);
    return fetchTimeout(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: SITE,
        Origin: ORIGIN,
        "x-player-key": KEY
      }
    }).then(function (response) {
      if (!response.ok) throw new Error("API " + response.status);
      return response.json();
    });
  }

  function resolveUrl(url) {
    var value = String(url || "");
    if (value.charAt(0) === "/") return ORIGIN + value;
    return value;
  }

  function streamsFromResponse(data, backend, display) {
    if (!data || !data.result || !Array.isArray(data.sources)) return [];
    var streams = [], seen = {};

    data.sources.forEach(function (source) {
      if (!source || !source.url) return;
      var subs = buildSubs(source.tracks);
      var variants = Array.isArray(source.qualities) ? source.qualities.filter(function (item) {
        return item && item.url;
      }) : [];

      if (variants.length) {
        variants.forEach(function (variant) {
          var quality = qualityFromHeight(variant.height) || qualityFromText(variant.quality || variant.label);
          var variantUrl = resolveUrl(variant.url);
          if (seen[variantUrl]) return;
          seen[variantUrl] = true;
          streams.push(makeStream(backend, display, variantUrl, quality, subs));
        });
      } else {
        var quality = qualityFromText(source.quality || source.label);
        var sourceUrl = resolveUrl(source.url);
        if (seen[sourceUrl]) return;
        seen[sourceUrl] = true;
        streams.push(makeStream(backend, display, sourceUrl, quality, subs));
      }
    });

    return streams;
  }

  function makeStream(backend, display, url, quality, subs) {
    var label = backend.label + (quality !== "Auto" ? " " + quality : "");
    var extra = subs.length ? " | " + langLabel(subs) : "";
    return {
      name: "MoviesAPI - " + label,
      title: display + "\n" + backend.label + " • " + quality + " [HLS]" + extra,
      url: url,
      quality: quality,
      isM3u8: true,
      type: "hls",
      headers: {
        "User-Agent": UA,
        Referer: SITE,
        Origin: ORIGIN
      },
      subtitles: subs,
      provider: "moviesapi"
    };
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[moviesapi]";
    var isTv = mediaType === "tv";
    var wantedSeason = parseInt(season, 10) || 1;
    var wantedEpisode = parseInt(episode, 10) || 1;
    var path = isTv ? "/tv/" + tmdbId + "/" + wantedSeason + "/" + wantedEpisode : "/movie/" + tmdbId;

    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      var display = info && info.title ? info.title : ("TMDB " + tmdbId);
      if (info && info.year) display += " (" + info.year + ")";
      if (isTv) display += " S" + wantedSeason + "E" + wantedEpisode;

      var streams = [], seen = {};
      var successfulBackends = 0;

      function tryBackend(index) {
        if (index >= BACKENDS.length || successfulBackends >= MAX_SUCCESSFUL_BACKENDS) {
          return Promise.resolve(streams);
        }
        var backend = BACKENDS[index];
        return requestBackend(backend, path).then(function (data) {
          var found = streamsFromResponse(data, backend, display);
          if (found.length) {
            successfulBackends++;
            found.forEach(function (stream) {
              if (seen[stream.url]) return;
              seen[stream.url] = true;
              streams.push(stream);
            });
          }
          return tryBackend(index + 1);
        }).catch(function () {
          return tryBackend(index + 1);
        });
      }

      return tryBackend(0);
    }).then(function (streams) {
      streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
      var limited = streams.slice(0, MAX_SOURCES);
      console.log(tag + " Found " + limited.length + " streams");
      return limited;
    }).catch(function (error) {
      console.log(tag + " Error: " + (error && error.message));
      return [];
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
