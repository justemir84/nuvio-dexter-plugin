/**
 * hdfilmcehennemiland - HD Film Cehennemi (.land) provider for Nuvio
 *
 * Flow:
 *   TMDB -> site search (/?s=) -> movie/series page
 *   -> admin-ajax get_video_url -> setplay.sbs player
 *   -> SPG.cerceve decode -> fastplay.mom video page
 *   -> manifest URL (X-Sp proof) + subtitles
 */
(function () {
  "use strict";

  var BASE = "https://www.hdfilmcehennemi.land";
  var EMBED_BASE = "https://fastplay.mom";
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

  function atobSafe(str) {
    try { return Buffer.from(str, "base64").toString("binary"); } catch (e) { return ""; }
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

  async function searchSite(query) {
    var url = BASE + "/?s=" + encodeURIComponent(query);
    var html = await fetchText(url, BASE + "/");
    if (!html) return [];
    var links = [...new Set((html.match(/https:\/\/www\.hdfilmcehennemi\.land\/(?:film|dizi)\/[^"']+/gi) || []))];
    var out = [];
    var seen = {};
    links.forEach(function (l) {
      var m = l.match(/\/(film|dizi)\/([^\/]+)\/?$/i);
      if (!m) return;
      if (seen[l]) return;
      seen[l] = true;
      out.push({ url: l.replace(/\/+$/, "/"), type: m[1].toLowerCase(), slug: m[2] });
    });
    return out;
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

  async function resolveStream(pageUrl) {
    var html = await fetchText(pageUrl, BASE + "/");
    if (!html) return null;

    var nonce = (html.match(/window\.videoAjax\s*=\s*\{[\s\S]*?nonce:\s*'([^']+)'/) || [])[1];
    var postId = (html.match(/data-post-id="(\d+)"/) || [])[1];
    var playerName = (html.match(/data-player-name="([^"]+)"/) || [])[1];
    if (!nonce || !postId || !playerName) return null;

    var body = new URLSearchParams({ action: "get_video_url", nonce: nonce, post_id: postId, player_name: playerName, part_key: "" }).toString();
    var ares = await fetch(BASE + "/wp-admin/admin-ajax.php", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Referer": pageUrl, "Origin": BASE, "X-Requested-With": "XMLHttpRequest" },
      body: body
    });
    var ajson;
    try { ajson = await ares.json(); } catch (e) { return null; }
    if (!ajson || !ajson.success || !ajson.data || !ajson.data.url) return null;

    var setplayUrl = ajson.data.url;
    var shtml = await fetchText(setplayUrl, pageUrl);
    if (!shtml) return null;

    var cer = shtml.match(/SPG\.cerceve\("([^"]+)","([^"]+)","([^"]+)"\)/);
    if (!cer) return null;
    var fastplayUrl = decodeXor(cer[2].replace(/\\\//g, "/"), cer[3])[0];
    if (!fastplayUrl) return null;

    var fres = await fetch(fastplayUrl, { headers: { "User-Agent": UA, "Referer": "https://setplay.sbs/" } });
    var fhtml = await fres.text();
    if (!fres.ok || !fhtml) return null;

    var spgA;
    try { spgA = JSON.parse((fhtml.match(/window\.SPG_A\s*=\s*(\{[^}]+\})/) || [])[1]); } catch (e) { spgA = null; }
    var streamPath = (fhtml.match(/stream:\s*"([^"]+)"/) || [])[1];
    if (!streamPath) return null;

    var sp = (spgA && spgA.sp) || "";
    var spT = (spgA && spgA.spT) || 0;
    function genProof() {
      var n = spT;
      var r = Math.floor(2176782336 * Math.random()).toString(36);
      return n + "." + r + "." + hashFn(sp + "|" + n + "|" + r);
    }
    var proof = genProof();

    var manifestUrl = new URL(streamPath, fastplayUrl).toString();

    var subtitles = [];
    var vttMatches = fhtml.match(/https?:\/\/[^"'\s]+\.vtt/g) || [];
    [...new Set(vttMatches)].forEach(function (u) {
      var lang = "und";
      if (/tur/i.test(u)) lang = "tr";
      else if (/eng/i.test(u)) lang = "en";
      subtitles.push({ url: u, language: lang, name: lang === "tr" ? "Türkçe" : (lang === "en" ? "English" : lang), lang: lang });
    });

    return { url: manifestUrl, fastplayUrl: fastplayUrl, proof: proof, subtitles: subtitles };
  }

  async function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[hdfilmcehennemiland]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var apiKey = getTmdbKey(settings);
    if (!apiKey) { console.log(tag + " TMDB API key missing"); return []; }

    var info = await tmdbDetails(tmdbId, isTv ? "tv" : "movie", apiKey);
    if (!info || !info.title) { console.log(tag + " TMDB details not found"); return []; }

    console.log(tag + " Searching: " + info.title + (info.year ? " (" + info.year + ")" : ""));

    var results = await searchSite(info.title);
    var match = findBestMatch(results, info.title, info.year, isTv);
    if (!match) { console.log(tag + " No matching page found"); return []; }
    console.log(tag + " Matched page: " + match.url);

    var pageUrl = match.url;
    if (isTv) {
      var s = parseInt(season, 10) || 1;
      var e = parseInt(episode, 10) || 1;
      var html = await fetchText(pageUrl, BASE + "/");
      if (!html) { console.log(tag + " Failed to fetch series page"); return []; }
      var epLinks = [...new Set((html.match(/https:\/\/www\.hdfilmcehennemi\.land\/bolum\/[^"']+/gi) || []))];
      var epUrl = null;
      for (var i = 0; i < epLinks.length; i++) {
        var m = epLinks[i].match(/(\d+)-sezon-(\d+)/i);
        if (m && parseInt(m[1], 10) === s && parseInt(m[2], 10) === e) { epUrl = epLinks[i]; break; }
      }
      if (!epUrl) { console.log(tag + " Episode not found"); return []; }
      pageUrl = epUrl;
    }

    var resolved = await resolveStream(pageUrl);
    if (!resolved) { console.log(tag + " Failed to resolve stream"); return []; }

    var display = info.title + (info.year ? " (" + info.year + ")" : "");
    if (isTv) display += " S" + (parseInt(season, 10) || 1) + "E" + (parseInt(episode, 10) || 1);

    var headers = { "User-Agent": UA, "Referer": resolved.fastplayUrl, "X-Sp": resolved.proof };

    var stream = {
      name: "HDFilmCehennemi",
      title: display,
      url: resolved.url,
      quality: "Auto",
      isM3u8: true,
      provider: "hdfilmcehennemiland",
      type: "hls",
      subtitles: resolved.subtitles || [],
      headers: headers
    };

    return [stream];
  }

  function onSettings() { return []; }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams, onSettings: onSettings };
  } else {
    this.getStreams = getStreams;
    this.onSettings = onSettings;
  }
})();
