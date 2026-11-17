/**
 * hdfilmcehennemiland - HD Film Cehennemi (.land) provider for Nuvio
 *
 * Flow:
 *   TMDB -> site search (/?s=) -> movie/series page
 *   -> admin-ajax get_video_url -> setplay.sbs player
   *   -> SPG.cerceve decode -> fastplay.mom video page
 *   -> manifest URL (X-Sp proof) + subtitles
 *
 * Notlar:
 * - Hermes uyumlu: async/await yok, Buffer/URL/URLSearchParams yok.
 * - m3u8 URL'si gecicidir (timestamp imzali), her istekte yenilenir.
 * - X-Sp proof token'i fastplay.mom sayfasindan uretilir.
 * - Altyazilar fastplay sayfasindaki .vtt linklerinden alinir.
 */
(function () {
  "use strict";

  var BASE = "https://www.hdfilmcehennemi.land";
  var EMBED_BASE = "https://fastplay.mom";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 20000;

  // ---------------------------------------------------------------- helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function atobSafe(str) {
    if (typeof atob === "function") {
      try { return atob(str); } catch (e) {}
    }
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var output = "";
    str = String(str).replace(/[^A-Za-z0-9\+\/=]/g, "");
    for (var i = 0; i < str.length; ) {
      var enc1 = chars.indexOf(str.charAt(i++));
      var enc2 = chars.indexOf(str.charAt(i++));
      var enc3 = chars.indexOf(str.charAt(i++));
      var enc4 = chars.indexOf(str.charAt(i++));
      var chr1 = (enc1 << 2) | (enc2 >> 4);
      var chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      var chr3 = ((enc3 & 3) << 6) | enc4;
      output += String.fromCharCode(chr1);
      if (enc3 !== 64) output += String.fromCharCode(chr2);
      if (enc4 !== 64) output += String.fromCharCode(chr3);
    }
    return output;
  }

  function decodeXor(t, n) {
    var r = atobSafe(t), o = atobSafe(n), i = "", c;
    for (c = 0; c < r.length; c++) i += String.fromCharCode(r.charCodeAt(c) ^ o.charCodeAt(c % o.length));
    return i.split("|");
  }

  function hashFn(s) {
    var t = 2166136261;
    for (var n = 0; n < s.length; n++) { t ^= s.charCodeAt(n); t = Math.imul(t, 16777619) >>> 0; }
    return t.toString(16);
  }

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

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

  function fetchJson(url, headers) {
    return fetchText(url, headers).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    });
  }

  function formEncode(obj) {
    var parts = [];
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
      }
    }
    return parts.join("&");
  }

  function resolveUrl(base, rel) {
    rel = String(rel || "");
    if (/^https?:\/\//i.test(rel)) return rel;
    var schemeIdx = base.indexOf("://");
    var hostStart = schemeIdx === -1 ? 0 : schemeIdx + 3;
    var pathStart = base.indexOf("/", hostStart);
    if (pathStart === -1) return base + "/" + rel;
    if (rel.charAt(0) === "/") return base.slice(0, pathStart) + rel;
    var clean = base.split("#")[0].split("?")[0];
    return clean.slice(0, clean.lastIndexOf("/") + 1) + rel;
  }

  // -------------------------------------------------------------- searching

  function searchSite(query) {
    var url = BASE + "/?s=" + encodeURIComponent(query);
    return fetchText(url, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return [];
        var links = [...new Set((html.match(/https:\/\/www\.hdfilmcehennemi\.land\/(?:film|dizi)\/[^"']+/gi) || []))];
        var out = [];
        var seen = {};
        links.forEach(function (l) {
          if (l.indexOf("#") !== -1) return;
          var m = l.match(/\/(film|dizi)\/([^\/]+)\/?$/i);
          if (!m) return;
          if (!m[2] || m[2].length < 3) return;
          if (seen[l]) return;
          seen[l] = true;
          out.push({ url: l.replace(/\/+$/, "/"), type: m[1].toLowerCase(), slug: m[2] });
        });
        return out;
      });
  }

  function isTvType(t) { return t === "dizi"; }

  function findBestMatch(results, title, year, isTv) {
    var best = null, bestScore = -Infinity;
    (results || []).forEach(function (r) {
      if (isTv ? !isTvType(r.type) : isTvType(r.type)) return;
      var score = 0;
      var rt = norm(r.slug.replace(/-/g, " "));
      var t = norm(title);
      if (t && rt.indexOf(t) !== -1) score += 10;
      else {
        var words = t.split(/\s+/).filter(function (w) { return w.length > 2; });
        if (words.length && words.every(function (w) { return rt.indexOf(w) !== -1; })) score += 5;
      }
      if (score > bestScore) { bestScore = score; best = r; }
    });
    if (best) return best;
    for (var i = 0; i < (results || []).length; i++) {
      var r2 = results[i];
      if (isTv ? isTvType(r2.type) : !isTvType(r2.type)) return r2;
    }
    return (results && results.length) ? results[0] : null;
  }

  // -------------------------------------------------------------- resolve stream

  function resolveStream(pageUrl) {
    return fetchText(pageUrl, { "User-Agent": UA, Referer: BASE + "/" })
      .then(function (html) {
        if (!html) return null;

        var nonce = (html.match(/window\.videoAjax\s*=\s*\{[\s\S]*?nonce:\s*'([^']+)'/) || [])[1];
        var postId = (html.match(/data-post-id="(\d+)"/) || [])[1];
        var playerName = (html.match(/data-player-name="([^"]+)"/) || [])[1];
        if (!nonce || !postId || !playerName) return null;

        var body = formEncode({ action: "get_video_url", nonce: nonce, post_id: postId, player_name: playerName, part_key: "" });
        return fetch(BASE + "/wp-admin/admin-ajax.php", {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Referer": pageUrl, "Origin": BASE, "X-Requested-With": "XMLHttpRequest" },
          body: body
        }).then(function (ares) {
          if (!ares || !ares.ok) return null;
          return ares.text();
        }).then(function (txt) {
          var ajson;
          try { ajson = JSON.parse(txt); } catch (e) { return null; }
          if (!ajson || !ajson.success || !ajson.data || !ajson.data.url) return null;

          var setplayUrl = ajson.data.url;
          return fetchText(setplayUrl, { "User-Agent": UA, Referer: pageUrl })
            .then(function (shtml) {
              if (!shtml) return null;

              var cer = shtml.match(/SPG\.cerceve\("([^"]+)","([^"]+)","([^"]+)"\)/);
              if (!cer) return null;
              var fastplayUrl = decodeXor(cer[2].replace(/\\\//g, "/"), cer[3])[0];
              if (!fastplayUrl) return null;

              return fetchText(fastplayUrl, { "User-Agent": UA, Referer: "https://setplay.sbs/" })
                .then(function (fhtml) {
                  if (!fhtml) return null;

                  var spgA;
                  try { spgA = JSON.parse((fhtml.match(/window\.SPG_A\s*=\s*(\{[^}]+\})/) || [])[1]); } catch (e) { spgA = null; }
                  var streamPath = (fhtml.match(/stream:\s*"([^"]+)"/) || [])[1];
                  if (!streamPath) return null;

                  var sp = (spgA && spgA.sp) || "";
                  var spT = (spgA && spgA.spT) || 0;
                  var n = spT;
                  var r = Math.floor(2176782336 * Math.random()).toString(36);
                  var proof = n + "." + r + "." + hashFn(sp + "|" + n + "|" + r);

                  var manifestUrl = resolveUrl(fastplayUrl, streamPath);

                  var subtitles = [];
                  var vttMatches = fhtml.match(/https?:\/\/[^"'\s]+\.vtt/g) || [];
                  [...new Set(vttMatches)].forEach(function (u) {
                    var lang = "und";
                    if (/tur/i.test(u)) lang = "tr";
                    else if (/eng/i.test(u)) lang = "en";
                    subtitles.push({ url: u, language: lang, name: lang === "tr" ? "Türkçe" : (lang === "en" ? "English" : lang), lang: lang });
                  });

                  return { url: manifestUrl, fastplayUrl: fastplayUrl, proof: proof, subtitles: subtitles };
                });
            });
        });
      });
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[hdfilmcehennemiland]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);
    if (!apiKey) { console.log(tag + " TMDB API key missing"); return []; }

    return fetchJson("https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + encodeURIComponent(tmdbId) + "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US", { "User-Agent": UA })
      .then(function (data) {
        if (!data) return null;
        var title = isTv ? (data.name || "") : (data.title || "");
        var year = "";
        var rawDate = isTv ? data.first_air_date : data.release_date;
        if (rawDate) year = String(rawDate).slice(0, 4);
        return { title: title, year: year };
      })
      .then(function (info) {
        if (!info || !info.title) {
          console.log(tag + " TMDB details not found");
          return [];
        }

        console.log(tag + " Searching: " + info.title + (info.year ? " (" + info.year + ")" : ""));

        return searchSite(info.title).then(function (results) {
          var match = findBestMatch(results, info.title, info.year, isTv);
          if (!match) {
            console.log(tag + " No matching page found");
            return [];
          }
          console.log(tag + " Matched page: " + match.url);

          var pageUrl = match.url;
          if (isTv) {
            return fetchText(pageUrl, { "User-Agent": UA, Referer: BASE + "/" })
              .then(function (html) {
                if (!html) {
                  console.log(tag + " Failed to fetch series page");
                  return [];
                }
                var epLinks = [...new Set((html.match(/https:\/\/www\.hdfilmcehennemi\.land\/bolum\/[^"']+/gi) || []))];
                var epUrl = null;
                for (var i = 0; i < epLinks.length; i++) {
                  var m = epLinks[i].match(/(\d+)-sezon-(\d+)/i);
                  if (m && parseInt(m[1], 10) === s && parseInt(m[2], 10) === e) { epUrl = epLinks[i]; break; }
                }
                if (!epUrl) {
                  console.log(tag + " Episode not found");
                  return [];
                }
                return { pageUrl: epUrl, match: match };
              });
          }
          return { pageUrl: pageUrl, match: match };
        })
        .then(function (ctx) {
          if (!ctx || !ctx.pageUrl || Array.isArray(ctx.pageUrl)) return [];
          return resolveStream(ctx.pageUrl).then(function (resolved) {
            if (!resolved) {
              console.log(tag + " Failed to resolve stream");
              return [];
            }

            var display = info.title + (info.year ? " (" + info.year + ")" : "");
            if (isTv) display += " S" + s + "E" + e;

            var headers = { "User-Agent": UA, "Referer": resolved.fastplayUrl, "X-Sp": resolved.proof };

            var stream = {
              name: "Land",
              title: display,
              url: resolved.url,
              quality: "Auto",
              isM3u8: true,
              provider: "hdfilmcehennemiland",
              type: "hls",
              subtitles: resolved.subtitles || [],
              headers: headers,
              behaviorHints: { bingeGroup: "land-" + (ctx.match && ctx.match.slug) }
            };

            console.log(tag + " Kaynak bulundu: 1 kaynak");
            return [stream];
          });
        });
      })
      .catch(function (err) {
        console.log(tag + " Hata: " + (err && err.message));
        return [];
      });
  }

  function onSettings() { return []; }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
