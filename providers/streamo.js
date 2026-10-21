/**
 * streamo - Streamo provider for Nuvio
 * Flow: TMDB id -> scrape-stream (SSE) -> resolve?ref= -> m3u8/mp4
 * Direct scraper providers only; premium/debrid refs are captcha-gated.
 * Hermes-safe: Promise chains only, no deps.
 */
(function () {
  "use strict";

  var API = "https://streamo.st/api/streaming";
  var SITE = "https://streamo.st/";
  var VIX = "https://vixsrc.to";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var VIX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var TIMEOUT = 12000;
  var SCRAPE_TIMEOUT = 30000;
  var MAX_PROV = 6;
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

  function readText(res, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var p = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([res.text(), p]).then(function (text) {
      if (timer) clearTimeout(timer);
      return text;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function readJson(res, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var p = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([res.json(), p]).then(function (json) {
      if (timer) clearTimeout(timer);
      return json;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function jget(url, timeout, extra) {
    var headers = { "User-Agent": UA, Accept: "application/json", Referer: SITE };
    var k;
    if (extra) {
      for (k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) headers[k] = extra[k];
      }
    }
    return fetchTimeout(url, { headers: headers }, timeout || TIMEOUT).then(function (r) {
      if (!r.ok) throw new Error("get " + r.status);
      return readJson(r, timeout || TIMEOUT);
    });
  }

  function parseQuality(v) {
    var s = String(v || "").toLowerCase();
    if (/2160|4k/.test(s)) return "2160p";
    if (/1080/.test(s)) return "1080p";
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

  function qualityFromHeight(h) {
    if (h >= 2160) return "2160p";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    return "HD";
  }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return readJson(r, TIMEOUT);
    }).then(function (d) {
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4)
      };
    });
  }

  function resolveRef(ref) {
    if (!ref) return Promise.resolve(null);
    if (String(ref).indexOf("://") >= 0) return Promise.resolve(ref);
    return jget(API + "/resolve?ref=" + encodeURIComponent(ref), 15000).then(function (d) {
      var url = d && d.url;
      if (typeof url !== "string" || !url) return null;
      if (/^https?:\/\//i.test(url)) return url;
      if (url.charAt(0) === "/") return "https://streamo.st" + url;
      return null;
    }).catch(function () { return null; });
  }

  function parseSSE(text) {
    var out = [];
    var blocks = String(text || "").replace(/\r\n/g, "\n").split("\n\n");
    var i, j, block, lines, event, data, parsed;
    for (i = 0; i < blocks.length; i++) {
      block = blocks[i];
      if (!block || block.indexOf("data:") < 0) continue;
      lines = block.split("\n");
      event = "message";
      data = "";
      for (j = 0; j < lines.length; j++) {
        if (lines[j].indexOf("event:") === 0) event = lines[j].slice(6).trim();
        else if (lines[j].indexOf("data:") === 0) data += lines[j].slice(5).trim();
      }
      parsed = null;
      try { parsed = JSON.parse(data); } catch (e) { continue; }
      out.push({ event: event, data: parsed });
    }
    return out;
  }

  function scrapeProviders(tmdbId, type, season, episode) {
    var url = API + "/scrape-stream?tmdbId=" + encodeURIComponent(tmdbId) + "&type=" + encodeURIComponent(type);
    if (type === "tv") {
      url += "&season=" + encodeURIComponent(season || 1) + "&episode=" + encodeURIComponent(episode || 1);
    }
    return fetchTimeout(url, {
      headers: { "User-Agent": UA, Accept: "text/event-stream", Referer: SITE }
    }, SCRAPE_TIMEOUT).then(function (r) {
      if (!r.ok) throw new Error("/scrape-stream " + r.status);
      return readText(r, SCRAPE_TIMEOUT);
    }).then(function (text) {
      var events = parseSSE(text);
      var provs = [];
      var seen = {};
      var i;
      for (i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.event !== "provider" || !ev.data) continue;
        var p = ev.data;
        if (!p.url || p.isLocked) continue;
        var key = String(p.slug || p.name || p.url);
        if (seen[key]) continue;
        seen[key] = true;
        provs.push(p);
      }
      if (!provs.length) {
        for (i = 0; i < events.length; i++) {
          var se = events[i];
          if (se.event !== "sources" || !se.data || !se.data.sources) continue;
          for (var j = 0; j < se.data.sources.length; j++) {
            var src = se.data.sources[j];
            if (!src || !src.url) continue;
            var skey = String(src.providerSlug || src.provider || src.url);
            if (seen[skey]) continue;
            seen[skey] = true;
            provs.push({
              name: se.data.provider || src.provider || "srv",
              slug: src.providerSlug || skey,
              url: src.url,
              kind: "direct",
              isDirectVideo: true,
              allQualities: [{ quality: src.quality || "HD", url: src.url }]
            });
          }
        }
      }
      return provs;
    });
  }

  function normalizeSubs(list) {
    var out = [], seen = {};
    (list || []).forEach(function (t) {
      if (!t || !t.url) return;
      var lang = String(t.lang || t.title || t.language || "Unknown").trim();
      var key = lang.toLowerCase();
      if (!lang || seen[key]) return;
      seen[key] = true;
      out.push({ url: t.url, lang: lang });
    });
    return out.slice(0, MAX_SUBS);
  }

  function chooseQuality(p) {
    var quals = p.allQualities || [];
    var best = null, bestRank = -1, i;
    for (i = 0; i < quals.length; i++) {
      var q = quals[i];
      if (!q || !q.url) continue;
      var label = parseQuality(q.quality);
      var rank = qRank(label);
      if (rank > bestRank) {
        bestRank = rank;
        best = q;
      }
    }
    if (best) return { quality: parseQuality(best.quality), ref: best.url };
    return { quality: parseQuality(quals[0] && quals[0].quality), ref: p.url };
  }

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

  function vixSubJob(name, uri) {
    return fetchTimeout(uri, {
      headers: { "User-Agent": VIX_UA, Accept: "*/*", Referer: VIX + "/" }
    }, TIMEOUT).then(function (r) {
      return r.ok ? readText(r, TIMEOUT) : "";
    }).then(function (txt) {
      var m = String(txt || "").match(/https?:\/\/[^\s"']+/);
      return m ? { url: m[0], lang: name } : null;
    }).catch(function () { return null; });
  }

  function parseVixSubs(master) {
    var jobs = [];
    String(master || "").split("\n").forEach(function (ln) {
      if (ln.indexOf("TYPE=SUBTITLES") < 0 || jobs.length >= MAX_SUBS) return;
      var name = (ln.match(/NAME="([^"]+)"/) || [])[1] || "und";
      var uri = (ln.match(/URI="([^"]+)"/) || [])[1] || "";
      if (!uri) return;
      jobs.push(vixSubJob(name, uri));
    });
    return Promise.all(jobs).then(function (arr) {
      var out = [], seen = {}, k;
      for (k = 0; k < arr.length; k++) {
        var x = arr[k];
        if (!x || !x.url) continue;
        var key = String(x.lang || "").toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        out.push(x);
      }
      return out;
    });
  }

  function vixsrcResolve(tmdbId, type, season, episode, lang) {
    var isTv = type === "tv";
    var pageUrl = VIX + (isTv ? "/tv/" + tmdbId + "/" + season + "/" + episode : "/movie/" + tmdbId);
    var apiUrl = VIX + "/api/" + (isTv ? "tv/" + tmdbId + "/" + season + "/" + episode : "movie/" + tmdbId);
    var embedUrl = "";
    return fetchTimeout(apiUrl, {
      headers: { "User-Agent": VIX_UA, Accept: "application/json", Referer: pageUrl }
    }, TIMEOUT).then(function (r) {
      if (!r.ok) throw new Error("vix api " + r.status);
      return readJson(r, TIMEOUT);
    }).then(function (j) {
      var src = j && j.src;
      if (!src) return null;
      embedUrl = src.indexOf("http") === 0 ? src : VIX + src;
      return fetchTimeout(embedUrl, {
        headers: { "User-Agent": VIX_UA, Accept: "text/html", Referer: pageUrl }
      }, TIMEOUT);
    }).then(function (r) {
      if (!r || !r.ok) return null;
      return readText(r, TIMEOUT);
    }).then(function (html) {
      if (!html) return null;
      var mp = parseEmbed(html);
      if (!mp.url || !mp.token || !mp.expires) return null;
      var sep = mp.url.indexOf("?") >= 0 ? "&" : "?";
      var playlistUrl = mp.url + sep + "token=" + mp.token + "&expires=" + mp.expires + "&h=1&lang=" + (lang || "en");
      return fetchTimeout(playlistUrl, {
        headers: { "User-Agent": VIX_UA, Accept: "*/*", Referer: embedUrl }
      }, TIMEOUT).then(function (r) {
        if (!r.ok) return null;
        return readText(r, TIMEOUT);
      }).then(function (master) {
        if (!master || master.replace(/^\s+/, "").indexOf("#EXTM3U") !== 0) return null;
        var maxH = 0;
        (String(master).match(/RESOLUTION=\d+x(\d+)/g) || []).forEach(function (rs) {
          var h = parseInt((rs.match(/(\d+)$/) || [])[1], 10) || 0;
          if (h > maxH) maxH = h;
        });
        return parseVixSubs(master).then(function (subs) {
          return { url: playlistUrl, quality: maxH ? qualityFromHeight(maxH) : "HD", subtitles: subs };
        });
      });
    }).catch(function () { return null; });
  }

  function makeStream(url, p, quality, display, subs, headers, isM3u8, kind) {
    var q = quality || "HD";
    var srv = p && (p.name || p.slug) ? (p.name || p.slug) : "srv";
    var subLangs = [];
    (subs || []).forEach(function (x) {
      if (x && x.lang) subLangs.push(x.lang);
    });
    var label = "HLS";
    var streamType = "hls";
    if (kind === "mp4") {
      label = "MP4";
      streamType = "mp4";
    } else if (kind === "mkv") {
      label = "MKV";
      streamType = "direct";
    } else if (kind === "direct") {
      label = "DIRECT";
      streamType = "direct";
    }
    var parts = [q + " [" + label + "]"];
    if (subLangs.length) {
      parts.push("altyazı: " + subLangs.slice(0, 6).join(", ") + (subLangs.length > 6 ? " +" + (subLangs.length - 6) : ""));
    }
    return {
      name: "Streamo - " + q + " (" + srv + ")",
      title: display + "\n" + parts.join(" | "),
      url: url,
      quality: q,
      isM3u8: !!isM3u8,
      type: streamType,
      headers: headers,
      subtitles: subs || [],
      provider: "streamo"
    };
  }

  function buildStream(playUrl, p, quality, display, type, tmdbId, season, episode) {
    if (!playUrl) return Promise.resolve(null);
    if (/beamup\.club/i.test(playUrl)) return Promise.resolve(null);

    if (/^https?:\/\/vixsrc\./i.test(playUrl) && playUrl.indexOf("/playlist/") >= 0) {
      var lang = (playUrl.match(/[?&]lang=([a-z]{2})/i) || [])[1] || "en";
      return vixsrcResolve(tmdbId, type, season, episode, lang).then(function (v) {
        if (!v) return null;
        return makeStream(v.url, p, v.quality || quality, display, v.subtitles || [], {
          Referer: VIX + "/",
          "User-Agent": VIX_UA
        }, true, "hls");
      });
    }

    var fixed = playUrl;
    if (/\.txt(\?|$)/i.test(fixed)) fixed = fixed.replace(/\.txt(?=(\?|$))/i, ".m3u8");
    var decoded = fixed;
    try { decoded = decodeURIComponent(fixed); } catch (e) { decoded = fixed; }
    var isHls = /\.m3u8(?:["'&?#]|$)/i.test(decoded) || /\/playlist\//i.test(fixed);
    var isMp4 = /\.mp4(?:["'&?#]|$)/i.test(decoded) || /\/remote_control\.php/i.test(fixed);
    var isMkv = /\.mkv(?:["'&?#]|$)/i.test(decoded) || /pixeldrain\.dev\/api\/file\//i.test(fixed);
    var kind, headers, isM3u8;
    if (isHls) {
      kind = "hls";
      headers = { Referer: SITE, "User-Agent": UA };
      isM3u8 = true;
    } else if (isMp4) {
      kind = "mp4";
      headers = { "User-Agent": UA };
      isM3u8 = false;
    } else if (isMkv) {
      kind = "mkv";
      headers = { "User-Agent": UA };
      isM3u8 = false;
    } else {
      kind = "direct";
      headers = { "User-Agent": UA };
      isM3u8 = false;
    }
    return Promise.resolve(makeStream(fixed, p, quality, display, normalizeSubs(p.subtitles), headers, isM3u8, kind));
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[Streamo]";
    var type = mediaType === "tv" ? "tv" : "movie";
    var s = Number(season) || 1;
    var e = Number(episode) || 1;
    var info = null;
    console.log(tag + " Fetching " + mediaType + " " + tmdbId);

    return tmdbLookup(tmdbId, type).catch(function () { return null; }).then(function (d) {
      info = d;
      return scrapeProviders(tmdbId, type, s, e);
    }).then(function (provs) {
      if (!provs.length) {
        console.log(tag + " No providers");
        return [];
      }
      provs = provs.slice(0, MAX_PROV);
      var display = (info && info.title ? info.title : "Video") + (info && info.year ? " (" + info.year + ")" : "");
      if (type === "tv") {
        display += " S" + (s < 10 ? "0" + s : s) + "E" + (e < 10 ? "0" + e : e);
      }
      var chain = Promise.resolve([]);
      provs.forEach(function (p) {
        chain = chain.then(function (acc) {
          var sel = chooseQuality(p);
          if (!sel.ref) return acc;
          return resolveRef(sel.ref).then(function (playUrl) {
            if (!playUrl) {
              console.log(tag + " resolve failed: " + (p.name || p.slug || "srv"));
              return acc;
            }
            return buildStream(playUrl, p, sel.quality, display, type, tmdbId, s, e).then(function (st) {
              if (st) acc.push(st);
              return acc;
            });
          });
        });
      });
      return chain.then(function (all) {
        all.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
        console.log(tag + " Found " + all.length + " streams");
        return all;
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
