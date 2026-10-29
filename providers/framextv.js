/**
 * framextv - FrameX TV provider for Nuvio (framextv.cc)
 * Flow: FrameX API providers list -> /api/stream (per provider) -> sources (mp4/hls) + VTT subtitles
 *
 * Aggregates every available FrameX provider into one stream list.
 * Hermes-safe: Promise chains only, no async/await, no generators, no deps.
 */
(function () {
  "use strict";

  var API = "https://api.framextv.cc";
  var SITE = "https://framextv.cc";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var MAX_STREAMS = 60;

  /* Fallback provider list (used when /api/providers is unreachable) */
  var FALLBACK_PROVIDERS = [
    "sparky", "bowler", "titan", "giant", "super_barbarian",
    "executioner", "root_rider", "super_dragon", "battle_copter",
    "archer_queen", "little_prince"
  ];

  var LANG_NAMES = {
    en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
    pt: "Portuguese", "pt-br": "Portuguese (Brazil)", ru: "Russian", ar: "Arabic",
    tr: "Turkish", hi: "Hindi", ja: "Japanese", ko: "Korean", zh: "Chinese",
    nl: "Dutch", pl: "Polish", sv: "Swedish", da: "Danish", fi: "Finnish",
    no: "Norwegian", cs: "Czech", el: "Greek", he: "Hebrew", id: "Indonesian",
    th: "Thai", vi: "Vietnamese", ro: "Romanian", hu: "Hungarian", uk: "Ukrainian"
  };

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
      return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, v: null, e: e }; });
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
    if (n > 0) {
      if (n >= 2160) return "4K";
      if (n >= 1440) return "1440p";
      if (n >= 1080) return "1080p";
      if (n >= 720) return "720p";
      if (n >= 480) return "480p";
      return "360p";
    }
    return "Auto";
  }

  function tmdbLookup(tmdbId, isTv) {
    var path = isTv ? "/tv/" : "/movie/";
    return fetchTimeout("https://api.themoviedb.org/3" + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US", {
      headers: { "User-Agent": UA, Accept: "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (d) {
      if (!d) return null;
      return {
        title: d.title || d.name || d.original_title || d.original_name || "",
        year: String(d.release_date || d.first_air_date || "").slice(0, 4)
      };
    });
  }

  function fetchProviders() {
    return fetchTimeout(API + "/api/providers", {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE + "/" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (j) {
      if (j && Array.isArray(j.providers)) {
        var ids = [];
        j.providers.forEach(function (p) {
          if (p && p.id && p.status === "available") ids.push(p.id);
        });
        if (ids.length) return ids;
      }
      return FALLBACK_PROVIDERS.slice();
    }).catch(function () { return FALLBACK_PROVIDERS.slice(); });
  }

  function cleanSubLabel(label, code) {
    var s = String(label || "");
    s = s.replace(/^.*?Subtitles.*?[^\w]*\s*/i, "");
    s = s.trim();
    if (!s || s === label && /subtitle/i.test(label)) {
      s = "";
    }
    if (!s) {
      var c = String(code || "").toLowerCase();
      s = LANG_NAMES[c] || code || "und";
    }
    return s;
  }

  function buildSubs(list) {
    var subs = [], seen = {};
    (list || []).forEach(function (s) {
      if (!s || !s.url) return;
      var key = s.url;
      if (seen[key]) return;
      seen[key] = true;
      var code = s.language || s.lang || "";
      var label = cleanSubLabel(s.label, code);
      subs.push({ url: s.url, lang: label });
    });
    return subs;
  }

  function fetchStream(providerId, tmdbId, isTv, season, episode) {
    var url = API + "/api/stream?type=" + (isTv ? "tv" : "movie") +
      "&id=" + encodeURIComponent(tmdbId) +
      "&provider=" + encodeURIComponent(providerId);
    if (isTv) {
      url += "&season=" + encodeURIComponent(season || 1) + "&episode=" + encodeURIComponent(episode || 1);
    }
    return fetchTimeout(url, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: SITE + "/", Origin: SITE }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (j) {
      if (!j || j.success !== true || !Array.isArray(j.sources) || !j.sources.length) return null;
      return { provider: providerId, serverName: j.provider || providerId, sources: j.sources, subtitles: buildSubs(j.subtitles) };
    }).catch(function () { return null; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[framextv]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId +
      (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;

    var ctx = { title: "", year: "" };

    return Promise.all([
      tmdbLookup(tmdbId, isTv),
      fetchProviders()
    ]).then(function (res) {
      var info = res[0];
      var providers = res[1] || [];
      if (info) {
        ctx.title = info.title || "";
        ctx.year = info.year || "";
      }
      if (!ctx.title) ctx.title = "TMDB " + tmdbId;
      var display = ctx.title;
      if (ctx.year) display += " (" + ctx.year + ")";
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);

      if (!providers.length) providers = FALLBACK_PROVIDERS.slice();

      var tasks = providers.map(function (pid) {
        return fetchStream(pid, tmdbId, isTv, s, e).then(function (r) {
          if (!r) return [];
          var out = [];
          r.sources.forEach(function (src) {
            if (!src || !src.url) return;
            var type = String(src.type || "").toLowerCase();
            var isHls = type === "hls" || /\.m3u8(\?|$)/i.test(src.url);
            var q = normQuality(src.quality);
            var server = src.server || r.serverName || pid;
            out.push({
              name: "FrameX - " + server + " " + q,
              title: display + "\n" + server + " " + q + (isHls ? " [HLS]" : " [MP4]"),
              url: src.url,
              quality: q,
              isM3u8: isHls,
              type: isHls ? "hls" : "mp4",
              headers: { "User-Agent": UA, "Referer": SITE + "/", "Origin": SITE },
              subtitles: r.subtitles,
              provider: "framextv"
            });
          });
          return out;
        });
      });

      return pAll(tasks).then(function (results) {
        var collected = [];
        var seenUrls = {};
        results.forEach(function (r) {
          if (!r || !r.ok || !Array.isArray(r.v)) return;
          r.v.forEach(function (st) {
            if (!st || !st.url) return;
            if (seenUrls[st.url]) return;
            seenUrls[st.url] = true;
            collected.push(st);
          });
        });
        collected.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
        if (collected.length > MAX_STREAMS) collected = collected.slice(0, MAX_STREAMS);
        console.log(tag + " Found " + collected.length + " streams");
        return collected;
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
