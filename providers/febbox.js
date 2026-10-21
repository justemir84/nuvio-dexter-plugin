/**
 * febbox - SuperStream / Febbox provider for Nuvio
 * Flow: TMDB ID -> IMDB ID -> Showbox search -> Share key -> File list -> Video qualities -> Direct video URLs
 * Requires: Febbox token (from Nuvio settings or local HTTP server)
 * Hermes-safe: Promise chains only, no async/await, no Node.js deps.
 */
(function () {
  "use strict";

  var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
  var FOURTH_API = "https://showbox.media";
  var THIRD_API  = "https://www.febbox.com";
  var TMDB_BASE  = "https://api.themoviedb.org/3";
  var REQUEST_TIMEOUT = 15000;

  var BASE_HEADERS = {
    "Accept": "application/json, text/html, */*",
    "Accept-Language": "en",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
  };

  var VIDEO_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.8",
    "Connection": "keep-alive",
    "Range": "bytes=0-",
    "Referer": "https://www.febbox.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
  };

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

  function httpGet(url, headers, timeout) {
    return fetchWithTimeout(url, { headers: headers || BASE_HEADERS }, timeout);
  }

  function copyObj(src) {
    var out = {};
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = src[keys[i]];
    }
    return out;
  }

  function normalizeToken(token) {
    if (!token) return "";
    if (token.indexOf("eyJ") === 0) return "ui=" + token;
    if (token.indexOf("ui=") === 0) return token;
    return "ui=" + token;
  }

  function episodeSlug(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function extractQuality(str) {
    if (!str) return "Unknown";
    var m = str.match(/(\d{3,4})[pP]/);
    return m ? m[1] + "p" : String(str).toUpperCase();
  }

  function parseQualityDivs(html) {
    var results = [];
    var re = /<div[^>]*class="[^"]*file_quality[^"]*"[^>]*>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var tag = m[0];
      var uM = tag.match(/data-url="([^"]+)"/);
      var qM = tag.match(/data-quality="([^"]+)"/);
      if (uM && qM) {
        results.push({
          url: uM[1].replace(new RegExp("\\/", "g"), "/"),
          quality: qM[1]
        });
      }
    }
    return results;
  }

  function parseSearchHref(html, baseUrl) {
    var m = html.match(/class="film-name[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"/i)
         || html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*film-name[^"]*"/i);
    return m ? baseUrl + m[1] : null;
  }

  function parseHeadingId(html) {
    var m = html.match(/class="heading-name[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i);
    if (!m) return null;
    var parts = m[1].split("/");
    var id = parseInt(parts[parts.length - 1]);
    return isNaN(id) ? null : id;
  }

  function getFebboxToken(settingsToken, localTokenUrl) {
    if (settingsToken) return Promise.resolve(settingsToken);
    if (!localTokenUrl) return Promise.resolve("");
    return fetchWithTimeout(localTokenUrl, { headers: BASE_HEADERS }, 10000)
      .then(function (resp) {
        if (!resp.ok) throw new Error("Local server error: " + resp.status);
        return resp.text();
      })
      .then(function (text) {
        var token = text.trim();
        return token || "";
      })
      .catch(function () { return ""; });
  }

  function getImdbId(tmdbId, mediaType) {
    var url1 = TMDB_BASE + "/" + mediaType + "/" + encodeURIComponent(tmdbId) + "/external_ids?api_key=" + TMDB_API_KEY;
    return httpGet(url1, BASE_HEADERS, 10000)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.imdb_id) return data.imdb_id;
        var url2 = TMDB_BASE + "/" + mediaType + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_API_KEY + "&language=en-US";
        return httpGet(url2, BASE_HEADERS, 10000)
          .then(function (r2) { return r2.ok ? r2.json() : null; })
          .then(function (d2) { return (d2 && d2.imdb_id) ? d2.imdb_id : null; });
      })
      .catch(function () { return null; });
  }

  function searchSuperstream(imdbId) {
    var url = FOURTH_API + "/search?keyword=" + encodeURIComponent(imdbId);
    return httpGet(url, BASE_HEADERS, 10000)
      .then(function (res) {
        if (!res.ok) return null;
        return res.text();
      })
      .then(function (html) {
        if (!html) return null;
        var href = parseSearchHref(html, FOURTH_API);
        if (!href) return null;
        return httpGet(href, BASE_HEADERS, 10000)
          .then(function (r2) {
            if (!r2.ok) return null;
            return r2.text();
          })
          .then(function (h2) {
            return h2 ? parseHeadingId(h2) : null;
          });
      })
      .catch(function () { return null; });
  }

  function getShareKey(mediaId, type) {
    var url = FOURTH_API + "/index/share_link?id=" + encodeURIComponent(mediaId) + "&type=" + type;
    return httpGet(url, BASE_HEADERS, 10000)
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        var link = (data && data.data && data.data.link) ? data.data.link : null;
        if (!link) return null;
        var parts = link.split("/");
        return parts[parts.length - 1] || null;
      })
      .catch(function () { return null; });
  }

  function getFileList(shareKey, parentId, page) {
    page = page || 1;
    var url = THIRD_API + "/file/file_share_list?share_key=" + encodeURIComponent(shareKey);
    if (parentId) url += "&parent_id=" + encodeURIComponent(parentId) + "&page=" + page;
    return httpGet(url, BASE_HEADERS, 10000)
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        return (data && data.data) ? data.data : null;
      })
      .catch(function () { return null; });
  }

  function getVideoQualities(fid, shareKey, token) {
    var cookieHeader = normalizeToken(token);
    var url = THIRD_API + "/console/video_quality_list?fid=" + encodeURIComponent(fid) + "&share_key=" + encodeURIComponent(shareKey);
    var hdrs = copyObj(BASE_HEADERS);
    if (cookieHeader) hdrs["Cookie"] = cookieHeader;
    return httpGet(url, hdrs, 12000)
      .then(function (res) {
        if (!res.ok) return [];
        return res.json();
      })
      .then(function (data) {
        var h = (data && data.html) ? data.html : "";
        return h ? parseQualityDivs(h) : [];
      })
      .catch(function () { return []; });
  }

  function onSettings() {
    return [
      { type: "header", label: "Febbox / SuperStream" },
      {
        type: "text",
        key: "febboxToken",
        label: "Febbox Token (ui=...)",
        placeholder: "Leave empty to use Local Token URL",
        description: "Token from Febbox console. Can also be fetched from Local Token URL below."
      },
      {
        type: "text",
        key: "localTokenUrl",
        label: "Local Token URL",
        placeholder: "http://192.168.1.x:8080/cookie_show.txt",
        description: "Optional: URL to fetch token from your Android Simple HTTP Server."
      }
    ];
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[febbox]";
    settings = (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) || settings || {};
    var febboxToken = settings.febboxToken || "";
    var localTokenUrl = settings.localTokenUrl || "http://192.168.1.244:8080/cookie_show.txt";

    return getFebboxToken(febboxToken, localTokenUrl).then(function (token) {
      if (!token) {
        console.log(tag + " No Febbox token available. Set febboxToken in Nuvio settings or configure Local Token URL.");
        return [];
      }
      token = normalizeToken(token);

      return getImdbId(String(tmdbId), mediaType)
        .then(function (imdbId) {
          if (!imdbId) throw new Error("IMDB ID not found");
          return imdbId;
        })
        .then(function (imdbId) {
          return searchSuperstream(imdbId);
        })
        .then(function (mediaId) {
          if (!mediaId) throw new Error("Media ID not found");
          var type = (mediaType === "tv") ? 2 : 1;
          return getShareKey(mediaId, type);
        })
        .then(function (shareKey) {
          if (!shareKey) throw new Error("Share key not found");
          return getFileList(shareKey, null, 1);
        })
        .then(function (data) {
          if (!data) return [];
          var fileList = data.file_list || [];
          if (!fileList.length) return [];

          if (mediaType === "tv" && season && episode) {
            var seasonStr = episodeSlug(season);
            var episodeStr = episodeSlug(episode);
            var seasonFolders = fileList.filter(function (f) {
              if (!f || !f.is_dir || !f.file_name) return false;
              var name = f.file_name.toLowerCase();
              return name.indexOf("season " + parseInt(seasonStr)) !== -1 ||
                     name.indexOf("s" + seasonStr) !== -1;
            });
            if (!seasonFolders.length) {
              seasonFolders = fileList.filter(function (f) { return f && f.is_dir; });
            }
            if (!seasonFolders.length) return [];

            var seasonFid = seasonFolders[0].fid;
            return getFileList(shareKey, seasonFid, 1)
              .then(function (epData) {
                if (!epData) return [];
                var epList = epData.file_list || [];
                var epFile = epList.filter(function (f) {
                  if (!f || f.is_dir) return false;
                  var name = (f.file_name || "").toLowerCase();
                  return name.indexOf("e" + episodeStr) !== -1 ||
                         name.indexOf("ep" + episodeStr) !== -1 ||
                         name.indexOf("episode " + parseInt(episodeStr)) !== -1;
                });
                if (!epFile.length) epFile = epList.filter(function (f) { return f && !f.is_dir; });
                if (!epFile.length) return [];
                return getVideoQualities(epFile[0].fid, shareKey, token);
              });
          } else {
            var videoFiles = fileList.filter(function (f) { return f && !f.is_dir; });
            if (!videoFiles.length) return [];
            return getVideoQualities(videoFiles[0].fid, shareKey, token);
          }
        })
        .then(function (qualities) {
          if (!qualities || !qualities.length) return [];
          return qualities.map(function (q) {
            return {
              name: "Febbox " + extractQuality(q.quality),
              url: q.url,
              quality: extractQuality(q.quality),
              isM3u8: false,
              type: "direct",
              subtitles: [],
              provider: "febbox",
              headers: VIDEO_HEADERS
            };
          });
        })
        .catch(function (err) {
          console.log(tag + " Error: " + (err && err.message));
          return [];
        });
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
