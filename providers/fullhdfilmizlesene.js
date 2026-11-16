/**
 * fullhdfilmizlesene - FullHDFilmizlesene (fullhdfilmizlesene.co) provider for Nuvio
 *
 * Flow:
 *   TMDB id -> TMDB basligi (tr) + alternatif basliklar + yil
 *   -> FullHDFilmizlesene /?s=  (film arama sonuclari)
 *   -> /film/{slug}/  (film sayfasi, JSON-LD veya HTML icinde embed_player_url_1)
 *   -> /dizi/{slug}/sezon-{s}/bolum-{e}/  (bolum sayfasi)
 *   -> embed_player_url_1 (vidmixi / fastplay vb. embed URL)
 *   -> embed sayfasi -> JW Player / video URL (m3u8)
 *
 * Notlar:
 * - Site Cloudflare korumali; direk fetch genellikle calisir ancak bazen engellenebilir.
 * - Arama sayfasi HTML'dir; JSON değil. Basit HTML parse kullaniliyor.
 * - embed_player_url_1 sayfa HTML'sinde bulunur (genelde JSON-LD veya script icinde).
 * - Videolar genelde vidmixi / fastplay gibi embed üzerinden calisir.
 * - Hermes uyumlu: async/await yok, Promise zinciri kullaniliyor.
 */
(function () {
  "use strict";

  var BASE = "https://fullhdfilmizlesene.co";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;

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
    return s
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function norm(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9çğıöşü]+/g, " ").replace(/\s+/g, " ").trim();
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

  // -------------------------------------------------------------- searching

  function searchSite(query) {
    var url = BASE + "/?s=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return [];
        // Arama sonuclari genelde <a href=".../film/slug/"> veya /dizi/slug/ seklindedir
        var links = [...new Set(html.match(/href="([^"]+)"/gi) || [])].map(function (m) { return m.slice(6, -1); });
        var out = [];
        var seen = {};
        links.forEach(function (l) {
          var m = l.match(/https:\/\/www\.fullhdfilmizlesene\.co\/(?:film|dizi)\/([^\/]+)\/?$/i);
          if (!m) return;
          if (seen[l]) return;
          seen[l] = true;
          out.push({ url: l.replace(/\/+$/, "/"), slug: m[1], type: l.indexOf("/dizi/") !== -1 ? "dizi" : "film", title: l.split("/").pop().replace(/-/g, " ") });
        });
        return out;
      });
  }

  function findResult(titles, isTv) {
    var best = null, bestScore = 0;
    var ordered = titles.filter(Boolean).slice(0, 10);

    function searchAll(idx) {
      if (idx >= ordered.length) {
        if (best) return Promise.resolve(best);
        return prefixAll(0, null);
      }
      return searchSite(ordered[idx]).then(function (items) {
        for (var i = 0; i < items.length; i++) {
          var s = scoreItem(items[i], titles);
          if (s > bestScore) { bestScore = s; best = items[i]; }
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
        for (var i = 0; i < items.length; i++) {
          var s = scoreItem(items[i], titles);
          if (s > bestScore) { bestScore = s; best = items[i]; }
        }
        if (bestScore >= 7) return Promise.resolve(best);
        return prefixAll(pIdx + 1, null);
      }).catch(function () { return prefixAll(pIdx + 1, null); });
    }

    return searchAll(0);
  }

  // -------------------------------------------------------------- page parsing

  function getPage(slug, isTv) {
    var url = BASE + "/" + (isTv ? "dizi/" : "film/") + slug + "/";
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return null;

        // 1) embed_player_url_1 (dizifilm tarzi JSON-LD / script icinde)
        var m = html.match(/["']embed_player_url_1["']?\s*:\s*["']([^"']+)["']/);
        if (!m) m = html.match(/<script[^>]*>[\s\S]*?embed_player_url_1["']?\s*:\s*["']([^"']+)["']/i);
        if (m) {
          var embedUrl = m[1];
          var embedId = embedUrl.match(/embed\/([a-z0-9]+)$/i);
          if (embedId) return { url: embedUrl, id: embedId[1], type: "vidmixi" };
        }

        // 2) Direkt vidmixi embed linki ara
        var m2 = html.match(/https:\/\/vidmixi\.com\/embed\/[a-z0-9]+/gi);
        if (m2 && m2.length) {
          var u = m2[0];
          var id = u.match(/embed\/([a-z0-9]+)$/i);
          return { url: u, id: id ? id[1] : null, type: "vidmixi" };
        }

        // 3) Generic embed / iframe arama
        var m3 = html.match(/<iframe[^>]*src="([^"]+)"/gi);
        if (m3) {
          for (var i = 0; i < m3.length; i++) {
            var u2 = m3[i].slice(m3[i].indexOf('src="')+5, -1);
            if (u2.indexOf("vidmixi") !== -1 || u2.indexOf("embed") !== -1) {
              var id2 = u2.match(/embed\/([a-z0-9]+)$/i);
              return { url: u2, id: id2 ? id2[1] : null, type: "embed" };
            }
          }
        }

        return null;
      });
  }

  // -------------------------------------------------------------- vidmixi embed decryption

  function resolveVidmixi(embedUrl) {
    return fetchText(embedUrl, { "User-Agent": UA, Referer: "https://fullhdfilmizlesene.co/" })
      .then(function (html) {
        if (!html) return null;
        console.log("[fullhdfilmizlesene] embed page len:", html.length);

        // bePlayer(hash, set) pattern
        var m = html.match(/bePlayer\(['"]([^'"]+)['"]\s*,\s*['"](\{[^"]+\})['"]\)/);
        if (!m) return null;
        var videoId = m[1];
        var encryptedJson = m[2];

        try {
          var config = JSON.parse(encryptedJson);
        } catch (e) {
          return null;
        }
        if (!config || !config.ct || !config.iv || !config.s) return null;

        // EVP_BytesToKey (MD5)
        var saltBytes = [];
        for (var i = 0; i < config.s.length; i += 2) saltBytes.push(parseInt(config.s.substr(i, 2), 16));
        var pwdBytes = _strToArray(videoId);
        var derived = [];
        var current = [];
        while (derived.length < 32 + 16) {
          var md5Input = current.concat(pwdBytes).concat(saltBytes);
          var hash = _md5Bytes(md5Input);
          current = hash;
          derived = derived.concat(hash);
        }
        var key = derived.slice(0, 32);
        var iv = derived.slice(32, 48);

        var ciphertext = _atob(config.ct);
        var ciphertextBytes = [];
        for (var i = 0; i < ciphertext.length; i++) ciphertextBytes.push(ciphertext.charCodeAt(i));
        var ivBytes = [];
        var ivHex = config.iv;
        for (var i = 0; i < ivHex.length; i += 2) ivBytes.push(parseInt(ivHex.substr(i, 2), 16));

        var plaintext = _aes256CbcDecrypt(ciphertextBytes, key, ivBytes);
        if (!plaintext) return null;

        try {
          var set = JSON.parse(plaintext);
        } catch (e) {
          return null;
        }
        if (!set || !set.video_location) return null;

        var subtitles = [];
        if (Array.isArray(set.strSubtitles)) {
          set.strSubtitles.forEach(function (sub) {
            if (!sub || !sub.file) return;
            var subUrl = sub.file;
            if (subUrl.indexOf("/") === 0) subUrl = "https://vidmixi.com" + subUrl;
            var lang = sub.language || "und";
            if (lang === "tr") lang = "tr";
            else if (lang === "en") lang = "en";
            subtitles.push({
              url: subUrl,
              language: lang,
              name: sub.label || lang,
              lang: lang,
              headers: { "User-Agent": UA, "Referer": embedUrl }
            });
          });
        }

        return { url: set.video_location, subtitles: subtitles };
      });
  }

  // -------------------------------------------------------------- crypto helpers

  function _md5(str) {
    var x = _strToArray(str);
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    var KK = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
    x[_x(x.length / 4 + 1)] = 0x80 << ((str.length % 4) * 8);
    x[_x((x.length + 64) >> 9 << 4) + 14] = str.length * 8;
    for (var i = 0; i < x.length; i += 16) {
      var aa = a, bb = b, cc = c, dd = d;
      a = _ff(a, b, c, d, x[i + 0], 7, KK[0]); d = _ff(d, a, b, c, x[i + 1], 12, KK[1]);
      c = _ff(c, d, a, b, x[i + 2], 17, KK[2]); b = _ff(b, c, d, a, x[i + 3], 22, KK[3]);
      a = _ff(a, b, c, d, x[i + 4], 5, KK[4]); d = _ff(d, a, b, c, x[i + 5], 9, KK[5]);
      c = _ff(c, d, a, b, x[i + 6], 14, KK[6]); b = _ff(b, c, d, a, x[i + 7], 20, KK[7]);
      a = _ff(a, b, c, d, x[i + 8], 5, KK[8]); d = _ff(d, a, b, c, x[i + 9], 9, KK[9]);
      c = _ff(c, d, a, b, x[i + 10], 14, KK[10]); b = _ff(b, c, d, a, x[i + 11], 20, KK[11]);
      a = _ff(a, b, c, d, x[i + 12], 5, KK[12]); d = _ff(d, a, b, c, x[i + 13], 9, KK[13]);
      c = _ff(c, d, a, b, x[i + 14], 14, KK[14]); b = _ff(b, c, d, a, x[i + 15], 20, KK[15]);
      a = _gg(a, b, c, d, x[i + 1], 5, KK[16]); d = _gg(d, a, b, c, x[i + 6], 9, KK[17]);
      c = _gg(c, d, a, b, x[i + 11], 14, KK[18]); b = _gg(b, c, d, a, x[i + 0], 20, KK[19]);
      a = _gg(a, b, c, d, x[i + 5], 5, KK[20]); d = _gg(d, a, b, c, x[i + 10], 9, KK[21]);
      c = _gg(c, d, a, b, x[i + 15], 14, KK[22]); b = _gg(b, c, d, a, x[i + 4], 20, KK[23]);
      a = _gg(a, b, c, d, x[i + 9], 5, KK[24]); d = _gg(d, a, b, c, x[i + 14], 9, KK[25]);
      c = _gg(c, d, a, b, x[i + 3], 14, KK[26]); b = _gg(b, c, d, a, x[i + 8], 20, KK[27]);
      a = _gg(a, b, c, d, x[i + 13], 5, KK[28]); d = _gg(d, a, b, c, x[i + 2], 9, KK[29]);
      c = _gg(c, d, a, b, x[i + 7], 14, KK[30]); b = _gg(b, c, d, a, x[i + 12], 20, KK[31]);
      a = _hh(a, b, c, d, x[i + 5], 4, KK[32]); d = _hh(d, a, b, c, x[i + 8], 11, KK[33]);
      c = _hh(c, d, a, b, x[i + 11], 16, KK[34]); b = _hh(b, c, d, a, x[i + 14], 23, KK[35]);
      a = _hh(a, b, c, d, x[i + 1], 4, KK[36]); d = _hh(d, a, b, c, x[i + 4], 11, KK[37]);
      c = _hh(c, d, a, b, x[i + 7], 16, KK[38]); b = _hh(b, c, d, a, x[i + 10], 23, KK[39]);
      a = _hh(a, b, c, d, x[i + 13], 4, KK[40]); d = _hh(d, a, b, c, x[i + 0], 11, KK[41]);
      c = _hh(c, d, a, b, x[i + 3], 16, KK[42]); b = _hh(b, c, d, a, x[i + 6], 23, KK[43]);
      a = _hh(a, b, c, d, x[i + 9], 4, KK[44]); d = _hh(d, a, b, c, x[i + 12], 11, KK[45]);
      c = _hh(c, d, a, b, x[i + 15], 16, KK[46]); b = _hh(b, c, d, a, x[i + 2], 23, KK[47]);
      a = _ii(a, b, c, d, x[i + 0], 6, KK[48]); d = _ii(d, a, b, c, x[i + 7], 10, KK[49]);
      c = _ii(c, d, a, b, x[i + 14], 15, KK[50]); b = _ii(b, c, d, a, x[i + 5], 21, KK[51]);
      a = _ii(a, b, c, d, x[i + 12], 6, KK[52]); d = _ii(d, a, b, c, x[i + 3], 10, KK[53]);
      c = _ii(c, d, a, b, x[i + 10], 15, KK[54]); b = _ii(b, c, d, a, x[i + 1], 21, KK[55]);
      a = _ii(a, b, c, d, x[i + 8], 6, KK[56]); d = _ii(d, a, b, c, x[i + 15], 10, KK[57]);
      c = _ii(c, d, a, b, x[i + 6], 15, KK[58]); b = _ii(b, c, d, a, x[i + 13], 21, KK[59]);
      a = _ii(a, b, c, d, x[i + 4], 6, KK[60]); d = _ii(d, a, b, c, x[i + 11], 10, KK[61]);
      c = _ii(c, d, a, b, x[i + 2], 15, KK[62]); b = _ii(b, c, d, a, x[i + 9], 21, KK[63]);
      a = _safeAdd(a, aa); b = _safeAdd(b, bb); c = _safeAdd(c, cc); d = _safeAdd(d, dd);
    }
    return _hex(a) + _hex(b) + _hex(c) + _hex(d);
  }

  function _safeAdd(a, b) { var lsw = (a & 0xFFFF) + (b & 0xFFFF); var msw = (a >> 16) + (b >> 16) + (lsw >> 16); return (msw << 16) | (lsw & 0xFFFF); }
  function _rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function _cmn(q, a, b, x, s, t) { return _safeAdd(_rol(_safeAdd(_safeAdd(a, q), _safeAdd(x, t)), s), b); }
  function _ff(a, b, c, d, x, s, t) { return _cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function _gg(a, b, c, d, x, s, t) { return _cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function _hh(a, b, c, d, x, s, t) { return _cmn(b ^ c ^ d, a, b, x, s, t); }
  function _ii(a, b, c, d, x, s, t) { return _cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function _strToArray(str) { var bin = []; for (var i = 0; i < str.length * 8; i += 8) bin[i >> 5] |= (str.charCodeAt(i / 8) & 0xFF) << (i % 32); return bin; }
  function _hex(n) { var s = "", v; for (var i = 7; i >= 0; i--) { v = (n >> (i * 4)) & 0xF; s += v.toString(16); } return s; }
  function _x(n) { return n; }

  function _md5Bytes(bytes) {
    var x = _arrayToWords(bytes);
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    var KK = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
    x[_x(x.length / 4 + 1)] = 0x80 << ((bytes.length % 4) * 8);
    x[_x((x.length + 64) >> 9 << 4) + 14] = bytes.length * 8;
    for (var i = 0; i < x.length; i += 16) {
      var aa = a, bb = b, cc = c, dd = d;
      a = _ff(a, b, c, d, x[i + 0], 7, KK[0]); d = _ff(d, a, b, c, x[i + 1], 12, KK[1]);
      c = _ff(c, d, a, b, x[i + 2], 17, KK[2]); b = _ff(b, c, d, a, x[i + 3], 22, KK[3]);
      a = _ff(a, b, c, d, x[i + 4], 5, KK[4]); d = _ff(d, a, b, c, x[i + 5], 9, KK[5]);
      c = _ff(c, d, a, b, x[i + 6], 14, KK[6]); b = _ff(b, c, d, a, x[i + 7], 20, KK[7]);
      a = _ff(a, b, c, d, x[i + 8], 5, KK[8]); d = _ff(d, a, b, c, x[i + 9], 9, KK[9]);
      c = _ff(c, d, a, b, x[i + 10], 14, KK[10]); b = _ff(b, c, d, a, x[i + 11], 20, KK[11]);
      a = _ff(a, b, c, d, x[i + 12], 5, KK[12]); d = _ff(d, a, b, c, x[i + 13], 9, KK[13]);
      c = _ff(c, d, a, b, x[i + 14], 14, KK[14]); b = _ff(b, c, d, a, x[i + 15], 20, KK[15]);
      a = _gg(a, b, c, d, x[i + 1], 5, KK[16]); d = _gg(d, a, b, c, x[i + 6], 9, KK[17]);
      c = _gg(c, d, a, b, x[i + 11], 14, KK[18]); b = _gg(b, c, d, a, x[i + 0], 20, KK[19]);
      a = _gg(a, b, c, d, x[i + 5], 5, KK[20]); d = _gg(d, a, b, c, x[i + 10], 9, KK[21]);
      c = _gg(c, d, a, b, x[i + 15], 14, KK[22]); b = _gg(b, c, d, a, x[i + 4], 20, KK[23]);
      a = _gg(a, b, c, d, x[i + 9], 5, KK[24]); d = _gg(d, a, b, c, x[i + 14], 9, KK[25]);
      c = _gg(c, d, a, b, x[i + 3], 14, KK[26]); b = _gg(b, c, d, a, x[i + 8], 20, KK[27]);
      a = _gg(a, b, c, d, x[i + 13], 5, KK[28]); d = _gg(d, a, b, c, x[i + 2], 9, KK[29]);
      c = _gg(c, d, a, b, x[i + 7], 14, KK[30]); b = _gg(b, c, d, a, x[i + 12], 20, KK[31]);
      a = _hh(a, b, c, d, x[i + 5], 4, KK[32]); d = _hh(d, a, b, c, x[i + 8], 11, KK[33]);
      c = _hh(c, d, a, b, x[i + 11], 16, KK[34]); b = _hh(b, c, d, a, x[i + 14], 23, KK[35]);
      a = _hh(a, b, c, d, x[i + 1], 4, KK[36]); d = _hh(d, a, b, c, x[i + 4], 11, KK[37]);
      c = _hh(c, d, a, b, x[i + 7], 16, KK[38]); b = _hh(b, c, d, a, x[i + 10], 23, KK[39]);
      a = _hh(a, b, c, d, x[i + 13], 4, KK[40]); d = _hh(d, a, b, c, x[i + 0], 11, KK[41]);
      c = _hh(c, d, a, b, x[i + 3], 16, KK[42]); b = _hh(b, c, d, a, x[i + 6], 23, KK[43]);
      a = _hh(a, b, c, d, x[i + 9], 4, KK[44]); d = _hh(d, a, b, c, x[i + 12], 11, KK[45]);
      c = _hh(c, d, a, b, x[i + 15], 16, KK[46]); b = _hh(b, c, d, a, x[i + 2], 23, KK[47]);
      a = _ii(a, b, c, d, x[i + 0], 6, KK[48]); d = _ii(d, a, b, c, x[i + 7], 10, KK[49]);
      c = _ii(c, d, a, b, x[i + 14], 15, KK[50]); b = _ii(b, c, d, a, x[i + 5], 21, KK[51]);
      a = _ii(a, b, c, d, x[i + 12], 6, KK[52]); d = _ii(d, a, b, c, x[i + 3], 10, KK[53]);
      c = _ii(c, d, a, b, x[i + 10], 15, KK[54]); b = _ii(b, c, d, a, x[i + 1], 21, KK[55]);
      a = _ii(a, b, c, d, x[i + 8], 6, KK[56]); d = _ii(d, a, b, c, x[i + 15], 10, KK[57]);
      c = _ii(c, d, a, b, x[i + 6], 15, KK[58]); b = _ii(b, c, d, a, x[i + 13], 21, KK[59]);
      a = _ii(a, b, c, d, x[i + 4], 6, KK[60]); d = _ii(d, a, b, c, x[i + 11], 10, KK[61]);
      c = _ii(c, d, a, b, x[i + 2], 15, KK[62]); b = _ii(b, c, d, a, x[i + 9], 21, KK[63]);
      a = _safeAdd(a, aa); b = _safeAdd(b, bb); c = _safeAdd(c, cc); d = _safeAdd(d, dd);
    }
    return [a, b, c, d];
  }

  function _arrayToWords(bytes) { var words = []; for (var i = 0; i < bytes.length; i++) words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8); return words; }

  function _atob(str) {
    if (typeof atob === "function") {
      try { return atob(str); } catch (e) {}
    }
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

  function _evpBytesToKey(password, saltStr, keySize, ivSize) {
    var saltBytes = [];
    for (var i = 0; i < saltStr.length; i += 2) saltBytes.push(parseInt(saltStr.substr(i, 2), 16));
    var pwdBytes = _strToArray(password);
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

  // AES-256-CBC decrypt (pure JS)
  var _sbox = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa6,0x92,0xa0,0x11,0xec,0x93,0x34,0x31,0x29,
    0x9e,0x50,0x8a,0x31,0x82,0x7b,0x18,0x28,0xdd,0x8f,0x92,0x95,0x1b,0x94,0x20,0x79,
    0x2e,0x07,0xb8,0xdb,0x2e,0x43,0xd9,0x71,0x87,0x1c,0x9d,0x2c,0x54,0x9b,0x4c,0x0d,
    0x51,0xb0,0x77,0x9c,0x44,0x0e,0x41,0x77,0x4e,0x8f,0x4f,0x77,0x5d,0x2e,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,
    0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77,0x77
  ];

  var _invSbox = [
    0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
    0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
    0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc9,0x4e,
    0x08,0x2e,0xa1,0x66,0x28,0xd3,0x2f,0x8e,0x44,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,
    0x9b,0x2f,0x01,0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,
    0x2f,0x01,0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,
    0x2f,0x01,0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,
    0x01,0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01,
    0x6f,0xaa,0xcd,0x1e,0x5e,0x45,0x4e,0x7a,0x92,0xc8,0xc5,0x5e,0x9b,0x2f,0x01
  ];

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
    var rounds = 14;
    var w = [];
    for (var i = 0; i < 8; i++) w[i] = (keyBytes[i * 4] << 24) | (keyBytes[i * 4 + 1] << 16) | (keyBytes[i * 4 + 2] << 8) | keyBytes[i * 4 + 3];
    for (var i = 8; i < 60; i++) {
      var temp = w[i - 1];
      if (i % 8 === 0) {
        var rot = ((temp << 8) | (temp >>> 24)) & 0xFFFFFFFF;
        var sub = (_sbox[(rot >>> 24) & 0xFF] << 24) | (_sbox[(rot >>> 16) & 0xFF] << 16) | (_sbox[(rot >>> 8) & 0xFF] << 8) | _sbox[rot & 0xFF];
        sub ^= _rcon[i / 8];
        temp = sub ^ temp;
      } else if (i % 8 === 4) {
        temp = (_sbox[(temp >>> 24) & 0xFF] << 24) | (_sbox[(temp >>> 16) & 0xFF] << 16) | (_sbox[(temp >>> 8) & 0xFF] << 8) | _sbox[temp & 0xFF];
      }
      w[i] = w[i - 8] ^ temp;
    }

    function addRoundKey(state, round) {
      for (var i = 0; i < 4; i++) state[i] ^= w[round * 4 + i];
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
      for (var i = 0; i < 4; i++) {
        var a = state[i], b = state[i + 4], c = state[i + 8], d = state[i + 12];
        state[i] = _gmul(0x0e, a) ^ _gmul(0x0b, b) ^ _gmul(0x0d, c) ^ _gmul(0x09, d);
        state[i + 4] = _gmul(0x09, a) ^ _gmul(0x0e, b) ^ _gmul(0x0b, c) ^ _gmul(0x0d, d);
        state[i + 8] = _gmul(0x0d, a) ^ _gmul(0x09, b) ^ _gmul(0x0e, c) ^ _gmul(0x0b, d);
        state[i + 12] = _gmul(0x0b, a) ^ _gmul(0x0d, b) ^ _gmul(0x09, c) ^ _gmul(0x0e, d);
      }
    }

    function decryptBlock(input) {
      var state = [];
      for (var i = 0; i < 16; i++) state[i] = input[i];
      addRoundKey(state, rounds);
      invShiftRows(state);
      invSubBytes(state);
      for (var round = rounds - 1; round >= 1; round--) {
        addRoundKey(state, round);
        invMixColumns(state);
        invShiftRows(state);
        invSubBytes(state);
      }
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

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[fullhdfilmizlesene]";
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
          console.log(tag + " Eslesen sayfa bulunamadi");
          return [];
        }

        console.log(tag + " Bulundu: " + result.title + " (" + result.slug + ")");

        return getPage(result.slug, s, e, isTv).then(function (epData) {
          if (!epData) {
            console.log(tag + " Sayfa alinamadi");
            return [];
          }

          console.log(tag + " Embed: " + epData.url);

          if (epData.type === "vidmixi") {
            return resolveVidmixi(epData.url).then(function (stream) {
              if (!stream) {
                console.log(tag + " Akis cozulumedi");
                return [];
              }

              var display = info.title + (info.year ? " (" + info.year + ")" : "");
              if (isTv) display += " S" + s + "E" + e;

              var headers = { "User-Agent": UA, "Referer": epData.url };

              var stream = {
                name: "FullHDFilmizlesene - 1080p",
                title: display,
                url: stream.url,
                quality: "Auto",
                isM3u8: true,
                type: "hls",
                language: "tr",
                provider: "fullhdfilmizlesene",
                headers: headers,
                subtitles: stream.subtitles || [],
                behaviorHints: { bingeGroup: "fullhdfilmizlesene-" + result.slug }
              };

              console.log(tag + " Kaynak bulundu: 1 kaynak");
              return [stream];
            });
          }

          console.log(tag + " Desteklenmeyen embed türu");
          return [];
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
