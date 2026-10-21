/**
 * uhdmovies - UHDMovies.us.org provider for Nuvio
 * Flow: TMDB id -> TMDB title/year -> uhdmovies WordPress search (?s=) -> post page -> Google Drive download links
 * Site: https://uhdmovies.us.org (indirme sitesi; Google Drive doku linkleri)
 * Hermes-safe: Promise chains only, no async/await, no deps.
 *
 * NOT: Bu site akış (streaming) sitesi degildir, indirme sitesidir.
 * Dondurulen linkler en.thenaukriadda.in üzerinden Google Drive'a yonlendirir.
 * Nuvio bu ara sayfalari direk video akisi olarak oynatamayabilir (buffering/takilma).
 */
(function () {
  "use strict";

  var BASE_URL = "https://uhdmovies.us.org";
  var REQUEST_TIMEOUT = 15000;
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  function fetchWithTimeout(url, options, timeout) {
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("API Timeout")); }, timeout || REQUEST_TIMEOUT);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchText(url, options) {
    return fetchWithTimeout(url, options).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
  }

  function tmdbLookup(tmdbId, isTv, apiKey) {
    if (!apiKey) return Promise.resolve(null);
    var path = isTv ? "/tv/" : "/movie/";
    return fetchWithTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function parseRelease(s) {
    s = " " + String(s || "").toLowerCase().replace(/[^a-z0-9+.]+/g, " ") + " ";
    var codec = /x265|hevc|h265|h\.265/.test(s) ? "HEVC x265" : (/x264|h264|h\.264|avc/.test(s) ? "H.264" : (/av1/.test(s) ? "AV1" : ""));
    var depth = /10bit|10 bit|hi10/.test(s) ? "10-bit" : "";
    var hdr = /dolby.?vision|\bdv\b|\bdovi\b/.test(s) ? "DV" : (/hdr10\+/.test(s) ? "HDR10+" : (/hdr10/.test(s) ? "HDR10" : (/hdr\b/.test(s) ? "HDR" : "")));
    var audio = /truehd/.test(s) ? "TrueHD" : (/dts.?hd|dts-hd/.test(s) ? "DTS-HD" : (/dts/.test(s) ? "DTS" : (/atmos/.test(s) ? "Atmos" : (/ddp|eac3|dd\+/.test(s) ? "DDP" : (/ac-3|ac3/.test(s) ? "DD" : (/aac/.test(s) ? "AAC" : ""))))));
    var ach = /ddp\.?5\.1|dd\.?5\.1|5\.1/.test(s) ? "5.1" : (/7\.1/.test(s) ? "7.1" : (/2\.0/.test(s) ? "2.0" : ""));
    var src = /remux/.test(s) ? "REMUX" : (/blu.?ray/.test(s) ? "BluRay" : (/web.?dl/.test(s) ? "WEB-DL" : (/webrip/.test(s) ? "WEBRip" : (/hdtv/.test(s) ? "HDTV" : (/dvdrip|dvd/.test(s) ? "DVD" : "")))));
    var lang = /dual/.test(s) ? "Dual Audio" : (/multi|multi.audio/.test(s) ? "Multi Audio" : "");
    return {
      codec: codec,
      depth: depth,
      hdr: hdr,
      audio: (audio + (ach ? " " + ach : "")).trim(),
      src: src,
      lang: lang
    };
  }

  function parseSize(text) {
    var m = String(text || "").match(/\[([\d.,]+\s*(?:TB|GB|MB))\]/i);
    if (!m) m = String(text || "").match(/([\d.,]+\s*(?:TB|GB|MB))/i);
    return m ? m[1] : "";
  }

  function qualityFromText(text) {
    var t = String(text || "").toLowerCase();
    if (/2160|4k|uhd/.test(t)) return "2160p";
    if (/1440|2k/.test(t)) return "1440p";
    if (/1080/.test(t)) return "1080p";
    if (/720/.test(t)) return "720p";
    if (/480/.test(t)) return "480p";
    return "Auto";
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

  function cleanText(html) {
    return String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&\w+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractOgImage(html) {
    var m = html.match(/<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']/i);
    return m ? m[1] : null;
  }

  function searchPosts(query) {
    var url = BASE_URL + "/?s=" + encodeURIComponent(query);
    return fetchText(url, { headers: { "User-Agent": UA } }).then(function (html) {
      var posts = [];
      var articleRegex = /<article[^>]*class="[^"]*gridlove-post[^"]*"[\s\S]*?<\/article>/gi;
      var match;
      while ((match = articleRegex.exec(html)) !== null) {
        var article = match[0];
        var linkMatch = article.match(/<a[^>]+href="([^"]+)"[^>]*title="([^"]*)"/i);
        if (!linkMatch) {
          linkMatch = article.match(/<h1[^>]*class="sanket"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        }
        if (linkMatch) {
          posts.push({ url: linkMatch[1], title: cleanText(linkMatch[2] || linkMatch[1]) });
        }
      }
      return posts;
    }).catch(function () { return []; });
  }

  function parseDownloadLinks(html) {
    var links = [];
    var poster = extractOgImage(html);
    var lastQuality = "";
    var lastSize = "";

    var pRegex = /<p[^>]*style="text-align: center;"[^>]*>([\s\S]*?)<\/p>/gi;
    var match;

    while ((match = pRegex.exec(html)) !== null) {
      var p = match[0];
      var text = cleanText(p);

      var hasDownload = p.indexOf("thenaukriadda.in") !== -1 || p.indexOf("maxbutton-download-g-drive") !== -1;

      if (hasDownload) {
        var urlMatch = p.match(/href="([^"]*thenaukriadda\.in[^"]*)"/i);
        if (urlMatch) {
          links.push({
            url: urlMatch[1],
            quality: qualityFromText(lastQuality),
            size: parseSize(lastQuality),
            text: lastQuality,
            poster: poster
          });
        }
        lastQuality = "";
        lastSize = "";
      } else {
        if (text.length > 0) {
          lastQuality = text;
          lastSize = parseSize(text);
        }
      }
    }

    return links;
  }

  function findBestMatch(posts, title, year) {
    var t = (title || "").toLowerCase();
    var y = String(year || "");
    var best = null;
    var bestScore = -1;

    posts.forEach(function (post) {
      var pt = post.title.toLowerCase();
      var score = 0;

      if (pt.indexOf(t) !== -1) score += 10;
      else if (t.split(" ").filter(function (w) { return w.length > 2; }).every(function (w) { return pt.indexOf(w) !== -1; })) score += 5;

      if (y && pt.indexOf("(" + y + ")") !== -1) score += 5;

      if (score > bestScore) {
        bestScore = score;
        best = post;
      }
    });

    return bestScore > 0 ? best : null;
  }

  function onSettings() {
    return [
      { type: "header", label: "UHDMovies" },
      {
        type: "text",
        key: "tmdbApiKey",
        label: "Personal TMDB API key (optional)",
        placeholder: "Leave blank to use Nuvio's built-in key",
        description: "Optional TMDB v3 key. If left blank, UHDMovies uses the TMDB key configured by Nuvio."
      }
    ];
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[uhdmovies]";
    var isTv = mediaType === "tv";
    settings = (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) || settings || {};
    var tmdbKey = settings.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || "";

    if (!tmdbKey) {
      console.log(tag + " TMDB API anahtarı ayarlanmamış. Nuvio'da UHDMovies eklenti ayarlarından TMDB API Key girin.");
      return Promise.resolve([]);
    }

    return tmdbLookup(tmdbId, isTv, tmdbKey).then(function (info) {
      if (!info) return [];
      var title = info.title || info.name || "";
      var year = String(info.release_date || info.first_air_date || "").slice(0, 4);
      var display = title + (year ? " (" + year + ")" : "");
      if (isTv && season) display += " S" + (season < 10 ? "0" + season : season) + (episode ? "E" + (episode < 10 ? "0" + episode : episode) : "");

      var query = title;
      if (year) query += " " + year;
      if (isTv && season) query += " Season " + season;
      if (isTv && episode) query += " Episode " + episode;

      console.log(tag + " Searching: " + query);

      return searchPosts(query).then(function (posts) {
        var match = findBestMatch(posts, title, year);
        if (!match) {
          console.log(tag + " Yil eşlesmesi bulunamadi, yıl olmayan arama deneniyor");
          return searchPosts(title).then(function (posts2) {
            return findBestMatch(posts2, title, "");
          });
        }
        return match;
      }).then(function (match) {
        if (!match) {
          console.log(tag + " Eşleşen yayin bulunamadi");
          return [];
        }
        console.log(tag + " Eslesen sayfa: " + match.title);

        return fetchText(match.url, { headers: { "User-Agent": UA } }).then(function (html) {
          var links = parseDownloadLinks(html);
          var streams = links.map(function (link) {
            var q = link.quality || "Auto";
            var rel = parseRelease(link.text);
            var size = link.size || "";
            var namePart = [];
            if (rel.src) namePart.push(rel.src);
            if (rel.codec) namePart.push(rel.codec);
            if (rel.depth) namePart.push(rel.depth);
            if (rel.hdr) namePart.push(rel.hdr);
            if (rel.audio) namePart.push(rel.audio);
            if (rel.lang) namePart.push(rel.lang);
            if (size) namePart.push(size);

            var streamName = "UHDMovies";
            if (namePart.length) streamName += " - " + namePart.join(" / ");

            var stream = {
              name: streamName,
              title: display + "\n" + q + (namePart.length ? " | " + namePart.join(" / ") : ""),
              url: link.url,
              quality: q,
              isM3u8: false,
              type: "direct",
              subtitles: [],
              provider: "uhdmovies"
            };
            if (link.poster) stream.image = link.poster;
            return stream;
          });
          streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
          console.log(tag + " Bulunan akış: " + streams.length);
          return streams;
        });
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message));
      return [];
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
