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
    var paragraphs = html.split(/(<p[^>]*style="text-align: center;"[^>]*>[\s\S]*?<\/p>)/gi);
    var lastQuality = "";

    paragraphs.forEach(function (p) {
      if (!p || p.indexOf("<p") !== 0) return;

      var hasDownload = p.indexOf("thenaukriadda.in") !== -1 || p.indexOf("maxbutton-download-g-drive") !== -1;

      if (hasDownload) {
        var urlMatch = p.match(/href="([^"]*thenaukriadda\.in[^"]*)"/i);
        if (urlMatch) {
          links.push({
            url: urlMatch[1],
            quality: qualityFromText(lastQuality),
            text: cleanText(lastQuality)
          });
        }
      } else {
        var text = cleanText(p);
        if (text.length > 0) {
          lastQuality = text;
        }
      }
    });

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
          console.log(tag + " No matching post found");
          return [];
        }
        console.log(tag + " Matched post: " + match.title);

        return fetchText(match.url, { headers: { "User-Agent": UA } }).then(function (html) {
          var links = parseDownloadLinks(html);
          var streams = links.map(function (link) {
            var q = link.quality || "Auto";
            var namePart = link.text ? (" - " + link.text) : "";
            return {
              name: "UHDMovies" + namePart,
              title: display + "\n" + q + namePart,
              url: link.url,
              quality: q,
              isM3u8: false,
              type: "direct",
              subtitles: [],
              provider: "uhdmovies"
            };
          });
          streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
          console.log(tag + " Found " + streams.length + " streams");
          return streams;
        });
      });
    }).catch(function (err) {
      console.log(tag + " Error: " + (err && err.message));
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
