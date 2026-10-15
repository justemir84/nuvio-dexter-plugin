// src/dexterpw/extractor.js
var require_extractor = __commonJS({
  "src/dexterpw/extractor.js"(exports2, module2) {
    "use strict";
    var BASE_URL = "https://dexter.pw";
    var M3U8_TIMEOUT = 8000;

    function makeAbsoluteUrl(rawUrl) {
      if (typeof rawUrl !== "string" || !rawUrl.trim())
        return null;
      const value = rawUrl.trim();
      if (/^https?:\/\//i.test(value))
        return value;
      if (value.indexOf("//") === 0)
        return "https:" + value;
      if (value.charAt(0) === "/")
        return BASE_URL + value;
      return BASE_URL + "/" + value;
    }

    function resolveSubUrl(baseUrl, relativeUrl) {
      if (!relativeUrl) return null;
      relativeUrl = relativeUrl.trim();
      if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
      if (relativeUrl.startsWith("//")) return "https:" + relativeUrl;

      try {
        return new URL(relativeUrl, baseUrl).href;
      } catch (e) {
        if (relativeUrl.startsWith("/")) {
          const match = baseUrl.match(/^(https?:\/\/[^\/]+)/i);
          if (match) return match[1] + relativeUrl;
        }
        const lastSlash = baseUrl.lastIndexOf("/");
        if (lastSlash !== -1) {
          return baseUrl.substring(0, lastSlash + 1) + relativeUrl;
        }
        return relativeUrl;
      }
    }

    function fetchWithTimeout(url, options, timeout) {
      timeout = timeout || M3U8_TIMEOUT;
      var timer = null;
      var timeoutPromise = new Promise(function(_, reject) {
        timer = setTimeout(function() { reject(new Error("Timeout")); }, timeout);
      });
      return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function(res) {
        if (timer) clearTimeout(timer);
        return res;
      }).catch(function(err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
    }

    function extractStreams2(details) {
      return __async(this, null, function* () {
        if (!details || !Array.isArray(details.sources) || details.sources.length === 0) {
          return [];
        }
        const episode = details.episode && typeof details.episode === "object" ? details.episode : null;
        const show = details.show && typeof details.show === "object" ? details.show : null;
        const episodeTitle = episode && (episode.title || episode.name);
        const showTitle = show && (show.title || show.name);
        const title = episodeTitle && showTitle ? showTitle + " - " + episodeTitle : episodeTitle || showTitle || details.title || "Video";

        const subtitles = [];
        const rawSubs = details.subtitles || details.tracks || [];
        if (Array.isArray(rawSubs)) {
          rawSubs.forEach(function(sub) {
            if (sub && typeof sub.url === "string") {
              const subUrl = makeAbsoluteUrl(sub.url);
              if (subUrl) {
                subtitles.push({
                  url: subUrl,
                  lang: sub.lang || sub.label || "Turkish"
                });
              }
            }
          });
        }

        const streams = [];

        for (let i = 0; i < details.sources.length; i++) {
          const source = details.sources[i];
          if (!source || typeof source.url !== "string")
            continue;

          const kind = String(source.kind || "").toLowerCase();
          const rawUrl = source.url;
          const isHls = kind === "hls" || kind === "m3u8" || /\.m3u8(?:$|[?#])/i.test(rawUrl);
          const isDash = kind === "dash" || /\.mpd(?:$|[?#])/i.test(rawUrl);
          const isMp4 = kind === "mp4" || /\.mp4(?:$|[?#])/i.test(rawUrl);
          const isDirectLink = isMp4 || /\.(mp4|mkv|avi|mov|flv|webm)(?:$|[?#])/i.test(rawUrl);

          if (kind === "embed" || kind === "player" || kind === "html")
            continue;

          if (!isHls && !isDash && !isDirectLink)
            continue;

          const mainUrl = makeAbsoluteUrl(rawUrl);
          if (!mainUrl)
            continue;

          const serverLabel = source.label || "Server";
          const qualityLabel = source.quality || "Auto";
          const subtitleLine = subtitles.length ? " | " + subtitles.map(function (s) { return s.lang || "Unknown"; }).join(", ") : "";

          if (isDirectLink) {
            streams.push({
              name: "Dexter - " + serverLabel,
              title: title + "\n" + qualityLabel + " | " + serverLabel + subtitleLine,
              url: mainUrl,
              quality: qualityLabel,
              isM3u8: false,
              provider: "dexter",
              type: "direct",
              subtitles: subtitles
            });
            continue;
          }

          if (isHls) {
            streams.push({
              name: "Dexter - " + serverLabel + " (Auto)",
              title: title + "\n" + qualityLabel + " | " + serverLabel + subtitleLine,
              url: mainUrl,
              quality: qualityLabel,
              isM3u8: true,
              provider: "dexter",
              type: "hls",
              subtitles: subtitles
            });

            try {
              const res = yield fetchWithTimeout(mainUrl, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  "Referer": "https://dexter.pw"
                }
              }, M3U8_TIMEOUT);

              if (res.ok) {
                const text = yield res.text();
                const lines = text.split(/\r?\n/);
                const parsedVariants = {};

                for (let j = 0; j < lines.length; j++) {
                  const line = lines[j].trim();
                  if (line.startsWith("#EXT-X-STREAM-INF")) {
                    let resolutionLabel = "SD";
                    let bandwidth = 0;

                    const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
                    if (resMatch) {
                      const height = parseInt(resMatch[1], 10);
                      if (height >= 2160) resolutionLabel = "4K";
                      else if (height >= 1440) resolutionLabel = "2K";
                      else if (height >= 1080) resolutionLabel = "1080p";
                      else if (height >= 720) resolutionLabel = "720p";
                      else if (height >= 480) resolutionLabel = "480p";
                      else resolutionLabel = height + "p";
                    }

                    const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
                    if (bwMatch) {
                      bandwidth = parseInt(bwMatch[1], 10);
                    }

                    let k = j + 1;
                    while (k < lines.length && (lines[k].trim() === "" || lines[k].trim().startsWith("#"))) {
                      k++;
                    }

                    if (k < lines.length) {
                      const rawSubUrl = lines[k].trim();
                      const subUrl = resolveSubUrl(mainUrl, rawSubUrl);
                      if (subUrl) {
                        if (!parsedVariants[resolutionLabel] || bandwidth > parsedVariants[resolutionLabel].bandwidth) {
                          parsedVariants[resolutionLabel] = { url: subUrl, bandwidth: bandwidth };
                        }
                      }
                    }
                  }
                }

                for (const [quality, variant] of Object.entries(parsedVariants)) {
                  streams.push({
                    name: "Dexter - " + quality,
                    title: title + "\n" + quality + " | " + serverLabel + subtitleLine,
                    url: variant.url,
                    quality: quality,
                    isM3u8: true,
                    provider: "dexter",
                    type: "hls",
                    subtitles: subtitles
                  });
                }
              }
            } catch (err) {
              console.log("[Dexter] M3U8 parse hatasi: " + err.message);
            }
          } else if (isDash) {
            streams.push({
              name: "Dexter - " + serverLabel + " (DASH)",
              title: title + "\n" + qualityLabel + " | " + serverLabel + subtitleLine,
              url: mainUrl,
              quality: qualityLabel,
              isM3u8: false,
              provider: "dexter",
              type: "dash",
              subtitles: subtitles
            });
          }
        }

        console.log("[Dexter] Found " + streams.length + " streams");
        return streams;
      });
    }
    module2.exports = { extractStreams: extractStreams2 };
  }
});
