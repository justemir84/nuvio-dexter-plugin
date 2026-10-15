// src/idlix/extractor.js
var require_extractor = __commonJS({
  "src/idlix/extractor.js"(exports2, module2) {
    "use strict";

    function resolveUrl(base, relative) {
      if (!relative) return null;
      if (/^https?:\/\//i.test(relative)) return relative;
      if (relative.startsWith("//")) return "https:" + relative;
      try { return new URL(relative, base).href; } catch (e) { return null; }
    }

    function qualityLabel(width, height) {
      var ref = Math.max(width || 0, height || 0);
      if (ref >= 1900) return "1080p";
      if (ref >= 1200) return "720p";
      if (ref >= 800)  return "480p";
      if (ref >= 600)  return "360p";
      return "SD";
    }

    function parseMasterPlaylist(text, baseUrl) {
      var lines = text.split(/\r?\n/);
      var variants = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

        var bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        var resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        var bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        var width = resMatch ? parseInt(resMatch[1], 10) : 0;
        var height = resMatch ? parseInt(resMatch[2], 10) : 0;

        var k = i + 1;
        while (k < lines.length && (lines[k].trim() === "" || lines[k].trim().startsWith("#"))) k++;
        if (k >= lines.length) continue;

        var uri = lines[k].trim();
        var fullUrl = resolveUrl(baseUrl, uri);
        if (!fullUrl) continue;

        variants.push({
          url: fullUrl,
          bandwidth: bandwidth,
          width: width,
          height: height,
          quality: qualityLabel(width, height)
        });
      }
      return variants;
    }

    function buildStreams(variants, subtitles, title) {
      var best = {};
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        if (!best[v.quality] || v.bandwidth > best[v.quality].bandwidth) {
          best[v.quality] = v;
        }
      }

      var order = ["1080p", "720p", "480p", "360p", "SD"];
      var streams = [];
      for (var j = 0; j < order.length; j++) {
        var key = order[j];
        if (!best[key]) continue;
        var variant = best[key];
        var subtitleLine = subtitles && subtitles.length ? " | " + subtitles.map(function (s) {
          return s.lang || s.label || "Unknown";
        }).join(", ") : "";
        streams.push({
          name: "IDLIX - " + variant.quality,
          title: (title || "") + "\n" + variant.quality + subtitleLine,
          url: variant.url,
          quality: variant.quality,
          isM3u8: true,
          provider: "idlix",
          type: "hls",
          subtitles: subtitles
        });
      }
      return streams;
    }

    module2.exports = {
      parseMasterPlaylist: parseMasterPlaylist,
      buildStreams: buildStreams
    };
  }
});
