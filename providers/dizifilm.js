/**
 * dizifilm - Dizifilm / Dizifilmizle (dizifilm.life, dizifilmizle.to) provider for Nuvio
 *
 * Flow:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> Dizifilm /api/search?q=  (film ve dizi sonuclari)
 *   -> /dizi/{slug}/sezon-{s}/bolum-{e}  (bolum sayfasi, server-rendered JSON icinde embed_player_url_1)
 *   -> vidmixi.com/embed/{id}  (JW Player sifreli yapilandirmesi)
 *   -> AES-256-CBC + EVP_BytesToKey (MD5) ile video_location cozulur (master.m3u8)
 *   -> video_location  (master HLS playlist, calisir)
 *
 * Notlar:
 * - Arama API'si /api/search?q= (JSON dondurur)
 * - Bolum sayfasi server-side render edilir; embed_player_url_1 HTML'de yer alir
 * - Vidmixi embed sayfasindaki bePlayer() cagrisindaki sifreli JSON cozulur
 *   (AES-256-CBC, sifre = video ID, salt/iv = JSON'daki s ve iv alanlari)
 * - Cozulmus video_location bir master.m3u8 URL'sidir
 * - Altyazilar: cozulmus yapilandirmadaki strSubtitles dizisinden alinir
 * - Hermes/QuickJS uyumlu: async/await yok, Promise zinciri kullanilir
 * - Sifreleme kutuphanesi yok: AES-256-CBC + EVP_BytesToKey (MD5) saf JS
 */
(function () {
  "use strict";

  var BASE = "https://dizifilm.life";
  var EMBED_REFERER = "https://dizifilmizle.to/";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;

  // ---------------------------------------------------------------- crypto: MD5

  var _MD5_K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
  var _MD5_S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];

  function _md5Raw(str) {
    var x = _strToArray(str);
    x[str.length >> 2] |= 0x80 << ((str.length % 4) * 8);
    x[(((str.length + 8) >>> 6) << 4) + 14] = (str.length * 8) >>> 0;
    x[(((str.length + 8) >>> 6) << 4) + 15] = ((str.length * 8) / 0x100000000) | 0;

    var a = 0x67452301;
    var b = 0xEFCDAB89;
    var c = 0x98BADCFE;
    var d = 0x10325476;

    for (var blk = 0; blk < x.length; blk += 16) {
      var olda = a, oldb = b, oldc = c, oldd = d;

      for (var i = 0; i < 64; i++) {
        var f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }

        var tmp = d;
        d = c;
        c = b;
        var sum = (a + f + _MD5_K[i] + x[blk + g]) >>> 0;
        b = (b + ((sum << _MD5_S[i]) | (sum >>> (32 - _MD5_S[i])))) >>> 0;
        a = tmp;
      }

      a = (a + olda) >>> 0;
      b = (b + oldb) >>> 0;
      c = (c + oldc) >>> 0;
      d = (d + oldd) >>> 0;
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
    var totalWords = (((str.length + 8) >>> 6) << 4) + 16;
    var bin = new Array(totalWords);
    for (var j = 0; j < totalWords; j++) bin[j] = 0;
    for (var i = 0; i < str.length * 8; i += 8) {
      bin[i >> 5] |= (str.charCodeAt(i / 8) & 0xFF) << (i % 32);
    }
    return bin;
  }

  function _hex(n) {
    var s = "", v;
    for (var i = 0; i < 4; i++) {
      v = (n >>> (i * 8)) & 0xFF;
      s += (v < 16 ? "0" : "") + v.toString(16);
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

        var derived = _evpBytesToKey(videoId, config.s, 32, 16);

        var ctStr = _atob(config.ct);
        var ctBytes = [];
        for (var ci = 0; ci < ctStr.length; ci++) ctBytes.push(ctStr.charCodeAt(ci) & 0xFF);

        var ivHex = String(config.iv || "");
        var ivBytes = [];
        for (var hi = 0; hi < ivHex.length; hi += 2) ivBytes.push(parseInt(ivHex.substr(hi, 2), 16) & 0xFF);

        var plaintext = "";
        try {
          plaintext = _bytesToUtf8(_aes256CbcDecrypt(ctBytes, derived.key, ivBytes));
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
    return plaintext;
  }

  function _bytesToUtf8(bytes) {
    var out = "", i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b < 0x80) {
        out += String.fromCharCode(b); i += 1;
      } else if (b < 0xE0) {
        out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2;
      } else if (b < 0xF0) {
        out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3;
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4;
      }
    }
    return out;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
