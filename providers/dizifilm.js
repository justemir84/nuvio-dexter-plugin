/**
 * dizifilm - Dizifilm / Dizifilmizle (dizifilm.life, dizifilmizle.to) provider for Nuvio
 *
 * Flow:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> Dizifilm /api/search?q=  (film ve dizi sonuclari)
 *   -> /dizi/{slug}/sezon-{s}/bolum-{e}  (bolum sayfasi, server-rendered JSON icinde embed_player_url_1)
 *   -> vidmixi.com/embed/{id}  (JW Player sifreli yapilandirmesi)
 *   -> CryptoJS.AES.decrypt ile video_location cozulur (master.m3u8)
 *   -> video_location  (master HLS playlist, calisir)
 *
 * Notlar:
 * - Arama API'si /api/search?q= (JSON dondurur)
 * - Bolum sayfasi server-side render edilir; embed_player_url_1 HTML'de yer alir
 * - Vidmixi embed sayfasindaki bePlayer() cagrisindaki sifreli JSON cozulur
 *   (CryptoJS.AES-256-CBC, sifre = video ID, salt/iv = JSON'daki s ve iv alanlari)
 * - Cozulmus video_location bir master.m3u8 URL'sidir
 * - Altyazilar: cozulmus yapilandirmadaki strSubtitles dizisinden alinir
 * - Hermes uyumlu: async/await yok, Promise zinciri kullanilir
 * - AES-256-CBC + EVP_BytesToKey (MD5) pure JavaScript ile uygulanmistir
 */
(function () {
  "use strict";

  var BASE = "https://dizifilm.life";
  var EMBED_REFERER = "https://dizifilmizle.to/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;

  // ---------------------------------------------------------------- crypto: MD5

  function _md5Raw(str) {
    function add32(a, b) {
      return (a + b) & 0xFFFFFFFF;
    }
    function bit_rotate(num, cnt) {
      return (num << cnt) | (num >>> (32 - cnt));
    }
    function md5_ff(a, b, c, d, x, s, t) {
      return add32(bit_rotate(add32(add32(a, f(b, c, d)), add32(x, t)), s), b);
    }
    function md5_gg(a, b, c, d, x, s, t) {
      return add32(bit_rotate(add32(add32(a, g(b, c, d)), add32(x, t)), s), b);
    }
    function md5_hh(a, b, c, d, x, s, t) {
      return add32(bit_rotate(add32(add32(a, h(b, c, d)), add32(x, t)), s), b);
    }
    function md5_ii(a, b, c, d, x, s, t) {
      return add32(bit_rotate(add32(add32(a, md5_i(b, c, d)), add32(x, t)), s), b);
    }
    function f(b, c, d) { return (b & c) | ((~b) & d); }
    function g(b, c, d) { return (b & d) | (c & (~b)); }
    function h(b, c, d) { return b ^ c ^ d; }
    function md5_i(b, c, d) { return c ^ (b | (~d)); }

    var x = _strToArray(str);
    x[str.length >> 2] |= 0x80 << ((str.length % 4) * 8);
    x[(((str.length + 8) >>> 6) << 4) + 14] = str.length * 8;

    var a = 0x67452301;
    var b = 0xEFCDAB89;
    var c = 0x98BADCFE;
    var d = 0x10325476;

    for (var i = 0; i < x.length; i += 16) {
      var olda = a, oldb = b, oldc = c, oldd = d;

      a = md5_ff(a, b, c, d, x[i + 0], 7, 0xD76AA478);
      d = md5_ff(d, a, b, c, x[i + 1], 12, 0xE8C7B756);
      c = md5_ff(c, d, a, b, x[i + 2], 17, 0x242070DB);
      b = md5_ff(b, c, d, a, x[i + 3], 22, 0xC1BDCEEE);
      a = md5_ff(a, b, c, d, x[i + 4], 5, 0xF57C0FAF);
      d = md5_ff(d, a, b, c, x[i + 5], 9, 0x4787C62A);
      c = md5_ff(c, d, a, b, x[i + 6], 14, 0xA8304613);
      b = md5_ff(b, c, d, a, x[i + 7], 20, 0xFD469501);
      a = md5_ff(a, b, c, d, x[i + 8], 5, 0x698098D8);
      d = md5_ff(d, a, b, c, x[i + 9], 9, 0x8B44F7AF);
      c = md5_ff(c, d, a, b, x[i + 10], 14, 0xFFFF5BB1);
      b = md5_ff(b, c, d, a, x[i + 11], 20, 0x895CD7BE);
      a = md5_gg(a, b, c, d, x[i + 1], 5, 0xF57C0FAF);
      d = md5_gg(d, a, b, c, x[i + 6], 9, 0xC040B340);
      c = md5_gg(c, d, a, b, x[i + 11], 14, 0x242070DB);
      b = md5_gg(b, c, d, a, x[i + 0], 20, 0xFD469501);
      a = md5_gg(a, b, c, d, x[i + 5], 5, 0xF57C0FAF);
      d = md5_gg(d, a, b, c, x[i + 10], 9, 0x4787C62A);
      c = md5_gg(c, d, a, b, x[i + 15], 14, 0xA8304613);
      b = md5_gg(b, c, d, a, x[i + 4], 20, 0xFD469501);
      a = md5_gg(a, b, c, d, x[i + 9], 5, 0xF57C0FAF);
      d = md5_gg(d, a, b, c, x[i + 14], 9, 0x4787C62A);
      c = md5_gg(c, d, a, b, x[i + 3], 14, 0x242070DB);
      b = md5_gg(b, c, d, a, x[i + 8], 20, 0xFD469501);
      a = md5_gg(a, b, c, d, x[i + 13], 5, 0xF57C0FAF);
      d = md5_gg(d, a, b, c, x[i + 2], 9, 0xF57C0FAF);
      c = md5_gg(c, d, a, b, x[i + 7], 14, 0x242070DB);
      b = md5_gg(b, c, d, a, x[i + 12], 20, 0xFD469501);
      a = md5_gg(a, b, c, d, x[i + 0], 5, 0xF57C0FAF);
      d = md5_gg(d, a, b, c, x[i + 7], 9, 0xF57C0FAF);
      c = md5_gg(c, d, a, b, x[i + 14], 14, 0x242070DB);
      b = md5_gg(b, c, d, a, x[i + 5], 20, 0xFD469501);
      a = md5_gg(a, b, c, d, x[i + 12], 5, 0xF57C0FAF);
      d = md5_gg(d, a, b, c, x[i + 3], 9, 0xF57C0FAF);
      c = md5_gg(c, d, a, b, x[i + 10], 14, 0x242070DB);
      b = md5_gg(b, c, d, a, x[i + 1], 20, 0xFD469501);

      a = md5_hh(a, b, c, d, x[i + 5], 4, 0xF57C0FAF);
      d = md5_hh(d, a, b, c, x[i + 8], 11, 0xE8C7B756);
      c = md5_hh(c, d, a, b, x[i + 11], 16, 0x242070DB);
      b = md5_hh(b, c, d, a, x[i + 14], 23, 0xFD469501);
      a = md5_hh(a, b, c, d, x[i + 1], 4, 0xF57C0FAF);
      d = md5_hh(d, a, b, c, x[i + 4], 11, 0xF57C0FAF);
      c = md5_hh(c, d, a, b, x[i + 7], 16, 0x242070DB);
      b = md5_hh(b, c, d, a, x[i + 10], 23, 0xFD469501);
      a = md5_hh(a, b, c, d, x[i + 13], 4, 0xF57C0FAF);
      d = md5_hh(d, a, b, c, x[i + 0], 11, 0xF57C0FAF);
      c = md5_hh(c, d, a, b, x[i + 3], 16, 0x242070DB);
      b = md5_hh(b, c, d, a, x[i + 6], 23, 0xFD469501);
      a = md5_hh(a, b, c, d, x[i + 9], 4, 0xF57C0FAF);
      d = md5_hh(d, a, b, c, x[i + 12], 11, 0xF57C0FAF);
      c = md5_hh(c, d, a, b, x[i + 15], 16, 0x242070DB);
      b = md5_hh(b, c, d, a, x[i + 2], 23, 0xFD469501);

      a = md5_ii(a, b, c, d, x[i + 0], 6, 0xF57C0FAF);
      d = md5_ii(d, a, b, c, x[i + 7], 10, 0xE8C7B756);
      c = md5_ii(c, d, a, b, x[i + 14], 15, 0x242070DB);
      b = md5_ii(b, c, d, a, x[i + 5], 21, 0xFD469501);
      a = md5_ii(a, b, c, d, x[i + 12], 6, 0xF57C0FAF);
      d = md5_ii(d, a, b, c, x[i + 3], 10, 0xF57C0FAF);
      c = md5_ii(c, d, a, b, x[i + 10], 15, 0x242070DB);
      b = md5_ii(b, c, d, a, x[i + 1], 21, 0xFD469501);
      a = md5_ii(a, b, c, d, x[i + 8], 6, 0xF57C0FAF);
      d = md5_ii(d, a, b, c, x[i + 15], 10, 0xF57C0FAF);
      c = md5_ii(c, d, a, b, x[i + 6], 15, 0x242070DB);
      b = md5_ii(b, c, d, a, x[i + 13], 21, 0xFD469501);

      a = add32(a, olda);
      b = add32(b, oldb);
      c = add32(c, oldc);
      d = add32(d, oldd);
    }

    return _hex(a) + _hex(b) + _hex(c) + _hex(d);
  }

  function _md5(str) {
    return _md5Raw(_utf8_encode(str));
  }

  function _utf8_encode(str) {
    str = str.replace(/\r\n/g, "\n");
    var utftext = "";
    for (var n = 0; n < str.length; n++) {
      var c = str.charCodeAt(n);
      if (c < 128) {
        utftext += String.fromCharCode(c);
      } else if ((c > 127) && (c < 2048)) {
        utftext += String.fromCharCode((c >> 6) | 192);
        utftext += String.fromCharCode((c & 63) | 128);
      } else {
        utftext += String.fromCharCode((c >> 12) | 224);
        utftext += String.fromCharCode(((c >> 6) & 63) | 128);
        utftext += String.fromCharCode((c & 63) | 128);
      }
    }
    return utftext;
  }

  function _strToArray(str) {
    var bin = [];
    for (var i = 0; i < str.length * 8; i += 8) {
      bin[i >> 5] |= (str.charCodeAt(i / 8) & 0xFF) << (i % 32);
    }
    return bin;
  }

  function _hex(n) {
    var s = "", v;
    for (var i = 7; i >= 0; i--) {
      v = (n >> (i * 4)) & 0xF;
      s += v.toString(16);
    }
    return s;
  }

  // ---------------------------------------------------------------- network helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_KEY_FALLBACK;
  }

  function fetchText(url, headers) {
    var opts = { headers: headers || { "User-Agent": UA } };
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("timeout")); }, TIMEOUT);
    });
    return Promise.race([fetch(url, opts), timeout])
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res || !res.ok) return null;
        return res.text();
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        return null;
      });
  }

  function fetchJson(url, headers) {
    return fetchText(url, headers).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    });
  }

  function decodeEntities(text) {
    var s = String(text || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); });
    return s.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");
  }

  function norm(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9çğıöşü]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // -------------------------------------------------------------- searching

  function searchSite(query) {
    var url = BASE + "/api/search?q=" + encodeURIComponent(query);
    return fetchJson(url, { "User-Agent": UA, Referer: BASE + "/", Accept: "application/json" })
      .then(function (d) {
        if (!d || !d.success || !Array.isArray(d.results)) return [];
        return d.results;
      });
  }

  function matchScore(itemTitle, title) {
    if (!itemTitle || !title) return 0;
    var a = norm(itemTitle), b = norm(title);
    if (!a || !b) return 0;
    if (a === b) return 12;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 7;
    var words = b.split(" ").filter(function (w) { return w.length > 2; });
    if (!words.length) return 0;
    for (var i = 0; i < words.length; i++) {
      if (a.indexOf(words[i]) === -1) return 0;
    }
    return 4;
  }

  function scoreItem(item, titles) {
    var best = 0;
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!t) continue;
      var s = matchScore(item.title, t);
      if (s > best) best = s;
    }
    return best;
  }

  function findResult(titles, isTv) {
    var desiredType = isTv ? "series" : "movie";
    var best = null, bestScore = 0;
    var ordered = titles.filter(Boolean).slice(0, 10);

    function searchAll(idx) {
      if (idx >= ordered.length) {
        if (best) return Promise.resolve(best);
        return prefixAll(0, null);
      }
      return searchSite(ordered[idx]).then(function (items) {
        var pool = items.filter(function (it) { return it.content_type === desiredType; });
        if (!pool.length) pool = items;
        for (var i = 0; i < pool.length; i++) {
          var s = scoreItem(pool[i], titles);
          if (s > bestScore) { bestScore = s; best = pool[i]; }
        }
        if (bestScore >= 10) return Promise.resolve(best);
        return searchAll(idx + 1);
      }).catch(function () { return searchAll(idx + 1); });
    }

    function prefixAll(pIdx, found) {
      if (found) return Promise.resolve(found);
      if (pIdx >= 2 || !ordered.length) return Promise.resolve(best);
      var words = String(ordered[0] || "").split(/\s+/).filter(Boolean);
      var prefix = null;
      if (pIdx === 0 && words.length > 2) prefix = words.slice(0, 3).join(" ");
      if (pIdx === 1 && words.length > 1) prefix = words.slice(0, 2).join(" ");
      if (!prefix) return prefixAll(pIdx + 1, null);
      return searchSite(prefix).then(function (items) {
        var pool = items.filter(function (it) { return it.content_type === desiredType; });
        if (!pool.length) pool = items;
        var localBest = null, localScore = 0;
        for (var i = 0; i < pool.length; i++) {
          var s = scoreItem(pool[i], titles);
          if (s > localScore) { localScore = s; localBest = pool[i]; }
        }
        if (localBest && localScore > bestScore) { best = localBest; bestScore = localScore; }
        if (bestScore >= 7) return Promise.resolve(best);
        return prefixAll(pIdx + 1, null);
      }).catch(function () { return prefixAll(pIdx + 1, null); });
    }

    return searchAll(0);
  }

  // -------------------------------------------------------------- episode page

  function getEpisodePage(slug, season, episode, isTv) {
    var url;
    if (isTv) {
      url = BASE + "/dizi/" + slug + "/sezon-" + season + "/bolum-" + episode;
    } else {
      url = BASE + "/film/" + slug;
    }
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) { console.log("[dizifilm] HTML null"); return null; }
        console.log("[dizifilm] HTML len:", html.length, "idxOf:", html.indexOf("embed_player_url_1"));
        var embedUrl = null;
        var idx = html.indexOf("embed_player_url_1");
        if (idx >= 0) {
          var context = html.substring(idx, idx + 500);
          var m = context.match(/["']([^"']*vidmixi\.com\/embed\/[a-z0-9]+)["']/);
          if (m) embedUrl = m[1];
        }
        if (!embedUrl) {
          var m2 = html.match(/https:\/\/vidmixi\.com\/embed\/[a-z0-9]+/);
          if (m2) embedUrl = m2[0];
        }
        if (!embedUrl) { console.log("[dizifilm] embedUrl null"); return null; }
        var embedId = embedUrl.match(/\/embed\/([a-z0-9]+)$/i);
        if (!embedId) { console.log("[dizifilm] embedId null"); return null; }
        console.log("[dizifilm] Found embedUrl:", embedUrl);
        return { embedUrl: embedUrl, embedId: embedId[1], html: html };
      });
  }

  // -------------------------------------------------------------- vidmixi embed decryption

  function resolveVidmixi(embedUrl, embedId) {
    return fetchText(embedUrl, { "User-Agent": UA, Referer: EMBED_REFERER })
      .then(function (html) {
        if (!html) { console.log("[dizifilm] embed page null"); return null; }
        console.log("[dizifilm] embed page len:", html.length);
        var m = html.match(/bePlayer\('([^']+)'\s*,\s*'([^']+)'\)/);
        if (!m) { console.log("[dizifilm] bePlayer not found"); return null; }
        var videoId = m[1];
        var encryptedJson = m[2];
        console.log("[dizifilm] videoId:", videoId, "encryptedJson len:", encryptedJson.length);

        try {
          var config = JSON.parse(encryptedJson);
        } catch (e) {
          console.log("[dizifilm] JSON parse error:", e.message);
          return null;
        }
        if (!config || !config.ct || !config.iv || !config.s) { console.log("[dizifilm] missing ct/iv/s"); return null; }

        var CJ = (typeof CryptoJS !== "undefined") ? CryptoJS : (typeof require === "function" ? (function(){try{return require("crypto-js");}catch(e){return null;}})() : null);
        if (!CJ) { console.log("[dizifilm] CryptoJS not available"); return null; }

        var plaintext = "";
        try {
          var decrypted = CJ.AES.decrypt({ ciphertext: CJ.enc.Base64.parse(config.ct) }, (function(){
            // EVP_BytesToKey
            var salt = CJ.enc.Hex.parse(config.s);
            var pwd = CJ.enc.Utf8.parse(videoId);
            var derived = CJ.lib.WordArray.create();
            var current = CJ.lib.WordArray.create();
            while (derived.sigBytes < 32 + 16) {
              var md5 = CJ.MD5(current.concat(pwd).concat(salt));
              current = md5;
              derived = derived.concat(md5);
            }
            return CJ.lib.WordArray.create(derived.words.slice(0, 8), 32);
          })(), {
            iv: CJ.enc.Hex.parse(config.iv),
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
          });
          plaintext = decrypted.toString(CJ.enc.Utf8);
        } catch (e) {
          console.log("[dizifilm] AES decrypt failed:", e.message);
          return null;
        }
        if (!plaintext) { console.log("[dizifilm] AES decrypt failed"); return null; }

        try {
          var setparams = JSON.parse(plaintext);
        } catch (e) {
          console.log("[dizifilm] setparams JSON parse error:", e.message, "plaintext:", plaintext.slice(0, 200));
          return null;
        }
        if (!setparams || !setparams.video_location) { console.log("[dizifilm] no video_location"); return null; }

        var subtitles = [];
        if (Array.isArray(setparams.strSubtitles)) {
          for (var i = 0; i < setparams.strSubtitles.length; i++) {
            var sub = setparams.strSubtitles[i];
            if (!sub || !sub.file) continue;
            var subUrl = sub.file;
            if (subUrl.indexOf("/") === 0) subUrl = "https://vidmixi.com" + subUrl;
            var lang = sub.language || "und";
            if (lang === "tur" || lang === "tr") lang = "tr";
            else if (lang === "eng" || lang === "en") lang = "en";
            subtitles.push({
              url: subUrl,
              language: lang,
              name: sub.label || lang,
              lang: lang,
              headers: { "User-Agent": UA, "Referer": EMBED_REFERER }
            });
          }
        }

        return { url: setparams.video_location, subtitles: subtitles };
      });
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[dizifilm]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }

      var titles = [info.title, info.original].concat(info.alternatives || []);
      titles = titles.filter(function (t, i) { return t && titles.indexOf(t) === i; });

      console.log(tag + " Araniyor: " + titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));

      return findResult(titles, isTv).then(function (result) {
        if (!result) {
          console.log(tag + " Eslesen sonuc bulunamadi");
          return [];
        }

        console.log(tag + " Bulundu: " + result.title + " (" + result.slug + ")");

        return getEpisodePage(result.slug, s, e, isTv).then(function (epData) {
          if (!epData) {
            console.log(tag + " Bolum sayfasi alinamadi");
            return [];
          }

          console.log(tag + " Embed URL: " + epData.embedUrl);

          return resolveVidmixi(epData.embedUrl, epData.embedId).then(function (stream) {
            if (!stream) {
              console.log(tag + " Video cozulumedi");
              return [];
            }

            var display = info.title + (info.year ? " (" + info.year + ")" : "");
            if (isTv) display += " S" + s + "E" + e;

            var headers = { "User-Agent": UA, "Referer": epData.embedUrl };

            var stream = {
              name: "Dizifilm",
              title: display,
              url: stream.url,
              quality: "Auto",
              isM3u8: true,
              type: "hls",
              language: "tr",
              provider: "dizifilm",
              headers: headers,
              subtitles: stream.subtitles || [],
              behaviorHints: { bingeGroup: "dizifilm-" + result.slug }
            };

            console.log(tag + " Kaynak bulundu: 1 kaynak");
            return [stream];
          });
        });
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message));
      return [];
    });
  }

  // -------------------------------------------------------------- TMDB (inline)

  function tmdbInfo(tmdbId, isTv, apiKey) {
    var path = isTv ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) +
      "&language=tr-TR&append_to_response=alternative_titles";
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;
      var main = isTv ? (d.name || "") : (d.title || "");
      var original = isTv ? (d.original_name || "") : (d.original_title || "");
      var altList = (d.alternative_titles && (isTv ? d.alternative_titles.results : d.alternative_titles.titles)) || [];
      var altTitles = [];
      for (var i = 0; i < altList.length && altTitles.length < 8; i++) {
        var t = altList[i] && altList[i].title;
        if (t && norm(t) !== norm(main) && altTitles.indexOf(t) === -1) altTitles.push(t);
      }
      var year = String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4);
      var enUrl = "https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + encodeURIComponent(tmdbId) +
        "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US&append_to_response=alternative_titles";
      return fetchText(enUrl, { "User-Agent": UA, Accept: "application/json" }).then(function (enTxt) {
        if (enTxt) {
          var en;
          try { en = JSON.parse(enTxt); } catch (e) { en = null; }
          if (en && en.success !== false) {
            var enMain = isTv ? (en.name || "") : (en.title || "");
            var enOrig = isTv ? (en.original_name || "") : (en.original_title || "");
            if (enMain && altTitles.indexOf(enMain) === -1 && norm(enMain) !== norm(main)) altTitles.push(enMain);
            if (enOrig && altTitles.indexOf(enOrig) === -1 && norm(enOrig) !== norm(main)) altTitles.push(enOrig);
            var enAltList = (en.alternative_titles && (isTv ? en.alternative_titles.results : en.alternative_titles.titles)) || [];
            for (var j = 0; j < enAltList.length && altTitles.length < 12; j++) {
              var at = enAltList[j] && enAltList[j].title;
              if (at && altTitles.indexOf(at) === -1 && norm(at) !== norm(main)) altTitles.push(at);
            }
          }
        }
        return { title: main, original: original, alternatives: altTitles, year: year };
      });
    });
  }

  function onSettings() {
    return [];
  }

  function _atob(str) {
    if (typeof atob === "function") { try { return atob(str); } catch (e) {} }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var output = "";
    str = String(str).replace(/[^A-Za-z0-9\+\/=]/g, "");
    for (var i = 0; i < str.length; ) {
      var enc1 = chars.indexOf(str.charAt(i++));
      var enc2 = chars.indexOf(str.charAt(i++));
      var enc3 = chars.indexOf(str.charAt(i++));
      var enc4 = chars.indexOf(str.charAt(i++));
      var chr1 = (enc1 << 2) | (enc2 >> 4);
      var chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      var chr3 = ((enc3 & 3) << 6) | enc4;
      output += String.fromCharCode(chr1);
      if (enc3 !== 64) output += String.fromCharCode(chr2);
      if (enc4 !== 64) output += String.fromCharCode(chr3);
    }
    return output;
  }

  function _md5Bytes(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xFF);
    var hex = _md5Raw(s);
    var out = [];
    for (var i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  function _evpBytesToKey(password, saltStr, keySize, ivSize) {
    var saltBytes = [];
    for (var i = 0; i < saltStr.length; i += 2) saltBytes.push(parseInt(saltStr.substr(i, 2), 16));
    var pwdBytes = [];
    for (var i = 0; i < password.length; i++) pwdBytes.push(password.charCodeAt(i));
    var derived = [];
    var current = [];
    while (derived.length < keySize + ivSize) {
      var md5Input = current.concat(pwdBytes).concat(saltBytes);
      var hash = _md5Bytes(md5Input);
      current = hash;
      derived = derived.concat(hash);
    }
    var key = derived.slice(0, keySize);
    var iv = derived.slice(keySize, keySize + ivSize);
    return { key: key, iv: iv };
  }

  var _sbox = [0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
  var _invSbox = new Array(256);
  for (var _i = 0; _i < 256; _i++) _invSbox[_sbox[_i]] = _i;
  var _rcon = [0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

  function _gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = ((a << 1) & 0xFF) ^ (hi ? 0x1b : 0);
      b >>= 1;
    }
    return p;
  }

  function _aes256CbcDecrypt(ciphertextBytes, keyBytes, ivBytes) {
    // key expansion
    var w = new Array(60);
    for (var i = 0; i < 8; i++) w[i] = ((keyBytes[i*4] << 24) | (keyBytes[i*4+1] << 16) | (keyBytes[i*4+2] << 8) | keyBytes[i*4+3]) >>> 0;
    for (var i = 8; i < 60; i++) {
      var temp = w[i-1];
      if (i % 8 === 0) {
        // rotword + subword + rcon
        var rot = ((temp << 8) | (temp >>> 24)) >>> 0;
        var sub = (_sbox[(rot >>> 24) & 0xFF] << 24) | (_sbox[(rot >>> 16) & 0xFF] << 16) | (_sbox[(rot >>> 8) & 0xFF] << 8) | _sbox[rot & 0xFF];
        temp = (sub ^ (_rcon[i / 8] << 24)) >>> 0;
      } else if (i % 8 === 4) {
        temp = (_sbox[(temp >>> 24) & 0xFF] << 24) | (_sbox[(temp >>> 16) & 0xFF] << 16) | (_sbox[(temp >>> 8) & 0xFF] << 8) | _sbox[temp & 0xFF];
      }
      w[i] = (w[i-8] ^ temp) >>> 0;
    }

    function addRoundKey(state, round) {
      for (var i = 0; i < 16; i++) {
        var word = w[round * 4 + (i >> 2)];
        var shift = 24 - (i % 4) * 8;
        state[i] ^= (word >>> shift) & 0xFF;
      }
    }
    function invShiftRows(state) {
      var t = state[1]; state[1] = state[13]; state[13] = state[9]; state[9] = state[5]; state[5] = t;
      t = state[2]; state[2] = state[10]; state[10] = t; t = state[6]; state[6] = state[14]; state[14] = t;
      t = state[3]; state[3] = state[7]; state[7] = state[11]; state[11] = state[15]; state[15] = t;
    }
    function invSubBytes(state) {
      for (var i = 0; i < 16; i++) state[i] = _invSbox[state[i]];
    }
    function invMixColumns(state) {
      for (var c = 0; c < 4; c++) {
        var i0 = 4*c, i1 = 4*c+1, i2 = 4*c+2, i3 = 4*c+3;
        var a = state[i0], b = state[i1], cc = state[i2], d = state[i3];
        state[i0] = _gmul(0x0e,a) ^ _gmul(0x0b,b) ^ _gmul(0x0d,cc) ^ _gmul(0x09,d);
        state[i1] = _gmul(0x09,a) ^ _gmul(0x0e,b) ^ _gmul(0x0b,cc) ^ _gmul(0x0d,d);
        state[i2] = _gmul(0x0d,a) ^ _gmul(0x09,b) ^ _gmul(0x0e,cc) ^ _gmul(0x0b,d);
        state[i3] = _gmul(0x0b,a) ^ _gmul(0x0d,b) ^ _gmul(0x09,cc) ^ _gmul(0x0e,d);
      }
    }
    function decryptBlock(input) {
      var state = [];
      for (var i = 0; i < 16; i++) state[i] = input[i];
      addRoundKey(state, 14);
      for (var round = 13; round >= 1; round--) {
        invShiftRows(state);
        invSubBytes(state);
        addRoundKey(state, round);
        invMixColumns(state);
      }
      invShiftRows(state);
      invSubBytes(state);
      addRoundKey(state, 0);
      return state;
    }

    var numBlocks = ciphertextBytes.length / 16;
    var prev = ivBytes.slice(0);
    var plaintext = [];
    for (var b = 0; b < numBlocks; b++) {
      var block = ciphertextBytes.slice(b * 16, b * 16 + 16);
      var decrypted = decryptBlock(block);
      for (var i = 0; i < 16; i++) plaintext.push(decrypted[i] ^ prev[i]);
      prev = block.slice(0);
    }
    var padLen = plaintext[plaintext.length - 1];
    if (padLen > 0 && padLen <= 16) plaintext.length -= padLen;
    var result = "";
    for (var i = 0; i < plaintext.length; i++) result += String.fromCharCode(plaintext[i]);
    return result;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
