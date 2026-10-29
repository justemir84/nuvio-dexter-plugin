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

  function qualityFromHeight(h) {
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h > 0) return "360p";
    return "Auto";
  }

  function codecTag(cds, rng) {
    cds = String(cds || "").toLowerCase();
    var dv = /dvh[1e]|dvhe|dav1/.test(cds) ? "DV" : "";
    var v = dv ? "HEVC" : (/hvc1|hev1|hevc/.test(cds) ? "HEVC" : (/avc1|avc3|avc/.test(cds) ? "H.264" : (/av01/.test(cds) ? "AV1" : (/vp9/.test(cds) ? "VP9" : ""))));
    var hdr = !dv && /^(PQ|HLG)$/i.test(String(rng || "")) ? "HDR" : "";
    var a = /ec-3|eac3/.test(cds) ? "DDP" : (/ac-3/.test(cds) ? "DD" : (/mp4a|aac/.test(cds) ? "AAC" : ""));
    return { v: v, dv: dv, hdr: hdr, a: a, tag: [v, dv || hdr, a].filter(function (x) { return !!x; }).join(" ") };
  }

  function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b > 0) return b + " B";
    return "";
  }

  function parseHls(text) {
    text = String(text || "");
    if (text.indexOf("#EXTM3U") !== 0) return null;
    var lines = text.split(/\r?\n/);
    var maxBw = 0, maxH = 0, bestLine = "", curLine = "", i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
        curLine = line;
      } else if (line && line.charAt(0) !== "#" && curLine) {
        var bm = curLine.match(/BANDWIDTH=(\d+)/);
        var bw = bm ? parseInt(bm[1], 10) : 0;
        var rm = curLine.match(/RESOLUTION=\d+x(\d+)/);
        var h = rm ? parseInt(rm[1], 10) : 0;
        if (bw >= maxBw) { maxBw = bw; if (h > maxH) maxH = h; bestLine = curLine; }
        curLine = "";
      }
    }
    var cds = (bestLine.match(/CODECS="([^"]+)"/i) || [])[1] || "";
    var rng = (bestLine.match(/VIDEO-RANGE=([A-Z0-9]+)/i) || [])[1] || "";
    var ct = codecTag(cds, rng);
    return { bw: maxBw, h: maxH, codec: ct };
  }

  function enrichHls(stream) {
    var timerPromise = new Promise(function (resolve) { setTimeout(function () { resolve(stream); }, 3000); });
    var work = fetchTimeout(stream.url, {
      headers: stream.headers || { "User-Agent": UA }
    }, 2500).then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; }).then(function (txt) {
      var info = parseHls(txt);
      if (!info) return stream;
      var parts = [];
      if (info.codec && info.codec.tag) parts.push(info.codec.tag);
      if (info.bw > 0) parts.push((info.bw / 1e6).toFixed(1) + " Mbps");
      if (info.codec && info.codec.dv) parts.push("Dolby Vision");
      if (info.codec && info.codec.hdr && info.codec.hdr !== "HDR") parts.push(info.codec.hdr);
      if (parts.length) {
        stream.title = stream.title + " [" + parts.join(" | ") + "]";
        stream.name = stream.name + " " + parts.join(" ");
      }
      if (stream.quality === "Auto" && info.h > 0) stream.quality = qualityFromHeight(info.h);
      return stream;
    }).catch(function () { return stream; });
    return Promise.race([work, timerPromise]);
  }

  function enrichMp4(stream) {
    var timerPromise = new Promise(function (resolve) { setTimeout(function () { resolve(stream); }, 3000); });
    var work = fetchTimeout(stream.url, {
      method: "HEAD",
      headers: stream.headers || { "User-Agent": UA }
    }, 2500).then(function (r) {
      if (!r) return stream;
      var len = 0;
      try { len = parseInt(r.headers.get ? r.headers.get("content-length") : (r.headers["content-length"] || "0"), 10); } catch (e) { len = 0; }
      if (len > 0) {
        var sz = fmtSize(len);
        if (sz) {
          stream.title = stream.title + " [" + sz + "]";
          stream.name = stream.name + " " + sz;
          stream.size = sz;
        }
      }
      return stream;
    }, function () { return stream; }).catch(function () { return stream; });
    return Promise.race([work, timerPromise]);
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

        var enrichTasks = collected.map(function (st) {
          if (st.type === "hls") return enrichHls(st);
          return enrichMp4(st);
        });
        return pAll(enrichTasks).then(function (res) {
          var out = collected.slice();
          res.forEach(function (r, i) {
            if (r && r.ok && r.v) out[i] = r.v;
          });
          console.log(tag + " Found " + out.length + " streams");
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
