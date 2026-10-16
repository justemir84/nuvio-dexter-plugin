/**
 * vidcloud - VidCloud provider for Nuvio (lookmovie/vidy backend)
 * Flow: TMDB -> seed -> {region}/sources (custom decrypt) -> m3u8 + vtt
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://api.wecollege.net";
  var REGIONS = ["miami", "boise", "seattle", "atlanta", "phoenix", "portland"];
  var REF = "https://www.vidy.st/";
  var UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;

  var L = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580];
  var MAGIC = [109, 118, 109, 49];
  var seedCache = {};

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

  function rot(x, n) { x >>>= 0; n &= 31; if (n === 0) return x >>> 0; return (((x << n) | (x >>> (32 - n))) >>> 0); }
  function mmx(e) {
    e >>>= 0; e ^= e >>> 16; e = Math.imul(e, 2246822507) >>> 0; e ^= e >>> 13;
    e = Math.imul(e, 3266489909) >>> 0; e ^= e >>> 16; return e >>> 0;
  }
  function fnv(e) {
    var t = 2166136261, a;
    for (a = 0; a < e.length; a++) t = Math.imul(t ^ e.charCodeAt(a), 16777619) >>> 0;
    return mmx(t);
  }
  function kdf61(S1, N1) {
    var s = mmx((fnv(S1) ^ mmx((N1 >>> 0) ^ 2654435769)) >>> 0) >>> 0;
    var a = new Array(61), e2, t2;
    for (e2 = 0; e2 < 8; e2++) {
      t2 = s % 61;
      s = rot((s + 2654435769) >>> 0, 7 + (7 & e2));
      a[t2] = (s ^ mmx(s)) >>> 0;
      s = mmx((s + t2) >>> 0);
    }
    return { S: a, acc: mmx(2779096485 ^ s) >>> 0 };
  }
  function step(st, n) {
    var o = st.S, acc = st.acc, d = acc % 61, r = 0 - Number(d in o), i = o[d] >>> 0;
    var s = ((i ^ Math.imul(2654435769, n + 1) >>> 0) >>> 0);
    var l2 = ((((acc ^ s) >>> 0) | ((acc & s & r) >>> 0)) >>> 0);
    var l3 = (rot(((l2 + acc) >>> 0), 31 & d) ^ rot(acc, 31 & Math.imul(d, 7))) >>> 0;
    var nn = mmx((l3 + 2654435769) >>> 0);
    o[d] = nn >>> 0; st.acc = nn; return nn >>> 0;
  }
  function keystream(st, len) {
    var o = new Array(len), n = 0, e = 0, t;
    while (e < len) {
      t = step(st, n++);
      o[e++] = 255 & t;
      if (e < len) o[e++] = (t >>> 8) & 255;
      if (e < len) o[e++] = (t >>> 16) & 255;
      if (e < len) o[e++] = (t >>> 24) & 255;
    }
    return o;
  }

  var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64decode(str) {
    str = String(str).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
    while (str.length % 4) str += "=";
    var out = [], i, e0, e1, e2, e3;
    for (i = 0; i < str.length; i += 4) {
      e0 = B64C.indexOf(str.charAt(i)); e1 = B64C.indexOf(str.charAt(i + 1));
      e2 = str.charAt(i + 2) === "=" ? 0 : B64C.indexOf(str.charAt(i + 2));
      e3 = str.charAt(i + 3) === "=" ? 0 : B64C.indexOf(str.charAt(i + 3));
      if (e0 < 0 || e1 < 0) throw new Error("b64");
      out.push((e0 << 2) | (e1 >> 4));
      if (str.charAt(i + 2) !== "=") out.push(((e1 & 15) << 4) | (e2 >> 2));
      if (str.charAt(i + 3) !== "=") out.push(((e2 & 3) << 6) | e3);
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
      else i++;
    }
    return s;
  }

  function decrypt(ct, seed, mediaId) {
    var cb = b64decode(ct);
    var st = kdf61(seed, mediaId);
    var ks = keystream(st, cb.length);
    var out = [], i;
    for (i = 0; i < cb.length; i++) out.push(cb[i] ^ ks[i]);
    for (i = 0; i < 4; i++) if (out[i] !== MAGIC[i]) throw new Error("bad key");
    return JSON.parse(utf8Str(out.slice(4)));
  }

  function getSeed(mediaId) {
    var c = seedCache[mediaId];
    if (c && c.exp > Date.now() + 5000) return Promise.resolve(c.seed);
    return fetchTimeout(API + "/seed?mediaId=" + encodeURIComponent(mediaId), {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: REF }
    }).then(function (r) {
      if (!r.ok) throw new Error("seed " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.seed) throw new Error("no seed");
      seedCache[mediaId] = { seed: j.seed, exp: Date.now() + (j.ttlMs || 30000) };
      return j.seed;
    });
  }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US&append_to_response=external_ids";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return r.json();
    }).then(function (d) {
      var ext = d.external_ids || {};
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4),
        imdbId: ext.imdb_id || null,
        totalSeasons: d.number_of_seasons || 1
      };
    });
  }

  function parseQuality(v) {
    var m = String(v || "").match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) + "p" : "Auto";
  }

  function subLang(l) {
    l = String(l || "").toLowerCase();
    if (l === "eng" || l === "en") return "English";
    if (l === "tur" || l === "tr") return "Turkish";
    if (l === "spa" || l === "es") return "Spanish";
    if (l === "fre" || l === "fr") return "French";
    if (l === "ger" || l === "de") return "German";
    if (l === "hin" || l === "hi") return "Hindi";
    if (l === "ara" || l === "ar") return "Arabic";
    return l.toUpperCase();
  }

  function fetchSources(region, p, mediaId, seed) {
    var qp = "title=" + encodeURIComponent(p.title) + "&mediaType=" + p.mediaType + "&year=" + encodeURIComponent(p.year || "") +
      "&totalSeasons=" + (p.totalSeasons || 1) + "&episodeId=" + (p.episodeId || 1) + "&seasonId=" + (p.seasonId || 1) +
      "&tmdbId=" + encodeURIComponent(mediaId) + "&imdbId=" + encodeURIComponent(p.imdbId || "") + "&enc=2&seed=" + encodeURIComponent(seed);
    return fetchTimeout(API + "/" + region + "/sources?" + qp, {
      headers: { "User-Agent": UA, Accept: "*/*", Referer: REF }
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!t || t.charAt(0) === "{") return null;
        try { return decrypt(t, seed, mediaId); } catch (e) { return null; }
      });
    }).catch(function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[VidCloud]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    var mid = parseInt(tmdbId, 10);
    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      if (!info.title) { console.log(tag + " TMDB lookup failed"); return []; }
      return getSeed(mid).then(function (seed) {
        var p = {
          title: info.title, mediaType: mediaType === "tv" ? "tv" : "movie", year: info.year,
          totalSeasons: mediaType === "tv" ? info.totalSeasons : 1,
          episodeId: mediaType === "tv" ? (episode || 1) : 1,
          seasonId: mediaType === "tv" ? (season || 1) : 1,
          imdbId: info.imdbId
        };
        var chain = Promise.resolve(null);
        REGIONS.forEach(function (rg) {
          chain = chain.then(function (found) {
            if (found) return found;
            return fetchSources(rg, p, mid, seed).then(function (d) {
              if (d && Array.isArray(d.sources) && d.sources.length) return { region: rg, data: d };
              return null;
            });
          });
        });
        return chain.then(function (hit) {
          if (!hit) { console.log(tag + " No streams"); return []; }
          var subs = [];
          (hit.data.subtitles || []).forEach(function (c) {
            if (c && c.url) subs.push({ url: c.url, lang: subLang(c.lang || c.language) });
          });
          var subLangs = subs.map(function (s) { return s.lang; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(",");
          var display = info.title + (info.year ? " (" + info.year + ")" : "");
          if (mediaType === "tv") {
            var s = season || 1, e = episode || 1;
            display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
          }
          var out = (hit.data.sources || []).filter(function (s) {
            return s && typeof s.url === "string" && /\.m3u8(?:$|[?#])/i.test(s.url);
          }).map(function (s) {
            var q = parseQuality(s.quality);
            return {
              name: "VidCloud - " + q,
              title: display + "\n" + q + " [HLS]" + (subLangs ? " | " + subLangs : ""),
              url: s.url,
              quality: q,
              isM3u8: true,
              type: "hls",
              headers: { Referer: REF, Origin: "https://www.vidy.st", "User-Agent": UA },
              subtitles: subs,
              provider: "vidcloud"
            };
          });
          console.log(tag + " Found " + out.length + " streams (" + hit.region + ")");
          return out;
        });
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
