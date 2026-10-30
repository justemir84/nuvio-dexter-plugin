/**
 * uhdmovies - UHDMovies provider for Nuvio
 * Flow: TMDB id -> TMDB title/year -> uhdmovies WordPress search (?s=)
 *       -> post page -> download buttons (thenaukriadda short links)
 *       -> linkpilot POST chain -> driveseed -> video-seed -> direct Google video URL
 *
 * Site: https://uhdmovies.us.org (indirme sitesi)
 * Hermes-safe: Promise chains only, no async/await, no deps.
 *
 * NOT: Bu site akis (streaming) sitesi degildir, indirme sitesidir.
 * Linkler en.thenaukriadda.in uzerinden driveseed.org'a, oradan da
 * video-seed uzerinden Google'in dogrudan video sunucusuna yonlendirir.
 *
 * Eski surumdeki hatalar:
 *  - Ara sayfa GET ile cozulmeye calisiliyordu; halbuki 2 adet POST formu,
 *    bir de lp_go cerezi gerekiyor. Bu yuzden player'da sonsuz buffering oluyordu.
 *  - Kalite etiketi yanlis paragraph'a baglaniyordu; bu yuzden tum 1080p
 *    linkleri "Auto" gorunuyordu.
 */
(function () {
  "use strict";

  var BASE_URL = "https://uhdmovies.us.org";
  var REQUEST_TIMEOUT = 20000;
  var RESOLVE_CONCURRENCY = 3;
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  // Diger provider'larla ayni ortak TMDB v3 anahtari. Kullanici ayarlardan
  // kendi anahtarini girerse o kullanilir.
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";

  function fetchWithTimeout(url, options, timeout) {
    // QuickJS (mobil/TV box) ortaminda setTimeout tanimli olmayabilir.
    // Bu durumda timeout olmadan fetch yap; native katmanin kendi
    // zaman asimi (30-60s) devreye girer.
    if (typeof setTimeout !== "function") {
      return fetch(url, options || {});
    }
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
      .replace(/&#0*38;/gi, "&")
      .replace(/&#0*39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*34;/gi, '"')
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }

  function cleanText(html) {
    return decodeEntities(String(html || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&\w+;/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function qualityFromText(text) {
    var t = String(text || "").toLowerCase();

    // Etiketin sonundaki acik "1080p / 2160p" ifadesini al. Ilk etiketin
    // onunde site tanitimi ("4k & 1080p UHD contents...") olabiliyor; ilk
    // eslesmeyi almak 26GB'lik 2160p linkini 1080p gosteriyordu. Son eslesme
    // ise gercek basliktir. Baslikta gecen "4k" kelimesi (ornek: "Fight Club
    // 4k (1999) ... [1080p ...]") yanlis kalite vermesin.
    var re = /\b(2160|1440|1080|720|576|480)p\b/g;
    var m = null;
    var last = null;
    while ((m = re.exec(t)) !== null) last = m;
    if (last) return last[1] + "p";
    if (/2160|\b4k\b|uhd/.test(t)) return "2160p";
    if (/1440|\b2k\b/.test(t)) return "1440p";
    if (/1080|\bfhd\b/.test(t)) return "1080p";
    if (/720/.test(t)) return "720p";
    if (/576/.test(t)) return "576p";
    if (/480|\bsd\b/.test(t)) return "480p";
    return "Auto";
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720/.test(q)) return 2;
    if (/576|480|sd/.test(q)) return 1;
    return 0;
  }

  function parseSize(text) {
    var re = /\[\s*([\d.,]+\s*(?:TB|GB|MB))\s*\]/gi;
    var m, last = null;
    while ((m = re.exec(String(text || ""))) !== null) last = m;
    if (last) return last[1];
    m = String(text || "").match(/([\d.,]+\s*(?:TB|GB|MB))/i);
    return m ? m[1] : "";
  }

  function extractOgImage(html) {
    var m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    return m ? m[1] : null;
  }

  function absoluteUrl(url, base) {
    if (!url) return null;
    var u = decodeEntities(String(url).trim()).replace(/\\\//g, "/");
    if (/^https?:\/\//i.test(u)) return u;
    if (u.indexOf("//") === 0) return "https:" + u;
    try {
      return new URL(u, base).href;
    } catch (e) {
      var cleanBase = String(base || "").replace(/[^/]*$/, "");
      return cleanBase + u.replace(/^\//, "");
    }
  }

  function originOf(url) {
    try { return new URL(url).origin; } catch (e) {
      var m = String(url || "").match(/^https?:\/\/[^/]+/i);
      return m ? m[0] : "https://en.thenaukriadda.in";
    }
  }

  function escapeRegExp(text) {
    return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ------------------------- cookie jar -------------------------

  function createJar() {
    var jar = {};
    return {
      set: function (name, value) {
        if (name) jar[name] = String(value);
      },
      store: function (res) {
        try {
          if (!res || !res.headers) return;
          var list = [];
          if (typeof res.headers.getSetCookie === "function") {
            try { list = res.headers.getSetCookie() || []; } catch (e) { list = []; }
          }
          if (!list.length && typeof res.headers.get === "function") {
            var raw = res.headers.get("set-cookie") || res.headers.get("Set-Cookie");
            if (raw) list = String(raw).split(/,(?=\s*[A-Za-z0-9_-]+=)/);
          }
          for (var i = 0; i < list.length; i++) {
            var pair = String(list[i]).split(";")[0];
            var eq = pair.indexOf("=");
            if (eq <= 0) continue;
            var name = pair.slice(0, eq).trim();
            var value = pair.slice(eq + 1).trim();
            if (!value || value.toLowerCase() === "deleted") delete jar[name];
            else jar[name] = value;
          }
        } catch (e) {}
      },
      header: function () {
        var parts = [];
        for (var k in jar) {
          if (Object.prototype.hasOwnProperty.call(jar, k)) parts.push(k + "=" + jar[k]);
        }
        return parts.join("; ");
      }
    };
  }

  function buildHeaders(jar, referer, extra) {
    var h = {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    };
    if (jar) {
      var cookie = jar.header();
      if (cookie) h["Cookie"] = cookie;
    }
    if (referer) h["Referer"] = referer;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
      }
    }
    return h;
  }

  function httpGet(url, jar, referer) {
    return fetchWithTimeout(url, { headers: buildHeaders(jar, referer) }).then(function (res) {
      if (jar) jar.store(res);
      return res.text().then(function (text) {
        return { url: res.url || url, status: res.status, text: text, response: res };
      });
    });
  }

  function formBody(fields) {
    var parts = [];
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]));
      }
    }
    return parts.join("&");
  }

  function postForm(url, fields, jar, referer) {
    return fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(jar, referer, {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": originOf(url)
      }),
      body: formBody(fields)
    }).then(function (res) {
      if (jar) jar.store(res);
      return res.text().then(function (text) {
        return { url: res.url || url, status: res.status, text: text, response: res };
      });
    });
  }

  // ------------------------- HTML helpers -------------------------

  function parseForm(html) {
    var re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    var match;
    while ((match = re.exec(html)) !== null) {
      var attrs = match[1];
      var isLp = /lp-land|lp-s\d-form/i.test(attrs);
      if (!isLp) continue;

      var actionMatch = attrs.match(/action=["']([^"']*)["']/i);
      var fields = {};
      var inputRe = /<input\b([^>]*)>/gi;
      var input;
      while ((input = inputRe.exec(match[2])) !== null) {
        var nameMatch = input[1].match(/name=["']([^"']*)["']/i);
        if (!nameMatch) continue;
        var valueMatch = input[1].match(/value=["']([^"']*)["']/i);
        fields[nameMatch[1]] = decodeEntities(valueMatch ? valueMatch[1] : "");
      }
      var count = 0;
      for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) count++;
      }
      if (count) {
        return { action: actionMatch ? actionMatch[1] : "", fields: fields };
      }
    }
    return null;
  }

  function jsRedirect(html) {
    var text = String(html || "");
    var m = text.match(/window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i) ||
      text.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i) ||
      text.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
      text.match(/location\.href\s*=\s*["']([^"']+)["']/i);
    return m ? decodeEntities(m[1].replace(/\\\//g, "/")) : null;
  }

  function metaRefresh(html) {
    var m = String(html || "").match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"']*?url=([^"']+)["']/i);
    return m ? decodeEntities(m[1].replace(/\\\//g, "/")) : null;
  }

  function firstHref(html, pattern) {
    var m = String(html || "").match(pattern);
    return m ? decodeEntities(m[1]) : null;
  }

  // ------------------------- search -------------------------

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

  // ------------------------- post page parsing -------------------------

  // TV sayfalarinda episode butonlari "<span class='mb-text'>Episode 5</span>"
  // seklindedir; kalite/boyut ise bir ustteki "SEASON 1 ... 1080p ... [11 GB/E]"
  // basligindan gelir. Filmlerde ise etiket dogrudan butonun onundedir.
  function lastSeasonFromText(text) {
    var t = String(text || "");
    var re = /SEASON\s*0?(\d{1,2})\b/gi;
    var m, last = null;
    while ((m = re.exec(t)) !== null) last = m;
    if (last) return parseInt(last[1], 10);

    re = /\bS(\d{2})(?:E\d{2})?\b/g;
    while ((m = re.exec(t)) !== null) last = m;
    return last ? parseInt(last[1], 10) : null;
  }

  function parseEpisodeSize(text) {
    var m = String(text || "").match(/\[\s*([\d.,]+\s*(?:TB|GB|MB))\s*\/\s*E\s*\]/i);
    return m ? m[1] : "";
  }

  function pad2(n) {
    n = parseInt(n, 10);
    if (isNaN(n)) return "";
    return n < 10 ? "0" + n : String(n);
  }

  // Her indirme butonundan once gelen baslik blogunu (kalite + boyut) alir.
  // Eski kod paragraph'lara bakiyordu; HTML'de kapatilmayan <p> etiketleri
  // yuzunden 1080p etiketleri bir sonraki linke kayiyordu.
  function parseDownloadLinks(html, isTv, season, episode) {
    var links = [];
    var poster = extractOgImage(html);
    var anchorRe = /<a\b[^>]*class=["'][^"']*(?:maxbutton-download-g-drive|maxbutton-gdrive-episode)[^"']*["'][^>]*>/gi;
    var anchors = [];
    var match;

    while ((match = anchorRe.exec(html)) !== null) {
      // Once kapanis etiketini bul; aradaki bosluk bir sonraki butonun
      // etiketini degil, sadece ayirici/bolum basligini icersin.
      var close = html.indexOf("</a>", anchorRe.lastIndex);
      var innerEnd = close === -1 ? Math.min(html.length, anchorRe.lastIndex + 250) : close;
      anchors.push({
        index: match.index,
        end: close === -1 ? anchorRe.lastIndex : close + 4,
        tag: match[0],
        inner: cleanText(html.slice(anchorRe.lastIndex, innerEnd))
      });
    }

    var currentSeason = null;
    var currentQuality = "";
    var currentSize = "";
    var currentRelease = "";

    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var hrefMatch = anchor.tag.match(/href=["']([^"']+)["']/i);
      var href = hrefMatch ? decodeEntities(hrefMatch[1]) : "";
      if (!href || /^javascript:/i.test(href) || href === "#") continue;

      var start = i === 0 ? Math.max(0, anchor.index - 1500) : anchors[i - 1].end;
      var gap = cleanText(html.slice(start, anchor.index));

      if (!isTv) {
        // Etiketi son boyut parantezinden geriye dogru al; boylece ilk
        // butonda once gelen site tanitimi ("4k & 1080p UHD contents...")
        // kalite tespitine karismaz.
        var lastSize = null;
        var sizeRe = /\[\s*[\d.,]+\s*(?:TB|GB|MB)\s*\]/gi;
        var sm;
        while ((sm = sizeRe.exec(gap)) !== null) lastSize = sm;
        var labelStart = lastSize ? Math.max(0, lastSize.index - 260) : Math.max(0, gap.length - 320);
        var label = gap.slice(labelStart);

        links.push({
          url: absoluteUrl(href, BASE_URL),
          quality: qualityFromText(label),
          size: parseSize(label),
          text: label,
          poster: poster
        });
        continue;
      }

      // --- TV: bolum numarasi butonun icinden, kalite/boyut basliktan ---
      var seasonHit = lastSeasonFromText(gap);
      if (seasonHit !== null) currentSeason = seasonHit;

      var gapQuality = qualityFromText(gap);
      var hasSize = /[\d.,]+\s*(?:TB|GB|MB)/i.test(gap);
      if (gapQuality !== "Auto" && hasSize) {
        currentQuality = gapQuality;
        currentSize = parseEpisodeSize(gap) || parseSize(gap);
        currentRelease = gap.slice(-180);
      }

      var epMatch = anchor.inner.match(/Episode\s*(\d+)/i);
      var isPack = /zip|pack/i.test(anchor.inner);
      if (!epMatch || isPack) continue;

      var epNum = parseInt(epMatch[1], 10);
      var seasonNum = currentSeason;

      var wantSeason = season ? parseInt(season, 10) : null;
      var wantEp = episode ? parseInt(episode, 10) : null;

      if (wantEp && epNum !== wantEp) continue;
      if (wantSeason && seasonNum !== null && seasonNum !== wantSeason) continue;

      links.push({
        url: absoluteUrl(href, BASE_URL),
        quality: currentQuality || gapQuality || "Auto",
        size: currentSize || parseEpisodeSize(gap) || parseSize(gap),
        text: currentRelease,
        season: seasonNum,
        episode: epNum,
        poster: poster
      });
    }

    // Ayni URL birden fazla kez gelebilir.
    var seen = {};
    links = links.filter(function (link) {
      if (!link.url || seen[link.url]) return false;
      seen[link.url] = true;
      return true;
    });

    // Cok fazla link varsa yuksek kaliteleri one al ve makul sayida tut.
    links.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    if (links.length > 12) links = links.slice(0, 12);

    return links;
  }

  // ------------------------- thenaukriadda chain -------------------------

  // 1) GET sid -> form#lp-land (_lp_http)
  // 2) POST -> form#lp-s1-form (_lp_http2 + token + chain + hop)
  // 3) POST -> stage2 (lp_go token + JS cookie degeri)
  // 4) GET ?lp_go=... (cerez ile) -> driveseed / video-seed yonlendirmesi
  function resolveThenaukri(sidUrl) {
    var jar = createJar();
    // Site ilk POST'ta bu test cerezini bekliyor.
    jar.set("lp_ck_test", "1");

    var referer = sidUrl;

    function finish(html, pageUrl) {
      var goMatch = String(html || "").match(/lp_go=([^"'&\\\s]+)/i);
      if (!goMatch) return Promise.resolve(null);
      var token = goMatch[1];

      var scRe = new RegExp("sc\\(\\s*[\"']" + escapeRegExp(token) + "[\"']\\s*,\\s*[\"']([^\"']+)[\"']", "i");
      var valueMatch = scRe.exec(html);
      if (valueMatch) {
        jar.set(token, decodeEntities(valueMatch[1].replace(/\\\//g, "/").replace(/\\"/g, '"')));
      }

      var goUrl = originOf(sidUrl) + "/?lp_go=" + encodeURIComponent(token);
      return httpGet(goUrl, jar, pageUrl).then(function (res) {
        var dest = jsRedirect(res.text) || metaRefresh(res.text);
        return dest ? absoluteUrl(dest, res.url) : null;
      });
    }

    function step(html, currentUrl, depth) {
      if (depth > 4) return Promise.resolve(null);

      // Son adim: stage2 sayfasinda lp_go ve cerez degeri var.
      if (/lp_go=/i.test(html)) return finish(html, currentUrl);

      var form = parseForm(html);
      if (!form) return Promise.resolve(null);

      var action = absoluteUrl(form.action || currentUrl, currentUrl);
      var fieldCount = 0;
      for (var k in form.fields) {
        if (Object.prototype.hasOwnProperty.call(form.fields, k)) fieldCount++;
      }
      if (!fieldCount) return Promise.resolve(null);

      return postForm(action, form.fields, jar, referer).then(function (res) {
        referer = action;
        return step(res.text, res.url, depth + 1);
      });
    }

    return httpGet(sidUrl, jar).then(function (res) {
      return step(res.text, res.url, 0);
    }).catch(function () {
      return null;
    });
  }

  // ------------------------- driveseed / video-seed chain -------------------------

  function extractDirectFromWrapper(url) {
    if (!url) return null;
    var wrapper = String(url);

    var m = wrapper.match(/[?&]url=([^&]+)/i);
    if (m) {
      var decoded = m[1].replace(/\\\//g, "/");
      try { decoded = decodeURIComponent(decoded); } catch (e) {}
      if (/^https?:\/\//i.test(decoded) && !/video-seed|video-gen\.xyz/i.test(decoded)) return decoded;
    }

    if (/googleusercontent\.com|workers\.dev|\.mkv(?:$|\?)|\.mp4(?:$|\?)/i.test(wrapper) &&
      !/video-seed|video-gen\.xyz/i.test(wrapper)) {
      return wrapper;
    }
    return null;
  }

  function resolveVideoGen(link, jar, referer) {
    var abs = absoluteUrl(link, referer);
    if (!abs) return Promise.resolve(null);

    // Mobil/TV (QuickJS) bazi ortamlarda redirect:"manual" desteklenmez.
    // Once normal (auto-follow) fetch dene; Location header varsa onu kullan,
    // yoksa son URL'den (res.url) dogrudan linki cikar.
    return fetchWithTimeout(abs, {
      headers: buildHeaders(jar, referer)
    }).then(function (res) {
      if (jar) jar.store(res);

      var loc = null;
      try { loc = res.headers.get("location") || res.headers.get("Location"); } catch (e) {}

      if (loc) {
        var direct = extractDirectFromWrapper(absoluteUrl(loc, abs));
        if (direct) return direct;
      }

      var followed = (res && res.url) ? res.url : abs;
      var direct2 = extractDirectFromWrapper(followed);
      if (direct2) return direct2;

      // Son sans: normal GET ile son URL'yi yakala.
      return httpGet(abs, jar, referer).then(function (r) {
        var u = (r && r.url) ? r.url : abs;
        var direct = extractDirectFromWrapper(u);
        if (direct) return direct;
        var href = firstHref(r.text, /href=["']([^"']*(?:workers\.dev|googleusercontent\.com|\.mkv|\.mp4)[^"']*)["']/i);
        if (href) return absoluteUrl(href, r.url || abs);
        var next = jsRedirect(r.text) || metaRefresh(r.text);
        if (next) return extractDirectFromWrapper(absoluteUrl(next, r.url || abs));
        return null;
      }, function () {
        return null;
      });
    }, function () {
      return httpGet(abs, jar, referer).then(function (r) {
        var u = (r && r.url) ? r.url : abs;
        var direct = extractDirectFromWrapper(u);
        if (direct) return direct;
        var href = firstHref(r.text, /href=["']([^"']*(?:workers\.dev|googleusercontent\.com|\.mkv|\.mp4)[^"']*)["']/i);
        if (href) return absoluteUrl(href, r.url || abs);
        var next = jsRedirect(r.text) || metaRefresh(r.text);
        if (next) return extractDirectFromWrapper(absoluteUrl(next, r.url || abs));
        return null;
      }, function () {
        return null;
      });
    });
  }

  function resolveZfile(link, jar, referer) {
    var abs = absoluteUrl(link, referer);
    if (!abs) return Promise.resolve(null);

    return httpGet(abs, jar, referer).then(function (res) {
      var directHref = firstHref(res.text,
        /href=["']([^"']*(?:workers\.dev|googleusercontent\.com|video-gen\.xyz|video-seed)[^"']*)["']/i);
      if (directHref) {
        var direct = absoluteUrl(directHref, res.url);
        if (/video-seed|video-gen\.xyz/i.test(direct)) {
          return resolveVideoGen(direct, jar, res.url);
        }
        return Promise.resolve(direct);
      }

      var next = jsRedirect(res.text) || metaRefresh(res.text);
      if (next) {
        var absNext = absoluteUrl(next, res.url);
        if (/video-seed|video-gen\.xyz/i.test(absNext)) return resolveVideoGen(absNext, jar, res.url);
        return Promise.resolve(extractDirectFromWrapper(absNext));
      }
      return Promise.resolve(null);
    }).catch(function () {
      return null;
    });
  }

  function resolveDriveSeed(pageUrl) {
    var jar = createJar();
    var current = pageUrl;
    var referer = pageUrl;

    function follow(depth) {
      if (depth > 3) return Promise.resolve(null);
      return httpGet(current, jar, referer).then(function (res) {
        referer = current;
        current = res.url;

        var next = jsRedirect(res.text) || metaRefresh(res.text);
        if (next) {
          current = absoluteUrl(next, res.url);
          return follow(depth + 1);
        }

        var instant = firstHref(res.text,
          /href=["']([^"']*(?:cdn\.video-gen\.xyz|video-gen\.xyz|video-seed)[^"']*)["']/i);
        var zfile = firstHref(res.text,
          /href=["']([^"']*\/zfile\/[^"']+)["']/i);

        var chain = Promise.resolve(null);
        if (instant) {
          chain = chain.then(function (found) {
            return found || resolveVideoGen(instant, jar, res.url);
          });
        }
        if (zfile) {
          chain = chain.then(function (found) {
            return found || resolveZfile(zfile, jar, res.url);
          });
        }
        return chain;
      }, function () {
        return null;
      });
    }

    return follow(0).catch(function () { return null; });
  }

  // ------------------------- link resolution -------------------------

  function resolveOneLink(link) {
    var startUrl = link.url;
    var flow;

    if (/thenaukriadda\./i.test(startUrl)) {
      flow = resolveThenaukri(startUrl).then(function (dest) {
        if (!dest) return null;
        if (/driveseed\.|driveleech\.|video-seed\.|video-gen\./i.test(dest)) {
          return resolveDriveSeed(dest);
        }
        return extractDirectFromWrapper(dest);
      });
    } else if (/driveseed\.|driveleech\.|video-seed\.|video-gen\./i.test(startUrl)) {
      flow = resolveDriveSeed(startUrl);
    } else if (/googleusercontent\.com|workers\.dev/i.test(startUrl)) {
      flow = Promise.resolve(startUrl);
    } else {
      flow = Promise.resolve(null);
    }

    return flow.then(function (directUrl) {
      if (!directUrl || !/^https?:\/\//i.test(directUrl)) {
        console.log("[uhdmovies] Cozulemedi: " + (link.quality || "Auto") + " " + (link.size || ""));
        return null;
      }
      console.log("[uhdmovies] OK: " + (link.quality || "Auto") + " " + (link.size || ""));
      return {
        url: directUrl,
        quality: link.quality || "Auto",
        size: link.size || "",
        text: link.text || "",
        season: link.season || null,
        episode: link.episode || null,
        poster: link.poster || null
      };
    }).catch(function () {
      return null;
    });
  }

  function mapLimit(items, limit, worker) {
    var results = new Array(items.length);
    var index = 0;
    var runners = [];

    function next() {
      if (index >= items.length) return Promise.resolve();
      var i = index++;
      return worker(items[i], i).then(function (value) {
        results[i] = value;
        return next();
      });
    }

    var count = Math.min(limit, items.length);
    for (var i = 0; i < count; i++) runners.push(next());
    return Promise.all(runners).then(function () { return results; });
  }

  // ------------------------- match -------------------------

  function findBestMatch(posts, title, year, season) {
    var t = (title || "").toLowerCase();
    var y = String(year || "");
    var sn = season ? parseInt(season, 10) : null;
    var best = null;
    var bestScore = -1;

    posts.forEach(function (post) {
      var pt = post.title.toLowerCase();
      var score = 0;

      if (pt.indexOf(t) !== -1) score += 10;
      else if (t.split(" ").filter(function (w) { return w.length > 2; }).every(function (w) { return pt.indexOf(w) !== -1; })) score += 5;

      if (y) {
        if (pt.indexOf("(" + y + ")") !== -1) {
          score += 8;
        } else {
          var rangeM = pt.match(/\((\d{4})\s*[-–]\s*(\d{4})\)/);
          if (rangeM && parseInt(y, 10) >= parseInt(rangeM[1], 10) && parseInt(y, 10) <= parseInt(rangeM[2], 10)) {
            // "Breaking Bad (2008-2013)" gibi cok sezonlu paketler.
            score += 4;
          } else {
            var ym = pt.match(/\((\d{4})(?:\s*[-–]\s*\d{4})?\)/);
            // Farkli yil (ornek: Deadpool & Wolverine 2024) veya yil yok:
            // istenen yila ciddi sekilde dusuk puan ver.
            score -= ym ? 6 : 2;
          }
        }
      }

      if (sn !== null) {
        var seasonRe = new RegExp("season\\s*0?" + sn + "\\b", "i");
        if (seasonRe.test(pt)) score += 6;
        else if (pt.indexOf("s" + pad2(sn)) !== -1) score += 4;
        else if (/season|complete|s\d{2}/i.test(pt)) score -= 3;
      }

      if (/collection|trilogy|duology|pack/i.test(pt) && t && pt.indexOf(t) === -1) score -= 2;

      if (score > bestScore) {
        bestScore = score;
        best = post;
      }
    });

    return bestScore > 0 ? best : null;
  }

  // ------------------------- settings -------------------------

  function onSettings() {
    return [
      { type: "header", label: "UHDMovies" },
      {
        type: "text",
        key: "tmdbApiKey",
        label: "Personal TMDB API key",
        placeholder: "TMDB v3 API key",
        description: "UHDMovies basligi ve yilini bulmak icin TMDB kullanir. Bos birakilirsa gomulu TMDB anahtari kullanilir; istersen kendi v3 anahtarini girebilirsin."
      }
    ];
  }

  // ------------------------- main -------------------------

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[uhdmovies]";
    var isTv = mediaType === "tv";
    settings = (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) || settings || {};
    var tmdbKey = settings.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;

    if (!tmdbKey) {
      console.log(tag + " TMDB API anahtari ayarlanmamis. Nuvio'da UHDMovies eklenti ayarlarindan TMDB API Key girin.");
      return Promise.resolve([]);
    }

    return tmdbLookup(tmdbId, isTv, tmdbKey).then(function (info) {
      if (!info) return [];
      var title = info.title || info.name || "";
      var year = String(info.release_date || info.first_air_date || "").slice(0, 4);
      var display = title + (year ? " (" + year + ")" : "");
      if (isTv && season) display += " S" + pad2(season) + (episode ? "E" + pad2(episode) : "");

      var query = title;
      if (isTv && season) query += " Season " + season;
      else if (year) query += " " + year;

      console.log(tag + " Searching: " + query);

      return searchPosts(query).then(function (posts) {
        console.log(tag + " Arama sonucu: " + posts.length + " yayin");
        var match = findBestMatch(posts, title, year, season);
        if (!match) {
          console.log(tag + " Eslesme bulunamadi, alternatif arama deneniyor");
          var fallback = isTv ? title + (year ? " " + year : "") : title;
          return searchPosts(fallback).then(function (posts2) {
            return findBestMatch(posts2, title, year, season);
          });
        }
        return match;
      }).then(function (match) {
        if (!match) {
          console.log(tag + " Eslesen yayin bulunamadi");
          return [];
        }
        console.log(tag + " Eslesen sayfa: " + match.title);

        return fetchText(match.url, { headers: { "User-Agent": UA } }).then(function (html) {
          var links = parseDownloadLinks(html, isTv, season, episode);
          console.log(tag + " Indirme butonu: " + links.length +
            " (" + links.map(function (l) {
              return (isTv && l.season ? "S" + pad2(l.season) + "E" + pad2(l.episode) + " " : "") + l.quality;
            }).join(", ") + ")");

          if (!links.length) return [];

          return mapLimit(links, RESOLVE_CONCURRENCY, resolveOneLink).then(function (resolved) {
            var streams = [];
            var seen = {};

            resolved.forEach(function (item) {
              if (!item || !item.url || seen[item.url]) return;
              seen[item.url] = true;

              var q = item.quality || "Auto";
              var epTag = isTv && item.season ? "S" + pad2(item.season) + "E" + pad2(item.episode) + " " : "";
              var label = item.text ? item.text.replace(/\s*\[\s*[\d.,]+\s*(?:TB|GB|MB)\s*\]\s*$/i, "").trim() : "";
              if (label.length > 90) label = label.slice(0, 88) + "...";

              streams.push({
                name: "UHDMovies " + epTag + q + (item.size ? " [" + item.size + "]" : ""),
                title: display + "\n" + q + (item.size ? " | " + item.size : "") + (label ? "\n" + label : ""),
                url: item.url,
                quality: q,
                isM3u8: false,
                type: "direct",
                subtitles: [],
                provider: "uhdmovies",
                headers: { "User-Agent": UA }
              });
              if (item.poster) streams[streams.length - 1].image = item.poster;
            });

            streams.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
            console.log(tag + " Found " + streams.length + " streams");
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
