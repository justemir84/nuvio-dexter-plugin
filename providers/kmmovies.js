/**
 * kmmovies - KMMovies provider for Nuvio
 * Flow: TMDB -> title/year -> SITE_DOMAIN search -> detail page
 *   movie: w3.magiclinks.lol links -> WATCH ONLINE (r2.dev direct)
 *          / pixeldrain api direct / skydrop -> googleusercontent direct
 *   tv: episodes.magiclinks.lol (<slug>-sNN-<quality>) -> Episode N
 *       -> skydrop -> googleusercontent direct (per-episode files)
 *       season packs (w3 combined/zip) as last-resort fallback
 * Skydrop chain: GET download.php (session cookie) -> POST /resolve/ (JSON)
 *   -> GET /id/ (file-ready page) -> POST /fetch/ (302 -> direct file)
 *
 * Hermes-safe: Promise chains only, no async/await, no generators.
 */
(function () {
  "use strict";

  // Domain değişirse SADECE bu satırı değiştir — dosyanın geri kalanı otomatik uyum sağlar.
  var SITE_DOMAIN = "kmmovies.autos";
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
  function parseDetail(html, pageUrl) {
    var out = { w3: [], episodes: [] };
    // Season attribution: content tabs are data-type="episodes-N|combined-N|zip-N"
    // (N = 0-based section index). Page slug says which seasons it covers
    // (e.g. "breaking-bad-s01-s05-..."); map section index -> real season.
    var startS = null;
    var um = String(pageUrl || "").match(/(?:^|[-/])s(\d{1,2})(?:-s\d{1,2})?(?=[-/]|$)/i);
    if (um) startS = parseInt(um[1], 10);
    var marks = [];
    var mre = /data-type="(?:episodes|combined|zip)-(\d+)"/gi;
    var mk;
    while ((mk = mre.exec(html)) !== null) {
      marks.push({ index: mk.index, num: parseInt(mk[1], 10) });
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
      var lastNum = null;
      for (var h = 0; h < marks.length; h++) {
        if (marks[h].index < m.index) lastNum = marks[h].num;
      }
      var season = (lastNum === null || startS === null) ? null : startS + lastNum;
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

  // --- skydrop (2-stage): GET download.php (session cookie)
  //   -> POST /resolve/ -> JSON { success, ready_url } (pending/busy -> poll)
  //   -> GET ready_url page (/id/, "file ready") -> POST /fetch/
  //   -> 302 Location = direct file (googleusercontent)
  function resolveSkydrop(skyUrl) {
    var origin;
    try {
      var u = new URL(skyUrl);
      origin = u.protocol + "//" + u.host;
    } catch (e) { return Promise.resolve(null); }
    var jar = {};
    var landingUrl = skyUrl;
    function storeCookie(c) {
      if (!c) return;
      var kv = String(c).split(";")[0].split("=");
      if (kv.length >= 2) jar[kv[0].trim()] = kv.slice(1).join("=").trim();
    }
    function storeCookies(r) {
      try {
        if (!r || !r.headers) return;
        var arr = [];
        if (typeof r.headers.getSetCookie === "function") {
          try { arr = r.headers.getSetCookie() || []; } catch (e) { arr = []; }
        }
        // Nuvio (QuickJS/React Native) exposes only headers.get(), not getSetCookie().
        if (!arr.length && typeof r.headers.get === "function") {
          var sc = r.headers.get("set-cookie") || r.headers.get("Set-Cookie");
          if (sc) arr = String(sc).split(/,(?=\s*[A-Za-z0-9_-]+=)/);
        }
        arr.forEach(storeCookie);
      } catch (e) {}
    }
    function cookieHeader() {
      var parts = [];
      for (var k in jar) parts.push(k + "=" + jar[k]);
      return parts.join("; ");
    }
    function hdr(referer, extra) {
      var h = headers(referer);
      var c = cookieHeader();
      if (c) h["Cookie"] = c;
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    }
    function wait(ms) {
      return new Promise(function (res) { setTimeout(res, ms); });
    }
    // 1) landing page sets the download session cookie
    return fetchTimeout(skyUrl, { headers: hdr(BASE + "/") }).then(function (landed) {
      storeCookies(landed);
      landingUrl = (landed && landed.url) || skyUrl;
      // 2) POST /resolve/ -> JSON
      function tryResolve(count) {
        return fetchTimeout(origin + "/resolve/", {
          method: "POST",
          headers: hdr(landingUrl, { "Origin": origin }),
          body: ""
        }).then(function (r) {
          storeCookies(r);
          return r.text().then(function (t) {
            var j = null;
            try { j = JSON.parse(t); } catch (e) { return null; }
            if (j && j.ready_url) return j.ready_url;
            if (count < 4 && j && (j.pending || j.busy)) {
              var ms2 = j.poll_after_ms || j.retry_after_ms ||
                (j.auto_refresh && j.auto_refresh.retry_after_ms) || 2500;
              return wait(Math.min(ms2 || 2500, 5000)).then(function () { return tryResolve(count + 1); });
            }
            return null;
          });
        }, function () { return null; });
      }
      return tryResolve(0);
    }).then(function (ready) {
      if (!ready) return null;
      // some files may resolve straight to the file
      if (/^https?:\/\//.test(ready) && ready.indexOf("skydrop") === -1 && isFileUrl(ready)) return ready;
      var readyAbs = ready.indexOf("http") === 0 ? ready : origin + ready;
      // 3) file-ready page (usually /id/)
      return fetchTimeout(readyAbs, { headers: hdr(landingUrl) }).then(function (pg) {
        storeCookies(pg);
        var pgUrl = (pg && pg.url) || readyAbs;
        // 4) form submit -> 302 Location = direct file
        return fetchTimeout(origin + "/fetch/", {
          method: "POST",
          headers: hdr(pgUrl, { "Origin": origin, "Content-Type": "application/x-www-form-urlencoded" }),
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
      });
    }).catch(function () { return null; });
  }

  function isFileUrl(u) {
    u = String(u || "");
    if (new RegExp("skydrop\\.sbs|magiclinks\\.lol|" + SITE_RE + "|kmphotos\\.cv/(online|download99)\\.php|gofile\\.io|vikingfile\\.com|bzzhr\\.co|transfer\\.it").test(u)) return false;
    return true;
  }

  // resolve one w3 link into 0..n direct streams (R2 / Pixeldrain / HubCloud / Skydrop)
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
        parsed.hubcloud.slice(0, 2).forEach(function (hc) {
          jobs.push(resolveHubcloud(hc, w3.url, w3.quality, w3.size, w3.label));
        });
        return Promise.all(jobs).then(function (arr) {
          var flat = [];
          arr.forEach(function (a) { flat = flat.concat(a); });
          if (flat.length) return flat;
          // last resort: skydrop (download.php -> /resolve/ -> /id/ -> /fetch/)
          if (allowSkydrop === false || !parsed.skydrop.length) return flat;
          return resolveSkydrop(parsed.skydrop[0]).then(function (direct) {
            return direct ? [{ url: direct, via: "Drive", quality: w3.quality, size: w3.size, label: w3.label }] : flat;
          });
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

  // --- tv: episodes page -> Episode N link ---
  function findEpisodeLink(html, episode) {
    var want = parseInt(episode, 10);
    var parts = String(html).split(/<div class="ep-row"/i);
    for (var i = 1; i < parts.length; i++) {
      var seg = parts[i];
      var nm = seg.match(/<span class="ep-name">\s*Episode\s*0?(\d+)/i);
      if (!nm || parseInt(nm[1], 10) !== want) continue;
      var sk = seg.match(/(https:\/\/w\d+\.skydrop\.sbs\/download\.php\?id=[^"'\s<]+)/);
      if (sk) return sk[1];
      var fm = seg.match(/href="(https?:\/\/[^"]+\.(?:mkv|mp4)[^"]*)"/i);
      if (fm) return fm[1];
      return null;
    }
    return null;
  }

  function resolveEpisode(epPageUrl, episode, referer) {
    return fetchTimeout(epPageUrl, { headers: headers(referer) })
      .then(function (r) {
        if (!r.ok) throw new Error("ep " + r.status);
        return r.text();
      })
      .then(function (html) {
        var link = findEpisodeLink(html, episode);
        if (!link) return null;
        if (/skydrop\.sbs/.test(link)) {
          return resolveSkydrop(link).then(function (direct) {
            return direct ? { url: direct, via: "Skydrop" } : null;
          });
        }
        return isFileUrl(link) ? { url: link, via: "Direct" } : null;
      })
      .catch(function () { return null; });
  }

  function codecFromLabel(s) {
    s = String(s || "").toLowerCase();
    return /x265|hevc|h265|h\.265/.test(s) ? "HEVC" : (/x264|h264|h\.264|avc/.test(s) ? "H.264" : "");
  }

  function makeStream(title, quality, url, via, size, label) {
    var ctag = codecFromLabel(label);
    return {
      name: "KMMovies - " + quality + (ctag ? " " + ctag : "") + " (" + via + ")",
      title: title + (size ? " | " + size : "") + (ctag ? " | " + ctag : ""),
      url: url,
      quality: quality,
      isM3u8: false,
      provider: "kmmovies",
      type: "direct"
    };
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

  // episode page preference: plain > 10bit > special (2008/hq/bluray)
  function epPageRank(u) {
    u = String(u || "").toLowerCase();
    if (/10bit/.test(u)) return 1;
    if (/2008|bluray|hq/.test(u)) return 2;
    return 0;
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
      var parsed = parseDetail(html, ctx.detailUrl);
      var displayBase = ctx.title + (ctx.year ? " (" + ctx.year + ")" : "");
      if (mediaType === "tv") {
        var wantS = parseInt(season || 1, 10);
        var wantE = parseInt(episode || 1, 10);
        var display = displayBase + " S" + pad2(wantS) + "E" + pad2(wantE);
        // 1) per-episode: episodes.magiclinks.lol season+quality pages
        var selRe = new RegExp("(?:^|[-/])s0?" + wantS + "(?:[-/]|$)", "i");
        var epPages = parsed.episodes.filter(function (w) { return selRe.test(w.url); });
        epPages.sort(function (a, b) {
          var d = qRank(b.quality) - qRank(a.quality);
          if (d) return d;
          return epPageRank(a.url) - epPageRank(b.url);
        });
        var picked = [], seenQ = {};
        epPages.forEach(function (w) {
          var qk = w.quality || "HD";
          if (seenQ[qk]) return;
          seenQ[qk] = 1;
          if (picked.length < 3) picked.push(w);
        });
        var chain = Promise.resolve([]);
        picked.forEach(function (pg) {
          chain = chain.then(function (acc) {
            if (acc.length >= 2) return acc;
            return resolveEpisode(pg.url, wantE, ctx.detailUrl).then(function (got) {
              console.log(tag + " ep " + pg.quality + " -> " + (got && got.url ? "ok" : "fail"));
              if (got && got.url) {
                acc.push(makeStream(display, pg.quality, got.url, got.via || "Skydrop", "", pg.label));
              }
              return acc;
            });
          });
        });
        return chain.then(function (streams) {
          if (streams.length) {
            var out0 = streams.slice().sort(function (a, b) {
              return qRank(b.quality) - qRank(a.quality);
            }).slice(0, 6);
            console.log(tag + " Found " + out0.length + " streams (episode-wise)");
            return out0;
          }
          // 2) last resort: season packs (combined w3 groups)
          var packs = parsed.w3.filter(function (w) {
            return w.season === null || w.season === wantS;
          });
          if (!packs.length) { console.log(tag + " No episode links / packs"); return []; }
          var order = { "1080p": 0, "720p": 1, "2160p": 2, "480p": 3, "HD": 4 };
          packs.sort(function (a, b) {
            return (order[a.quality] === undefined ? 5 : order[a.quality]) -
              (order[b.quality] === undefined ? 5 : order[b.quality]);
          });
          var packDisplay = display + " Pack";
          return resolveW3List(packs, ctx.detailUrl, 4, true).then(function (found) {
            var streams2 = qSort(found.map(function (f) {
              return makeStream(packDisplay, f.quality, f.url, f.via, f.size, f.label);
            })).slice(0, 10);
            console.log(tag + " Found " + streams2.length + " streams (pack)");
            return streams2;
          });
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
          return makeStream(display, f.quality, f.url, f.via, f.size, f.label);
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
