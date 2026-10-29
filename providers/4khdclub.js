/**
 * 4khdclub - 4K-HD.Club provider for Nuvio
 * Flow: TMDB id -> TMDB title/year -> 4K-HD.Club DLE search
 *       -> movie/series page -> download host links (TakeFile / MoonDL / ...)
 *
 * Site: https://4k-hd.club (4K REMUX downloads)
 */
(function () {
  "use strict";

  var BASE_URL = "https://4k-hd.club";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function decodeEntities(text) {
    var s = String(text || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    });
    return s
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  function cleanText(html) {
    return decodeEntities(String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchText(url) {
    try {
      var res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      return null;
    }
  }

  async function tmdbDetails(tmdbId, type, apiKey, season) {
    var isTv = type === "tv" || type === "series";
    var endpoint = isTv ? "tv" : "movie";
    try {
      var res = await fetch("https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US");
      if (!res.ok) return null;
      var data = await res.json();
      var title = isTv ? (data.name || "") : (data.title || "");
      var year = "";
      var rawDate = isTv ? data.first_air_date : data.release_date;
      if (rawDate) year = String(rawDate).slice(0, 4);

      // Season-specific air year (helps match "Season 4 2014").
      if (isTv && season) {
        try {
          var sres = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + season + "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US");
          if (sres.ok) {
            var sdata = await sres.json();
            if (sdata.air_date) year = String(sdata.air_date).slice(0, 4);
          }
        } catch (e) {}
      }

      return { title: title, year: year };
    } catch (e) {
      return null;
    }
  }

  function parseSearch(html) {
    var posts = [];
    var marker = '<div class="main-news">';
    var idx = html.indexOf(marker);
    while (idx !== -1) {
      var next = html.indexOf(marker, idx + marker.length);
      var block = next === -1 ? html.slice(idx) : html.slice(idx, next);

      var linkMatch = block.match(/<a href="(https?:\/\/4k-hd\.club\/[^"]+)" class="main-news-image"/i);
      if (!linkMatch) {
        linkMatch = block.match(/<a class="main-news-image"[^>]*href="(https?:\/\/4k-hd\.club\/[^"]+)"/i);
      }
      var titleMatch = block.match(/<div class="main-news-title">\s*<a[^>]*>([\s\S]*?)<\/a>/i);
      var sizeMatch = block.match(/SIZE<span>\s*([^<]+)<\/span>/i);

      if (linkMatch && titleMatch) {
        posts.push({
          url: decodeEntities(linkMatch[1]),
          title: cleanText(titleMatch[1]),
          size: sizeMatch ? cleanText(sizeMatch[1]) : ""
        });
      }

      idx = next;
    }
    return posts;
  }

  async function searchPosts(query) {
    var url = BASE_URL + "/index.php?do=search&subaction=search&story=" + encodeURIComponent(query);
    var html = await fetchText(url);
    if (!html) return [];
    return parseSearch(html);
  }

  function scorePost(postTitle, title, year, season, isTv) {
    var pt = String(postTitle || "").toLowerCase();
    var t = String(title || "").toLowerCase();
    var s = 0;

    if (t && pt.indexOf(t) !== -1) s += 10;
    else {
      var words = t.split(/\s+/).filter(function (w) { return w.length > 2; });
      if (words.length && words.every(function (w) { return pt.indexOf(w) !== -1; })) s += 5;
    }

    if (year) {
      var ym = pt.match(/\b(19|20)\d{2}\b/g);
      if (ym && ym.indexOf(String(year)) !== -1) s += 8;
      else s -= 3;
    }

    if (isTv && season) {
      var sn = parseInt(season, 10);
      var seasonRe = new RegExp("season\\s*0?" + sn + "\\b", "i");
      if (seasonRe.test(pt)) s += 8;
      else if (new RegExp("\\bs0?" + sn + "\\b", "i").test(pt)) s += 6;
      else if (/season|s\d{2}/i.test(pt)) s -= 4;
    }

    if (/collection|trilogy|duology|pack/i.test(pt) && t && pt.indexOf(t) === -1) s -= 2;

    return s;
  }

  function findBestMatch(posts, title, year, season, isTv) {
    var best = null;
    var bestScore = -Infinity;
    (posts || []).forEach(function (post) {
      var sc = scorePost(post.title, title, year, season, isTv);
      if (sc > bestScore) {
        bestScore = sc;
        best = post;
      }
    });
    return bestScore > 0 ? best : null;
  }

  function parseDownloadLinks(html) {
    var links = [];
    var seen = {};
    function add(href) {
      href = decodeEntities(String(href || "").trim());
      if (!href || seen[href]) return;
      seen[href] = true;
      links.push(href);
    }

    var re1 = /<a[^>]*class=["'][^"']*dwlink[^"']*["'][^>]*href=["']([^"']+)["']/gi;
    var re2 = /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*dwlink[^"']*["']/gi;
    var m;
    while ((m = re1.exec(html)) !== null) add(m[1]);
    while ((m = re2.exec(html)) !== null) add(m[1]);

    return links;
  }

  function qualityFromUrl(url) {
    var m = String(url || "").match(/(\d{3,4})p/i);
    if (m) return m[1] + "p";
    if (/2160|\b4k\b/i.test(url)) return "2160p";
    return "2160p";
  }

  function hostName(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch (e) {
      return "4k-hd.club";
    }
  }
  function uniqueAudioFormats(audioSection) {
    var set = {};
    var out = [];
    var parts = String(audioSection || "").split("|");
    parts.forEach(function (p) {
      p = p.trim();
      if (!p) return;
      // "#English: DTS-HD Master Audio 5.1 (48kHz, 24-bit)" -> format
      var m = p.match(/:\s*(.+?)(?:\s*\(|$)/);
      var fmt = m ? m[1].trim() : p;
      fmt = fmt.replace(/^#+/, "").trim();
      if (!fmt) return;
      if (!Object.prototype.hasOwnProperty.call(set, fmt)) {
        set[fmt] = true;
        out.push(fmt);
      }
    });
    return out;
  }
  async function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[4khdclub]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var apiKey = getTmdbKey(settings);
    if (!apiKey) {
      console.log(tag + " TMDB API key missing");
      return [];
    }

    var info = await tmdbDetails(tmdbId, isTv ? "tv" : "movie", apiKey, season);
    if (!info || !info.title) {
      console.log(tag + " TMDB details not found");
      return [];
    }

    var title = info.title;
    var year = info.year;
    console.log(tag + " Searching: " + title + (year ? " (" + year + ")" : ""));

    var query = title;
    if (isTv && season) query += " Season " + season;
    else if (year) query += " " + year;

    var posts = await searchPosts(query);
    var match = findBestMatch(posts, title, year, season, isTv);

    if (!match && isTv) {
      posts = await searchPosts(title + (year ? " " + year : ""));
      match = findBestMatch(posts, title, year, season, isTv);
    }
    if (!match) {
      posts = await searchPosts(title);
      match = findBestMatch(posts, title, year, season, isTv);
    }

    if (!match) {
      console.log(tag + " No matching page found");
      return [];
    }

    console.log(tag + " Matched page: " + match.title + " -> " + match.url);

    var html = await fetchText(match.url);
    if (!html) return [];

    var links = parseDownloadLinks(html);
    console.log(tag + " Found " + links.length + " download links");
    if (!links.length) return [];

    var pageTitleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    var pageTitle = pageTitleMatch ? cleanText(pageTitleMatch[1]) : (title + (year ? " " + year : ""));

    var sizeMatch = html.match(/File [Ss]ize:\s*<i>\s*([^<]+?)\s*<\/i>/i);
    if (!sizeMatch) sizeMatch = html.match(/File size:\s*([0-9.]+\s*[A-Z]+)/i);
    var size = sizeMatch ? cleanText(sizeMatch[1]) : "";

    var ogMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    var poster = ogMatch ? decodeEntities(ogMatch[1]) : null;

    var videoSection = (function(html,title){ var re = new RegExp('<div class="stb-sp-title">\\s*' + title + '\\s*</div>\\s*<div class="stb-sp-content">([\\s\\S]*?)</div>', "i"); var m = String(html||"").match(re); if(!m) return "NOMATCH"; return m[1].replace(/<br\s*\/?>/gi," | ").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(); })(html, "Video");
    var audioSection = (function(html,title){ var re = new RegExp('<div class="stb-sp-title">\\s*' + title + '\\s*</div>\\s*<div class="stb-sp-content">([\\s\\S]*?)</div>', "i"); var m = String(html||"").match(re); if(!m) return ""; return m[1].replace(/<br\s*\/?>/gi," | ").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(); })(html, "Audio");
    var subsSection = (function(html,title){ var re = new RegExp('<div class="stb-sp-title">\\s*' + title + '\\s*</div>\\s*<div class="stb-sp-content">([\\s\\S]*?)</div>', "i"); var m = String(html||"").match(re); if(!m) return ""; return m[1].replace(/<br\s*\/?>/gi," | ").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(); })(html, "Subtitles");

    var audioFormats = uniqueAudioFormats(audioSection);
    var bitrateMatch = videoSection.match(/\(([^)]*Mb\/s[^)]*)\)/i);
    var bitrate = bitrateMatch ? bitrateMatch[1].trim() : "";
    var hdrMatch = videoSection.match(/HDR:\s*([^|]+)/i);
    var hdr = hdrMatch ? hdrMatch[1].trim() : "";
    var codecMatch = videoSection.match(/Codec:\s*([^(|]+)/i);
    var codec = codecMatch ? codecMatch[1].trim() : "";

    var detailLines = [];
    if (codec) detailLines.push("Video: " + codec + (bitrate ? " (" + bitrate + ")" : "") + (hdr ? " | HDR: " + hdr : ""));
    if (audioFormats.length) detailLines.push("Audio: " + audioFormats.join(", "));
    if (subsSection) {
      var subCount = subsSection.split(",").filter(function (x) { return x.trim(); }).length;
      detailLines.push("Subs: " + subCount + " langs");
    }

    var streams = [];
    var seen = {};
    links.forEach(function (link) {
      if (seen[link]) return;
      seen[link] = true;

      var q = qualityFromUrl(link);
      var host = hostName(link);
      var name = "4KHD Club - " + host + (q ? " " + q : "") + (bitrate ? " (" + bitrate + ")" : "");
      var titleLine = pageTitle + (q ? "\n" + q : "") + (size ? " | " + size : "");
      if (detailLines.length) titleLine += "\n" + detailLines.join("\n");

      var stream = {
        name: name,
        title: titleLine,
        description: detailLines.join(" | "),
        url: link,
        quality: q,
        isM3u8: false,
        type: "direct",
        subtitles: [],
        provider: "4khdclub",
        headers: { "User-Agent": UA }
      };
      if (poster) stream.image = poster;
      streams.push(stream);
    });

    return streams;
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
