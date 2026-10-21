/**
 * uhdmovies - UHDMovies.us.org provider for Nuvio
 * Flow: TMDB id -> TMDB title/year -> UHDMovies WordPress search (?s=) -> post page
 *       -> thenaukriadda ad-gate -> DriveSeed -> Google video CDN (direct MKV/MP4)
 * Hermes-safe: Promise chains only, no async/await, no deps.
 */
(function () {
  "use strict";

  var BASE_URL = "https://uhdmovies.us.org";
  var REQUEST_TIMEOUT = 12000;
  var RESOLVE_TIMEOUT = 24000;
  var MAX_STREAMS = 5;
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  // Ayni anahtar diger Nuvio saglayicilarinda de kullaniliyor; ayarlardan bos birakilirsa bu kullanilir.
  var DEFAULT_TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";

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
    var path = isTv ? "/tv/" : "/movie/";
    return fetchWithTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function baseHeaders(extra) {
    var h = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function createJar() {
    var jar = {};
    return {
      store: function (res) {
        try {
          if (!res || !res.headers) return;
          var arr = [];
          if (typeof res.headers.getSetCookie === "function") arr = res.headers.getSetCookie() || [];
          if (!arr.length && typeof res.headers.get === "function") {
            var sc = res.headers.get("set-cookie") || res.headers.get("Set-Cookie");
            if (sc) arr = String(sc).split(/,(?=\s*[A-Za-z0-9_-]+=)/);
          }
          arr.forEach(function (c) {
            var kv = String(c).split(";")[0].split("=");
            if (kv.length >= 2) jar[kv[0].trim()] = kv.slice(1).join("=").trim();
          });
        } catch (e) {}
      },
      set: function (k, v) { jar[k] = v; },
      header: function () {
        var parts = [];
        for (var k in jar) parts.push(k + "=" + jar[k]);
        return parts.join("; ");
      }
    };
  }

  function request(url, options, jar) {
    var opt = options || {};
    var h = baseHeaders(opt.headers);
    if (jar) {
      var c = jar.header();
      if (c) h.Cookie = c;
    }
    opt.headers = h;
    return fetchWithTimeout(url, opt).then(function (res) {
      if (jar) jar.store(res);
      return res;
    });
  }

  function readPage(res, fallbackUrl) {
    return res.text().then(function (html) {
      return { html: html, url: res.url || fallbackUrl };
    });
  }

  function getPage(url, jar) {
    return request(url, {}, jar).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return readPage(res, url);
    });
  }

  function absoluteUrl(base, href) {
    href = String(href || "").replace(/\\\//g, "/");
    if (/^https?:\/\//i.test(href)) return href;
    if (href.indexOf("//") === 0) return "https:" + href;
    if (href.charAt(0) === "/") {
      var m = String(base || "").match(/^(https?:\/\/[^\/]+)/i);
      return (m ? m[1] : BASE_URL) + href;
    }
    return String(base || BASE_URL).replace(/\/[^\/]*$/, "/") + href;
  }

  function cleanText(html) {
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&#8211;|&#8212;/gi, "-")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&\w+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractOgImage(html) {
    var m = String(html || "").match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    return m ? m[1] : null;
  }

  // "UHDMovies" kanal adi 4K sanilmasin: kelime siniri kullan.
  function qualityFromText(text) {
    var t = " " + String(text || "").toLowerCase() + " ";
    if (/\b(2160p?|4k|uhd)\b/.test(t)) return "2160p";
    if (/\b(1440p?|2k)\b/.test(t)) return "1440p";
    if (/\b1080p?\b/.test(t)) return "1080p";
    if (/\b720p?\b/.test(t)) return "720p";
    if (/\b(480p?|sd)\b/.test(t)) return "480p";
    return "Auto";
  }

  function sizeFromText(text) {
    var m = String(text || "").match(/\[\s*([\d.]+\s*(?:GB|MB))\s*\]/i);
    return m ? m[1].replace(/\s+/g, "") : "";
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480|sd/.test(q)) return 1;
    return 2.5;
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

  // Post icindeki indirme butonlarini sirayla bulur; kalite/boyut etiketi
  // butonun bulundugu <hr> blogunun basindaki aciklamadir.
  function parseDownloadLinks(html, isTv, season, episode) {
    var links = [];
    var seen = {};
    var segments = String(html || "").split(/<hr\b[^>]*>|<div[^>]*mks_separator[^>]*>/i);

    segments.forEach(function (seg) {
      var anchors = seg.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
      var groupLabel = "";
      if (isTv) {
        groupLabel = cleanText(seg).replace(/Episode\s*0?\d+/gi, " ").replace(/\s+/g, " ").trim();
        if (groupLabel.length > 240) groupLabel = groupLabel.slice(0, 240);
      }

      anchors.forEach(function (a) {
        if (a.indexOf("thenaukriadda.in") === -1 && a.indexOf("drive.google.com") === -1) return;
        var hrefMatch = a.match(/href="([^"]+)"/i);
        if (!hrefMatch) return;
        var href = hrefMatch[1].replace(/&amp;/g, "&");
        var anchorText = cleanText(a);
        var isEpisode = /maxbutton-gdrive-episode/i.test(a);
        var isMovieBtn = /maxbutton-download-g-drive|maxbutton-gdrive/i.test(a);
        if (!isEpisode && !isMovieBtn) return;

        var label = isTv ? groupLabel : cleanText(seg);
        if (!isTv) {
          label = label.replace(/Download\s*\(G-Drive\)/ig, " ")
            .replace(/Download\s*From\s*Google\s*Drive/ig, " ")
            .replace(/\s+/g, " ").trim();
          if (label.length > 240) label = label.slice(0, 240);
        }

        var epNum = 0;
        var epMatch = anchorText.match(/(?:episode|ep|e)\s*0*(\d+)/i);
        if (epMatch) epNum = parseInt(epMatch[1], 10);

        var quality = qualityFromText(label);
        var size = sizeFromText(label);

        if (isTv && episode && epNum && epNum !== parseInt(episode, 10)) return;
        if (isTv && !episode && epNum) return;

        var key = href + "|" + quality + "|" + epNum;
        if (seen[key]) return;
        seen[key] = true;

        links.push({
          url: href,
          label: label,
          quality: quality,
          size: size,
          episode: epNum
        });
      });
    });

    return links;
  }

  function findBestMatch(posts, title, year, season, isTv) {
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
      if (isTv && season) {
        var sn = String(season);
        if (new RegExp("season\\s*0?" + sn + "\\b", "i").test(pt) || new RegExp("s0?" + sn + "e", "i").test(pt)) score += 3;
      }

      if (score > bestScore) {
        bestScore = score;
        best = post;
      }
    });

    return bestScore > 0 ? best : null;
  }

  function parseLpForm(html) {
    var forms = String(html || "").match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      var inputRe = /<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi;
      var inputs = [];
      var m;
      while ((m = inputRe.exec(form)) !== null) {
        inputs.push([m[1], m[2].replace(/&amp;/g, "&")]);
      }
      if (!inputs.length) continue;
      var hasLp = inputs.some(function (x) { return x[0].indexOf("_lp_") === 0; });
      if (!hasLp) continue;
      var action = (form.match(/action="([^"]*)"/i) || [])[1] || "";
      return { action: action, inputs: inputs };
    }
    return null;
  }

  function postForm(url, form, jar) {
    var body = form.inputs.map(function (x) {
      return encodeURIComponent(x[0]) + "=" + encodeURIComponent(x[1]);
    }).join("&");
    var origin = (String(url).match(/^(https?:\/\/[^\/]+)/i) || [])[1] || BASE_URL;
    return request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
        Referer: origin + "/"
      },
      body: body
    }, jar).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return readPage(res, url);
    });
  }

  function jsRedirect(html) {
    var m = String(html || "").match(/window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i);
    return m ? m[1].replace(/\\\//g, "/") : "";
  }

  function findInstantLink(html) {
    var anchors = String(html || "").match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
    for (var i = 0; i < anchors.length; i++) {
      var text = cleanText(anchors[i]);
      if (!/instant\s*download/i.test(text)) continue;
      var href = (anchors[i].match(/href="([^"]+)"/i) || [])[1];
      if (href) return href.replace(/&amp;/g, "&");
    }
    var m = String(html || "").match(/https?:\/\/cdn\.video-gen\.xyz\/[^"'\s<>]+/i);
    return m ? m[0] : "";
  }

  function queryParam(url, name) {
    var q = String(url || "").split("#")[0].split("?")[1] || "";
    var parts = q.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0] === name) {
        try { return decodeURIComponent(kv.slice(1).join("=")); } catch (e) { return kv.slice(1).join("="); }
      }
    }
    return "";
  }

  function googleVideoTarget(res, fallbackUrl) {
    var finalUrl = res.url || fallbackUrl || "";
    var target = queryParam(finalUrl, "url");
    if (!target && res.headers && typeof res.headers.get === "function") {
      var loc = res.headers.get("location") || "";
      target = queryParam(loc, "url");
    }
    if (target && /googleusercontent\.com/i.test(target)) return target;
    return "";
  }

  function resolveCdn(cdnUrl, jar) {
    return request(cdnUrl, { headers: { Referer: "https://driveseed.org/" } }, jar).then(function (res) {
      var target = googleVideoTarget(res, cdnUrl);
      if (target) return target;
      return res.text().then(function (html) {
        var m = String(html || "").match(/https?:\/\/(?:video-downloads\.)?googleusercontent\.com\/[^"'\s<>]+/i);
        if (m) return m[0];
        throw new Error("CDN hedefi bulunamadi");
      });
    });
  }

  function normalizeDriveUrl(url) {
    if (/googleusercontent\.com/i.test(url)) return url;
    var m = String(url || "").match(/\/file\/d\/([^\/]+)/) || String(url || "").match(/[?&]id=([^&]+)/);
    if (m) return "https://drive.usercontent.google.com/download?id=" + m[1] + "&export=download&confirm=t";
    return url;
  }

  // thenaukriadda ara sayfasi: form POST'lari -> lp_go cookie -> driveseed -> file -> CDN
  function resolveLink(linkUrl) {
    if (/^https?:\/\/(?:drive|docs)\.google\.com\//i.test(linkUrl) || /googleusercontent\.com/i.test(linkUrl)) {
      return Promise.resolve(normalizeDriveUrl(linkUrl));
    }

    var jar = createJar();
    var stageUrl = linkUrl;

    function postStage(page) {
      var form = parseLpForm(page.html);
      if (!form) throw new Error("LP formu bulunamadi");
      return postForm(absoluteUrl(page.url, form.action || page.url), form, jar);
    }

    return getPage(stageUrl, jar)
      .then(postStage)              // _lp_http
      .then(postStage)              // _lp_http2
      .then(function (page) {
        var sc = page.html.match(/sc\(\s*["'](lp-[^"']+)["']\s*,\s*["']([^"']+)["']/i);
        var go = page.html.match(/setAttribute\(\s*["']href["']\s*,\s*["']([^"']*\?lp_go=[^"']+)["']/i) ||
                 page.html.match(/["']([^"']*\?lp_go=[^"']+)["']/i);
        if (!sc || !go) throw new Error("LP devam adimi bulunamadi");
        jar.set(sc[1], sc[2]);
        return getPage(absoluteUrl(page.url, go[1].replace(/\\\//g, "/")), jar);
      })
      .then(function (page) {
        var loc = jsRedirect(page.html);
        if (!loc) throw new Error("DriveSeed yonlendirmesi yok");
        return getPage(absoluteUrl(page.url, loc), jar);
      })
      .then(function (page) {
        var loc = jsRedirect(page.html);
        if (!loc) throw new Error("DriveSeed dosya yonlendirmesi yok");
        return getPage(absoluteUrl(page.url, loc), jar);
      })
      .then(function (page) {
        var cdn = findInstantLink(page.html);
        if (!cdn) throw new Error("DriveSeed indirme linki yok");
        return resolveCdn(absoluteUrl(page.url, cdn), jar);
      });
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error(label + " timeout")); }, ms);
      })
    ]);
  }

  function pickLinks(links) {
    var byQuality = {};
    links.forEach(function (l) {
      var q = l.quality || "Auto";
      if (!byQuality[q]) byQuality[q] = [];
      byQuality[q].push(l);
    });

    var order = ["2160p", "1440p", "1080p", "720p", "480p", "Auto"];
    var picked = [];
    order.forEach(function (q) {
      var arr = byQuality[q] || [];
      var cap = (q === "1080p" || q === "2160p") ? 3 : 1;
      arr.slice(0, cap).forEach(function (l) { if (picked.length < MAX_STREAMS) picked.push(l); });
    });
    return picked;
  }

  function onSettings() {
    return [
      { type: "header", label: "UHDMovies" },
      {
        type: "text",
        key: "tmdbApiKey",
        label: "Personal TMDB API key (optional)",
        placeholder: "Leave blank to use the built-in key",
        description: "Optional TMDB v3 key. Leave blank to use the shared key bundled with the provider."
      }
    ];
  }

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[uhdmovies]";
    var isTv = mediaType === "tv";
    settings = (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) || settings || {};
    var tmdbKey = settings.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || DEFAULT_TMDB_KEY;

    return tmdbLookup(tmdbId, isTv, tmdbKey).then(function (info) {
      if (!info) throw new Error("TMDB lookup failed");
      var title = info.title || info.name || "";
      var year = String(info.release_date || info.first_air_date || "").slice(0, 4);
      var display = title + (year ? " (" + year + ")" : "");
      if (isTv && season) {
        display += " S" + (season < 10 ? "0" + season : season) +
          (episode ? "E" + (episode < 10 ? "0" + episode : episode) : "");
      }

      // Dizilerde bolum numarasi aramaya eklenmez; UHDMovies sezonun tum
      // bolumlerini tek postta "Episode N" butonlariyla listeliyor.
      var query = title + (year ? " " + year : "");
      console.log(tag + " Searching: " + query);

      return searchPosts(query).then(function (posts) {
        var match = findBestMatch(posts, title, year, season, isTv);
        if (!match) {
          console.log(tag + " No matching post found");
          return [];
        }
        console.log(tag + " Matched post: " + match.title);

        return fetchText(match.url, { headers: { "User-Agent": UA } }).then(function (html) {
          var poster = extractOgImage(html);
          var links = parseDownloadLinks(html, isTv, season, episode);
          console.log(tag + " Download links: " + links.length +
            " (" + links.map(function (l) { return l.quality + (l.episode ? "/E" + l.episode : "") + (l.size ? "/" + l.size : ""); }).join(", ") + ")");

          var picked = pickLinks(links);
          if (!picked.length) {
            console.log(tag + " No download links after episode/quality filter");
            return [];
          }

          var jobs = picked.map(function (link) {
            return withTimeout(resolveLink(link.url), RESOLVE_TIMEOUT, "resolve")
              .then(function (direct) {
                if (!direct) return null;
                var q = link.quality || "Auto";
                var size = link.size ? " " + link.size : "";
                var stream = {
                  name: "UHDMovies " + q + size,
                  title: display + "\n" + q + size + (link.label ? "\n" + link.label : ""),
                  url: direct,
                  quality: q,
                  isM3u8: false,
                  type: "direct",
                  subtitles: [],
                  provider: "uhdmovies",
                  headers: { "User-Agent": UA }
                };
                if (link.size) stream.size = link.size;
                if (poster) stream.image = poster;
                return stream;
              })
              .catch(function (err) {
                console.log(tag + " Resolve failed (" + link.quality + "): " + (err && err.message));
                return null;
              });
          });

          return Promise.all(jobs).then(function (results) {
            var streams = results.filter(function (s) { return !!s; });
            streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
            console.log(tag + " Found " + streams.length + " playable streams");
            return streams;
          });
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
