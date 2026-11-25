/**
 * vaplayer - VAplayer provider for Nuvio (vaplayer.ru / nextgencloudfabric / streamdata)
 *
 * Yeni akis (Ekim/Kasim 2026):
 *   1) vaplayer.ru/embed/{tv|movie}/...  -> iframe data-api
 *   2) /embed/va_src.php?path=...        -> { src: "https://<player>/embed/...?va=..." }
 *   3) player HTML                       -> CONFIG.apiToken (tek kullanilik, IP'ye bagli)
 *   4) streamdata .../api.php?...&stream_urls&api_token=... (Referer: player URL)
 *   5) data.stream_urls metin ise ChaCha20 ile sifreli -> wasm.php modulunden anahtar
 *      cikarilir ve saf JS ile cozulur (WebAssembly/Hermes gerektirmez)
 *   6) her stream host'u /generate.php?api_token=... ile ?token= alir
 *
 * Eski API (api.php?type=&tmdb=...&season=&episode=) artik 404 donuyor;
 * token'i vaplayer.ru/embed sayfasinda aramak da artik 403 veriyor cunku token
 * sadece 3. adimdaki player sayfasinda uretiliyor.
 *
 * Hermes-safe: ES5 + Promise zincirleri, harici kutuphane yok.
 */
(function () {
  "use strict";

  var EMBED_BASE = "https://vaplayer.ru";
  var STREAM_DATA_API = "https://streamdata.vaplayer.ru/api.php";
  var SUBS = "https://sub.vdrk.site";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TIMEOUT = 12000;
  var MAX_MIRRORS = 3;
  var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // ------------------------------------------------------------- temel fetch

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

  function fetchJson(url, options) {
    return fetchTimeout(url, options).then(function (r) {
      return r.json().catch(function () { return null; });
    });
  }

  function fetchText(url, options) {
    return fetchTimeout(url, options).then(function (r) {
      if (!r.ok) return "";
      return r.text();
    }).catch(function () { return ""; });
  }

  function fetchHtml(url, options) {
    return fetchTimeout(url, options).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.text();
    });
  }

  function fetchBuffer(url, options) {
    return fetchTimeout(url, options).then(function (r) {
      if (!r.ok || typeof r.arrayBuffer !== "function") throw new Error("no binary response");
      return r.arrayBuffer();
    });
  }

  function originOf(u) {
    var m = String(u || "").match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : "";
  }

  function resolveUrl(u, base) {
    u = String(u || "");
    if (/^https?:\/\//i.test(u)) return u;
    var o = originOf(base);
    if (!o) return u;
    return u.charAt(0) === "/" ? o + u : o + "/" + u;
  }

  function setQueryParam(url, key, value) {
    var q = url.indexOf("?");
    var base = q > -1 ? url.substring(0, q) : url;
    var qs = q > -1 ? url.substring(q + 1) : "";
    var parts = [];
    qs.split("&").forEach(function (p) {
      if (p && p.split("=")[0] !== key) parts.push(p);
    });
    parts.push(key + "=" + encodeURIComponent(value));
    return base + "?" + parts.join("&");
  }

  // ------------------------------------------------------- base64 / utf8 yardim

  function b64ToBytes(str) {
    var s = String(str || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
    while (s.length % 4) s += "=";
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), buf = 0, bits = 0, n = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "=") break;
      var v = B64C.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (buf >>> bits) & 255;
      }
    }
    return out.subarray(0, n);
  }

  function utf8Decode(bytes) {
    var s = "", i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 128) s += String.fromCharCode(c);
      else if (c > 191 && c < 224) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else if (c > 223 && c < 240) s += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else {
        var cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      }
    }
    return s;
  }

  // ------------------------------------------------ saf JS ChaCha20 (WASM yerine)

  function rotl32(v, n) { return ((v << n) | (v >>> (32 - n))) | 0; }

  function u32le(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
  }

  function quarter(s, a, b, c, d) {
    s[a] = (s[a] + s[b]) | 0; s[d] = rotl32(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) | 0; s[b] = rotl32(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) | 0; s[d] = rotl32(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) | 0; s[b] = rotl32(s[b] ^ s[c], 7);
  }

  function chachaBlock(keyWords, counter, nonce, out) {
    var s = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
    for (var i = 0; i < 8; i++) s[4 + i] = keyWords[i];
    s[12] = counter | 0;
    s[13] = nonce[0] | 0; s[14] = nonce[1] | 0; s[15] = nonce[2] | 0;
    var x = s.slice();
    for (var r = 0; r < 10; r++) {
      quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13);
      quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
      quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12);
      quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
    }
    for (var j = 0; j < 16; j++) {
      var v = (x[j] + s[j]) | 0;
      out[j * 4] = v & 255;
      out[j * 4 + 1] = (v >>> 8) & 255;
      out[j * 4 + 2] = (v >>> 16) & 255;
      out[j * 4 + 3] = (v >>> 24) & 255;
    }
  }

  function chachaDecrypt(keyWords, raw) {
    var nonce = [u32le(raw, 0), u32le(raw, 4), u32le(raw, 8)];
    var bodyLen = raw.length - 12;
    var out = new Uint8Array(bodyLen);
    var ks = new Uint8Array(64);
    for (var off = 0, counter = 0; off < bodyLen; off += 64, counter = (counter + 1) | 0) {
      chachaBlock(keyWords, counter, nonce, ks);
      var n = Math.min(64, bodyLen - off);
      for (var i = 0; i < n; i++) out[off + i] = raw[off + 12 + i] ^ ks[i];
    }
    return utf8Decode(out);
  }

  // ------------------------------------- wasm.php veri bolumlerini okuma (LEB)

  function readUleb(b, p) {
    var v = 0, shift = 0, byte;
    do { byte = b[p++]; v |= (byte & 127) << shift; shift += 7; } while (byte & 128);
    return [v >>> 0, p];
  }

  function readSleb(b, p) {
    var v = 0, shift = 0, byte;
    do { byte = b[p++]; v |= (byte & 127) << shift; shift += 7; } while (byte & 128);
    if (byte & 64) v |= ~0 << shift;
    return [v | 0, p];
  }

  function wasmDataSegments(buffer) {
    var b = new Uint8Array(buffer);
    if (b.length < 8 || b[0] !== 0 || b[1] !== 97 || b[2] !== 115 || b[3] !== 109) return [];
    var p = 8, segs = [];
    while (p + 2 <= b.length) {
      var id = b[p++];
      var r = readUleb(b, p); var size = r[0]; p = r[1];
      var end = p + size;
      if (end > b.length) break;
      if (id === 11) {
        r = readUleb(b, p); var count = r[0]; p = r[1];
        for (var i = 0; i < count && p < end; i++) {
          r = readUleb(b, p); var flags = r[0]; p = r[1];
          var off = -1;
          if (flags === 2) { r = readUleb(b, p); p = r[1]; } // memory index
          if ((flags === 0 || flags === 2) && b[p] === 0x41) {
            p++;
            r = readSleb(b, p); off = r[0] >>> 0; p = r[1];
            if (b[p] === 0x0b) p++;
          }
          r = readUleb(b, p); var len = r[0]; p = r[1];
          if (p + len > b.length) break;
          segs.push({ off: off, bytes: b.subarray(p, p + len) });
          p += len;
        }
      }
      p = end;
    }
    return segs;
  }

  // Modul her istekte degisiyor: veri bolumlerindeki 32'ser baytlik parcalarin
  // XOR'u gercek ChaCha anahtarini veriyor. Cozum "http" ile basliyorsa dogru
  // cift bulundu demektir (WASM icinde WebAssembly calistirmaya gerek yok).
  function decodeEncryptedStreams(encoded, wasmBuffer) {
    var raw = b64ToBytes(encoded);
    if (raw.length < 13) return [];
    var segs = wasmDataSegments(wasmBuffer).filter(function (s) {
      return s.bytes.length >= 32 && s.off >= 0;
    });
    for (var i = 0; i < segs.length; i++) {
      for (var j = i + 1; j < segs.length; j++) {
        var a = segs[i].bytes, b = segs[j].bytes;
        var words = [];
        for (var w = 0; w < 8; w++) {
          words.push((a[w * 4] ^ b[w * 4]) |
            ((a[w * 4 + 1] ^ b[w * 4 + 1]) << 8) |
            ((a[w * 4 + 2] ^ b[w * 4 + 2]) << 16) |
            ((a[w * 4 + 3] ^ b[w * 4 + 3]) << 24));
        }
        var plain = chachaDecrypt(words, raw);
        if (/^https?:\/\//.test(plain.trim())) {
          return plain.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return /^https?:\/\//i.test(s); });
        }
      }
    }
    return [];
  }

  // ----------------------------------------------------------- aciklama/siralama

  function parseRelease(s) {
    try { s = decodeURIComponent(s); } catch (e) {}
    s = " " + String(s || "").toLowerCase().replace(/[^a-z0-9+.]+/g, " ") + " ";
    var codec = /x265|hevc|h265|h\.265/.test(s) ? "HEVC x265" : (/x264|h264|h\.264|avc/.test(s) ? "H.264" : "");
    var depth = /10bit|10 bit|hi10/.test(s) ? "10bit" : "";
    var hdr = /dolby.?vision|\bdv\b|\bdovi\b/.test(s) ? "DV" : (/hdr10\+/.test(s) ? "HDR10+" : (/hdr10/.test(s) ? "HDR10" : (/hdr\b/.test(s) ? "HDR" : "")));
    var audio = /truehd/.test(s) ? "TrueHD" : (/atmos/.test(s) ? "Atmos" : (/dts/.test(s) ? "DTS" : ""));
    var ach = /ddp.?5\.1|dd.?5\.1|ac.?3|5\.1/.test(s) ? "5.1" : (/7\.1/.test(s) ? "7.1" : "");
    var net = /\bnf\b|netflix/.test(s) ? "NF " : (/\bamzn\b|amazon/.test(s) ? "AMZN " : (/\batvp\b|apple/.test(s) ? "ATVP " : (/\bdsnp\b|disney/.test(s) ? "DSNP " : "")));
    var src = /remux/.test(s) ? "REMUX" : (/blu.?ray/.test(s) ? "BluRay" : (/web.?dl/.test(s) ? "WEB-DL" : (/web.?rip/.test(s) ? "WEBRip" : (/\bhdtv\b/.test(s) ? "HDTV" : ""))));
    var dual = /\bdual\b/.test(s) ? "Dual Audio" : "";
    return { codec: codec, depth: depth, hdr: hdr, audio: (audio + (ach ? " " + ach : "")).trim(), src: (net + src).trim(), dual: dual };
  }

  function parseQuality(v) {
    var s = String(v || "").toLowerCase();
    if (/2160|4k|uhd/.test(s)) return "2160p";
    if (/1080|fhd/.test(s)) return "1080p";
    if (/720/.test(s)) return "720p";
    if (/480/.test(s)) return "480p";
    if (/360/.test(s)) return "360p";
    return "HD";
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
    return list.slice().sort(function (a, b) {
      var d = qRank(b.quality) - qRank(a.quality);
      if (d) return d;
      var x = String(a.name || ""), y = String(b.name || "");
      return x < y ? -1 : (x > y ? 1 : 0);
    });
  }

  // ----------------------------------------------------------- 1-3. CONFIG akisi

  function extractConfig(html, marker) {
    var h = String(html || "");
    var start = h.indexOf(marker);
    if (start < 0) return null;
    var i = h.indexOf("{", start);
    if (i < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var j = i; j < h.length; j++) {
      var c = h.charAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(h.substring(i, j + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function fetchPlayerConfig(playerUrl, referer) {
    return fetchHtml(playerUrl, { headers: { "User-Agent": UA, Accept: "text/html", Referer: referer } }).then(function (html) {
      var cfg = extractConfig(html, "const CONFIG");
      if (cfg && cfg.apiToken) return cfg;
      // Eski tip player: CONFIG yok, token dogrudan gomulu olabilir.
      var m = html.match(/"apiToken"\s*:\s*"([^"]*)"/);
      if (m) return { apiToken: m[1], streamDataApiUrl: STREAM_DATA_API };
      return null;
    }).catch(function () { return null; });
  }

  function fetchPlayerUrl(type, tmdbId, season, episode) {
    var path = type === "tv"
      ? "/embed/tv/" + tmdbId + "/" + (season || 1) + "/" + (episode || 1)
      : "/embed/movie/" + tmdbId;
    var wrapperUrl = EMBED_BASE + path;
    var headers = { "User-Agent": UA, Accept: "text/html" };
    return fetchHtml(wrapperUrl, { headers: headers }).then(function (html) {
      // Once eski akis: token dogrudan embed sayfasinda (hala mumkun olabilir).
      var old = extractConfig(html, "const CONFIG");
      var tokenMatch = html.match(/"apiToken"\s*:\s*"([^"]*)"/);
      if (!old && tokenMatch) {
        var apiMatch = html.match(/"streamDataApiUrl"\s*:\s*"([^"]*)"/);
        old = { apiToken: tokenMatch[1], streamDataApiUrl: apiMatch ? apiMatch[1] : STREAM_DATA_API };
      }
      if (old && old.apiToken) return { cfg: old, playerUrl: wrapperUrl, wrapperUrl: wrapperUrl };

      var m = html.match(/data-api="([^"]+)"/);
      var apiPath = m ? m[1].replace(/&amp;/g, "&") : "/embed/va_src.php?path=" + encodeURIComponent(path);
      return fetchJson(EMBED_BASE + apiPath, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: wrapperUrl, "X-Requested-With": "XMLHttpRequest" }
      }).then(function (j) {
        if (!j || !j.src) throw new Error("va_src bos");
        var playerUrl = resolveUrl(j.src, wrapperUrl);
        return fetchPlayerConfig(playerUrl, wrapperUrl).then(function (cfg) {
          if (!cfg || !cfg.apiToken) throw new Error("apiToken yok");
          return { cfg: cfg, playerUrl: playerUrl, wrapperUrl: wrapperUrl };
        });
      });
    });
  }

  // ------------------------------------------------------------- 4. stream API

  function requestStreamData(ctx, type, tmdbId, season, episode, token) {
    var api = ctx.cfg.streamDataApiUrl || STREAM_DATA_API;
    var url = api + "?tmdb=" + encodeURIComponent(tmdbId) + "&type=" + type;
    if (type === "tv") url += "&season=" + (season || 1) + "&episode=" + (episode || 1);
    url += "&stream_urls&api_token=" + encodeURIComponent(token || ctx.cfg.apiToken || "");
    var origin = originOf(ctx.playerUrl) || EMBED_BASE;
    return fetchJson(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: ctx.playerUrl,
        Origin: origin
      }
    });
  }

  function getStreamData(ctx, type, tmdbId, season, episode, retry) {
    return requestStreamData(ctx, type, tmdbId, season, episode).then(function (j) {
      if (j && (String(j.status_code) === "403" || String(j.status_code) === "429") && !retry && ctx.cfg.refreshVa) {
        // Token tek kullanilik: player sayfasini yeniden render edip yeni token al.
        var url = ctx.playerUrl;
        try { url = setQueryParam(url, "va", ctx.cfg.refreshVa); } catch (e) {}
        return fetchPlayerConfig(url, ctx.wrapperUrl).then(function (cfg) {
          if (!cfg || !cfg.apiToken) return j;
          // Disariya donen ctx de yeni tokeni kullanmali (host /generate.php icin).
          ctx.cfg = cfg;
          ctx.playerUrl = url;
          return getStreamData(ctx, type, tmdbId, season, episode, true);
        });
      }
      return j;
    });
  }

  // ---------------------------------------------- 5. sifre cozme + 6. host token

  function decodeStreamUrls(j, referer) {
    var data = (j && j.data) || {};
    var rawUrls = data.stream_urls || [];
    if (typeof rawUrls === "string" && /^https?:\/\//i.test(rawUrls.trim())) {
      return rawUrls.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return /^https?:\/\//i.test(s); });
    }
    if (typeof rawUrls === "string" && j.va && j.va.wasm_url) {
      return fetchBuffer(resolveUrl(j.va.wasm_url, referer), {
        headers: { "User-Agent": UA, Accept: "application/wasm", Referer: referer }
      }).then(function (buf) {
        return decodeEncryptedStreams(rawUrls, buf);
      }).catch(function () { return []; });
    }
    if (Array.isArray(rawUrls)) {
      return rawUrls.map(function (u) { return typeof u === "string" ? u : (u && u.url); }).filter(function (u) { return !!u; });
    }
    return [];
  }

  function fetchHostToken(origin, apiToken) {
    var url = origin + "/generate.php?api_token=" + encodeURIComponent(apiToken || "");
    return fetchText(url, { headers: { "User-Agent": UA, Accept: "text/plain" } }).then(function (t) {
      t = String(t || "").trim();
      if (!t) return "";
      if (t.charAt(0) === "{" || t.charAt(0) === "[") {
        try {
          var o = JSON.parse(t);
          t = typeof o === "string" ? o : (o.token || o.data || o.string || o.result || "");
        } catch (e) {}
      }
      return String(t || "").trim();
    }).catch(function () { return ""; });
  }

  function applyHostToken(url, token) {
    if (!token || !url) return url;
    if (url.indexOf("__TOKEN__") > -1) return url.split("__TOKEN__").join(token);
    return url + (url.indexOf("?") > -1 ? "&" : "?") + "token=" + token;
  }

  function stampHostTokens(urls, apiToken) {
    var origins = [], seen = {};
    urls.forEach(function (u) {
      var o = originOf(u);
      if (o && !seen[o]) { seen[o] = true; origins.push(o); }
    });
    var chain = Promise.resolve([]);
    origins.forEach(function (origin) {
      chain = chain.then(function (acc) {
        return fetchHostToken(origin, apiToken).then(function (tk) {
          urls.forEach(function (u, i) {
            if (originOf(u) === origin && !acc[i]) acc[i] = applyHostToken(u, tk);
          });
          return acc;
        });
      });
    });
    return chain.then(function (acc) {
      return urls.map(function (u, i) { return acc[i] || u; });
    });
  }

  function fetchSubs(tmdbId, mediaType, season, episode) {
    var url = mediaType === "tv"
      ? SUBS + "/v1/tv/" + encodeURIComponent(tmdbId) + "/" + (season || 1) + "/" + (episode || 1)
      : SUBS + "/v1/movie/" + encodeURIComponent(tmdbId);
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("subs " + r.status);
      return r.json();
    }).then(function (d) {
      var out = [];
      (Array.isArray(d) ? d : []).forEach(function (s) {
        if (s && s.file) out.push({ url: s.file, lang: s.label || s.language || "Unknown" });
      });
      return out;
    }).catch(function () { return []; });
  }

  // --------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[VAplayer]";
    var type = mediaType === "tv" ? "tv" : "movie";
    var s = season || 1;
    var e = episode || 1;
    console.log(tag + " Fetching " + type + " " + tmdbId + (type === "tv" ? " S" + s + "E" + e : ""));

    return fetchPlayerUrl(type, tmdbId, s, e).then(function (ctx) {
      return getStreamData(ctx, type, tmdbId, s, e, false).then(function (j) {
        if (!j) throw new Error("Stream API yanit vermedi");
        if (j.status_code && String(j.status_code) !== "200") {
          throw new Error("Stream API " + j.status_code + " " + (j.error || ""));
        }
        return decodeStreamUrls(j, ctx.playerUrl).then(function (urls) {
          if (!urls.length && Array.isArray(j.data && j.data.cast_urls)) {
            // Son care: sifresiz cast URL'leri (oyunici bazen calisir).
            urls = j.data.cast_urls.slice();
          }
          if (!urls.length) throw new Error("Kaynak yok");
          return stampHostTokens(urls.slice(0, MAX_MIRRORS), ctx.cfg.apiToken).then(function (stamped) {
            var data = j.data || {};
            var fileName = data.file_name || "";
            var quality = parseQuality(fileName);
            var rel = parseRelease(fileName);
            var extra = [];
            if (rel.codec || rel.depth) extra.push((rel.codec + " " + rel.depth).trim());
            var aura = (rel.hdr + " " + rel.audio).trim();
            if (aura) extra.push(aura);
            if (rel.dual) extra.push(rel.dual);
            if (rel.src) extra.push(rel.src);
            var codecShort = rel.codec === "HEVC x265" ? "HEVC" : rel.codec;
            var display = data.title || "Video";
            if (type === "tv") display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);

            var out = [];
            stamped.forEach(function (u, i) {
              if (!u) return;
              var mi = i === 0 ? "" : " (M" + (i + 1) + ")";
              out.push({
                name: "VAplayer - " + quality + (codecShort ? " " + codecShort : "") + mi,
                title: display + "\n" + quality + (extra.length ? " | " + extra.join(" | ") : "") + " [HLS · " + originOf(u) + "]",
                url: u,
                quality: quality,
                isM3u8: true,
                type: "hls",
                headers: { "User-Agent": UA },
                subtitles: [],
                provider: "vaplayer"
              });
            });
            console.log(tag + " Found " + out.length + " streams");
            return qSort(out);
          });
        });
      });
    }).then(function (out) {
      if (!out || !out.length) return out;
      return fetchSubs(tmdbId, type, s, e).then(function (subs) {
        for (var i = 0; i < out.length; i++) out[i].subtitles = subs;
        return out;
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
