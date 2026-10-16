/**
 * kmmovies - KMMovies provider for Nuvio
 * Flow: TMDB -> title/year -> SITE_DOMAIN search -> detail page
 *   movie: w3.magiclinks.lol links -> WATCH ONLINE (r2.dev direct)
 *          / pixeldrain api direct / skydrop POST -> googleusercontent direct
 *   tv: episodes.magiclinks.lol season+quality pages -> Episode N skydrop
 *       -> POST /fetch/ -> googleusercontent direct
 *
 * Hermes-safe: Promise chains only, no async/await, no generators.
 */
(function () {
  "use strict";

  // Domain değişirse SADECE bu satırı değiştir — dosyanın geri kalanı otomatik uyum sağlar.
  var SITE_DOMAIN = "k1.kmmovies.cam";
  var BASE = "https://" + SITE_DOMAIN;
  var SITE_RE = SITE_DOMAIN.replace(/\./g, "\\.");
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TIMEOUT = 12000;
  var MAX_W3 = 6;

  function headers(referer) {
    var h = {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    };
    if (referer) h["Referer"] = referer;
    return h;
  }

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

  function norm(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function parseQuality(label) {
    var s = String(label || "").toLowerCase();
    if (/2160p/.test(s) || /\b4k\b/.test(s)) return "2160p";
    if (/1080p/.test(s)) return "1080p";
    if (/720p/.test(s)) return "720p";
    if (/480p/.test(s)) return "480p";
    return "HD";
  }

  function pad2(n) {
    n = parseInt(n, 10);
    return (n < 10 ? "0" : "") + n;
  }

  // --- TMDB -> title + year ---
  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": UA, "Accept": "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("TMDB " + r.status);
        return r.json();
      })
      .then(function (d) {
        return {
          title: d.name || d.title || d.original_name || d.original_title || "",
          year: (d.first_air_date || d.release_date || "").substring(0, 4)
        };
      });
  }

  var SKIP_PATH = /\/(category|genre|year|actor|director|writer|quality|tag|trending|browse|request|faq|contact-us|about-us|privacy-policy|disclaimer|dmca|site-disclaimer)\//;

  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // --- kmmovies search: /search/<query>/ ---
  function searchOnce(query) {
    var url = BASE + "/search/" + encodeURIComponent(query) + "/";
    return fetchTimeout(url, { headers: headers(BASE + "/") })
      .then(function (r) {
        if (!r.ok) throw new Error("Search " + r.status);
        return r.text();
      })
      .then(function (html) {
        var links = [];
        var re = new RegExp('<a[^>]+href="(https://' + SITE_RE + '/[^"]+/)"[^>]*>', 'gi');
        var m;
        while ((m = re.exec(html)) !== null) {
          if (links.indexOf(m[1]) === -1) links.push(m[1]);
        }
        return links.filter(function (u) {
          if (u === BASE + "/") return false;
          return !SKIP_PATH.test(u);
        });
      });
  }

  function pickBest(links, title, year) {
    var words = String(title).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; });
    var best = null, bestScore = -1;
    for (var i = 0; i < links.length; i++) {
      var slug = links[i].replace(/^https?:\/\/[^\/]+\//, "").replace(/\/$/, "");
      var ns = norm(slug);
      var hit = 0;
      for (var w = 0; w < words.length; w++) {
        if (ns.indexOf(norm(words[w])) !== -1) hit++;
      }
      var score = hit * 10 + ((year && links[i].indexOf(year) !== -1) ? 5 : 0);
      if (score > bestScore) { bestScore = score; best = links[i]; }
    }
    var need = words.length >= 2 ? 2 : 1;
    if (best && bestScore >= need * 10) return best;
    return null;
  }

  function searchDetailUrl(title, year) {
    var words = String(title).split(/[^A-Za-z0-9]+/).filter(function (w) { return w; });
    var queries = [];
    var full = slugify(title);
    if (full) queries.push(full);
    if (words.length >= 2) {
      var two = slugify(words.slice(0, 2).join(" "));
      if (two && queries.indexOf(two) === -1) queries.push(two);
    }
    if (words.length >= 3) {
      var three = slugify(words.slice(0, 3).join(" "));
      if (three && queries.indexOf(three) === -1) queries.push(three);
    }
    // Yeni sitede tireli çok kelimeli slug 0 sonuç verebiliyor; ayırt edici
    // tek kelimeleri de dene (uzundan kısaya, pickBest zaten eler).
    var singles = words.filter(function (w) { return w.length > 3; })
      .sort(function (a, b) { return b.length - a.length; });
    singles.forEach(function (w) {
      var q = slugify(w);
      if (q && queries.indexOf(q) === -1) queries.push(q);
    });
    var chain = Promise.resolve(null);
    queries.forEach(function (q) {
      chain = chain.then(function (found) {
        if (found) return found;
        return searchOnce(q).then(function (links) {
          return pickBest(links, title, year);
        });
      });
    });
    return chain;
  }

  // --- detail page: collect w3 + episodes links with labels + season section ---
  function parseDetail(html) {
    var out = { w3: [], episodes: [] };
    // season section headings to attribute packs to seasons
    var heads = [];
    var hre = /Season\s+(\d+)\s*\(\d+\s*eps?\)/gi;
    var hm;
    while ((hm = hre.exec(html)) !== null) {
      heads.push({ season: parseInt(hm[1], 10), index: hm.index });
    }
    var re = /<a[^>]+href="(https:\/\/(?:w3|episodes)\.magiclinks\.lol\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var url = m[1];
      var label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 120);
      var q = parseQuality(label + " " + url);
      var size = "";
      var sm = label.match(/(\d+(?:\.\d+)?\s*(?:MB|GB))/i);
      if (sm) size = sm[1];
      var season = null;
      for (var h = 0; h < heads.length; h++) {
        if (heads[h].index < m.index) season = heads[h].season;
      }
      if (/^https:\/\/w3\.magiclinks\.lol\//.test(url)) {
        out.w3.push({ url: url, label: label, quality: q, size: size, season: season });
      } else {
        out.episodes.push({ url: url, label: label, quality: q, size: size, season: season });
      }
    }
    return out;
  }

  // --- w3 page html -> watch-online / pixeldrain / skydrop / hubcloud hrefs ---
  function parseW3(html) {
    var res = { watch: null, pixeldrain: [], skydrop: [], hubcloud: [] };
    var m = html.match(/https:\/\/z1\.kmphotos\.cv\/online\.php\?file=[^"'\s<]+/);
    if (m) res.watch = m[0];
    var re2 = /https:\/\/pixeldrain\.com\/u\/([A-Za-z0-9]+)/g;
    var p;
    while ((p = re2.exec(html)) !== null) {
      res.pixeldrain.push("https://pixeldrain.com/api/file/" + p[1] + "?download");
    }
    var re3 = /(https:\/\/w\d+\.skydrop\.sbs\/download\.php\?id=[^"'\s<]+)/g;
    var s;
    while ((s = re3.exec(html)) !== null) {
      if (res.skydrop.indexOf(s[1]) === -1) res.skydrop.push(s[1]);
    }
    var re4 = /(https:\/\/hubcloud\.foo\/drive\/[A-Za-z0-9]+)/g;
    var hc;
    while ((hc = re4.exec(html)) !== null) {
      if (res.hubcloud.indexOf(hc[1]) === -1) res.hubcloud.push(hc[1]);
    }
    return res;
  }

  // --- online.php -> window.VIDEO_URL (r2.dev direct) ---
  function resolveWatchOnline(watchUrl) {
    return fetchTimeout(watchUrl, { headers: headers(BASE + "/") })
      .then(function (r) {
        if (!r.ok) throw new Error("watch " + r.status);
        return r.text();
      })
      .then(function (html) {
        var m = html.match(/window\.VIDEO_URL\s*=\s*"([^"]+)"/);
        if (m) return m[1];
        return null;
      })
      .catch(function () { return null; });
  }

  // --- skydrop: GET (redirects to /id/) -> single POST /fetch/ -> googleusercontent ---
  function resolveSkydrop(skyUrl) {
    var origin;
    try {
      var u = new URL(skyUrl);
      origin = u.protocol + "//" + u.host;
    } catch (e) { return Promise.resolve(null); }
    var jar = {};
    function storeCookies(r) {
      try {
        if (r && r.headers && typeof r.headers.getSetCookie === "function") {
          var arr = r.headers.getSetCookie() || [];
          arr.forEach(function (c) {
            var kv = c.split(";")[0].split("=");
            if (kv.length >= 2) jar[kv[0].trim()] = kv.slice(1).join("=").trim();
          });
        }
      } catch (e) {}
    }
    function cookieHeader() {
      var parts = [];
      for (var k in jar) parts.push(k + "=" + jar[k]);
      return parts.join("; ");
    }
    function get(url, referer) {
      var h = headers(referer);
      var c = cookieHeader();
      if (c) h["Cookie"] = c;
      return fetchTimeout(url, { headers: h }).then(function (r) {
        storeCookies(r);
        return r.text().then(function (t) { return { res: r, text: t }; });
      });
    }
    // 1) landing page (download.php?id= -> follows to /id/)
    return get(skyUrl, BASE + "/").then(function (landed) {
      var pageUrl = (landed.res && landed.res.url) || skyUrl;
      var h = headers(pageUrl);
      var c = cookieHeader();
      if (c) h["Cookie"] = c;
      h["Content-Type"] = "application/x-www-form-urlencoded";
      return fetchTimeout(origin + "/fetch/", {
        method: "POST",
        headers: h,
        body: "",
        redirect: "manual"
      }).then(function (r) {
        storeCookies(r);
        var loc = null;
        try { loc = r.headers.get("location"); } catch (e) {}
        if (loc) {
          if (loc.charAt(0) === "/") loc = origin + loc;
          return isFileUrl(loc) ? loc : null;
        }
        if (r.url && r.url !== origin + "/fetch/" && /^https?:\/\//.test(r.url)) {
          return isFileUrl(r.url) ? r.url : null;
        }
        return null;
      });
    }).catch(function () { return null; });
  }

  function isFileUrl(u) {
    u = String(u || "");
    if (new RegExp("skydrop\\.sbs|magiclinks\\.lol|" + SITE_RE + "|kmphotos\\.cv/(online|download99)\\.php|gofile\\.io|vikingfile\\.com|bzzhr\\.co|transfer\\.it").test(u)) return false;
    return true;
  }

  // resolve one w3 link into 0..n direct streams
  // tv packs skip skydrop (JS-gated interstitial, unresolvable without a browser)
  function resolveW3Link(w3, referer, allowSkydrop) {
    return fetchTimeout(w3.url, { headers: headers(referer) })
      .then(function (r) {
        if (!r.ok) throw new Error("w3 " + r.status);
        return r.text();
      })
      .then(function (html) {
        var parsed = parseW3(html);
        var jobs = [];
        if (parsed.watch) {
          jobs.push(resolveWatchOnline(parsed.watch).then(function (direct) {
            return direct ? [{ url: direct, via: "R2", quality: w3.quality, size: w3.size, label: w3.label }] : [];
          }));
        }
        parsed.pixeldrain.slice(0, 1).forEach(function (pd) {
          jobs.push(Promise.resolve([{ url: pd, via: "Pixeldrain", quality: w3.quality, size: w3.size, label: w3.label }]));
        });
        if (allowSkydrop !== false && !parsed.watch && parsed.pixeldrain.length === 0 && parsed.skydrop.length > 0) {
          jobs.push(resolveSkydrop(parsed.skydrop[0]).then(function (direct) {
            return direct ? [{ url: direct, via: "Drive", quality: w3.quality, size: w3.size, label: w3.label }] : [];
          }));
        }
        if (!jobs.length && allowSkydrop !== false && parsed.skydrop.length > 0) {
          jobs.push(resolveSkydrop(parsed.skydrop[0]).then(function (direct) {
            return direct ? [{ url: direct, via: "Drive", quality: w3.quality, size: w3.size, label: w3.label }] : [];
          }));
        }
        parsed.hubcloud.slice(0, 2).forEach(function (hc) {
          jobs.push(resolveHubcloud(hc, w3.url, w3.quality, w3.size, w3.label));
        });
        return Promise.all(jobs).then(function (arr) {
          var flat = [];
          arr.forEach(function (a) { flat = flat.concat(a); });
          return flat;
        });
      })
      .catch(function () { return []; });
  }

  function resolveW3List(list, referer, max, allowSkydrop) {
    var picked = list.slice(0, max || MAX_W3);
    var chain = Promise.resolve([]);
    picked.forEach(function (w3) {
      chain = chain.then(function (acc) {
        return resolveW3Link(w3, referer, allowSkydrop).then(function (streams) {
          return acc.concat(streams);
        });
      });
    });
    return chain;
  }

  // --- hubcloud: drive page -> gamerxyt redirector -> direct file (workers.dev) ---
  function resolveHubcloud(hubUrl, referer, quality, size, label) {
    return fetchTimeout(hubUrl, { headers: headers(referer) })
      .then(function (r) {
        if (!r.ok) throw new Error("hub " + r.status);
        return r.text();
      })
      .then(function (html) {
        var m = html.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"'\s<]+/);
        if (!m) return [];
        return fetchTimeout(m[0], { headers: headers(hubUrl) }).then(function (r2) {
          if (!r2.ok) throw new Error("hub2 " + r2.status);
          return r2.text();
        });
      })
      .then(function (html) {
        if (!html) return [];
        var found = [];
        var re = /href="(https?:\/\/[^"]+)"/gi;
        var a;
        while ((a = re.exec(html)) !== null) {
          var u = a[1];
          if (found.indexOf(u) === -1 &&
              /\.(mkv|mp4|avi|mov|webm)(\?|#|$)/i.test(u) &&
              isFileUrl(u)) {
            found.push({ url: u, via: "HubCloud", quality: quality, size: size, label: label });
            if (found.length >= 3) break;
          }
        }
        return found;
      })
      .catch(function () { return []; });
  }

  // --- tv: episodes page -> Episode N skydrop link ---
  function resolveEpisode(epPageUrl, episode, referer) {
    return fetchTimeout(epPageUrl, { headers: headers(referer) })
      .then(function (r) {
        if (!r.ok) throw new Error("ep " + r.status);
        return r.text();
      })
      .then(function (html) {
        var ep = parseInt(episode, 10);
        var patterns = [
          new RegExp("Episode\\s*0?" + ep + "[^<]*<\\/[^>]+>\\s*<a[^>]+href=\"([^\"]+)\"", "i"),
          new RegExp("Episode\\s*0?" + ep + "\\s*<a[^>]+href=\"([^\"]+)\"", "i")
        ];
        var m = null, i;
        for (i = 0; i < patterns.length; i++) {
          m = html.match(patterns[i]);
          if (m) break;
        }
        if (!m) {
          // generic: all skydrop links on page, pick by order
          var all = [];
          var re = /(https:\/\/w\d+\.skydrop\.sbs\/download\.php\?id=[^"'\s<]+)/g;
          var s;
          while ((s = re.exec(html)) !== null) all.push(s[1]);
          if (all.length >= ep) return all[ep - 1];
          if (all.length) return all[0];
          return null;
        }
        return m[1];
      })
      .then(function (skyUrl) {
        if (!skyUrl) return null;
        return resolveSkydrop(skyUrl);
      })
      .catch(function () { return null; });
  }

  function makeStream(title, quality, url, via, size) {
    return {
      name: "KMMovies - " + quality + " (" + via + ")",
      title: title + (size ? " | " + size : ""),
      url: url,
      quality: quality,
      isM3u8: false,
      provider: "kmmovies",
      type: "direct"
    };
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 99;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480/.test(q)) return 1;
    return 0;
  }
  function qSort(list) {
    var hd = list.filter(function (s) { return qRank(s.quality) >= 3; });
    var base = hd.length ? hd : list;
    base.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return base;
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[KMMovies]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId +
      (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    var ctx = {};
    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      if (!info.title) { console.log(tag + " TMDB lookup failed"); return []; }
      ctx.title = info.title;
      ctx.year = info.year;
      console.log(tag + " TMDB: " + info.title + " (" + info.year + ")");
      return searchDetailUrl(info.title, info.year);
    }).then(function (detailUrl) {
      if (!detailUrl) { console.log(tag + " No match on kmmovies"); return []; }
      ctx.detailUrl = detailUrl;
      console.log(tag + " Match: " + detailUrl);
      return fetchTimeout(detailUrl, { headers: headers(BASE + "/") }).then(function (r) {
        if (!r.ok) throw new Error("Detail " + r.status);
        return r.text();
      });
    }).then(function (html) {
      if (!html) return [];
      if (typeof html !== "string") return html; // already streams array from early return
      var parsed = parseDetail(html);
      var displayBase = ctx.title + (ctx.year ? " (" + ctx.year + ")" : "");
      if (mediaType === "tv") {
        // episode-wise links are skydrop JS-gated -> use season packs (w3)
        // filtered to the requested season; pack plays the whole season
        var wantS = parseInt(season || 1, 10);
        var packs = parsed.w3.filter(function (w) {
          return w.season === null || w.season === wantS;
        });
        if (!packs.length) packs = parsed.w3.slice();
        if (!packs.length) { console.log(tag + " No season packs"); return []; }
        var order = { "1080p": 0, "720p": 1, "2160p": 2, "480p": 3, "HD": 4 };
        packs.sort(function (a, b) {
          return (order[a.quality] === undefined ? 5 : order[a.quality]) -
            (order[b.quality] === undefined ? 5 : order[b.quality]);
        });
        var display = displayBase + " S" + pad2(wantS) + "E" + pad2(episode || 1) + " Pack";
        return resolveW3List(packs, ctx.detailUrl, MAX_W3, false).then(function (found) {
          var streams = qSort(found.map(function (f) {
            return makeStream(display, f.quality, f.url, f.via, f.size);
          })).slice(0, 10);
          console.log(tag + " Found " + streams.length + " streams");
          return streams;
        });
      }
      // movie: w3 links
      if (!parsed.w3.length) { console.log(tag + " No w3 links"); return []; }
      // prefer 1080p/720p mid sizes first
      var order = { "1080p": 0, "720p": 1, "2160p": 2, "480p": 3, "HD": 4 };
      parsed.w3.sort(function (a, b) {
        return (order[a.quality] === undefined ? 5 : order[a.quality]) -
          (order[b.quality] === undefined ? 5 : order[b.quality]);
      });
      return resolveW3List(parsed.w3, ctx.detailUrl, MAX_W3).then(function (found) {
        var display = displayBase;
        var streams = qSort(found.map(function (f) {
          return makeStream(display, f.quality, f.url, f.via, f.size);
        })).slice(0, 10);
        console.log(tag + " Found " + streams.length + " streams");
        return streams;
      });
    }).catch(function (err) {
      console.log(tag + " Error: " + (err && err.message));
      return [];
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
