/**
 * moviebox - MovieBox provider for Nuvio
 * Flow: TMDB -> search/v2 -> subject get -> play-info -> DASH/HLS/MP4 + captions
 * Hermes-safe: Promise chains only, no deps (embedded MD5/base64).
 */
(function () {
  "use strict";

  var HOSTS = ["https://api6.aoneroom.com", "https://api5.aoneroom.com", "https://api4.aoneroom.com", "https://api4sg.aoneroom.com", "https://api3.aoneroom.com"];
  var TOKEN_URL = "https://apig.inmoviebox.com/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1";
  var PLAYER_BASE = "https://moviebox.ph";
  var PLAYER_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
  var PKG_NAME = "com.community.mbox.in";
  var PKG_CODE = 50020130;
  var KEY_B64_DEFAULT = "NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==";
  var KEY_B64_ALT = "WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ==";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 15000;

  var deviceId = "";
  var selBrand = "";
  var selModel = "";
  var bearerToken = "";

  function utf8Bytes(s) {
    s = String(s);
    var out = [], i, c, d, cp;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else if (c >= 55296 && c <= 56319 && i + 1 < s.length) {
        d = s.charCodeAt(i + 1);
        if (d >= 56320 && d <= 57343) {
          cp = ((c - 55296) << 10) + (d - 56320) + 65536;
          out.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
          i++;
        } else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
      } else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return out;
  }

  function utf8Str(bytes) {
    var s = "", i = 0, c;
    while (i < bytes.length) {
      c = bytes[i];
      if (c < 128) { s += String.fromCharCode(c); i++; }
      else if ((c & 224) === 192) { s += String.fromCharCode(((c & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
      else if ((c & 240) === 224) { s += String.fromCharCode(((c & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
      else if ((c & 248) === 240) {
        var cp = ((c & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
        cp -= 65536;
        s += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023));
        i += 4;
      } else i++;
    }
    return s;
  }

  var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64encode(bytes) {
    var s = "", i, b0, b1, b2;
    for (i = 0; i < bytes.length; i += 3) {
      b0 = bytes[i]; b1 = i + 1 < bytes.length ? bytes[i + 1] : 0; b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      s += B64C[b0 >> 2] + B64C[((b0 & 3) << 4) | (b1 >> 4)];
      s += i + 1 < bytes.length ? B64C[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      s += i + 2 < bytes.length ? B64C[b2 & 63] : "=";
    }
    return s;
  }

  function b64decode(str) {
    str = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
    var out = [], i, e0, e1, e2, e3;
    for (i = 0; i < str.length; i += 4) {
      e0 = B64C.indexOf(str.charAt(i)); e1 = B64C.indexOf(str.charAt(i + 1));
      e2 = str.charAt(i + 2) === "=" ? 0 : B64C.indexOf(str.charAt(i + 2));
      e3 = str.charAt(i + 3) === "=" ? 0 : B64C.indexOf(str.charAt(i + 3));
      out.push((e0 << 2) | (e1 >> 4));
      if (str.charAt(i + 2) !== "=") out.push(((e1 & 15) << 4) | (e2 >> 2));
      if (str.charAt(i + 3) !== "=") out.push(((e2 & 3) << 6) | e3);
    }
    return out;
  }

  function md5Raw(bytes) {
    var m = bytes.slice();
    var bitLen = bytes.length * 8;
    m.push(128);
    while ((m.length % 64) !== 56) m.push(0);
    var lo = bitLen >>> 0, hi = Math.floor(bitLen / 4294967296), i, j;
    for (i = 0; i < 4; i++) m.push((lo >>> (i * 8)) & 255);
    for (j = 0; j < 4; j++) m.push((hi >>> (j * 8)) & 255);
    var a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
    function rot(x, n) { return (x << n) | (x >>> (32 - n)); }
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    for (var off = 0; off < m.length; off += 64) {
      var X = [], k;
      for (k = 0; k < 16; k++) X[k] = (m[off + k * 4] | (m[off + k * 4 + 1] << 8) | (m[off + k * 4 + 2] << 16) | (m[off + k * 4 + 3] << 24)) | 0;
      var A = a0, B = b0, C = c0, D = d0, f, g, t;
      for (t = 0; t < 64; t++) {
        if (t < 16) { f = (B & C) | (~B & D); g = t; }
        else if (t < 32) { f = (D & B) | (~D & C); g = (5 * t + 1) % 16; }
        else if (t < 48) { f = B ^ C ^ D; g = (3 * t + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7 * t) % 16; }
        var K = Math.floor(Math.abs(Math.sin(t + 1)) * 4294967296);
        var sum = (A + f + K + X[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rot(sum, S[t])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    function w(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
    return w(a0).concat(w(b0), w(c0), w(d0));
  }

  function md5HexBytes(bytes) {
    var d = md5Raw(bytes), s = "", i;
    for (i = 0; i < d.length; i++) s += (d[i] < 16 ? "0" : "") + d[i].toString(16);
    return s;
  }

  function md5Hex(str) { return md5HexBytes(utf8Bytes(str)); }

  function hmacMd5Bytes(key, msg) {
    if (key.length > 64) key = md5Raw(key);
    var ip = [], op = [], i, kb;
    for (i = 0; i < 64; i++) {
      kb = i < key.length ? key[i] : 0;
      ip.push(kb ^ 54); op.push(kb ^ 92);
    }
    return md5Raw(op.concat(md5Raw(ip.concat(msg))));
  }

  var SECRET_CACHE = {};

  function secretBytes(alt) {
    var k = alt ? "a" : "d";
    if (!SECRET_CACHE[k]) {
      SECRET_CACHE[k] = b64decode(utf8Str(b64decode(alt ? KEY_B64_ALT : KEY_B64_DEFAULT)));
    }
    return SECRET_CACHE[k];
  }

  var BRANDS = { Samsung: ["SM-S918B", "SM-A528B"], Xiaomi: ["2201117TI", "Redmi Note 11"], OnePlus: ["LE2111", "IN2023"], Google: ["Pixel 6", "Pixel 8"], Realme: ["RMX3085", "RMX3551"] };

  function initSession() {
    if (deviceId) return;
    var chars = "0123456789abcdef", i;
    deviceId = "";
    for (i = 0; i < 32; i++) deviceId += chars[Math.floor(Math.random() * 16)];
    var brands = Object.keys(BRANDS);
    selBrand = brands[Math.floor(Math.random() * brands.length)];
    var models = BRANDS[selBrand];
    selModel = models[Math.floor(Math.random() * models.length)];
  }

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

  function canonicalStr(method, accept, ctype, url, body, ts) {
    var path, query = "";
    var q = url.indexOf("?");
    var noq = q === -1 ? url : url.slice(0, q);
    path = noq.replace(/^https?:\/\/[^\/]+/, "");
    if (q !== -1) query = url.slice(q + 1).split("&").sort().join("&");
    var curl = query ? path + "?" + query : path;
    var blen = "", bhash = "";
    if (body) {
      var bb = utf8Bytes(body);
      blen = String(bb.length);
      bhash = md5HexBytes(bb);
    }
    return method.toUpperCase() + " " + (accept || "") + " " + (ctype || "") + " " + blen + " " + ts + " " + bhash + " " + curl;
  }

  function buildHeaders(method, url, body, custom, ts, alt) {
    custom = custom || {};
    var accept = custom.Accept || "application/json";
    var ctype = custom["Content-Type"] || (body ? "application/json; charset=utf-8" : "application/json");
    var rev = String(ts).split("").reverse().join("");
    var can = canonicalStr(method, accept, ctype, url, body, ts);
    var sig = b64encode(hmacMd5Bytes(secretBytes(alt), utf8Bytes(can)));
    var info = JSON.stringify({
      package_name: PKG_NAME, version_name: "4.0.03.0920.03", version_code: PKG_CODE,
      os: "android", os_version: "14", device_id: deviceId, install_store: "official",
      gaid: "1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d", brand: selBrand.toLowerCase(), model: selModel,
      system_language: "en", net: "NETWORK_WIFI", region: "IN", timezone: "Asia/Calcutta", sp_code: ""
    });
    var h = {
      Accept: accept,
      "Content-Type": ctype,
      "x-client-token": ts + "," + md5Hex(rev),
      "x-tr-signature": ts + "|2|" + sig,
      "User-Agent": PKG_NAME + "/" + PKG_CODE + " (Linux; U; Android 14; en_IN; " + selModel + "; Build/UD1A.230803.041; Cronet/145.0.7582.0)",
      "x-client-info": info,
      "x-client-status": "0"
    };
    for (var k in custom) h[k] = custom[k];
    return h;
  }

  function jwtValid(token) {
    try {
      var p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      var o = JSON.parse(utf8Str(b64decode(p)));
      return o && o.exp && (o.exp * 1000 - Date.now() > 60000);
    } catch (e) { return false; }
  }

  function sendOnce(method, url, body, custom, ts, alt, useBearer) {
    var h = buildHeaders(method, url, body, custom, ts, alt);
    if (useBearer && bearerToken) h.Authorization = "Bearer " + bearerToken;
    var opt = { method: method, headers: h };
    if (body) opt.body = body;
    return fetchTimeout(url, opt).then(function (res) {
      if (!res.ok) {
        if (res.status === 403 || res.status === 429 || res.status >= 500) return { retry: true };
        return null;
      }
      return res.text().then(function (text) {
        var parsed = text;
        try { parsed = JSON.parse(text); } catch (e) {}
        var xu = null;
        try { xu = res.headers.get("x-user"); } catch (e) {}
        if (xu) {
          try {
            var xo = JSON.parse(xu);
            if (xo && xo.token && jwtValid(xo.token)) bearerToken = xo.token;
          } catch (e) {}
        }
        return { data: parsed, headers: res.headers };
      });
    }).catch(function () { return { retry: true }; });
  }

  function mbRequest(method, url, body, customHeaders, isTokenFetch) {
    initSession();
    customHeaders = customHeaders || {};
    var host;
    try { host = new URL(url).host; } catch (e) { return Promise.resolve(null); }
    var pool = HOSTS.map(function (h) {
      try { return new URL(h).host; } catch (e) { return ""; }
    });
    var hosts = pool.indexOf(host) === -1 ? [host] : [host].concat(pool.filter(function (h) { return h && h !== host; })).slice(0, 3);
    var queue = [];
    hosts.forEach(function (h) { queue.push([h, false]); queue.push([h, true]); });
    var p = Promise.resolve({ retry: true });
    queue.forEach(function (qq) {
      p = p.then(function (r) {
        if (r && !r.retry) return r;
        var uu = url.replace(/^https?:\/\/[^\/]+/, "https://" + qq[0]);
        var ts = Date.now();
        return sendOnce(method, uu, body, customHeaders, ts, qq[1], !isTokenFetch);
      });
    });
    return p.then(function (r) { return (r && !r.retry) ? r : null; });
  }

  function getCachedToken() {
    if (bearerToken && jwtValid(bearerToken)) return Promise.resolve(bearerToken);
    console.log("[MovieBox] Fetching fresh anonymous token...");
    return mbRequest("GET", TOKEN_URL, null, {}, true).then(function () {
      return (bearerToken && jwtValid(bearerToken)) ? bearerToken : "";
    });
  }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return r.json();
    }).then(function (d) {
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        originalTitle: d.original_title || d.original_name || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4)
      };
    });
  }

  function normTitle(s) {
    return String(s || "").replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ").replace(/\b(dub|dubbed|hd|4k|hindi|tamil|telugu|dual audio)\b/gi, " ").trim().toLowerCase().replace(/:/g, " ").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ");
  }

  function searchMB(query) {
    var url = HOSTS[0] + "/wefeed-mobile-bff/subject-api/search/v2";
    var body = JSON.stringify({ page: 1, perPage: 20, keyword: query, restrictKid: 1 });
    return mbRequest("POST", url, body, {}).then(function (res) {
      var out = [];
      try {
        var groups = res && res.data && res.data.data && res.data.data.results;
        (groups || []).forEach(function (g) { if (g && g.subjects) out = out.concat(g.subjects); });
      } catch (e) {}
      return out;
    });
  }

  function findBest(subjects, tmdbTitle, tmdbYear, mediaType) {
    var nt = normTitle(tmdbTitle);
    var want = mediaType === "tv" ? 2 : 1;
    var best = null, bestScore = 0;
    (subjects || []).forEach(function (s) {
      if (!s || s.subjectType !== want) return;
      var n = normTitle(s.title);
      var y = s.year || (s.releaseDate ? String(s.releaseDate).substring(0, 4) : null);
      var score = 0;
      if (n === nt) score += 50;
      else if (n && nt && (n.indexOf(nt) !== -1 || nt.indexOf(n) !== -1)) score += 15;
      if (tmdbYear && y && tmdbYear == y) score += 35;
      if (score > bestScore) { bestScore = score; best = s; }
    });
    return bestScore >= 40 ? best : null;
  }

  function getPlaybackPage(detail) {
    var cands = [detail.detailPath, detail.detail_path, detail.path, detail.slug];
    var dp = null, i;
    for (i = 0; i < cands.length; i++) {
      if (typeof cands[i] === "string" && cands[i].trim()) { dp = cands[i]; break; }
    }
    var webBase = PLAYER_BASE;
    var doms = [detail.detailDomain, detail.webDomain, detail.webUrl, detail.detailUrl, detail.shareUrl];
    for (i = 0; i < doms.length; i++) {
      if (typeof doms[i] !== "string") continue;
      try {
        var pu = new URL(doms[i].indexOf("http") === 0 ? doms[i] : "https://" + doms[i]);
        if (pu.host.indexOf("aoneroom.com") === -1) webBase = pu.origin;
        if (!dp && pu.pathname && pu.pathname !== "/") dp = pu.pathname;
        break;
      } catch (e) {}
    }
    if (!dp) return { webBase: webBase, referer: webBase + "/", detailPath: null };
    dp = dp.replace(/^\/+/, "").replace(/^movies\//, "");
    return { webBase: webBase, referer: webBase + "/", detailPath: dp };
  }

  function dubVariants(detail) {
    var out = [];
    ["dubs", "dubList", "languages", "lans", "resources", "versions", "subResources"].forEach(function (k) {
      var arr = detail[k];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (d) {
        if (!d || typeof d !== "object") return;
        var id = d.subjectId || d.subject_id || d.id;
        var lang = d.lanName || d.languageName || d.language || d.lan;
        if (id && lang) out.push({ id: id, lang: lang });
      });
    });
    return out;
  }

  function parseQuality(v) {
    var m = String(v || "").match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) + "p" : "Auto";
  }

  function formatType(url, declared) {
    if (declared) {
      var d = String(declared).toUpperCase();
      if (d === "DASH" || d === "HLS" || d === "MP4" || d === "MKV") return d;
    }
    var u = String(url || "").toLowerCase();
    if (u.indexOf(".mpd") !== -1) return "DASH";
    if (u.indexOf(".m3u8") !== -1) return "HLS";
    if (u.indexOf(".mp4") !== -1) return "MP4";
    if (u.indexOf(".mkv") !== -1) return "MKV";
    return "VIDEO";
  }

  function policyUrl(signCookie) {
    if (!signCookie || typeof signCookie !== "string") return null;
    var em = signCookie.match(/Edge-Cache-Cookie=urlprefix=([^:;\s]+)/);
    if (em) {
      try {
        var std = em[1].replace(/_/g, "/").replace(/-/g, "+");
        while (std.length % 4) std += "=";
        var dec = utf8Str(b64decode(std)).replace(/\/+$/, "");
        if (dec) return dec + "/index.mpd";
      } catch (e) {}
    }
    var cm = signCookie.match(/CloudFront-Policy=([^;]+)/);
    if (cm) {
      try {
        var b = cm[1].replace(/-/g, "+").replace(/~/g, "/").replace(/_/g, "=");
        while (b.length % 4) b += "=";
        var root = JSON.parse(utf8Str(b64decode(b)));
        var res = root && root.Statement && root.Statement[0] && root.Statement[0].Resource;
        if (res && typeof res === "string") {
          var t = res.replace(/[*\/]+$/, "");
          return t.toLowerCase().slice(-4) === ".mpd" ? t : t + "/index.mpd";
        }
      } catch (e) {}
    }
    return null;
  }

  function collectStreams(playData) {
    var out = [];
    function push(item, format) {
      if (!item) return;
      if (typeof item === "string") { if (item) out.push({ url: item, format: format }); return; }
      if (typeof item === "object") {
        if (item.url || item.playUrl || item.resourceLink || item.streamUrl) {
          if (!item.format && format) item.format = format;
          out.push(item);
          return;
        }
        Object.keys(item).forEach(function (k) {
          if (typeof item[k] === "string" && item[k]) out.push({ url: item[k], resolution: k, format: format });
        });
      }
    }
    (playData.streams || []).forEach(function (s) { push(s); });
    [["netDash", "DASH"], ["netHls", "HLS"]].forEach(function (pair) {
      var v = playData[pair[0]];
      if (!v) return;
      (Array.isArray(v) ? v : [v]).forEach(function (it) { push(it, pair[1]); });
    });
    var seen = {}, ded = [];
    out.forEach(function (s) {
      var key = s.url || s.playUrl || s.resourceLink || s.streamUrl || "";
      if (!key || seen[key]) return;
      seen[key] = true;
      ded.push(s);
    });
    return ded;
  }

  function audioLabel(stream, fallback) {
    var raw = stream.languageName || stream.lanName || stream.language || stream.lan || fallback || "Unknown";
    raw = String(raw).replace(/\bdub\b/gi, " ").replace(/\s+/g, " ").trim();
    if (!raw) raw = "Unknown";
    raw = raw.charAt(0).toUpperCase() + raw.slice(1);
    if (/audio/i.test(raw)) return raw;
    return raw + " Audio";
  }

  function extraTokens(st) {
    var toks = [];
    function yes(v) { return v === true || (typeof v === "string" && /true|1|yes|hdr|dv|dolby/i.test(v)); }
    if (yes(st.hdr) || yes(st.hdr10) || /hdr/i.test(String(st.definition || st.quality || ""))) toks.push("HDR");
    if (yes(st.dolbyVision) || yes(st.dolby_vision)) toks.push("DV");
    if (/hevc|x265/i.test(String(st.codec || st.videoCodec || ""))) toks.push("HEVC");
    return toks.join(" ");
  }

  function fetchSubs(subjectId, streamId, lang) {
    var out = [];
    function add(arr) {
      (arr || []).forEach(function (c) {
        if (c && (c.url || c.file)) out.push({ url: c.url || c.file, lang: c.label || c.lang || c.lan || lang || "Unknown" });
      });
    }
    return mbRequest("GET", HOSTS[0] + "/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=" + encodeURIComponent(subjectId) + "&streamId=" + encodeURIComponent(streamId), null, {}).then(function (r) {
      try {
        var d = r && r.data && r.data.data;
        add(d && (d.extCaptions || d.extCaptionList || d.captions));
      } catch (e) {}
      return mbRequest("GET", HOSTS[0] + "/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=" + encodeURIComponent(subjectId) + "&resourceId=" + encodeURIComponent(streamId) + "&episode=0", null, {});
    }).then(function (r2) {
      try {
        var d2 = r2 && r2.data && r2.data.data;
        add(d2 && (d2.extCaptions || d2.extCaptionList || d2.captions));
      } catch (e) {}
      return out;
    }).catch(function () { return out; });
  }

  function getStreamLinks(subjectId, season, episode, mediaTitle, mediaType) {
    return mbRequest("GET", HOSTS[0] + "/wefeed-mobile-bff/subject-api/get?subjectId=" + encodeURIComponent(subjectId), null, {}).then(function (res) {
      if (!res || !res.data || !res.data.data) return [];
      var detail = res.data.data;
      var page = getPlaybackPage(detail);
      var origLang = detail.language || detail.lan || detail.originalLanguage || "en";
      var ids = [{ id: subjectId, lang: origLang }];
      dubVariants(detail).forEach(function (d) { ids.push(d); });
      var pHeaders = {
        Origin: page.webBase,
        Referer: page.referer,
        "User-Agent": PLAYER_UA,
        "x-request-lang": "en",
        "x-vip-restrict": "0",
        "x-no-high-risk-restrict": "0"
      };
      var all = [];
      var chain = Promise.resolve();
      ids.forEach(function (item) {
        chain = chain.then(function () {
          var qp = "subjectId=" + encodeURIComponent(item.id) + "&se=" + season + "&ep=" + episode + "&streamSignType=1";
          if (page.detailPath) qp += "&detailPath=" + encodeURIComponent(page.detailPath);
          qp += "&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1";
          return mbRequest("GET", HOSTS[0] + "/wefeed-mobile-bff/subject-api/play-info?" + qp, null, pHeaders).then(function (pr) {
            if (!pr || !pr.data || !pr.data.data) return null;
            var list = collectStreams(pr.data.data);
            var inner = Promise.resolve();
            list.forEach(function (st) {
              inner = inner.then(function () {
                var rawUrl = st.url || st.playUrl || st.resourceLink || st.streamUrl || "";
                var signCookie = st.signCookie || null;
                var finalUrl = policyUrl(signCookie) || rawUrl;
                if (!finalUrl || finalUrl.indexOf("b164fbfb4347792950bdfbfb563d39d9") !== -1) return null;
                var ql = st.resolutions || st.resolution || st.quality || "Auto";
                var quality = parseQuality(ql);
                var alabel = audioLabel(st, item.lang);
                var sid = st.id || (item.id + "|" + season + "|" + episode);
                return fetchSubs(item.id, sid, item.lang).then(function (subs) {
                  var fmt = formatType(finalUrl, st.format);
                  var extra = extraTokens(st);
                  var skey = st.signHeaderKey || st.sign_header_key || "Cookie";
                  var hh = {};
                  for (var k in pHeaders) hh[k] = pHeaders[k];
                  if (signCookie) hh[skey] = signCookie;
                  var se = (mediaType === "tv" && season > 0) ? " S" + season + "E" + episode : "";
                  all.push({
                    name: "MovieBox",
                    title: mediaTitle + se + " - " + quality + " (" + alabel + ")" + (extra ? " " + extra : "") + " [" + fmt + "]",
                    url: finalUrl,
                    quality: quality,
                    headers: hh,
                    subtitles: subs,
                    provider: "moviebox"
                  });
                  return null;
                });
              });
            });
            return inner;
          });
        });
      });
      return chain.then(function () {
        console.log("[MovieBox] Found " + all.length + " streams");
        return all;
      });
    }).catch(function (err) {
      console.log("[MovieBox] getStreamLinks error: " + (err && err.message));
      return [];
    });
  }

  function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    var tag = "[MovieBox]";
    console.log(tag + " Querying streams for TMDB: " + tmdbId + ", Type: " + mediaType);
    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      if (!info || !info.title) return [];
      return searchMB(info.title).then(function (subs) {
        var best = findBest(subs, info.title, info.year, mediaType);
        if (!best && info.originalTitle && info.originalTitle !== info.title) {
          return searchMB(info.originalTitle).then(function (subs2) {
            return findBest(subs2, info.originalTitle, info.year, mediaType);
          });
        }
        return best;
      }).then(function (best) {
        if (!best) {
          console.log(tag + " No matching content found");
          return [];
        }
        var s = mediaType === "tv" ? (seasonNum || 1) : 0;
        var e = mediaType === "tv" ? (episodeNum || 1) : 0;
        return getStreamLinks(best.subjectId, s, e, info.title, mediaType);
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
