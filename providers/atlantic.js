/**
 * atlantic - Atlantic provider for Nuvio (hls.lol APIs)
 * Flow: TMDB id -> cdn.hls.lol/content -> totallyacdn m3u8 master -> variants + vdrk subs
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var CDN = "https://cdn.hls.lol";
  var SUBS = "https://sub.vdrk.site";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var REF = "http://atlantic.st/";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;

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

  function headers() {
    return { "User-Agent": UA, Accept: "*/*", Referer: REF };
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

  function codecOf(codecs) {
    var s = String(codecs || "").toLowerCase();
    var v = /hevc|hvc1|hev1|x265/.test(s) ? "HEVC x265" : (/avc1|avc3|x264|h264|avc/.test(s) ? "H.264" : "");
    var a = /ec-3|ac-3|ddp|atmos/.test(s) ? "DDP" : (/mp4a|aac/.test(s) ? "AAC" : "");
    return v + (a ? " " + a : "");
  }

  function qualityOf(h, w) {
    h = parseInt(h, 10) || 0;
    w = parseInt(w, 10) || 0;
    if (h >= 2160 || w >= 3800) return "2160p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (w >= 1900) return "1080p";
    if (w >= 1200) return "720p";
    return h + "p";
  }

  function fetchSubs(mediaType, tmdbId, season, episode) {
    var url = mediaType === "tv"
      ? SUBS + "/v1/tv/" + encodeURIComponent(tmdbId) + "/" + (season || 1) + "/" + (episode || 1)
      : SUBS + "/v1/movie/" + encodeURIComponent(tmdbId);
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: REF } }).then(function (r) {
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

  function fetchMaster(masterUrl) {
    return fetchTimeout(masterUrl, { headers: headers() }).then(function (r) {
      if (!r.ok) throw new Error("master " + r.status);
      return r.text();
    }).then(function (text) {
      if (text.indexOf("#EXT-X-STREAM-INF") === -1) return null;
      var lines = text.split(/\r?\n/), variants = [], cur = null, i;
      for (i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
          var bw = 0, w = 0, h = 0, codecs = "";
          var m;
          m = line.match(/BANDWIDTH=(\d+)/i); if (m) bw = parseInt(m[1], 10);
          m = line.match(/RESOLUTION=(\d+)x(\d+)/i); if (m) { w = parseInt(m[1], 10); h = parseInt(m[2], 10); }
          m = line.match(/CODECS="([^"]+)"/i); if (m) codecs = m[1];
          cur = { bw: bw, w: w, h: h, codecs: codecs };
        } else if (line && line.charAt(0) !== "#" && cur) {
          var u = /^https?:\/\//i.test(line) ? line : masterUrl.split("/").slice(0, -1).join("/") + "/" + line;
          variants.push({ url: u, bw: cur.bw, w: cur.w, h: cur.h, codecs: cur.codecs });
          cur = null;
        }
      }
      return variants;
    }).catch(function () { return null; });
  }

  function masterInfo(masterUrl) {
    return fetchMaster(masterUrl).then(function (vs) {
      if (!vs || !vs.length) return null;
      var top = vs[0];
      for (var i = 1; i < vs.length; i++) { if ((vs[i].h || 0) > (top.h || 0)) top = vs[i]; }
      var q = qualityOf(top.h, top.w);
      if (q === "0p") q = "Auto";
      return { q: q, codec: codecOf(top.codecs) };
    }).catch(function () { return null; });
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

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[Atlantic]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    var info = null, subs = [];
    return tmdbLookup(tmdbId, mediaType).then(function (d) {
      info = d;
      return fetchSubs(mediaType, tmdbId, season, episode);
    }).then(function (ss) {
      subs = ss;
      var subst = [], subSeen = {};
      subs.forEach(function (x) {
        var l = String(x.lang || "").replace(/\s*\d+$/, "").trim();
        var k = l.toLowerCase();
        if (!l || subSeen[k]) return;
        subSeen[k] = true;
        subst.push(l);
      });
      var subLangs = subst.slice(0, 8).join(", ") + (subst.length > 8 ? " +" + (subst.length - 8) : "");
      var url = mediaType === "tv"
        ? CDN + "/content/tv/" + encodeURIComponent(tmdbId) + "/" + (season || 1) + "/" + (episode || 1)
        : CDN + "/content/movie/" + encodeURIComponent(tmdbId);
      return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: REF } }).then(function (r) {
        if (!r.ok) throw new Error("content " + r.status);
        return r.json();
      }).then(function (d) {
        if (!d || !d.found || !d.url) { console.log(tag + " No content"); return []; }
        var display = (info && info.title ? info.title : (d.title || "Video")) + (info && info.year ? " (" + info.year + ")" : "");
        if (mediaType === "tv") {
          var s = season || 1, e = episode || 1;
          display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
        }
        var streams = [{
          name: "Atlantic - Auto",
          title: display + "\nAuto [HLS]" + (subLangs ? " | " + subLangs : ""),
          url: d.url, quality: "Auto", isM3u8: true, type: "hls",
          headers: { Referer: REF, "User-Agent": UA },
          subtitles: subs, provider: "atlantic"
        }];
        return Promise.resolve(null).then(function () {
          var zurl = mediaType === "tv"
            ? "https://zcdn.bluevelvet.space/cdn?tmdb=" + encodeURIComponent(tmdbId) + "&type=tv&season=" + (season || 1) + "&episode=" + (episode || 1)
            : "https://zcdn.bluevelvet.space/cdn?tmdb=" + encodeURIComponent(tmdbId) + "&type=movie";
          return Promise.all([
            masterInfo(d.url),
            fetchTimeout(zurl, { headers: { "User-Agent": UA, Accept: "application/json", Referer: REF } }).then(function (rz) {
              if (!rz.ok) throw new Error("zcdn " + rz.status);
              return rz.json();
            }).catch(function (err) {
              console.log(tag + " zcdn error: " + (err && err.message));
              return null;
            })
          ]).then(function (rr) {
            var dinfo = rr[0], zj = rr[1];
            if (dinfo && dinfo.q && dinfo.q !== "Auto") {
              streams[0].name = "Atlantic - " + dinfo.q + (dinfo.q === "2160p" ? " (4K)" : "") + (dinfo.codec ? " " + dinfo.codec : "");
              streams[0].title = display + "\n" + dinfo.q + (dinfo.codec ? " " + dinfo.codec : "") + " [HLS]" + (subLangs ? " | " + subLangs : "");
              streams[0].quality = dinfo.q;
            }
            if (!zj || !zj.ready || !zj.url) {
              console.log(tag + " Found " + streams.length + " streams");
              return qSort(streams);
            }
            return masterInfo(zj.url).then(function (zinfo) {
              if (zinfo) {
                streams.push({
                  name: "Atlantic - " + zinfo.q + (zinfo.q === "2160p" ? " (4K)" : "") + (zinfo.codec ? " " + zinfo.codec : ""),
                  title: display + "\n" + zinfo.q + (zinfo.codec ? " " + zinfo.codec : "") + " [HLS]" + (subLangs ? " | " + subLangs : ""),
                  url: zj.url, quality: zinfo.q, isM3u8: true, type: "hls",
                  headers: { Referer: REF, "User-Agent": UA },
                  subtitles: subs, provider: "atlantic"
                });
              }
              console.log(tag + " Found " + streams.length + " streams");
              return qSort(streams);
            });
          });
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
