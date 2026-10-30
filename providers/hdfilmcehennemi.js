/**
 * hdfilmcehennemi - HD Film Cehennemi provider for Nuvio
 * Flow: TMDB -> site search -> movie/episode page -> embed (hdfilmcehennemi.mobi)
 *       -> d1ko9 decode -> HLS master URL
 */
(function () {
  "use strict";

  var BASE = "https://www.hdfilmcehennemi.nl";
  var EMBED_BASE = "https://hdfilmcehennemi.mobi";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TMDB_API_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_API_KEY_FALLBACK;
  }

  function cleanText(html) {
    return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function decodeEntities(text) {
    var s = String(text || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); });
    return s.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  }

  async function fetchText(url, referer) {
    try {
      var res = await fetch(url, { headers: { "User-Agent": UA, "Referer": referer || (BASE + "/") } });
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      return null;
    }
  }

  async function tmdbDetails(tmdbId, type, apiKey) {
    var isTv = type === "tv" || type === "series";
    var endpoint = isTv ? "tv" : "movie";
    try {
      var res = await fetch("https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId + "?api_key=" + encodeURIComponent(apiKey) + "&language=en-US");
      if (!res.ok) return null;
      var data = await res.json();
      var title = isTv ? (data.name || "") : (data.title || "");
      var year = "";
      var rawDate = isTv ? data.first_air_date : data.release_date;
      if (rawDate) year = String(rawDate).slice(0, 4);
      return { title: title, year: year };
    } catch (e) {
      return null;
    }
  }

  async function searchHdfc(query) {
    var url = BASE + "/search/?q=" + encodeURIComponent(query);
    try {
      var res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          "X-Requested-With": "fetch",
          "Referer": BASE + "/"
        }
      });
      if (!res.ok) return [];
      var data = await res.json();
      return Array.isArray(data.results) ? data.results : [];
    } catch (e) {
      return [];
    }
  }

  function parseResults(results) {
    var out = [];
    var seen = {};
    (results || []).forEach(function (html) {
      var hrefMatch = String(html || "").match(/href="(https:\/\/www\.hdfilmcehennemi\.nl\/[^"]+)"/i);
      if (!hrefMatch) return;
      var url = hrefMatch[1];
      if (seen[url]) return;
      seen[url] = true;
      var yearMatch = String(html).match(/<span class="year">(\d{4})<\/span>/i);
      var typeMatch = String(html).match(/<span class="type">([^<]+)<\/span>/i);
      var titleMatch = String(html).match(/<h4 class="title">([\s\S]*?)<\/h4>/i);
      out.push({
        url: url,
        year: yearMatch ? yearMatch[1] : "",
        type: typeMatch ? cleanText(typeMatch[1]) : "",
        title: titleMatch ? cleanText(decodeEntities(titleMatch[1])) : ""
      });
    });
    return out;
  }

  function isTvType(t) {
    return /dizi|tv|series/i.test(String(t || ""));
  }

  function findBestMatch(results, title, year, isTv) {
    var best = null;
    var bestScore = -Infinity;
    (results || []).forEach(function (r) {
      if (isTv ? !isTvType(r.type) : isTvType(r.type)) return;
      var score = 0;
      var rt = String(r.title || "").toLowerCase();
      var t = String(title || "").toLowerCase();
      if (t && rt.indexOf(t) !== -1) score += 10;
      else {
        var words = t.split(/\s+/).filter(function (w) { return w.length > 2; });
        if (words.length && words.every(function (w) { return rt.indexOf(w) !== -1; })) score += 5;
      }
      if (year && r.year) {
        if (r.year === year) score += 8;
        else score -= 3;
      }
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    });
    if (best) return best;
    // fallback: first of correct type
    for (var i = 0; i < (results || []).length; i++) {
      var r2 = results[i];
      if (isTv ? isTvType(r2.type) : !isTvType(r2.type)) return r2;
    }
    return (results && results.length) ? results[0] : null;
  }

  function extractEmbedUrl(html) {
    var m = String(html || "").match(/<iframe[^>]*class="close"[^>]*data-src="([^"]+)"/i);
    if (!m) m = String(html || "").match(/<iframe[^>]*data-src="([^"]+)"[^>]*class="close"/i);
    return m ? m[1] : null;
  }

  // ---- base64 decode (atob fallback) ----
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

  // ---- d1ko9 decode (from embed page) ----
  function d1ko9(t5x) {
    var window = { location: { hostname: "hdfilmcehennemi.mobi" } };
    var cs2 = t5x.length - 2, mf6 = cs2 % 7, h239 = 8 + (cs2 % 5);
    var uf7j = t5x.splice(h239, 1)[0], e10t = t5x.splice(mf6, 1)[0];
    e10t += window.location.hostname;
    var c17 = t5x.join("");
    if (e10t.length > 4096) { c17 = atobSafe(c17); }
    var x56dr = 0, ut5 = 0, n347, kv7z;
    for (n347 = 0; n347 < e10t.length; n347++) {
      kv7z = e10t.charCodeAt(n347);
      x56dr = (x56dr * 37 + kv7z) % 241;
      ut5 = (ut5 + ((kv7z << 1) ^ n347)) & 255;
    }
    var f1fzp = (x56dr * 3 + ut5) % 256, mc622 = (ut5 % 11) + 5, n0e = ((ut5 * 251 + x56dr) % 65519) + 1;
    var vou63, bn4;
    for (n347 = uf7j.length - 1; n347 >= 0; n347--) {
      vou63 = uf7j.charAt(n347);
      if (vou63 === "7") { c17 = atobSafe(c17); }
      else if (vou63 === "3") { c17 = c17.split("").reverse().join(""); }
      else {
        bn4 = (26 - ((vou63.charCodeAt(0) - 96) % 26)) % 26;
        c17 = c17.replace(/[a-zA-Z]/g, function (sfo0) {
          var ah5iz = sfo0.charCodeAt(0), z27 = (ah5iz <= 90) ? 65 : 97;
          return String.fromCharCode((ah5iz - z27 + bn4) % 26 + z27);
        });
      }
    }
    if (uf7j.length > 2048) { c17 = c17.split("").reverse().join(""); }
    cs2 = c17.length;
    var k7mcf = [], fb5h9, gk4, r26pu;
    for (n347 = cs2 - 1; n347 >= 1; n347--) { n0e = (n0e * 97 + 41) % 65519; k7mcf[n347] = n0e % (n347 + 1); }
    fb5h9 = c17.split("");
    for (n347 = 1; n347 < cs2; n347++) { gk4 = k7mcf[n347]; r26pu = fb5h9[n347]; fb5h9[n347] = fb5h9[gk4]; fb5h9[gk4] = r26pu; }
    c17 = fb5h9.join("");
    var tj3kl = f1fzp, js0 = "";
    for (n347 = 0; n347 < c17.length; n347++) {
      kv7z = c17.charCodeAt(n347);
      tj3kl = (tj3kl * 5 + mc622) % 256;
      js0 += String.fromCharCode(kv7z ^ tj3kl);
      tj3kl = (tj3kl + kv7z) % 256;
    }
    return js0;
  }

  async function resolveEmbed(embedUrl) {
    var html = await fetchText(embedUrl, BASE + "/");
    if (!html) return null;
    var m = html.match(/var\s+[a-zA-Z0-9_]+\s*=\s*([a-zA-Z0-9_]+)\("([\s\S]*?)"\.split\("([^"]+)"\)\)/);
    if (!m) return null;
    var funcName = m[1];
    var raw = m[2];
    var delimiter = m[3];

    var funcRegex = new RegExp('var\\s+' + funcName + '\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\};');
    var fm = html.match(funcRegex);
    if (!fm) return null;

    var window = { location: { hostname: "hdfilmcehennemi.mobi" } };
    var self = window;
    var document = { location: { hostname: "hdfilmcehennemi.mobi" } };
    var location = window.location;
    function atob(str) { return atobSafe(str); }

    var funcs = {};
    try {
      var funcDef = fm[0].replace(new RegExp('^var\\s+' + funcName + '\\s*='), 'funcs.' + funcName + ' =');
      eval(funcDef);
    } catch (e) {
      console.log("[hdfilmcehennemi] eval err", e && e.message);
      return null;
    }

    var str;
    try { str = eval('"' + raw + '"'); } catch (e) { return null; }
    var input = String(str).split(delimiter);
    var finalUrl;
    try { global.document = document; global.self = self; global.window = window; global.location = location; finalUrl = funcs[funcName](input); } catch (e) { return null; }
    if (!finalUrl) return null;

    var subs = [];
    var tracksMatch = html.match(/tracks:\s*(\[[\s\S]*?\])/i);
    if (tracksMatch) {
      var tracks = null;
      try { tracks = eval(tracksMatch[1]); } catch (e) { tracks = null; }
      if (Array.isArray(tracks)) {
        tracks.forEach(function (t) {
          if (t && t.file && (t.kind === "captions" || t.kind === "subtitles")) {
            subs.push({ url: t.file, lang: t.label || "" });
          }
        });
      }
    }
    return { url: finalUrl, subtitles: subs };
  }

  async function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[hdfilmcehennemi]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var apiKey = getTmdbKey(settings);
    if (!apiKey) {
      console.log(tag + " TMDB API key missing");
      return [];
    }

    var info = await tmdbDetails(tmdbId, isTv ? "tv" : "movie", apiKey);
    if (!info || !info.title) {
      console.log(tag + " TMDB details not found");
      return [];
    }

    var title = info.title;
    var year = info.year;
    console.log(tag + " Searching: " + title + (year ? " (" + year + ")" : ""));

    var queries = [title];
    // try original title variants not available from tmdbDetails; title enough
    var allResults = [];
    for (var qi = 0; qi < queries.length; qi++) {
      var resHtml = await searchHdfc(queries[qi]);
      var parsed = parseResults(resHtml);
      parsed.forEach(function (r) {
        if (allResults.indexOf(r) === -1) allResults.push(r);
      });
    }

    var match = findBestMatch(allResults, title, year, isTv);
    if (!match) {
      console.log(tag + " No matching page found");
      return [];
    }
    console.log(tag + " Matched page: " + match.title + " -> " + match.url);

    var pageUrl = match.url;
    if (isTv) {
      var s = parseInt(season, 10) || 1;
      var e = parseInt(episode, 10) || 1;
      if (pageUrl.charAt(pageUrl.length - 1) !== "/") pageUrl += "/";
      pageUrl = pageUrl + "sezon-" + s + "/bolum-" + e + "/";
    }

    var html = await fetchText(pageUrl, BASE + "/");
    if (!html) {
      console.log(tag + " Failed to fetch page");
      return [];
    }

    var embedUrl = extractEmbedUrl(html);
    if (!embedUrl) {
      console.log(tag + " No embed URL found");
      return [];
    }
    console.log(tag + " Embed: " + embedUrl);

    var resolved = await resolveEmbed(embedUrl);
    if (!resolved) {
      console.log(tag + " Failed to resolve embed");
      return [];
    }

    var display = info.title + (info.year ? " (" + info.year + ")" : "");
    if (isTv) {
      display += " S" + (parseInt(season, 10) || 1) + "E" + (parseInt(episode, 10) || 1);
    }

    var stream = {
      name: "HDFilmCehennemi",
      title: display,
      url: resolved.url,
      quality: "Auto",
      isM3u8: true,
      provider: "hdfilmcehennemi",
      type: "direct",
      subtitles: resolved.subtitles || [],
      headers: { "User-Agent": UA, "Referer": EMBED_BASE + "/" }
    };

    return [stream];
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
