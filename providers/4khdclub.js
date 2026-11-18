/**
 * 4khdclub - 4K-HD.Club provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB baslik/yil -> 4k-hd.club DLE arama -> film/dizi sayfasi
 *   -> indirme butonlari (TakeFile / MoonDL)
 *   -> TakeFile dosya/klasor sayfasi -> dogrudan oynatilabilir dosya URL'i
 *
 * Site bir indirme (download) sitesidir; sayfadaki butonlar TakeFile/MoonDL
 * HTML indirme sayfalaridir. Eski surumde bu HTML linkleri oldugu gibi stream
 * olarak donduruldugu icin player hicbir icerigi acamiyordu.
 *
 * Artik TakeFile linkleri cozuluyor:
 *   GET dosya sayfasi (dil cerezi ile) -> POST op=download2
 *   -> 302 Location: https://fsNN.takefile.link/d/<token>/<dosya>.mkv
 *   Bu URL byte-range (HTTP 206) destekler, player oynatabilir.
 *
 * TV serileri klasor linki verir; klasor sayfasindan bolum dosyasi secilir.
 *
 * MoonDL ucretsiz indirme reCAPTCHA + 1000 MB limiti ile kilitli oldugu icin
 * cozulemiyor; oynatilamayacak HTML linkleri listeye girmesin diye elenir.
 *
 * Hermes/QuickJS uyumlu: sadece var/fonksiyon, async/await yok, zincir promise.
 */
(function () {
  "use strict";

  var BASE_URL = "https://4k-hd.club";
  var TAKEFILE_HOME = "https://takefile.link/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var REQUEST_TIMEOUT = 20000;
  var MAX_LINKS = 4;
  var TAG = "[4khdclub]";

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  // ------------------------------------------------------------ text utils

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

  function absoluteUrl(url, base) {
    url = decodeEntities(String(url || "").trim()).replace(/\\\//g, "/");
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf("//") === 0) return "https:" + url;
    var origin = String(base || "").match(/^(https?:\/\/[^\/]+)/i);
    if (url.charAt(0) === "/") return origin ? origin[1] + url : url;
    var dir = String(base || "").replace(/[^\/]*$/, "");
    return dir + url;
  }

  function originOf(url) {
    var m = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
    return m ? m[1] : "";
  }

  function getHeader(res, name) {
    try {
      if (res && res.headers && typeof res.headers.get === "function") {
        return res.headers.get(name) || res.headers.get(name.toLowerCase()) || null;
      }
    } catch (e) {}
    return null;
  }

  function escapeRegExp(text) {
    return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --------------------------------------------------------------- network

  // QuickJS/Hermes ortaminda setTimeout tanimli olmayabilir; bu durumda
  // timeout olmadan fetch yapilir, native katmanin zaman asimi devreye girer.
  function fetchWithTimeout(url, options, timeout) {
    if (typeof setTimeout !== "function") {
      return fetch(url, options || {});
    }
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout || REQUEST_TIMEOUT);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchText(url, referer) {
    var headers = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
    if (referer) headers["Referer"] = referer;
    return fetchWithTimeout(url, { headers: headers }).then(function (res) {
      if (!res || (res.status && res.status >= 400)) return null;
      return res.text();
    }, function () {
      return null;
    });
  }

  // ------------------------------------------------------------- cookie jar

  function createJar() {
    var jar = {};
    return {
      set: function (name, value) {
        if (name) jar[name] = String(value);
      },
      get: function (name) {
        return jar[name] || "";
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

  // TakeFile ilk istekte lang cerezi olmadan 302 ile kendine yonlendirir;
  // bu yuzden dil cerezi basindan gonderilir, ref_url ise 4k-hd sayfasini tutar.
  function ensureCookies(jar, referer) {
    if (jar && !jar.get("lang")) jar.set("lang", "english");
    if (jar && referer && !jar.get("ref_url")) jar.set("ref_url", encodeURIComponent(referer));
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

  function formBody(fields) {
    var parts = [];
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]));
      }
    }
    return parts.join("&");
  }

  // GET + el ile yonlendirme takibi (cerezleri biz yonetiyoruz).
  function httpGet(url, jar, referer, depth) {
    depth = depth || 0;
    if (depth > 4) return Promise.resolve(null);
    ensureCookies(jar, referer);

    return fetchWithTimeout(url, {
      headers: buildHeaders(jar, referer),
      redirect: "manual"
    }).then(function (res) {
      if (jar) jar.store(res);
      var status = (res && res.status) || 0;

      if (status >= 300 && status < 400) {
        var loc = getHeader(res, "location");
        if (!loc) return null;
        var next = absoluteUrl(loc, url);
        if (!next || next === url) return null;
        return httpGet(next, jar, referer, depth + 1);
      }

      if (status === 0) {
        // redirect:"manual" desteklenmiyor; normal takip ile bir kez dene.
        if (depth > 0) return null;
        return fetchWithTimeout(url, { headers: buildHeaders(jar, referer) }).then(function (res2) {
          if (jar) jar.store(res2);
          if (!res2 || (res2.status && res2.status >= 400)) return null;
          return res2.text().then(function (text) {
            return { status: res2.status || 200, url: (res2 && res2.url) || url, text: text };
          }, function () { return null; });
        }, function () { return null; });
      }

      if (status >= 400) return null;
      return res.text().then(function (text) {
        return { status: status, url: (res && res.url) || url, text: text };
      }, function () { return null; });
    }, function () {
      return null;
    });
  }

  // -------------------------------------------------------------- takefile

  function isTakefileUrl(url) {
    return /takefile\.link\//i.test(String(url || ""));
  }

  function isFolderUrl(url) {
    return /takefile\.link\/folder\//i.test(String(url || ""));
  }

  function isHtmlPage(url) {
    return /\.html(\?|#|$)/i.test(String(url || "")) || /takefile\.link\/folder\//i.test(String(url || ""));
  }

  // Dogrudan dosya linki mi? (fs44.takefile.link/d/<token>/<dosya>.mkv)
  function isDirectFileUrl(url) {
    if (!url) return false;
    if (isHtmlPage(url)) return false;
    if (/takefile\.link\/d\//i.test(url)) return true;
    if (/\.(mkv|mp4|m4v|webm|avi|ts)(\?|#|$)/i.test(url)) return true;
    return false;
  }

  function inputValue(html, name) {
    var m = String(html || "").match(
      new RegExp("<input[^>]*name=[\"']" + escapeRegExp(name) + "[\"'][^>]*>", "i")
    );
    if (!m) return "";
    var v = m[0].match(/value=["']([^"']*)["']/i);
    return v ? decodeEntities(v[1]) : "";
  }

  // Hata/kota sayfasi: "You have reached the download-limit: 10240 Mb ..."
  // Dikkat: normal indirme sayfasi da "No downloads captcha" metni icerir;
  // bu yuzden yalnizca acik hata ifadeleri hata sayilir.
  function takefileError(html) {
    var s = String(html || "");
    var m = s.match(/msgp-card[\s\S]{0,600}?<p>([\s\S]*?)<\/p>/i);
    if (m) return cleanText(m[1]) || "bilinmeyen hata";
    if (/wrong captcha|captcha (?:is )?required|verify (?:that )?you are human/i.test(s)) return "captcha gerekli";
    if (/download-limit/i.test(s)) return "indirme limiti asildi";
    return "";
  }

  function inputFields(html) {
    var fields = {};
    var re = /<input\b([^>]*)>/gi;
    var m;
    while ((m = re.exec(String(html || ""))) !== null) {
      var attrs = m[1];
      var nm = attrs.match(/name=["']([^"']*)["']/i);
      if (!nm) continue;
      var val = attrs.match(/value=["']([^"']*)["']/i);
      fields[nm[1]] = val ? decodeEntities(val[1]) : "";
    }
    return fields;
  }

  /**
   * TakeFile dosya sayfasini dogrudan dosya URL'ine cozer.
   * 1) GET sayfa (session + form alanylari)
   * 2) POST op=download2 -> 302 Location: dogrudan dosya linki
   */
  function resolveTakefileFile(filePageUrl, jar, referer, depth) {
    depth = depth || 0;

    return httpGet(filePageUrl, jar, referer).then(function (page) {
      if (!page || !page.text) {
        console.log(TAG + " TakeFile sayfasi alinamadi: " + filePageUrl);
        return null;
      }

      var err = takefileError(page.text);
      if (err) {
        console.log(TAG + " TakeFile engeli: " + err);
        return null;
      }

      var parsed = inputFields(page.text);
      var fields = {
        op: parsed.op || "download2",
        id: parsed.id || (String(filePageUrl).match(/takefile\.link\/([^\/]+)\//i) || [])[1] || "",
        rand: parsed.rand || "",
        referer: parsed.referer || referer || "",
        method_free: parsed.method_free || "",
        method_premium: parsed.method_premium || ""
      };

      if (!fields.id) {
        console.log(TAG + " TakeFile dosya id'si bulunamadi");
        return null;
      }

      ensureCookies(jar, referer);

      var opts = {
        method: "POST",
        headers: buildHeaders(jar, referer, {
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": originOf(filePageUrl),
          // Yonlendirme takip edilirse govde 80GB dosya olmasin diye
          // sadece ilk 2 bayt istenir (redirect manual destekli ortamda
          // zaten kullanilmaz).
          "Range": "bytes=0-1"
        }),
        body: formBody(fields),
        redirect: "manual"
      };

      return fetchWithTimeout(filePageUrl, opts).then(function (res) {
        if (jar) jar.store(res);
        var status = (res && res.status) || 0;
        var finalUrl = (res && res.url) || "";

        // --- manual redirect: Location header dogrudan dosya linkidir
        if (status >= 300 && status < 400) {
          var loc = getHeader(res, "location");
          if (!loc) return null;
          var abs = absoluteUrl(loc, filePageUrl);
          if (!abs || abs === filePageUrl) return null;      // sayfaya geri: oturum/kota
          if (isHtmlPage(abs)) return null;                  // baska bir HTML sayfasi
          return abs;
        }

        // --- redirect:"manual" yok: takip edilmis cevap gelmis olabilir
        if (finalUrl && finalUrl !== filePageUrl && isDirectFileUrl(finalUrl)) return finalUrl;

        if (status === 0) return null;

        var ct = getHeader(res, "content-type") || "";
        if (ct && !/text\/html|xml/i.test(ct)) return null;   // govde video ama URL bilinmiyor

        return res.text().then(function (html) {
          var e = takefileError(html);
          if (e) console.log(TAG + " TakeFile engeli: " + e);
          return null;
        }, function () { return null; });
      }, function () {
        return null;
      });
    }).then(function (direct) {
      // Ilk deneme oturum/kota kaynakli geri yonlendirmeyse bir kez daha dene.
      if (direct || depth > 0) return direct;
      return resolveTakefileFile(filePageUrl, createJar(), referer, depth + 1);
    });
  }

  // <TR> satirlarindan klasor icerigi: {url, name, size}
  function parseFolder(html) {
    var files = [];
    var rows = String(html || "").split(/<TR>/i);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var m = row.match(/<a href="(https:\/\/takefile\.link\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!m) continue;
      var url = decodeEntities(m[1]);
      if (!/\.html(\?|#|$)/i.test(url)) continue;
      var name = cleanText(m[2]);
      if (!name) continue;
      var sm = row.match(/([\d.,]+\s*(?:TB|GB|MB|KB))/i);
      files.push({ url: url, name: name, size: sm ? sm[1] : "" });
    }
    return files;
  }

  function episodeFromName(name) {
    var s = String(name || "");
    var m = s.match(/S(\d{1,2})[.\s_-]*E(\d{1,3})/i);
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    m = s.match(/\bE[Pp]?[.\s_-]*(\d{1,3})\b/);
    if (m) return { season: null, episode: parseInt(m[1], 10) };
    m = s.match(/\bepisode[.\s_-]*(\d{1,3})\b/i);
    if (m) return { season: null, episode: parseInt(m[1], 10) };
    return null;
  }

  // Klasor iceriginden istenen bolumu (filmlerde tum dosyalari) sec.
  function pickFolderFiles(files, isTv, season, episode) {
    if (!files || !files.length) return [];
    if (!isTv) return files.slice(0, 3);

    var wantS = parseInt(season, 10) || null;
    var wantE = parseInt(episode, 10) || null;
    var exact = [];
    var epOnly = [];

    for (var i = 0; i < files.length; i++) {
      var info = episodeFromName(files[i].name);
      if (!info || info.episode === null) continue;
      if (wantE && info.episode !== wantE) continue;
      if (info.season !== null && wantS !== null && info.season !== wantS) continue;
      if (info.season !== null) exact.push(files[i]);
      else epOnly.push(files[i]);
    }
    if (exact.length) return exact.slice(0, 2);
    if (epOnly.length) return epOnly.slice(0, 2);

    // Dosya adlarinda bolum bilgisi yoksa sirali klasor varsayimi.
    if (files.length === 1) return files;
    if (wantE && wantE <= files.length) return [files[wantE - 1]];
    return [];
  }

  // ---------------------------------------------------------- site parsing

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

  function searchPosts(query) {
    var url = BASE_URL + "/index.php?do=search&subaction=search&story=" + encodeURIComponent(query);
    return fetchText(url).then(function (html) {
      return html ? parseSearch(html) : [];
    });
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
      if (!/^https?:\/\//i.test(href)) return;
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

  function qualityFromText(url) {
    var s = String(url || "");
    var m = s.match(/\b(2160|1440|1080|720|576|480)p\b/i);
    if (m) return m[1] + "p";
    if (/2160|\b4k\b|uhd/i.test(s)) return "2160p";
    if (/\b2k\b/i.test(s)) return "1440p";
    if (/\b1080\b|\bfhd\b/i.test(s)) return "1080p";
    return "2160p";
  }

  function hostLabel(url) {
    var host = "";
    try {
      host = new URL(String(url)).hostname.replace(/^www\./i, "");
    } catch (e) {
      host = (String(url).match(/^[a-z]+:\/\/([^\/]+)/i) || [, ""])[1] || "";
      host = host.replace(/^www\./i, "");
    }
    if (/takefile/i.test(host)) return "TakeFile";
    if (/moondl/i.test(host)) return "MoonDL";
    return host || "4k-hd.club";
  }

  function uniqueAudioFormats(audioSection) {
    var set = {};
    var out = [];
    var parts = String(audioSection || "").split("|");
    parts.forEach(function (p) {
      p = p.trim();
      if (!p) return;
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

  // ----------------------------------------------------------- aday zinciri

  // Sayfadaki indirme butonlarini cozulebilir TakeFile adaylarina cevirir.
  // Klasor linkleri (TV) acilir, istenen bolum dosyasi secilir.
  function collectCandidates(hostLinks, ctx, jar) {
    var out = [];

    var chain = Promise.resolve(null);
    hostLinks.forEach(function (link) {
      chain = chain.then(function () {
        if (out.length >= MAX_LINKS) return null;

        if (!isTakefileUrl(link)) {
          console.log(TAG + " Elendi (cozulemeyen host): " + hostLabel(link) + " -> " + link);
          return null;
        }

        if (isFolderUrl(link)) {
          return httpGet(link, jar, ctx.referer).then(function (page) {
            if (!page) {
              console.log(TAG + " TakeFile klasoru okunamadi: " + link);
              return null;
            }
            var files = parseFolder(page.text);
            var picked = pickFolderFiles(files, ctx.isTv, ctx.season, ctx.episode);
            console.log(TAG + " Klasor: " + files.length + " dosya, " + picked.length + " aday" +
              (ctx.isTv ? " (S" + ctx.season + "E" + ctx.episode + ")" : ""));
            picked.forEach(function (f) {
              if (out.length >= MAX_LINKS) return;
              out.push({ pageUrl: f.url, name: f.name, size: f.size, source: link });
            });
            return null;
          });
        }

        out.push({ pageUrl: link, name: "", size: "", source: link });
        return null;
      });
    });

    return chain.then(function () { return out; });
  }

  function resolveCandidates(candidates, jar, referer) {
    var out = [];
    var blocked = "";

    var chain = Promise.resolve(null);
    candidates.forEach(function (cand) {
      chain = chain.then(function () {
        if (blocked || out.length >= MAX_LINKS) return null;
        return resolveTakefileFile(cand.pageUrl, jar, referer).then(function (direct) {
          if (direct) {
            cand.direct = direct;
            out.push(cand);
            console.log(TAG + " Cozuldu: " + direct);
          } else {
            // Kota/captcha gibi bir engel varsa diger linkleri denemeyi birak.
            blocked = blocked || "TakeFile linki cozulemedi";
            console.log(TAG + " Cozulemedi: " + cand.pageUrl);
          }
          return null;
        });
      });
    });

    return chain.then(function () { return out; });
  }

  // --------------------------------------------------------------- tmdb

  function tmdbDetails(tmdbId, type, apiKey, season) {
    var isTv = type === "tv" || type === "series";
    var endpoint = isTv ? "tv" : "movie";
    return fetchWithTimeout(
      "https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId +
      "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US",
      { headers: { "User-Agent": UA, "Accept": "application/json" } }
    ).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data) return null;
      var title = isTv ? (data.name || "") : (data.title || "");
      var year = "";
      var rawDate = isTv ? data.first_air_date : data.release_date;
      if (rawDate) year = String(rawDate).slice(0, 4);

      // Dizide sezon yayin yili "Season 4 2014" gibi eslestirmeleri guclendirir.
      if (!isTv || !season) return { title: title, year: year };

      return fetchWithTimeout(
        "https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + season +
        "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US",
        { headers: { "User-Agent": UA, "Accept": "application/json" } }
      ).then(function (sres) {
        if (sres && sres.ok) return sres.json();
        return null;
      }).then(function (sdata) {
        if (sdata && sdata.air_date) year = String(sdata.air_date).slice(0, 4);
        return { title: title, year: year };
      }, function () {
        return { title: title, year: year };
      });
    }).catch(function () {
      return null;
    });
  }

  // ------------------------------------------------------------- main

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var isTv = mediaType === "tv" || mediaType === "series";
    var apiKey = getTmdbKey(settings);
    if (!apiKey) {
      console.log(TAG + " TMDB API key missing");
      return Promise.resolve([]);
    }

    var jar = createJar();

    return tmdbDetails(tmdbId, isTv ? "tv" : "movie", apiKey, season).then(function (info) {
      if (!info || !info.title) {
        console.log(TAG + " TMDB details not found");
        return [];
      }

      var title = info.title;
      var year = info.year;
      console.log(TAG + " Searching: " + title + (year ? " (" + year + ")" : ""));

      var query = title;
      if (isTv && season) query += " Season " + season;
      else if (year) query += " " + year;

      var searches = [query];
      if (isTv) searches.push(title + (year ? " " + year : ""));
      searches.push(title);

      var chain = Promise.resolve(null);
      searches.forEach(function (q) {
        chain = chain.then(function (found) {
          if (found) return found;
          return searchPosts(q).then(function (posts) {
            return findBestMatch(posts, title, year, season, isTv);
          });
        });
      });

      return chain.then(function (match) {
        if (!match) {
          console.log(TAG + " No matching page found");
          return [];
        }

        console.log(TAG + " Matched page: " + match.title + " -> " + match.url);

        return fetchText(match.url, BASE_URL + "/").then(function (html) {
          if (!html) {
            console.log(TAG + " Post page could not be fetched");
            return [];
          }

          var hostLinks = parseDownloadLinks(html);
          if (!hostLinks.length) {
            console.log(TAG + " Download buttons not found");
            return [];
          }

          var pageTitleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
          var pageTitle = pageTitleMatch ? cleanText(pageTitleMatch[1]) : (title + (year ? " " + year : ""));

          var sizeMatch = html.match(/File [Ss]ize:\s*<i>\s*([^<]+?)\s*<\/i>/i);
          if (!sizeMatch) sizeMatch = html.match(/File size:\s*([0-9.]+\s*[A-Z]+)/i);
          var size = sizeMatch ? cleanText(sizeMatch[1]) : "";

          var ogMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
          var poster = ogMatch ? decodeEntities(ogMatch[1]) : null;
          if (!poster) {
            var imgMatch = html.match(/<div class="full-news-top-wrap">[\s\S]*?<img src="([^"]+)"/i);
            if (imgMatch) poster = absoluteUrl(imgMatch[1], BASE_URL + "/");
          }

          function section(name) {
            var re = new RegExp(
              '<div class="stb-sp-title">\\s*' + name + '\\s*</div>\\s*<div class="stb-sp-content">([\\s\\S]*?)</div>',
              "i"
            );
            var m = String(html || "").match(re);
            if (!m) return "";
            return m[1].replace(/<br\s*\/?>/gi, " | ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          }

          var videoSection = section("Video");
          var audioSection = section("Audio");
          var subsSection = section("Subtitles");

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

          var ctx = {
            isTv: isTv,
            season: season,
            episode: episode,
            referer: match.url
          };

          console.log(TAG + " Download buttons: " + hostLinks.length);

          return collectCandidates(hostLinks, ctx, jar).then(function (candidates) {
            if (!candidates.length) {
              console.log(TAG + " No resolvable TakeFile link");
              return [];
            }
            console.log(TAG + " Resolving " + candidates.length + " link(s)");
            return resolveCandidates(candidates, jar, match.url);
          }).then(function (resolved) {
            if (!resolved.length) {
              console.log(TAG + " No playable stream (host limit / captcha / dead link)");
              return [];
            }

            var streams = [];
            var seen = {};

            resolved.forEach(function (item) {
              var url = item.direct;
              if (!url || seen[url]) return;
              seen[url] = true;

              var q = qualityFromText(item.name || item.pageUrl || url);
              var epTag = "";
              if (isTv) {
                var epInfo = episodeFromName(item.name || "") || episodeFromName(url);
                if (epInfo && epInfo.episode !== null) {
                  epInfo.episode < 10 ? (epTag = "E0" + epInfo.episode) : (epTag = "E" + epInfo.episode);
                  if (epInfo.season !== null) {
                    epTag = (epInfo.season < 10 ? "S0" + epInfo.season : "S" + epInfo.season) + epTag;
                  }
                } else if (season) {
                  var sN = parseInt(season, 10) || 0;
                  var eN = parseInt(episode, 10) || 0;
                  epTag = (sN < 10 ? "S0" + sN : "S" + sN) + (eN < 10 ? "E0" + eN : "E" + eN);
                }
              }

              var fileLabel = item.name || "";
              var itemSize = item.size || size;

              var name = "4KHD Club - TakeFile " + (epTag ? epTag + " " : "") + q +
                (bitrate ? " (" + bitrate + ")" : "");

              var titleLine = pageTitle + (epTag ? " " + epTag : "") + (itemSize ? "\n" + itemSize : "");
              if (fileLabel && fileLabel !== pageTitle) titleLine += "\n" + fileLabel;
              if (detailLines.length) titleLine += "\n" + detailLines.join("\n");

              var stream = {
                name: name,
                title: titleLine,
                description: detailLines.join(" | "),
                url: url,
                quality: q,
                isM3u8: false,
                type: "direct",
                subtitles: [],
                provider: "4khdclub",
                headers: {
                  "User-Agent": UA,
                  "Referer": TAKEFILE_HOME
                }
              };
              if (poster) stream.image = poster;
              streams.push(stream);
            });

            console.log(TAG + " Found " + streams.length + " playable stream(s)");
            return streams;
          });
        });
      });
    }).catch(function (err) {
      console.log(TAG + " Error: " + (err && (err.message || err)));
      return [];
    });
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
