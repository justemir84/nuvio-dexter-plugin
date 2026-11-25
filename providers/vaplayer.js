/**
 * vaplayer - VAplayer provider for Nuvio (vaplayer.ru / VidAPI embed backend)
 * Akis:
 *   TMDB id -> https://vaplayer.ru/embed/{tv|movie}/... render -> CONFIG apiToken
 *   -> https://streamdata.vaplayer.ru/api.php?type=<tv|movie>&tmdb=<id>[&season=&episode=]&stream_urls&api_token=..
 *   -> { status_code, data: { stream_urls: [...] } } HLS master aynalari + file_name
 * Notler:
 *   - Eski akis (streamdata.vaplayer.ru/api.php?type=&tmdb=&season=&episode=) artik 404
 *     donuyor; backend yeni token tabanli akise gecis yapti (render -> apiToken ->
 *     stream_urls&api_token). Bu yuzden provider yeni akisi kullanir.
 *   - Response: { status_code: "200", data: { stream_urls: [...], file_name: "..." } }
 *   - stream_urls ayni dosyanin aynalari olabilir (dil farki yoktur); isim satiri
 *     kalite/codec icerir, baslik satiri altyazi/sinif bilgisi icerir.
 *   - Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var EMBED_BASE = "https://vaplayer.ru";
  var STREAM_DATA_API = "https://streamdata.vaplayer.ru/api.php";
  var SUBS = "https://sub.vdrk.site";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_MIRRORS = 3;

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
    var hd = list.filter(function (s) { return qRank(s.quality) >= 2.5; });
    var base = hd.length ? hd : list;
    base.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return base;
  }

  function hostOf(u) {
    var m = String(u || "").match(/^https?:\/\/([^\/]+)/i);
    return m ? m[1] : "";
  }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return r.json();
    }).then(function (d) {
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4)
      };
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

  // ------------------------------------------------------------ token + stream

  function extractApiToken(html) {
    var h = String(html || "");
    var m = h.match(/"apiToken"\s*:\s*"([^"]*)"/);
    if (!m) m = h.match(/apiToken["']?\s*[:=]\s*["']([^"']*)["']/i);
    if (!m) m = h.match(/"token"\s*:\s*"([^"]*)"/);
    if (!m) return "";
    return String(m[1] || "").trim();
  }

  function fetchApiToken(type, tmdbId, season, episode) {
    var path = type === "tv" ? "/embed/tv/" + tmdbId + "/" + (season || 1) + "/" + (episode || 1) : "/embed/movie/" + tmdbId;
    var url = EMBED_BASE + path;
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "text/html" } }).then(function (r) {
      if (!r.ok) return "";
      return r.text();
    }).then(function (html) { return extractApiToken(html); }).catch(function () { return ""; });
  }

  function buildStreamDataUrl(type, tmdbId, season, episode, token) {
    var qs = "type=" + type + "&tmdb=" + encodeURIComponent(tmdbId);
    if (type === "tv") qs += "&season=" + (season || 1) + "&episode=" + (episode || 1);
    qs += "&stream_urls&api_token=" + encodeURIComponent(token || "");
    return STREAM_DATA_API + "?" + qs;
  }

  // --------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[VAplayer]";
    var type = mediaType === "tv" ? "tv" : "movie";
    var s = season || 1;
    var e = episode || 1;
    console.log(tag + " Fetching " + mediaType + " " + tmdbId);

    return fetchApiToken(type, tmdbId, s, e).then(function (token) {
      var url = buildStreamDataUrl(type, tmdbId, s, e, token);
      return fetchJson(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    }).then(function (j) {
      if (!j) { console.log(tag + " Stream API yanit vermedi"); return []; }
      if (j.status_code && String(j.status_code) !== "200") {
        console.log(tag + " Stream API " + j.status_code + " " + (j.error || ""));
        return [];
      }
      var data = j.data || {};
      var urls = data.stream_urls || [];
      if (!urls.length) { console.log(tag + " No sources"); return []; }
      var fileName = data.file_name || "";
      var quality = parseQuality(fileName);
      var rel = parseRelease(fileName);
      var extra = [];
      if (rel.codec || rel.depth) extra.push((rel.codec + " " + rel.depth).trim());
      var aura = (rel.hdr + " " + rel.audio).trim();
      if (aura) extra.push(aura);
      if (rel.dual) extra.push(rel.dual);
      if (rel.src) extra.push(rel.src);
      extra = extra.join(" | ");
      var codecShort = rel.codec === "HEVC x265" ? "HEVC" : rel.codec;

      var out = [];
      urls.slice(0, MAX_MIRRORS).forEach(function (u, i) {
        var u2 = typeof u === "string" ? u : (u && u.url);
        if (!u2) return;
        var mi = i === 0 ? "" : " (M" + (i + 1) + ")";
        var host = hostOf(u2);
        out.push({
          name: "VAplayer - " + quality + (codecShort ? " " + codecShort : "") + mi,
          title: (data.title || "Video") + "\n" + quality + (extra ? " | " + extra : "") + " [HLS" + (host ? " · " + host : "") + "]",
          url: u2,
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
    }).then(function (out) {
      if (!out || !out.length) return out;
      return fetchSubs(tmdbId, mediaType, s, e).then(function (subs) {
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
