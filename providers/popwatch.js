/**
 * popwatch - PopWatch saglayicisi - Nuvio
 *
 * NOT: PopWatch'in eski scraping API'si kapatilmistir; popwatch.to/api/scrape/*
 * artik yok (ve .to domain'i erisilemez durumda). Yeni site (popwatch.pro)
 * dogrudan stream vermiyor, sadece iframe embed + TMDB proxy sunuyor.
 *
 * Bu modul bu yuzden:
 *   - metadata icin popwatch.pro/api/tmdb kullanir (yedek: api.themoviedb.org)
 *   - stream icin dogrudan calisan backend'leri dener: once VidBolt,
 *     bos kalirsa VixSrc.
 *
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var POPWATCH_API = "https://popwatch.pro/api/tmdb";
  var TMDB_BASE = "https://api.themoviedb.org/3";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  var VIDBOLT = "https://vidbolt.xyz";
  var VIXSRC = "https://vixsrc.to";
  var PREFERS = ["quantum", "vega", "callisto", "orion", "fastva"];

  var TIMEOUT = 12000;
  var MAX_STREAMS = 6;
  var MAX_SUBS = 12;

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
      return p.then(function (v) { return { ok: true, v: v }; }, function () { return { ok: false, v: null }; });
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

  function qualityFromHeight(h) {
    if (h >= 2160) return "4K";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    return "Auto";
  }

  // Metadata: popwatch.pro proxy (yedek: dogrudan TMDB)
  function tmdbLookup(tmdbId, mediaType) {
    var path = mediaType === "tv" ? "/tv/" : "/movie/";
    var popUrl = POPWATCH_API + path + tmdbId + "?language=en-US";
    var directUrl = TMDB_BASE + path + tmdbId + "?api_key=" + TMDB_KEY + "&language=en-US";
    function parse(d) {
      if (!d) return null;
      return {
        title: d.title || d.name || d.original_title || d.original_name || "",
        year: String(d.release_date || d.first_air_date || "").substring(0, 4)
      };
    }
    return fetchTimeout(popUrl, { headers: { "User-Agent": UA, Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
      .then(function (d) {
        var info = parse(d);
        if (info && info.title) return info;
        return fetchTimeout(directUrl, { headers: { "User-Agent": UA, Accept: "application/json" } })
          .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
          .then(parse);
      });
  }

  // --- VidBolt backend -------------------------------------------------------

  function vidboltResolve(qs) {
    return fetchTimeout(VIDBOLT + "/api/resolve?" + qs, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: VIDBOLT + "/" }
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  function mediaInfoFromMaster(txt) {
    var out = { audio: [], subs: [] };
    if (!txt) return out;
    var re = /#EXT-X-MEDIA:TYPE=(AUDIO|SUBTITLES)([^\n]*)/g;
    var m;
    while ((m = re.exec(txt)) !== null) {
      var nm = m[2].match(/NAME="([^"]+)"/);
      if (!nm) continue;
      var arr = m[1] === "AUDIO" ? out.audio : out.subs;
      if (arr.indexOf(nm[1]) === -1) arr.push(nm[1]);
    }
    return out;
  }

  function vidboltStreams(tmdbId, isTv, s, e, display) {
    var qs = "type=" + (isTv ? "tv" : "movie") + "&id=" + tmdbId + (isTv ? "&season=" + s + "&episode=" + e : "");

    function pick(j) {
      var out = [], seen = {};
      (((j || {}).stream || {}).sources || []).forEach(function (x) {
        if (!x || !x.url || seen[x.url]) return;
        seen[x.url] = true;
        var mi = mediaInfoFromMaster(x.master || "");
        var q = String(x.quality || x.name || "").trim() || "Auto";
        var kind = String(x.kind || "hls").toLowerCase();
        var lang = String(x.language || "").trim();
        if (!lang && mi.audio.length === 1) lang = mi.audio[0];
        var meta = [];
        if (mi.audio.length > 1) meta.push("ses: " + mi.audio.join(", "));
        else if (mi.audio.length === 1 && lang !== mi.audio[0]) meta.push("ses: " + mi.audio.join(", "));
        if (mi.subs.length) meta.push("altyazi: " + mi.subs.join(", "));
        var server = ((j || {}).stream || {}).server || "";
        out.push({
          name: "PopWatch - " + (lang ? lang + " " : "") + q,
          title: display + "\n" + q + (lang ? " " + lang : "") +
            " [" + (kind === "mp4" ? "MP4" : "HLS") + (server ? " - " + server : "") + "]" +
            (meta.length ? " | " + meta.join(" | ") : ""),
          url: x.url,
          quality: q,
          isM3u8: kind !== "mp4",
          type: kind === "mp4" ? "mp4" : "hls",
          headers: { Referer: VIDBOLT + "/", "User-Agent": UA },
          subtitles: [],
          provider: "popwatch"
        });
      });
      return out;
    }

    return vidboltResolve(qs).then(function (j) {
      var found = pick(j);
      if (found.length) return found;
      return pAll(PREFERS.map(function (p) { return vidboltResolve(qs + "&prefer=" + p); })).then(function (rs) {
        for (var i = 0; i < rs.length; i++) {
          var f = pick((rs[i] && rs[i].ok) ? rs[i].v : null);
          if (f.length) return f;
        }
        return [];
      });
    });
  }

  // --- VixSrc backend (yedek) ------------------------------------------------

  function grab(block, key) {
    var m = block.match(new RegExp("['\"]?" + key + "['\"]?\\s*:\\s*'([^']+)'"));
    if (m) return m[1];
    m = block.match(new RegExp("['\"]?" + key + "['\"]?\\s*:\\s*\"([^\"]+)\""));
    if (m) return m[1];
    m = block.match(new RegExp("['\"]?" + key + "['\"]?\\s*:\\s*([0-9]+)"));
    return m ? m[1] : "";
  }

  function parseEmbed(html) {
    var i = String(html || "").indexOf("masterPlaylist");
    var seg = i >= 0 ? String(html).slice(i, i + 700) : "";
    return { url: grab(seg, "url"), token: grab(seg, "token"), expires: grab(seg, "expires") };
  }

  function parseSubTracks(master) {
    var lines = String(master || "").split("\n");
    var out = [], seen = {};
    lines.forEach(function (ln) {
      if (ln.indexOf("TYPE=SUBTITLES") < 0) return;
      var name = (ln.match(/NAME="([^"]+)"/) || [])[1] || "";
      var uri = (ln.match(/URI="([^"]+)"/) || [])[1] || "";
      if (!uri) return;
      var key = (name || uri).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ lang: name || "und", uri: uri });
    });
    return out;
  }

  function subVttUrl(sub) {
    return fetchTimeout(sub.uri, { headers: { "User-Agent": UA, Accept: "*/*" } })
      .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
      .then(function (txt) {
        var m = String(txt || "").match(/https?:\/\/[^\s"']+/);
        return m ? { url: m[0], lang: sub.lang } : null;
      });
  }

  function parseAudioTracks(master) {
    var lines = String(master || "").split("\n");
    var out = [], seen = {};
    lines.forEach(function (ln) {
      if (ln.indexOf("TYPE=AUDIO") < 0) return;
      var name = (ln.match(/NAME="([^"]+)"/) || [])[1] || "";
      if (!name) return;
      var k = name.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(name);
    });
    return out;
  }

  function masterCodec(master) {
    var lines = String(master || "").split("\n"), bestH = -1, bestLine = "", curLine = "", i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) {
        curLine = line;
      } else if (line && line.charAt(0) !== "#" && curLine) {
        var m = curLine.match(/RESOLUTION=\d+x(\d+)/);
        var h = m ? parseInt(m[1], 10) : 0;
        if (h >= bestH) { bestH = h; bestLine = curLine; }
        curLine = "";
      }
    }
    var cds = ((bestLine.match(/CODECS="([^"]+)"/i) || [])[1] || "").toLowerCase();
    var dv = /dvh[1e]|dvhe|dav1/.test(cds) ? "DV" : "";
    var v = dv ? "HEVC" : (/hvc1|hev1|hevc/.test(cds) ? "HEVC" : (/avc1|avc3|avc/.test(cds) ? "H.264" : (/av01/.test(cds) ? "AV1" : "")));
    var rng = (bestLine.match(/VIDEO-RANGE=([A-Z0-9]+)/i) || [])[1] || "";
    var hdr = !dv && /^(PQ|HLG)$/i.test(rng) ? "HDR" : "";
    return [v, dv || hdr].filter(function (x) { return !!x; }).join(" ");
  }

  function vixsrcStreams(tmdbId, isTv, s, e, display) {
    var pageUrl = isTv ? VIXSRC + "/tv/" + tmdbId + "/" + s + "/" + e : VIXSRC + "/movie/" + tmdbId;
    var apiUrl = VIXSRC + "/api/" + (isTv ? "tv/" + tmdbId + "/" + s + "/" + e : "movie/" + tmdbId);
    return fetchTimeout(apiUrl, { headers: { "User-Agent": UA, Accept: "application/json", Referer: pageUrl } })
      .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
      .then(function (j) {
        if (!j || !j.src) return [];
        var embedUrl = j.src.indexOf("http") === 0 ? j.src : VIXSRC + j.src;
        var lang = (embedUrl.match(/lang=([a-z]{2})/) || [])[1] || "en";
        return fetchTimeout(embedUrl, { headers: { "User-Agent": UA, Accept: "text/html", Referer: pageUrl } })
          .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
          .then(function (html) {
            var mp = parseEmbed(html);
            if (!mp.url) return [];
            var sep = mp.url.indexOf("?") >= 0 ? "&" : "?";
            var playlistUrl = mp.url + sep + "token=" + mp.token + "&expires=" + mp.expires + "&h=1&lang=" + lang;
            return fetchTimeout(playlistUrl, { headers: { "User-Agent": UA, Accept: "*/*", Referer: embedUrl } })
              .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
              .then(function (master) {
                if (!master || master.indexOf("#EXTM3U") !== 0) return [];
                var maxH = 0;
                (master.match(/RESOLUTION=\d+x(\d+)/g) || []).forEach(function (rs) {
                  var h = Number((rs.match(/(\d+)$/) || [])[1]) || 0;
                  if (h > maxH) maxH = h;
                });
                var q = qualityFromHeight(maxH);
                var vtag = masterCodec(master);
                var audios = parseAudioTracks(master).slice(0, 4);
                var subTracks = parseSubTracks(master).slice(0, MAX_SUBS).map(subVttUrl);
                return pAll(subTracks).then(function (subsRes) {
                  var subs = subsRes.filter(function (x) { return x.ok && x.v; }).map(function (x) { return x.v; });
                  var langs = subs.map(function (x) { return x.lang; });
                  var parts = [q + (vtag ? " " + vtag : "") + " [HLS]"];
                  if (audios.length) parts.push("ses: " + audios.join(", "));
                  if (langs.length) parts.push("altyazi: " + langs.slice(0, 6).join(", ") + (langs.length > 6 ? " +" + (langs.length - 6) : ""));
                  return [{
                    name: "PopWatch - " + q + (vtag ? " " + vtag : ""),
                    title: display + "\n" + parts.join(" | "),
                    url: playlistUrl,
                    quality: q,
                    isM3u8: true,
                    type: "hls",
                    headers: { Referer: VIXSRC + "/", "User-Agent": UA },
                    subtitles: subs,
                    provider: "popwatch"
                  }];
                });
              });
          });
      });
  }

  // --- Ana akis --------------------------------------------------------------

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[popwatch]";
    var isTv = mediaType === "tv";
    var s = season || 1;
    var e = episode || 1;

    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      var display = "";
      if (info && info.title) display = info.title + (info.year ? " (" + info.year + ")" : "");
      if (!display) display = "TMDB " + tmdbId;
      if (isTv) display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);

      return vidboltStreams(tmdbId, isTv, s, e, display).then(function (vb) {
        if (vb.length) return vb;
        return vixsrcStreams(tmdbId, isTv, s, e, display);
      }).then(function (out) {
        out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
        out = out.slice(0, MAX_STREAMS);
        console.log(tag + " Found " + out.length + " streams");
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
