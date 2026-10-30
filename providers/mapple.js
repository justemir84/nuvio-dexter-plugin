/**
 * mapple - Mapple provider for Nuvio
 * Flow: TMDB -> ui/session -> media-session (+PoW) -> per-hoster encrypt -> HLS master -> variants
 * Subs: Stremio OpenSubtitles v3 (via IMDb id)
 * Hermes-safe: Promise chains only, no deps (embedded SHA256).
 */
(function () {
  "use strict";

  var BASE = "https://mapple.fun";
  var STREMIO = "https://opensubtitles-v3.strem.io";
  var TMDB_BASE = "https://api.themoviedb.org/3";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  // Site/API (mapple.fun) rejects Android UA with Cloudflare 403 -> desktop UA.
  var WEB_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36";
  // Playlist proxy rejects desktop/Node TLS with 403 -> Android/ExoPlayer style UA.
  var PLAY_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
  var TIMEOUT = 15000;

  var HOSTERS = [
    { name: "Zeus", key: "mapple" },
    { name: "Poseidon", key: "s25" },
    { name: "Athena", key: "s2" },
    { name: "Hera", key: "s4" },
    { name: "Persephone", key: "s12" },
    { name: "Apollo", key: "s19" },
    { name: "Artemis", key: "s13" },
    { name: "Hermes", key: "s26" },
    { name: "Ares", key: "s24" },
    { name: "Aphrodite", key: "s6" },
    { name: "Hephaestus", key: "s15" },
    { name: "Demeter", key: "s7" },
    { name: "Dionysus", key: "s8" },
    { name: "Hestia", key: "s3" },
    { name: "Hades", key: "s16" },
    { name: "Nike", key: "s5" },
    { name: "Atlas", key: "s1" },
    { name: "Prometheus", key: "s10" }
  ];

  var LANGS = {
    eng: "English", tur: "Turkish", spa: "Spanish", por: "Portuguese", pob: "Portuguese (BR)",
    fre: "French", fra: "French", ger: "German", deu: "German", ita: "Italian", rus: "Russian",
    ara: "Arabic", hin: "Hindi", jpn: "Japanese", kor: "Korean", chi: "Chinese", zho: "Chinese",
    pol: "Polish", dut: "Dutch", nld: "Dutch", swe: "Swedish", dan: "Danish", nor: "Norwegian",
    fin: "Finnish", cze: "Czech", ces: "Czech", hun: "Hungarian", gre: "Greek", ell: "Greek",
    heb: "Hebrew", rum: "Romanian", ron: "Romanian", ukr: "Ukrainian", vie: "Vietnamese",
    tha: "Thai", ind: "Indonesian", may: "Malay", msa: "Malay", srp: "Serbian", hrv: "Croatian",
    bul: "Bulgarian", slo: "Slovak", slk: "Slovak", slv: "Slovenian", est: "Estonian",
    lav: "Latvian", lit: "Lithuanian", ice: "Icelandic", isl: "Icelandic", per: "Persian",
    fas: "Persian", ben: "Bengali", tam: "Tamil", tel: "Telugu", mal: "Malayalam",
    kan: "Kannada", mar: "Marathi", guj: "Gujarati", pun: "Punjabi", urd: "Urdu",
    alb: "Albanian", sqi: "Albanian", mac: "Macedonian", mkd: "Macedonian", bos: "Bosnian",
    cat: "Catalan", baq: "Basque", eus: "Basque", glg: "Galician", fil: "Filipino",
    tgl: "Tagalog", swa: "Swahili", afr: "Afrikaans", bel: "Belarusian", geo: "Georgian",
    kat: "Georgian", arm: "Armenian", hye: "Armenian", aze: "Azerbaijani", kaz: "Kazakh",
    uz_uz: "Uzbek", mni: "Manipuri", asm: "Assamese", ori: "Odia", pan: "Punjabi"
  };

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
    var nonce = 0, max = 50000000;
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

  function apiH(json, cookie) {
    var h = {
      "User-Agent": WEB_UA,
      Accept: json ? "application/json, text/plain, */*" : "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: BASE,
      Referer: BASE + "/"
    };
    if (json) h["Content-Type"] = "application/json";
    if (cookie) h.Cookie = cookie;
    return h;
  }

  function splitSetCookies(raw) {
    if (!raw) return [];
    var out = [];
    String(raw).split(/\r?\n/).forEach(function (line) {
      line.split(/,(?=\s*[^;,=\s]+=)/).forEach(function (c) {
        if (String(c).trim()) out.push(c);
      });
    });
    return out;
  }

  function jar() {
    var m = {};
    // Server sets the same signed session under both names; mirror in case one is hidden.
    function mirror() {
      var a = m["_mapple_site"];
      var b = m["_mapple_site_partitioned"];
      if (a && !b) m["_mapple_site_partitioned"] = a;
      else if (b && !a) m["_mapple_site"] = b;
    }
    return {
      update: function (res) {
        var raw = [];
        try {
          if (res && res.headers) {
            if (typeof res.headers.getSetCookie === "function") raw = res.headers.getSetCookie() || [];
            if (!raw.length) {
              var h = res.headers.get("set-cookie");
              if (h) raw = splitSetCookies(h);
            }
          }
        } catch (e) {}
        raw.forEach(function (c) {
          var i = String(c).indexOf("=");
          if (i <= 0) return;
          var name = String(c).slice(0, i).trim();
          var val = String(c).slice(i + 1).split(";")[0].trim();
          if (name) m[name] = val;
        });
        mirror();
      },
      str: function () {
        var p = [];
        for (var k in m) p.push(k + "=" + m[k]);
        return p.join("; ");
      }
    };
  }

  /* ---------- session ---------- */

  function finishSession(ms, payload, j) {
    if (ms && ms.token) {
      return { requestToken: payload.requestToken, token: ms.token, jar: j, cookie: j.str() };
    }
    if (ms && ms.requiresPow && ms.pow) {
      var powStart = Date.now();
      var nonce = solvePow(ms.pow.challenge, Number(ms.pow.difficulty) || 18);
      if (nonce === null) throw new Error("pow unsolved");
      console.log("[Mapple] PoW " + (Date.now() - powStart) + "ms, nonce " + nonce);
      var body = {
        mediaId: payload.mediaId,
        mediaType: payload.mediaType,
        tv_slug: payload.tv_slug,
        requestToken: payload.requestToken,
        pow: { challengeId: ms.pow.challengeId, nonce: nonce }
      };
      return fetchTimeout(BASE + "/api/media-session", {
        method: "POST",
        headers: apiH(true, j.str()),
        body: JSON.stringify(body)
      }).then(function (r) {
        j.update(r);
        if (!r.ok) throw new Error("media-session " + r.status);
        return r.json();
      }).then(function (ms2) {
        if (!ms2 || !ms2.token) throw new Error("pow rejected");
        return { requestToken: payload.requestToken, token: ms2.token, jar: j, cookie: j.str() };
      });
    }
    throw new Error("media-session denied");
  }

  function getSession(tmdbId, mediaType, tvSlug) {
    var j = jar();
    var payload = { mediaId: Number(tmdbId), mediaType: mediaType, tv_slug: tvSlug };
    return fetchTimeout(BASE + "/", {
      headers: {
        "User-Agent": WEB_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }).then(function (r) {
      j.update(r);
      return fetchTimeout(BASE + "/api/ui/session", {
        method: "POST",
        headers: apiH(true, j.str()),
        body: ""
      });
    }).then(function (r) {
      j.update(r);
      if (!r.ok) throw new Error("ui/session " + r.status);
      return r.json();
    }).then(function (td) {
      var requestToken = td && td.token;
      if (!requestToken) throw new Error("no requestToken");
      payload.requestToken = requestToken;
      return fetchTimeout(BASE + "/api/media-session", {
        method: "POST",
        headers: apiH(true, j.str()),
        body: JSON.stringify(payload)
      });
    }).then(function (r) {
      j.update(r);
      if (!r.ok) throw new Error("media-session " + r.status);
      return r.json();
    }).then(function (ms) {
      return finishSession(ms, payload, j);
    }).catch(function (err) {
      console.log("[Mapple] session failed: " + (err && err.message));
      return null;
    });
  }

  /* ---------- tmdb / subs ---------- */

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = TMDB_BASE + "/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&append_to_response=external_ids";
    return fetchTimeout(url, { headers: { "User-Agent": WEB_UA, Accept: "application/json" } }).then(function (r) {
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

  function stremioSubs(imdbId, mediaType, season, episode) {
    if (!imdbId) return Promise.resolve([]);
    var type = mediaType === "tv" ? "series" : "movie";
    var id = imdbId;
    if (type === "series") id += ":" + (season || 1) + ":" + (episode || 1);
    var url = STREMIO + "/subtitles/" + type + "/" + id + ".json";
    return fetchTimeout(url, { headers: { Accept: "application/json", "User-Agent": WEB_UA } }).then(function (r) {
      if (!r.ok) throw new Error("stremio " + r.status);
      return r.json();
    }).then(function (d) {
      var arr = (d && d.subtitles) || [];
      var out = [], seen = {}, perLang = {};
      for (var i = 0; i < arr.length && out.length < 60; i++) {
        var s = arr[i];
        if (!s || !s.url || seen[s.url]) continue;
        var code = String(s.lang || "").toLowerCase();
        if ((perLang[code] || 0) >= 3) continue;
        seen[s.url] = true;
        perLang[code] = (perLang[code] || 0) + 1;
        out.push({ url: s.url, lang: LANGS[code] || code.toUpperCase() || "Subtitle" });
      }
      function prio(x) {
        if (x.lang === "English") return 0;
        if (x.lang === "Turkish") return 1;
        return 2;
      }
      out.sort(function (a, b) { return prio(a) - prio(b); });
      return out.slice(0, 40);
    }).catch(function () { return []; });
  }

  /* ---------- streams ---------- */

  function absUrl(u) {
    u = String(u || "");
    if (/^https?:\/\//i.test(u)) return u;
    if (u.indexOf("//") === 0) return "https:" + u;
    if (u.charAt(0) === "/") return BASE + u;
    return BASE + "/" + u;
  }

  function resolveUrl(base, rel) {
    rel = String(rel || "");
    if (/^https?:\/\//i.test(rel)) return rel;
    var origin = (base.match(/^https?:\/\/[^\/]+/) || [""])[0];
    if (rel.indexOf("//") === 0) return "https:" + rel;
    if (rel.charAt(0) === "/") return origin + rel;
    var clean = base.split("?")[0].split("#")[0];
    return clean.slice(0, clean.lastIndexOf("/") + 1) + rel;
  }

  function pHeaders() {
    return { Referer: BASE + "/", Origin: BASE, "User-Agent": PLAY_UA, Accept: "*/*" };
  }

  function parseMaster(masterUrl, hosterName, display, subs) {
    return fetchTimeout(masterUrl, { headers: pHeaders() }).then(function (r) {
      if (!r.ok) throw new Error("master " + r.status);
      return r.text();
    }).then(function (text) {
      if (!text || text.indexOf("#EXT-X-STREAM-INF") === -1) return null;
      var lines = text.split("\n"), out = [], cur = null, i;
      for (i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
          var rm = line.match(/RESOLUTION=\d+x(\d+)/);
          var q = rm ? rm[1] + "p" : "Unknown";
          var bm = line.match(/BANDWIDTH=(\d+)/);
          var abm = line.match(/AVERAGE-BANDWIDTH=(\d+)/);
          var bps = bm ? Number(bm[1]) : (abm ? Number(abm[1]) : 0);
          var bitrate = bps ? (bps / 1000000).toFixed(1) + " Mbps" : "";
          var cm = line.match(/CODECS="([^"]+)"/i);
          var cds = cm ? cm[1].toLowerCase() : "";
          var vc = /dvh[1e]|dvhe|dav1/.test(cds) ? "HEVC" : (/hvc1|hev1|hevc/.test(cds) ? "HEVC" : (/avc1|avc3|avc/.test(cds) ? "H.264" : (/av01/.test(cds) ? "AV1" : "")));
          var dv = /dvh[1e]|dvhe|dav1/.test(cds) ? "DV" : "";
          var rnm = line.match(/VIDEO-RANGE=([A-Z0-9]+)/i);
          var hdr = !dv && rnm && /^(PQ|HLG)$/i.test(rnm[1]) ? "HDR" : "";
          var ac = /ec-3|eac3|ddp/.test(cds) ? "DDP" : (/ac-3/.test(cds) ? "DD" : (/mp4a|aac/.test(cds) ? "AAC" : (/opus/.test(cds) ? "Opus" : "")));
          var shortTag = [vc, dv || hdr].filter(function (x) { return !!x; }).join(" ");
          var fullTag = [vc, dv || hdr, ac].filter(function (x) { return !!x; }).join(" ");
          cur = { q: q, short: shortTag, full: fullTag, bitrate: bitrate };
        } else if (line && line.charAt(0) !== "#" && cur) {
          out.push({
            name: "Mapple [" + hosterName + "] - " + cur.q + (cur.short ? " " + cur.short : ""),
            title: display + "\n" + cur.q + (cur.bitrate ? " • " + cur.bitrate : "") + (cur.full ? " " + cur.full : "") + " [HLS]",
            url: resolveUrl(masterUrl, line), quality: cur.q, isM3u8: true, type: "hls",
            headers: pHeaders(), subtitles: subs, provider: "mapple"
          });
          cur = null;
        }
      }
      return out;
    }).catch(function () { return null; });
  }

  function hosterStream(hoster, tmdbId, mediaType, tvSlug, session, display, subs) {
    var body = JSON.stringify({
      data: { mediaId: Number(tmdbId), mediaType: mediaType, tv_slug: tvSlug, source: hoster.key },
      endpoint: "stream-encrypted",
      requestToken: session.requestToken
    });
    return fetchTimeout(BASE + "/api/encrypt", {
      method: "POST",
      headers: apiH(true, session.cookie),
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error("encrypt " + r.status);
      return r.json();
    }).then(function (enc) {
      if (!enc || !enc.url) return [];
      var ep = absUrl(enc.url);
      ep += (ep.indexOf("?") === -1 ? "?" : "&") + "requestToken=" + encodeURIComponent(session.requestToken) + "&token=" + encodeURIComponent(session.token);
      return fetchTimeout(ep, { headers: apiH(false, session.cookie) });
    }).then(function (r2) {
      if (!r2.ok) throw new Error("stream " + r2.status);
      return r2.json();
    }).then(function (sd) {
      if (!sd || sd.success === false || !sd.data || !sd.data.stream_url) return [];
      var su = String(sd.data.stream_url);
      if (su.indexOf("playback-unavailable") !== -1) return [];
      var streamUrl = absUrl(su);
      var fmt = String(sd.data.format || "hls").toLowerCase();
      if (fmt !== "hls" && streamUrl.indexOf(".m3u8") === -1) {
        return [{
          name: "Mapple [" + hoster.name + "]",
          title: display + "\n" + fmt.toUpperCase(),
          url: streamUrl, quality: "Auto", isM3u8: false, type: fmt,
          headers: pHeaders(), subtitles: subs, provider: "mapple"
        }];
      }
      return parseMaster(streamUrl, hoster.name, display, subs).then(function (parsed) {
        if (parsed && parsed.length) return parsed;
        return [{
          name: "Mapple [" + hoster.name + "]",
          title: display + "\nAuto [HLS]",
          url: streamUrl, quality: "Auto", isM3u8: true, type: "hls",
          headers: pHeaders(), subtitles: subs, provider: "mapple"
        }];
      });
    }).catch(function (err) {
      console.log("[Mapple] " + hoster.name + ": " + (err && err.message));
      return [];
    });
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
  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    var tag = "[Mapple]";
    var type = mediaType === "tv" ? "tv" : "movie";
    var s = seasonNum ? Number(seasonNum) : 1;
    var e = episodeNum ? Number(episodeNum) : 1;
    var tvSlug = type === "tv" ? s + "-" + e : "";
    console.log(tag + " Querying TMDB: " + tmdbId + ", Type: " + mediaType);
    var info = null, subs = [];
    return tmdbLookup(tmdbId, type).then(function (d) {
      info = d;
      if (!info || !info.title) throw new Error("tmdb");
      return stremioSubs(info.imdbId, type, s, e);
    }).then(function (ss) {
      subs = ss;
      return getSession(tmdbId, type, tvSlug);
    }).then(function (session) {
      if (!session) return [];
      var display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (type === "tv") display += " S" + pad2(s) + "E" + pad2(e);
      var all = HOSTERS.map(function (h) {
        return hosterStream(h, tmdbId, type, tvSlug, session, display, subs);
      });
      return Promise.all(all).then(function (arr) {
        var flat = [], seen = {};
        arr.forEach(function (a) {
          (a || []).forEach(function (st) {
            if (st && st.url && !seen[st.url]) {
              seen[st.url] = true;
              flat.push(st);
            }
          });
        });
        console.log(tag + " Found " + flat.length + " streams, " + subs.length + " subs");
        var picked = qSort(flat).slice(0, 20);
        console.log(tag + " Returning " + picked.length);
        return picked;
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
