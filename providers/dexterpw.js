/**
 * dexterpw - Dexter.pw provider for Nuvio
 * Flow: TMDB id -> dexter.pw api (movie / tv season / episode) -> hls/direct
 * Hermes-safe: Promise chains only, no async/await, no generators, no deps.
 */
(function () {
  "use strict";

  var BASE_URL = "https://dexter.pw";
  var REQUEST_TIMEOUT = 12000;
  var M3U8_TIMEOUT = 8000;

  function fetchWithTimeout(url, options, timeout) {
    timeout = timeout || REQUEST_TIMEOUT;
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("API Timeout")); }, timeout);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function parseRelease(s) {
    s = " " + String(s || "").toLowerCase().replace(/[^a-z0-9+.]+/g, " ") + " ";
    var codec = /x265|hevc|h265/.test(s) ? "HEVC x265" : (/x264|h264|avc/.test(s) ? "H.264" : (/av1/.test(s) ? "AV1" : ""));
    var depth = /10bit|10 bit|hi10/.test(s) ? "10bit" : "";
    var hdr = /dolby.?vision|\bdv\b|\bdovi\b/.test(s) ? "DV" : (/hdr10\+/.test(s) ? "HDR10+" : (/hdr10/.test(s) ? "HDR10" : (/hdr\b/.test(s) ? "HDR" : "")));
    var audio = /truehd/.test(s) ? "TrueHD" : (/atmos/.test(s) ? "Atmos" : (/dts/.test(s) ? "DTS" : ""));
    var ach = /ddp.?5\.1|dd.?5\.1|ac.?3|5\.1/.test(s) ? "5.1" : (/7\.1/.test(s) ? "7.1" : "");
    return { codec: codec, depth: depth, hdr: hdr, audio: (audio + (ach ? " " + ach : "")).trim() };
  }

  function detailLine(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out.push(parts[i]);
    }
    return out.join(" | ");
  }

  function fetchDetails(tmdbId, mediaType, season, episode, retry) {
    retry = retry || 0;
    var url;
    if (mediaType === "tv") {
      if (season && episode) {
        url = BASE_URL + "/api/tv/" + encodeURIComponent(tmdbId) + "/episode/" + encodeURIComponent(season) + "/" + encodeURIComponent(episode) + "?site=dexter";
      } else if (season) {
        url = BASE_URL + "/api/tv/" + encodeURIComponent(tmdbId) + "/season/" + encodeURIComponent(season) + "?site=dexter";
      } else {
        url = BASE_URL + "/api/tv/" + encodeURIComponent(tmdbId) + "?site=dexter";
      }
    } else {
      url = BASE_URL + "/api/movie/" + encodeURIComponent(tmdbId) + "?site=dexter";
    }
    return fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
        "Referer": "https://dexter.pw"
      }
    }).then(function (res) {
      if (!res.ok) {
        console.log("[Dexter] API Error " + res.status + " for URL: " + url);
        return { sources: [], error: res.status };
      }
      return res.json();
    }).catch(function (err) {
      if (retry < 1) {
        console.log("[Dexter] API retry (" + (retry + 1) + "): " + err.message);
        return fetchDetails(tmdbId, mediaType, season, episode, retry + 1);
      }
      console.log("[Dexter] API Fetch Error: " + err);
      return { sources: [], error: err.message };
    });
  }

  function makeAbsoluteUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
    var value = rawUrl.trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (value.indexOf("//") === 0) return "https:" + value;
    if (value.charAt(0) === "/") return BASE_URL + value;
    return BASE_URL + "/" + value;
  }

  function resolveSubUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return null;
    relativeUrl = relativeUrl.trim();
    if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
    if (relativeUrl.indexOf("//") === 0) return "https:" + relativeUrl;
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
      if (relativeUrl.charAt(0) === "/") {
        var m = baseUrl.match(/^(https?:\/\/[^\/]+)/i);
        if (m) return m[1] + relativeUrl;
      }
      var lastSlash = baseUrl.lastIndexOf("/");
      if (lastSlash !== -1) return baseUrl.substring(0, lastSlash + 1) + relativeUrl;
      return relativeUrl;
    }
  }

  function qualityFromHeight(height) {
    if (height >= 2160) return "4K";
    if (height >= 1440) return "2K";
    if (height >= 1080) return "1080p";
    if (height >= 720) return "720p";
    if (height >= 480) return "480p";
    return height + "p";
  }

  function extractStreams(details) {
    if (!details || !Array.isArray(details.sources) || details.sources.length === 0) {
      return Promise.resolve([]);
    }
    var episode = details.episode && typeof details.episode === "object" ? details.episode : null;
    var show = details.show && typeof details.show === "object" ? details.show : null;
    var episodeTitle = episode && (episode.title || episode.name);
    var showTitle = show && (show.title || show.name);
    var title = (episodeTitle && showTitle) ? showTitle + " - " + episodeTitle : (episodeTitle || showTitle || details.title || "Video");

    var subtitles = [];
    var rawSubs = details.subtitles || details.tracks || [];
    if (Array.isArray(rawSubs)) {
      rawSubs.forEach(function (sub) {
        if (sub && typeof sub.url === "string") {
          var subUrl = makeAbsoluteUrl(sub.url);
          if (subUrl) subtitles.push({ url: subUrl, lang: sub.lang || sub.label || "Turkish" });
        }
      });
    }
    var subLangs = subtitles.map(function (s) { return s.lang; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join(",");

    var streams = [];
    var chain = Promise.resolve();

    details.sources.forEach(function (source) {
      chain = chain.then(function () {
        if (!source || typeof source.url !== "string") return null;
        var kind = String(source.kind || "").toLowerCase();
        var rawUrl = source.url;
        if (kind === "embed" || kind === "player" || kind === "html") return null;

        var isHls = kind === "hls" || kind === "m3u8" || /\.m3u8(?:$|[?#])/i.test(rawUrl);
        var isDash = kind === "dash" || /\.mpd(?:$|[?#])/i.test(rawUrl);
        var isDirectLink = kind === "mp4" || /\.mp4(?:$|[?#])/i.test(rawUrl) || /\.(mp4|mkv|avi|mov|flv|webm)(?:$|[?#])/i.test(rawUrl);
        if (!isHls && !isDash && !isDirectLink) return null;

        var mainUrl = makeAbsoluteUrl(rawUrl);
        if (!mainUrl) return null;

        var serverLabel = source.label || "Server";
        var q0 = source.quality || "Auto";
        var rel = parseRelease(rawUrl + " " + serverLabel + " " + q0);
        var extra = detailLine([[rel.codec, rel.depth].join(" "), [rel.hdr, rel.audio].join(" ")]);
        var base = detailLine([serverLabel, extra, subLangs]);

        if (isDirectLink) {
          streams.push({
            name: "Dexter - " + serverLabel,
            title: title + "\n" + detailLine([q0, base]),
            url: mainUrl,
            quality: q0,
            isM3u8: false,
            provider: "dexter",
            type: "direct",
            subtitles: subtitles
          });
          return null;
        }

        if (isDash) {
          streams.push({
            name: "Dexter - " + serverLabel + " (DASH)",
            title: title + "\n" + detailLine([q0, base]),
            url: mainUrl,
            quality: q0,
            isM3u8: false,
            provider: "dexter",
            type: "dash",
            subtitles: subtitles
          });
          return null;
        }

        // HLS: Auto + per-variant
        streams.push({
          name: "Dexter - " + serverLabel + " (Auto)",
          title: title + "\n" + detailLine(["Auto", base]),
          url: mainUrl,
          quality: "Auto",
          isM3u8: true,
          provider: "dexter",
          type: "hls",
          subtitles: subtitles
        });

        return fetchWithTimeout(mainUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://dexter.pw"
          }
        }, M3U8_TIMEOUT).then(function (res) {
          if (!res.ok) return null;
          return res.text();
        }).then(function (text) {
          if (!text) return null;
          var lines = text.split(/\r?\n/);
          var parsed = {};
          for (var j = 0; j < lines.length; j++) {
            var line = lines[j].trim();
            if (line.indexOf("#EXT-X-STREAM-INF") !== 0) continue;
            var label = "SD";
            var bw = 0;
            var rm = line.match(/RESOLUTION=\d+x(\d+)/i);
            if (rm) label = qualityFromHeight(parseInt(rm[1], 10));
            var bm = line.match(/BANDWIDTH=(\d+)/i);
            if (bm) bw = parseInt(bm[1], 10);
            var k = j + 1;
            while (k < lines.length && (lines[k].trim() === "" || lines[k].trim().charAt(0) === "#")) k++;
            if (k >= lines.length) continue;
            var subUrl = resolveSubUrl(mainUrl, lines[k].trim());
            if (subUrl && (!parsed[label] || bw > parsed[label].bandwidth)) {
              parsed[label] = { url: subUrl, bandwidth: bw };
            }
          }
          Object.keys(parsed).forEach(function (ql) {
            streams.push({
              name: "Dexter - " + ql,
              title: title + "\n" + detailLine([ql, base]),
              url: parsed[ql].url,
              quality: ql,
              isM3u8: true,
              provider: "dexter",
              type: "hls",
              subtitles: subtitles
            });
          });
          return null;
        }).catch(function (err) {
          console.log("[Dexter] M3U8 parse hatasi: " + err.message);
          return null;
        });
      });
    });

    return chain.then(function () {
      console.log("[Dexter] Found " + streams.length + " streams");
      return qSort(streams);
    });
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 2.5;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480/.test(q)) return 1;
    return 0;
  }
  function qSort(list) {
    var hd = list.filter(function (s) { return qRank(s.quality) >= 2.5; });
    var base = hd.length ? hd : list;
    base.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return base;
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    console.log("[Dexter] Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    return fetchDetails(tmdbId, mediaType, season, episode).then(function (details) {
      if (!details || details.playable === false || !Array.isArray(details.sources) || details.sources.length === 0) {
        console.log("[Dexter] No sources available");
        return [];
      }
      return extractStreams(details);
    }).catch(function (err) {
      console.log("[Dexter] getStreams error: " + err.message);
      return [];
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
