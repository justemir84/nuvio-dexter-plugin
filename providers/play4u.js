/**
 * play4u - Play4u (play4u.org) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB external_ids (imdb_id)
 *   -> movie: /watch/{imdb_id}
 *     series: /series/{imdb_id}/s-{s}/ep-{e}
 *   -> window.__PA_PLAY__ JSON -> m3u8_url (sealed)
 *   -> unseal (XOR + URL-safe base64, key "pa4u-stream-seal-v1")
 *   -> master m3u8 (HLS, çoklu ses + kalite varyantları)
 *
 * Notlar:
 * - Play4u uses IMDb IDs (tt...) not TMDB IDs.
 * - m3u8_url is sealed (pa!~ prefix); unsealed with simple XOR.
 * - Unsealed URL requires Referer: https://play4u.org/
 * - Only 1080p+ content is returned (720p and below filtered out).
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://play4u.org";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var SEAL_KEY = "pa4u-stream-seal-v1";
  var TIMEOUT = 15000;

  // ---------------------------------------------------------------- helpers

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

  function norm(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // -------------------------------------------------------------- base64

  function base64ToBytes(input) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var str = String(input || "").replace(/[^A-Za-z0-9\+\/=]/g, "");
    var bytes = [];
    for (var i = 0; i < str.length;) {
      var e1 = chars.indexOf(str.charAt(i++));
      var e2 = chars.indexOf(str.charAt(i++));
      var e3 = chars.indexOf(str.charAt(i++));
      var e4 = chars.indexOf(str.charAt(i++));
      bytes.push((e1 << 2) | (e2 >> 4));
      if (e3 !== 64) bytes.push(((e2 & 15) << 4) | (e3 >> 2));
      if (e4 !== 64) bytes.push(((e3 & 3) << 6) | e4);
    }
    return bytes;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); } catch (e) {}
    }
    var out = "", i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      else if (b < 0xf0) out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      else {
        var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function urlSafeB64Decode(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    var p = s.length % 4;
    if (p) s += "====".slice(p);
    var bytes = base64ToBytes(s);
    return utf8Decode(bytes);
  }

  function unseal(u) {
    if (!u || typeof u !== "string") return u;
    if (u.indexOf("pa!~") !== 0) return u;
    var raw = urlSafeB64Decode(u.slice(4));
    if (!raw) return "";
    var o = "";
    for (var i = 0; i < raw.length; i++) o += String.fromCharCode(raw.charCodeAt(i) ^ SEAL_KEY.charCodeAt(i % SEAL_KEY.length));
    return o;
  }

  // -------------------------------------------------------------- TMDB

  function tmdbInfo(tmdbId, isTv, apiKey) {
    var path = isTv ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) +
      "&language=tr-TR&append_to_response=alternative_titles,external_ids";
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;

      var main = isTv ? (d.name || "") : (d.title || "");
      var original = isTv ? (d.original_name || "") : (d.original_title || "");
      var altList = (d.alternative_titles && (isTv ? d.alternative_titles.results : d.alternative_titles.titles)) || [];
      var altTitles = [];
      for (var i = 0; i < altList.length && altTitles.length < 4; i++) {
        var t = altList[i] && altList[i].title;
        if (t && norm(t) !== norm(main) && altTitles.indexOf(t) === -1) altTitles.push(t);
      }

      var ext = d.external_ids || {};
      var imdbId = ext.imdb_id || null;

      return {
        title: main,
        original: original,
        alternatives: altTitles,
        year: String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4),
        imdbId: imdbId
      };
    });
  }

  // -------------------------------------------------------------- page parsing

  function extractPaPlay(html) {
    var m = String(html || "").match(/window\.__PA_PLAY__\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function maxQualityFromPlay(play) {
    var streams = (play && play.streams) || [];
    var maxH = 0;
    for (var i = 0; i < streams.length; i++) {
      var qs = streams[i].qualities || [];
      for (var j = 0; j < qs.length; j++) {
        var h = qs[j].height || 0;
        if (!h && qs[j].label) {
          var m = String(qs[j].label).match(/(\d+)/);
          if (m) h = parseInt(m[1], 10);
        }
        if (!h && qs[j].slug) {
          var m2 = String(qs[j].slug).match(/(\d+)/);
          if (m2) h = parseInt(m2[1], 10);
        }
        if (h > maxH) maxH = h;
      }
    }
    return maxH;
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[play4u]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }

      if (!info.imdbId) {
        console.log(tag + " IMDb ID bulunamadi");
        return [];
      }

      var imdbId = info.imdbId;
      var display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (isTv) display += " S" + s + "E" + e;

      var url = isTv
        ? BASE + "/series/" + imdbId + "/s-" + (s < 10 ? "0" : "") + s + "/ep-" + (e < 10 ? "0" : "") + e
        : BASE + "/watch/" + imdbId;

      console.log(tag + " Sayfa: " + url);

      return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" }).then(function (html) {
        if (!html) {
          console.log(tag + " Sayfa icerigi alinamadi");
          return [];
        }

        var play = extractPaPlay(html);
        if (!play || !play.ok) {
          console.log(tag + " PA_PLAY bulunamadi");
          return [];
        }

        // 1080p+ kontrolu
        var maxH = maxQualityFromPlay(play);
        if (maxH < 1080) {
          console.log(tag + " Kalite yetersiz (" + maxH + "p < 1080p)");
          return [];
        }

        // m3u8_url unseal
        var streams = play.streams || [];
        var out = [], seen = {};
        for (var i = 0; i < streams.length; i++) {
          var st = streams[i];
          if (!st || !st.m3u8_url) continue;
          var unsealed = unseal(st.m3u8_url);
          if (!unsealed) continue;
          if (seen[unsealed]) continue;
          seen[unsealed] = true;

          var langs = (st.languages || []).map(function (l) { return l.name; }).join(", ");
          var qs = (st.qualities || []).map(function (q) { return q.label; }).join(", ");
          var maxQ = maxH >= 2160 ? "4K" : (maxH >= 1440 ? "1440p" : (maxH >= 1080 ? "1080p" : maxH + "p"));

          out.push({
            name: "Play4u - " + maxQ + (langs ? " " + langs : ""),
            title: display + " | " + maxQ + (langs ? " | " + langs : "") + " [HLS]",
            url: unsealed,
            quality: maxQ,
            isM3u8: true,
            type: "hls",
            language: "en",
            provider: "play4u",
            headers: { "User-Agent": UA, Referer: BASE + "/", Origin: BASE },
            subtitles: [],
            behaviorHints: { bingeGroup: "play4u-" + tmdbId }
          });
        }

        console.log(tag + " Kaynak bulundu: " + out.length + " kaynak (" + maxH + "p max)");
        return out;
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message));
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
