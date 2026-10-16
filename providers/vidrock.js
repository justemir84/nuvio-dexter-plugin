/**
 * vidrock - VidRock (vidrock.net) saglayicisi - Nuvio
 * Akis: TMDB -> /api/movie/{id} | /api/tv/{id}/{s}/{e} -> {Sunucu:{url,language,type}}
 *   -> url alani AES-256-GCM (b64url: 12B IV + ct + 16B tag) ile sifreli;
 *      anahtar bundle icinde sabit hex -> saf JS AES ile cozulur.
 *   -> HLS master m3u8 (bazen JSON [ {resolution,url} ] listesi).
 *   -> medya istekleri Referer + Origin: https://vidrock.net/ ister (yoksa 403/404).
 * Hermes-safe: Promise chains only, no deps (kripto saf JS).
 */
(function () {
  "use strict";

  var SITE = "https://vidrock.net";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_STREAMS = 10;
  var AES_KEY_HEX = "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
  var MEDIA_HEADERS = { "Referer": SITE + "/", "Origin": SITE, "User-Agent": UA };

  /* ---- saf JS AES-256 (GCM/CTR cozum icin yalniz sifreleme yonu) ---- */
  var SBOX = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
  ];
  var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];

  function mul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }

  function expandKey(key) {
    var w = new Array(60);
    var i;
    for (i = 0; i < 8; i++) {
      w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    }
    for (i = 8; i < 60; i++) {
      var t = w[i - 1];
      if (i % 8 === 0) {
        t = (((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[(t >>> 24) & 255]) ^ (RCON[(i / 8) - 1] << 24)) >>> 0;
      } else if (i % 8 === 4) {
        t = ((SBOX[(t >>> 24) & 255] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255]) >>> 0;
      }
      w[i] = (w[i - 8] ^ t) >>> 0;
    }
    return w;
  }

  function addRoundKey(s, rk, round) {
    for (var c = 0; c < 4; c++) {
      var w = rk[round * 4 + c];
      s[c * 4] ^= (w >>> 24) & 255;
      s[c * 4 + 1] ^= (w >>> 16) & 255;
      s[c * 4 + 2] ^= (w >>> 8) & 255;
      s[c * 4 + 3] ^= w & 255;
    }
  }

  function subBytes(s) {
    for (var i = 0; i < 16; i++) s[i] = SBOX[s[i]];
  }

  function shiftRows(s) {
    for (var r = 1; r <= 3; r++) {
      var row = [s[r], s[4 + r], s[8 + r], s[12 + r]];
      for (var c = 0; c < 4; c++) s[c * 4 + r] = row[(c + r) % 4];
    }
  }

  function mixColumns(s) {
    for (var c = 0; c < 4; c++) {
      var a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
      s[c * 4] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
      s[c * 4 + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
      s[c * 4 + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
      s[c * 4 + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
    }
  }

  function encryptBlock(rk, input) {
    var s = new Array(16);
    for (var i = 0; i < 16; i++) s[i] = input[i];
    addRoundKey(s, rk, 0);
    for (var round = 1; round <= 13; round++) {
      subBytes(s);
      shiftRows(s);
      mixColumns(s);
      addRoundKey(s, rk, round);
    }
    subBytes(s);
    shiftRows(s);
    addRoundKey(s, rk, 14);
    return s;
  }

  var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64ToBytes(str) {
    var s = String(str || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
    while (s.length % 4) s += "=";
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "=") break;
      var v = B64C.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >>> bits) & 255);
      }
    }
    return new Uint8Array(out);
  }

  function hexToBytes(h) {
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function utf8Decode(b) {
    var s = "", i = 0;
    while (i < b.length) {
      var c = b[i++];
      if (c < 128) s += String.fromCharCode(c);
      else if (c > 191 && c < 224) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
      else if (c > 223 && c < 240) s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
      else {
        var cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      }
    }
    return s;
  }

  function aesGcmDecrypt(b64urlStr) {
    var key = hexToBytes(AES_KEY_HEX);
    var raw = b64ToBytes(b64urlStr);
    if (raw.length < 28) throw new Error("ciphertext too short");
    var ctLen = raw.length - 28;
    var rk = expandKey(key);
    var out = new Uint8Array(ctLen);
    var ctrBlock = new Uint8Array(16);
    for (var i = 0; i < 12; i++) ctrBlock[i] = raw[i];
    var ctr = 2;
    for (var off = 0; off < ctLen; off += 16) {
      ctrBlock[12] = (ctr >>> 24) & 255;
      ctrBlock[13] = (ctr >>> 16) & 255;
      ctrBlock[14] = (ctr >>> 8) & 255;
      ctrBlock[15] = ctr & 255;
      var ks = encryptBlock(rk, ctrBlock);
      var n = Math.min(16, ctLen - off);
      for (var j = 0; j < n; j++) out[off + j] = raw[12 + off + j] ^ ks[j];
      ctr = (ctr + 1) >>> 0;
    }
    return utf8Decode(out);
  }
  /* ---- AES sonu ---- */

  function fetchTimeout(url, options, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var p = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([fetch(url, options || {}), p]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function pAll(list) {
    return Promise.all(list.map(function (p) {
      return p.then(function (v) { return { ok: true, v: v }; }, function () { return { ok: false, v: null }; });
    }));
  }

  function qRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 2.5;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480|sd/.test(q)) return 1;
    return 0.5;
  }

  function qualityFromHeight(h) {
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h > 0) return "360p";
    return "Auto";
  }

  function normQuality(v) {
    var s = String(v || "").toLowerCase();
    if (!s) return "Auto";
    if (/2160|4k|uhd/.test(s)) return "4K";
    if (/1440/.test(s)) return "1440p";
    if (/1080/.test(s)) return "1080p";
    if (/720/.test(s)) return "720p";
    if (/480/.test(s)) return "480p";
    if (/360/.test(s)) return "360p";
    var n = parseInt(s, 10);
    if (n > 0) return qualityFromHeight(n);
    return "Auto";
  }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function probeQuality(url) {
    return fetchTimeout(url, { headers: MEDIA_HEADERS }).then(function (r) {
      return r.ok ? r.text() : "";
    }, function () { return ""; }).then(function (txt) {
      if (!txt || txt.indexOf("#EXTM3U") !== 0) return "Auto";
      var maxH = 0;
      (txt.match(/RESOLUTION=\d+x(\d+)/g) || []).forEach(function (rs) {
        var h = Number((rs.match(/(\d+)$/) || [])[1]) || 0;
        if (h > maxH) maxH = h;
      });
      return maxH ? qualityFromHeight(maxH) : "Auto";
    });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[vidrock]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;
    var apiUrl = SITE + "/api/" + (isTv ? "tv/" + tmdbId + "/" + s + "/" + e : "movie/" + tmdbId);
    var display = "";

    return pAll([
      fetchTimeout(apiUrl, { headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE + "/" } })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }),
      tmdbLookup(tmdbId, isTv)
    ]).then(function (res) {
      var j = (res[0] && res[0].ok) ? res[0].v : null;
      var info = (res[1] && res[1].ok) ? res[1].v : null;
      if (info) {
        display = info.title || info.name || "";
        var y = String(info.release_date || info.first_air_date || "").slice(0, 4);
        if (display && y) display += " (" + y + ")";
      }
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      if (!j) return [];
      var cands = [];
      Object.keys(j).forEach(function (name) {
        var it = j[name] || {};
        if (!it.url) return;
        var dec = "";
        try { dec = aesGcmDecrypt(it.url); } catch (err) { dec = ""; }
        if (!dec) return;
        var t = dec.trim();
        if (t.charAt(0) === "[") {
          var arr = null;
          try { arr = JSON.parse(t); } catch (err) { arr = null; }
          if (arr && arr.length) {
            arr.forEach(function (it2) {
              if (!it2 || !it2.url) return;
              cands.push({ server: name, lang: it.language || "", url: it2.url, q: normQuality(it2.resolution), type: String(it.type || "").toLowerCase() });
            });
            return;
          }
        }
        if (t.indexOf("http") !== 0) return;
        cands.push({ server: name, lang: it.language || "", url: t, q: "", type: String(it.type || "").toLowerCase() });
      });
      var probes = cands.map(function (c) {
        if (c.q) return null;
        var isHls = c.type === "hls" || /\.m3u8(\?|$)/.test(c.url) || c.type === "";
        if (!isHls) { c.q = "Auto"; return null; }
        return probeQuality(c.url).then(function (q) { c.q = q || "Auto"; }, function () { c.q = "Auto"; });
      }).filter(function (x) { return x; });
      return pAll(probes).then(function () { return cands; });
    }).then(function (cands) {
      var out = (cands || []).map(function (c) {
        var q = c.q || "Auto";
        var isHls = c.type === "hls" || /\.m3u8(\?|$)/.test(c.url);
        var lang = c.lang && c.lang !== "English" ? " (" + c.lang + ")" : "";
        return {
          name: "VidRock - " + c.server + lang + " " + q,
          title: display + "\n" + c.server + lang + " " + q,
          url: c.url,
          quality: q,
          isM3u8: isHls,
          type: isHls ? "hls" : "mp4",
          headers: MEDIA_HEADERS,
          subtitles: [],
          provider: "vidrock"
        };
      });
      out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
      out = out.slice(0, MAX_STREAMS);
      console.log(tag + " Found " + out.length + " streams");
      return out;
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
