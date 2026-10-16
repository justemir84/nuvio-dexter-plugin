/**
 * mapple - Mapple provider for Nuvio
 * Flow: TMDB -> request-token -> playback-init (+PoW) -> per-hoster encrypt -> HLS master -> variants + wyzie subs
 * Hermes-safe: Promise chains only, no deps (embedded SHA256).
 */
(function () {
  "use strict";

  var BASE = "https://mapple.fun";
  var SUBS = "https://sub.wyzie.io";
  var TMDB_BASE = "https://api.themoviedb.org/3";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var DUA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var PUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var TIMEOUT = 15000;

  var HOSTERS = [
    { name: "Zeus", key: "mapple" }, { name: "Poseidon", key: "s25" }, { name: "Athena", key: "s2" },
    { name: "Hera", key: "s4" }, { name: "Persephone", key: "s12" }, { name: "Apollo", key: "s19" },
    { name: "Artemis", key: "s13" }, { name: "Hermes", key: "s26" }, { name: "Ares", key: "s24" },
    { name: "Aphrodite", key: "s6" }, { name: "Hephaestus", key: "s15" }, { name: "Demeter", key: "s7" },
    { name: "Dionysus", key: "s8" }, { name: "Hestia", key: "s3" }, { name: "Hades", key: "s16" },
    { name: "Nike", key: "s5" }, { name: "Atlas", key: "s1" }, { name: "Prometheus", key: "s10" }
  ];

  /* ---------- sha256 (pure js) ---------- */

  function sha256Bytes(msg) {
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var ml = msg.length, bitLenLo = (ml * 8) >>> 0, bitLenHi = Math.floor(ml / 4294967296), i, j;
    msg.push(128);
    while ((msg.length % 64) !== 56) msg.push(0);
    for (i = 3; i >= 0; i--) msg.push((bitLenHi >>> (i * 8)) & 255);
    for (i = 3; i >= 0; i--) msg.push((bitLenLo >>> (i * 8)) & 255);
    var w = new Array(64);
    for (j = 0; j < msg.length; j += 64) {
      for (i = 0; i < 16; i++) w[i] = (msg[j + i * 4] << 24) | (msg[j + i * 4 + 1] << 16) | (msg[j + i * 4 + 2] << 8) | msg[j + i * 4 + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7], t1, t2;
      for (i = 0; i < 64; i++) {
        var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        var ch = (e & f) ^ (~e & g);
        t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) { var n = H[i]; out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
    return out;
  }

  function utf8Bytes(s) {
    s = String(s);
    var out = [], i, c, d;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else if (c >= 55296 && c <= 56319 && i + 1 < s.length && (d = s.charCodeAt(i + 1)) >= 56320 && d <= 57343) {
        var cp = ((c - 55296) << 10) + (d - 56320) + 65536;
        out.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
        i++;
      } else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return out;
  }

  function lzBits(bytes) {
    var count = 0, i, w, lz;
    for (i = 0; i < bytes.length; i += 4) {
      w = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      lz = 0;
      if (w === 0) lz = 32;
      else { while ((w & 0x80000000) === 0) { lz++; w <<= 1; } }
      count += lz;
      if (lz < 32) break;
    }
    return count;
  }

  function solvePow(challenge, difficulty) {
    var nonce = 0, max = 20000000;
    while (nonce < max) {
      var h = sha256Bytes(utf8Bytes(challenge + nonce));
      if (lzBits(h) >= difficulty) return String(nonce);
      nonce++;
    }
    return null;
  }

  /* ---------- http ---------- */

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

  function apiH(ref, json, cookie) {
    var h = { "User-Agent": DUA, Accept: "*/*", Origin: BASE, Referer: ref || BASE + "/" };
    if (json) h["Content-Type"] = "application/json";
    if (cookie) h.Cookie = cookie;
    return h;
  }

  function jar() {
    var m = {};
    return {
      update: function (res) {
        var raw = [];
        try {
          if (res && res.headers && typeof res.headers.getSetCookie === "function") raw = res.headers.getSetCookie() || [];
          else if (res && res.headers) {
            var h = res.headers.get("set-cookie");
            if (h) raw = [h];
          }
        } catch (e) {}
        raw.forEach(function (c) {
          var kv = c.split(";")[0].split("=");
          if (kv.length >= 2) m[kv[0].trim()] = kv.slice(1).join("=").trim();
        });
      },
      str: function () {
        var p = [];
        for (var k in m) p.push(k + "=" + m[k]);
        return p.join("; ");
      }
    };
  }

  /* ---------- session ---------- */

  function getSession(tmdbId, mediaType, tvSlug, mediaReferer) {
    var j = jar();
    return fetchTimeout(BASE + "/", { headers: { "User-Agent": DUA, Accept: "text/html" } }).then(function (r) {
      j.update(r);
      return r.text().then(function () {
        return fetchTimeout(BASE + "/api/request-token", {
          method: "POST",
          headers: apiH(mediaReferer, true, j.str()),
          body: ""
        });
      });
    }).then(function (r) {
      j.update(r);
      if (!r.ok) throw new Error("request-token " + r.status);
      return r.json();
    }).then(function (td) {
      var requestToken = td && td.token;
      if (!requestToken) throw new Error("no requestToken");
      var payload = { mediaId: Number(tmdbId), mediaType: mediaType, tv_slug: tvSlug, requestToken: requestToken };
      return fetchTimeout(BASE + "/api/playback-init", {
        method: "POST",
        headers: apiH(mediaReferer, true, j.str()),
        body: JSON.stringify(payload)
      }).then(function (r) {
        j.update(r);
        return r.json().then(function (pd) { return { pd: pd, payload: payload, jar: j, ref: mediaReferer }; });
      });
    }).then(function (o) {
      if (o.pd && o.pd.success && o.pd.token) return { requestToken: o.payload.requestToken, playbackToken: o.pd.token, jar: o.jar, ref: o.ref };
      if (o.pd && o.pd.requiresPow && o.pd.pow) {
        var nonce = solvePow(o.pd.pow.challenge, o.pd.pow.difficulty || 18);
        if (nonce === null) throw new Error("pow unsolved");
        var body2 = { mediaId: o.payload.mediaId, mediaType: o.payload.mediaType, tv_slug: o.payload.tv_slug, requestToken: o.payload.requestToken, pow: { challengeId: o.pd.pow.challengeId, nonce: nonce } };
        return fetchTimeout(BASE + "/api/playback-init", {
          method: "POST",
          headers: apiH(o.ref, true, o.jar.str()),
          body: JSON.stringify(body2)
        }).then(function (r2) {
          o.jar.update(r2);
          return r2.json();
        }).then(function (pd2) {
          if (!pd2 || !pd2.token) throw new Error("pow rejected");
          return { requestToken: o.payload.requestToken, playbackToken: pd2.token, jar: o.jar, ref: o.ref };
        });
      }
      throw new Error("playback-init denied");
    }).catch(function (err) {
      console.log("[Mapple] session failed: " + (err && err.message));
      return null;
    });
  }

  /* ---------- tmdb / subs ---------- */

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = TMDB_BASE + "/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&append_to_response=external_ids";
    return fetchTimeout(url, { headers: { "User-Agent": DUA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return r.json();
    }).then(function (d) {
      var ext = d.external_ids || {};
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4),
        imdbId: ext.imdb_id || null
      };
    });
  }

  function wyzie(tmdbId, mediaType, season, episode) {
    var url = mediaType === "tv"
      ? SUBS + "/search?id=" + encodeURIComponent(tmdbId) + "&season=" + (season || 1) + "&episode=" + (episode || 1)
      : SUBS + "/search?id=" + encodeURIComponent(tmdbId);
    return fetchTimeout(url, { headers: { Accept: "application/json", "User-Agent": DUA } }).then(function (r) {
      if (!r.ok) throw new Error("wyzie " + r.status);
      return r.json();
    }).then(function (d) {
      var arr = Array.isArray(d) ? d : (d && (d.subtitles || d.results)) || [];
      var out = [];
      arr.forEach(function (s) {
        if (s && (s.url || s.file)) {
          var lang = s.language || s.lang || "Subtitle";
          out.push({ url: s.url || s.file, lang: s.isCC || s.cc ? lang + " (CC)" : lang });
        }
      });
      return out;
    }).catch(function () { return []; });
  }

  function parseQuality(v) {
    var m = String(v || "").match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) + "p" : "Auto";
  }

  function pHeaders(ref) {
    return { Referer: ref || BASE + "/", Origin: BASE, "User-Agent": PUA };
  }

  function parseMaster(masterUrl, hosterName, display, subs) {
    return fetchTimeout(masterUrl, { headers: pHeaders() }).then(function (r) {
      if (!r.ok) throw new Error("master " + r.status);
      return r.text();
    }).then(function (text) {
      if (text.indexOf("#EXT-X-STREAM-INF") === -1) return null;
      var lines = text.split("\n"), out = [], cur = "Unknown", i;
      for (i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
          var rm = line.match(/RESOLUTION=\d+x(\d+)/);
          cur = rm ? rm[1] + "p" : "Unknown";
        } else if (line && line.charAt(0) !== "#") {
          var u = line.indexOf("http") === 0 ? line : masterUrl.split("/").slice(0, -1).join("/") + "/" + line;
          out.push({
            name: "Mapple [" + hosterName + "] - " + cur,
            title: display + "\n" + cur + " [HLS]",
            url: u, quality: cur, isM3u8: true, type: "hls",
            headers: pHeaders(), subtitles: subs, provider: "mapple"
          });
          cur = "Unknown";
        }
      }
      return out;
    }).catch(function () { return null; });
  }

  function hosterStream(hoster, tmdbId, mediaType, tvSlug, session, display, subs) {
    var body = JSON.stringify({ data: { mediaId: Number(tmdbId), mediaType: mediaType, tv_slug: tvSlug, source: hoster.key }, endpoint: "stream-encrypted", requestToken: session.requestToken });
    return fetchTimeout(BASE + "/api/encrypt", {
      method: "POST",
      headers: apiH(session.ref, true, session.jar.str()),
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error("encrypt " + r.status);
      return r.json();
    }).then(function (enc) {
      if (!enc || !enc.url) return [];
      var ep = BASE + enc.url + "&requestToken=" + encodeURIComponent(session.requestToken) + "&token=" + encodeURIComponent(session.playbackToken);
      return fetchTimeout(ep, { headers: apiH(session.ref, false, session.jar.str()) }).then(function (r2) {
        if (!r2.ok) throw new Error("stream " + r2.status);
        return r2.json();
      }).then(function (sd) {
        var su = sd && sd.data && sd.data.stream_url;
        if (!su || !sd.success || String(su).indexOf("playback-unavailable") !== -1) return [];
        return parseMaster(su, hoster.name, display, subs).then(function (parsed) {
          if (parsed && parsed.length) return parsed;
          return [{
            name: "Mapple [" + hoster.name + "]",
            title: display + "\nAuto [HLS]",
            url: su, quality: "Auto", isM3u8: true, type: "hls",
            headers: pHeaders(), subtitles: subs, provider: "mapple"
          }];
        });
      });
    }).catch(function (err) {
      console.log("[Mapple] " + hoster.name + ": " + (err && err.message));
      return [];
    });
  }

  function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    var tag = "[Mapple]";
    var type = mediaType === "tv" ? "tv" : "movie";
    var s = seasonNum ? Number(seasonNum) : 1;
    var e = episodeNum ? Number(episodeNum) : 1;
    var tvSlug = type === "tv" ? s + "-" + e : "";
    var ref = type === "tv" ? BASE + "/tv/" + tmdbId + "/" + s + "/" + e : BASE + "/movie/" + tmdbId;
    console.log(tag + " Querying TMDB: " + tmdbId + ", Type: " + mediaType);
    var info = null, subs = [];
    return tmdbLookup(tmdbId, type).then(function (d) {
      info = d;
      if (!info || !info.title) throw new Error("tmdb");
      return wyzie(tmdbId, type, s, e);
    }).then(function (ss) {
      subs = ss;
      return getSession(tmdbId, type, tvSlug, ref);
    }).then(function (session) {
      if (!session) return [];
      var display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (type === "tv") display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      var subLangs = subs.map(function (x) { return x.lang; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(",");
      if (subLangs) display += "";
      var all = HOSTERS.map(function (h) {
        return hosterStream(h, tmdbId, type, tvSlug, session, display, subs);
      });
      return Promise.all(all).then(function (arr) {
        var flat = [], seen = {};
        arr.forEach(function (a) {
          (a || []).forEach(function (st) {
            if (st && st.url && !seen[st.url]) {
              seen[st.url] = true;
              if (subLangs) st.title = st.title + " | " + subLangs;
              flat.push(st);
            }
          });
        });
        console.log(tag + " Found " + flat.length + " streams");
        return flat.slice(0, 20);
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
