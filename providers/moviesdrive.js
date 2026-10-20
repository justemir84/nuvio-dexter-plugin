/**
 * moviesdrive - MoviesDrive provider for Nuvio
 * Flow: TMDB -> MoviesDrive WordPress search -> post -> mdrive archive
 *       -> HubCloud -> generated R2/direct file link
 * Hermes-safe: Promise chains only, no async/await, no generators, no deps.
 */
(function () {
  "use strict";

  // Site adresi degisirse sadece bu satiri guncelle.
  var BASE = "https://new3.moviesdrive.beer";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TIMEOUT = 12000;
  var MAX_MOVIE_LINKS = 7;
  var MAX_TV_GROUPS = 5;

  var LANG_NAMES = {
    hindi: "Hindi",
    english: "English",
    tamil: "Tamil",
    telugu: "Telugu",
    kannada: "Kannada",
    malayalam: "Malayalam",
    korean: "Korean",
    japanese: "Japanese",
    spanish: "Spanish",
    french: "French",
    german: "German",
    arabic: "Arabic",
    urdu: "Urdu",
    punjabi: "Punjabi",
    bengali: "Bengali",
    marathi: "Marathi",
    gujarati: "Gujarati",
    chinese: "Chinese",
    italian: "Italian",
    russian: "Russian",
    turkish: "Turkish",
    dutch: "Dutch",
    portuguese: "Portuguese"
  };

  function headers(referer, accept) {
    var h = {
      "User-Agent": UA,
      "Accept": accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    };
    if (referer) h["Referer"] = referer;
    return h;
  }

  function fetchTimeout(url, options, timeout) {
    timeout = timeout || TIMEOUT;
    var timer = null;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("Timeout")); }, timeout);
    });
    return Promise.race([fetch(url, options || {}), timeoutPromise]).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchText(url, referer) {
    return fetchTimeout(url, { headers: headers(referer) }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
      return res.text();
    });
  }

  function fetchJson(url, referer) {
    return fetchTimeout(url, {
      headers: headers(referer, "application/json, text/plain, */*")
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
      return res.json();
    });
  }

  function codePointToString(cp) {
    if (cp <= 0xFFFF) return String.fromCharCode(cp);
    cp -= 0x10000;
    return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
  }

  function decodeEntities(s) {
    s = String(s || "");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, h) {
      return codePointToString(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return codePointToString(parseInt(d, 10));
    });
    var map = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
      ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'",
      ldquo: '"', rdquo: '"'
    };
    return s.replace(/&([a-z]+);/gi, function (m, n) {
      var v = map[n.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function stripTags(html) {
    return decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function htmlToLines(html) {
    var s = String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|td|section|article|header|footer)>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    s = decodeEntities(s).replace(/\u00a0/g, " ");
    return s.split(/\r?\n/).map(function (line) {
      return line.replace(/\s+/g, " ").trim();
    }).filter(function (line) { return line; });
  }

  function lastLineBefore(html, index) {
    var start = Math.max(0, index - 1400);
    var lines = htmlToLines(html.substring(start, index));
    return lines.length ? lines[lines.length - 1] : "";
  }

  function extractTitle(html) {
    var m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? stripTags(m[1]) : "";
  }

  function normalize(s) {
    s = decodeEntities(s).toLowerCase();
    s = s.replace(/[isişğüöçâîû]/g, function (ch) {
      var map = { i: "i", s: "s", "ş": "s", "ğ": "g", "ü": "u", "ö": "o", "ç": "c", "â": "a", "î": "i", "û": "u" };
      return map[ch] || ch;
    });
    s = s.replace(/&/g, " and ").replace(/['’`]/g, "");
    return s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function pad2(n) {
    n = parseInt(n, 10) || 0;
    return (n < 10 ? "0" : "") + n;
  }

  function yearOf(title) {
    var s = String(title || "");
    var m = s.match(/\((19|20)\d{2}\)/);
    if (m) return parseInt(m[0].replace(/[^\d]/g, ""), 10);
    m = s.match(/\b(19|20)\d{2}\b/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function seasonNumbers(title) {
    var s = String(title || "").toLowerCase();
    var out = [];
    var m;

    var re = /season\s*(\d{1,2})(?:\s*[-–—]\s*(\d{1,2}))?/g;
    while ((m = re.exec(s)) !== null) {
      var a = parseInt(m[1], 10);
      var b = m[2] ? parseInt(m[2], 10) : a;
      if (b < a) { var tmp = a; a = b; b = tmp; }
      for (var i = a; i <= b && i <= a + 25; i++) out.push(i);
    }

    re = /\bs(\d{1,2})\s*e\d{1,3}\b/g;
    while ((m = re.exec(s)) !== null) out.push(parseInt(m[1], 10));

    re = /\bs(\d{1,2})\b/g;
    while ((m = re.exec(s)) !== null) out.push(parseInt(m[1], 10));

    var seen = [];
    return out.filter(function (v) {
      if (!v || seen.indexOf(v) !== -1) return false;
      seen.push(v);
      return true;
    });
  }

  function detectQuality(s) {
    s = String(s || "").toLowerCase();
    if (/2160|4k|uhd/.test(s)) return "4K";
    if (/1440|2k/.test(s)) return "2K";
    if (/1080|fhd/.test(s)) return "1080p";
    if (/720|hd/.test(s)) return "720p";
    if (/480/.test(s)) return "480p";
    return "Auto";
  }

  function qualityRank(q) {
    q = String(q || "").toLowerCase();
    if (q === "auto") return 2.5;
    if (/2160|4k|uhd/.test(q)) return 5;
    if (/1440|2k/.test(q)) return 4;
    if (/1080|fhd/.test(q)) return 3;
    if (/720|hd/.test(q)) return 2;
    if (/480/.test(q)) return 1;
    return 0;
  }

  function parseSize(s) {
    var m = String(s || "").match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\b/i);
    return m ? m[1].replace(",", ".") + " " + m[2].toUpperCase() : "";
  }

  function sizeInMb(s) {
    var m = String(s || "").match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\b/i);
    if (!m) return 0;
    var n = parseFloat(m[1].replace(",", "."));
    var unit = m[2].toUpperCase();
    if (unit === "TB") return n * 1024 * 1024;
    if (unit === "GB") return n * 1024;
    return n;
  }

  function parseLangs(s) {
    var out = [];
    var re = /\b(hindi|english|tamil|telugu|kannada|malayalam|korean|japanese|spanish|french|german|arabic|urdu|punjabi|bengali|marathi|gujarati|chinese|italian|russian|turkish|dutch|portuguese)\b/gi;
    var m;
    while ((m = re.exec(String(s || ""))) !== null) {
      var name = LANG_NAMES[m[1].toLowerCase()];
      if (name && out.indexOf(name) === -1) out.push(name);
    }
    if (/dual\s*audio/i.test(String(s || "")) && out.indexOf("Dual Audio") === -1) out.push("Dual Audio");
    return out.join(", ");
  }

  function parseMeta(label, qualityOverride) {
    var s = String(label || "");
    var lower = s.toLowerCase();
    var q = qualityOverride && qualityOverride !== "Auto" ? qualityOverride : detectQuality(s);
    var codec = "";
    if (/x265|hevc|h265|h\.265/.test(lower)) codec = "HEVC";
    else if (/x264|h264|h\.264|avc/.test(lower)) codec = "H.264";
    else if (/av1/.test(lower)) codec = "AV1";
    if (/10bit|10 bit|hi10/.test(lower)) codec = (codec ? codec + " 10bit" : "10bit");

    var hdr = "";
    if (/dolby.?vision|\bdv\b|\bdovi\b/.test(lower)) hdr = "DV";
    else if (/hdr10\+/.test(lower)) hdr = "HDR10+";
    else if (/hdr10/.test(lower)) hdr = "HDR10";
    else if (/\bhdr\b/.test(lower)) hdr = "HDR";

    var audio = [];
    if (/atmos/.test(lower)) audio.push("Atmos");
    if (/truehd/.test(lower)) audio.push("TrueHD");
    if (/ddp?\s*5\.1|dd5\.1|5\.1/.test(lower)) audio.push("5.1");
    else if (/ddp?\s*2\.0|dd2\.0|2\.0/.test(lower)) audio.push("2.0");
    if (/dts/.test(lower) && audio.indexOf("DTS") === -1) audio.push("DTS");

    var size = parseSize(s);
    var langs = parseLangs(s);
    var detail = [q, codec, hdr, audio.join(" "), size, langs].filter(function (x) {
      return !!x;
    }).join(" | ");

    return {
      quality: q,
      codec: codec,
      hdr: hdr,
      audio: audio.join(" "),
      size: size,
      langs: langs,
      detail: detail
    };
  }

  // ---------------------------------------------------------------- TMDB

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + TMDB_KEY + "&language=en-US&append_to_response=external_ids,alternative_titles";
    return fetchJson(url).then(function (d) {
      var alt = [];
      var altObj = d.alternative_titles || {};
      var list = altObj.titles || altObj.results || [];
      if (Array.isArray(list)) {
        list.forEach(function (item) {
          var t = item && (item.title || item.name);
          if (t && alt.indexOf(t) === -1) alt.push(t);
        });
      }
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        originalTitle: d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4),
        imdbId: (d.external_ids && d.external_ids.imdb_id) || "",
        totalSeasons: d.number_of_seasons || 1,
        altTitles: alt
      };
    });
  }

  // ------------------------------------------------------- site search

  function searchPosts(query) {
    var url = BASE + "/wp-json/wp/v2/posts?search=" + encodeURIComponent(query) +
      "&per_page=50&orderby=relevance&_fields=id,link,title,date";
    return fetchJson(url, BASE + "/").then(function (posts) {
      return Array.isArray(posts) ? posts : [];
    });
  }

  function queryWords(title) {
    var stop = { the: 1, a: 1, an: 1, of: 1, and: 1, or: 1, for: 1, to: 1, in: 1, on: 1, at: 1 };
    var words = normalize(title).split(" ").filter(function (w) {
      return w && !stop[w];
    });
    return words.length ? words : normalize(title).split(" ");
  }

  function scorePost(title, date, info, mediaType, season) {
    var postNorm = " " + normalize(title) + " ";
    var qNorm = normalize(info.title);
    if (!qNorm) return 0;

    var score = 0;
    if (postNorm.indexOf(" " + qNorm + " ") !== -1) {
      score += 100;
    } else {
      var qWords = queryWords(info.title);
      var pWords = postNorm.split(" ");
      var hits = 0;
      qWords.forEach(function (w) {
        if (pWords.indexOf(w) !== -1) hits++;
      });
      var cov = qWords.length ? hits / qWords.length : 0;
      if (cov < 0.6) return 0;
      score += Math.round(cov * 70);
    }

    var py = yearOf(title);
    var iy = parseInt(info.year, 10) || 0;
    if (py && iy) {
      if (py === iy) score += 40;
      else if (Math.abs(py - iy) <= 1) score += 15;
      else score -= 70;
    } else if (iy) {
      score += 5;
    }

    if (mediaType === "movie") {
      if (/\bseason\s*\d|\bs\d{1,2}\s*e\b|\bepisode\s*\d/i.test(title)) score -= 90;
      if (/\bseries\b|\btv show\b/i.test(title)) score -= 30;
    } else {
      var sn = seasonNumbers(title);
      var wanted = parseInt(season, 10) || 1;
      if (sn.length) {
        score += sn.indexOf(wanted) !== -1 ? 30 : -70;
      }
      if (/\bseason\b|\bseries\b|\bepisode\b|\bep\d+\b/i.test(title)) score += 10;
      if (/full movie/i.test(title)) score -= 60;
    }

    if (/web[- ]?dl|bluray|blu[- ]ray/i.test(title)) score += 12;
    if (/2160p|\b4k\b/i.test(title)) score += 8;
    if (/1080p/i.test(title)) score += 5;
    if (/\bcam\b|\bhdtc\b|hq rip|predvd|dvdscr/i.test(title)) score -= 20;

    var t = Date.parse(date || "");
    if (!isNaN(t)) {
      var days = (Date.now() - t) / 86400000;
      if (days < 30) score += 6;
      else if (days < 180) score += 3;
      else if (days > 1800) score -= 3;
    }
    return score;
  }

  function pickPost(posts, info, mediaType, season) {
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < posts.length; i++) {
      var post = posts[i];
      var title = post && post.title && post.title.rendered ? decodeEntities(post.title.rendered) : "";
      var score = scorePost(title, post.date, info, mediaType, season);
      if (score > bestScore) {
        bestScore = score;
        best = post;
      }
    }
    if (bestScore >= 60) {
      console.log("[MoviesDrive] Match (" + bestScore + "): " + decodeEntities(best.title.rendered));
      return best;
    }
    return null;
  }

  function findPost(info, mediaType, season) {
    var queries = [];
    function add(q) {
      q = String(q || "").replace(/\s+/g, " ").trim();
      if (q.length > 1 && queries.indexOf(q) === -1) queries.push(q);
    }

    add(info.title);
    add(info.originalTitle);
    (info.altTitles || []).slice(0, 5).forEach(add);

    var t = String(info.title || "");
    if (t.indexOf(":") !== -1) add(t.split(":")[0]);
    if (t.indexOf(" - ") !== -1) add(t.split(" - ")[0]);

    var words = t.split(/\s+/);
    if (words.length > 4) add(words.slice(0, 4).join(" "));
    if (info.year && t) add(t + " " + info.year);

    var chain = Promise.resolve(null);
    queries.slice(0, 8).forEach(function (query) {
      chain = chain.then(function (found) {
        if (found) return found;
        return searchPosts(query).then(function (posts) {
          return pickPost(posts, info, mediaType, season);
        }).catch(function (err) {
          console.log("[MoviesDrive] Search error (" + query + "): " + (err && err.message));
          return null;
        });
      });
    });
    return chain;
  }

  function fetchPost(post) {
    var url = BASE + "/wp-json/wp/v2/posts/" + post.id + "?_fields=id,link,title,content,date";
    return fetchJson(url, BASE + "/").then(function (full) {
      if (full && full.content && full.content.rendered) return full;
      throw new Error("Post content empty");
    });
  }

  // ---------------------------------------------------- HTML extraction

  function absoluteUrl(url, base) {
    url = decodeEntities(String(url || "").trim());
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf("//") === 0) return "https:" + url;
    if (url.charAt(0) === "/" && base) {
      var m = String(base).match(/^(https?:\/\/[^\/]+)/i);
      if (m) return m[1] + url;
    }
    if (base && base.charAt(base.length - 1) !== "/" && url.charAt(0) !== "/") {
      return base + "/" + url;
    }
    return base ? base + url : url;
  }

  function extractArchiveLinks(html) {
    var out = [];
    var re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var url = decodeEntities(m[1]);
      if (!/\/archive\/\d+/i.test(url)) continue;
      var anchor = stripTags(m[2]);
      var context = lastLineBefore(html, m.index);
      out.push({ url: url, anchor: anchor, context: context, index: m.index });
    }
    return out;
  }

  function sourceRank(label) {
    var s = String(label || "").toLowerCase();
    if (/web[- ]?dl/.test(s)) return 3;
    if (/bluray|blu[- ]ray/.test(s)) return 2;
    if (/hdtc|cam|predvd|dvdscr|hq rip/.test(s)) return -1;
    return 1;
  }

  function buildMovieCandidates(content) {
    var links = extractArchiveLinks(content);
    var seen = {};
    var out = [];
    links.forEach(function (link) {
      var label = (link.context + " " + link.anchor).replace(/\s+/g, " ").trim();
      if (/\bzip\b|\bcomplete\b|season pack|\bpack\b/i.test(label)) return;
      if (seen[link.url]) return;
      seen[link.url] = true;
      var anchorQuality = detectQuality(link.anchor);
      var meta = parseMeta(label, anchorQuality);
      out.push({ url: link.url, label: label, meta: meta });
    });
    out.sort(function (a, b) {
      var d = qualityRank(b.meta.quality) - qualityRank(a.meta.quality);
      if (d) return d;
      d = sourceRank(b.label) - sourceRank(a.label);
      if (d) return d;
      return sizeInMb(a.meta.size) - sizeInMb(b.meta.size);
    });
    return out;
  }

  function buildTvGroups(content, season, episode) {
    var links = extractArchiveLinks(content);
    var wantedSeason = parseInt(season, 10) || 1;
    var wantedEpisode = parseInt(episode, 10) || 1;
    var seen = {};
    var all = [];

    links.forEach(function (link) {
      var label = (link.context + " " + link.anchor).replace(/\s+/g, " ").trim();
      if (/\bzip\b|\bcomplete\b|season pack|\bpack\b/i.test(label)) return;
      if (seen[link.url]) return;
      seen[link.url] = true;

      var meta = parseMeta(label, detectQuality(link.anchor));
      var sn = seasonNumbers(label);
      if (sn.length && sn.indexOf(wantedSeason) === -1) return;

      var directEp = 0;
      var m = link.anchor.match(/\b(?:ep|episode|e)\s*0*(\d{1,3})\b/i) ||
        link.anchor.match(/\bs\d{1,2}\s*e(\d{1,3})\b/i);
      if (m) directEp = parseInt(m[1], 10);

      if (directEp) {
        if (directEp !== wantedEpisode) return;
        all.push({ type: "direct", url: link.url, label: label, meta: meta, season: sn });
      } else {
        all.push({ type: "group", url: link.url, label: label, meta: meta, season: sn });
      }
    });

    // Ayni kalitede hem tek bolum hem sezon grubu varsa tek bolumu tercih et.
    var byQ = {};
    all.forEach(function (g) {
      var key = g.meta.quality + "|" + sourceRank(g.label);
      var cur = byQ[key];
      if (!cur || (cur.type !== "direct" && g.type === "direct")) byQ[key] = g;
    });

    var out = Object.keys(byQ).map(function (k) { return byQ[k]; });
    out.sort(function (a, b) {
      var d = qualityRank(b.meta.quality) - qualityRank(a.meta.quality);
      if (d) return d;
      d = sourceRank(b.label) - sourceRank(a.label);
      if (d) return d;
      if (a.type !== b.type) return a.type === "direct" ? -1 : 1;
      return sizeInMb(a.meta.size) - sizeInMb(b.meta.size);
    });
    return out.slice(0, MAX_TV_GROUPS);
  }

  function findHubcloud(html) {
    var re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
    var m;
    var fallback = "";
    while ((m = re.exec(html)) !== null) {
      var u = decodeEntities(m[1]);
      if (!/hubcloud/i.test(u)) continue;
      if (/\/drive\/admin|\/login|favicon|\.(png|jpe?g|webp|gif|css|js)(\?|$)/i.test(u)) continue;
      u = absoluteUrl(u, BASE + "/");
      if (/\/drive\/[a-z0-9]+/i.test(u)) return u;
      if (!fallback) fallback = u;
    }
    if (fallback) return fallback;
    var direct = String(html || "").match(/https?:\/\/[^"'\s<>]*hubcloud[^"'\s<>]*\/drive\/[a-z0-9]+/i);
    return direct ? decodeEntities(direct[0]) : null;
  }

  function hrefFromTag(tag) {
    var m = String(tag || "").match(/\bhref=["']([^"']+)["']/i);
    return m ? decodeEntities(m[1]) : "";
  }

  function isFinalFileUrl(url) {
    if (!url) return false;
    if (/hubcloud|gamerxyt|gdflix/i.test(url)) return false;
    return /r2\.cloudflarestorage\.com|\.r2\.dev|\.(mkv|mp4|m4v|webm)(\?|$)/i.test(url);
  }

  function findFinalUrl(html) {
    var candidates = [];
    var tagRe = /<a\b[^>]*>/gi;
    var m;
    while ((m = tagRe.exec(html)) !== null) {
      var tag = m[0];
      if (!/\bid=["']fsl["']/i.test(tag)) continue;
      var href = hrefFromTag(tag);
      if (href) candidates.push(href);
    }

    var rm = String(html || "").match(/https?:\/\/[^"'\s<>]*r2\.cloudflarestorage\.com[^"'\s<>]*/i);
    if (rm) candidates.push(decodeEntities(rm[0]));

    var hrefRe = /\bhref=["']([^"']+\.(?:mkv|mp4|m4v|webm)(?:\?[^"']*)?)["']/gi;
    while ((m = hrefRe.exec(html)) !== null) candidates.push(decodeEntities(m[1]));

    var srcRe = /<source\b[^>]*\bsrc=["']([^"']+)["']/gi;
    while ((m = srcRe.exec(html)) !== null) candidates.push(decodeEntities(m[1]));

    for (var i = 0; i < candidates.length; i++) {
      var url = absoluteUrl(candidates[i], BASE + "/");
      if (isFinalFileUrl(url)) return url;
    }
    return null;
  }

  function findNavUrl(html, base) {
    var tagRe = /<a\b[^>]*>/gi;
    var m;
    var fallback = "";
    while ((m = tagRe.exec(html)) !== null) {
      var tag = m[0];
      var href = hrefFromTag(tag);
      if (!href) continue;
      if (/\bid=["']fsl["']/i.test(tag)) return absoluteUrl(href, base);
      if (/\bid=["']download["']/i.test(tag)) fallback = href;
      else if (!fallback && /gamerxyt\.com\/hubcloud\.php|hubcloud\.php\?/i.test(href)) fallback = href;
    }
    if (fallback) return absoluteUrl(fallback, base);

    var gm = String(html || "").match(/https?:\/\/[^"'\s<>]*(?:gamerxyt\.com\/hubcloud\.php|hubcloud\.php\?)[^"'\s<>]*/i);
    return gm ? decodeEntities(gm[0]) : null;
  }

  function resolveHubcloud(url, referer) {
    var depth = 0;
    var visited = {};

    function step(current, ref) {
      if (!current || visited[current] || depth > 3) return Promise.resolve(null);
      visited[current] = true;
      depth++;
      return fetchText(current, ref).then(function (html) {
        var finalUrl = findFinalUrl(html);
        if (finalUrl) return finalUrl;
        var next = findNavUrl(html, current);
        if (next && next !== current) return step(next, current);
        return null;
      });
    }

    return step(url, referer).catch(function (err) {
      console.log("[MoviesDrive] HubCloud error: " + (err && err.message));
      return null;
    });
  }

  function contentRegion(html) {
    var s = String(html || "");
    var m = s.match(/<div[^>]+class=["'][^"']*entry-content[^"']*["'][^>]*>/i);
    if (!m) return s;
    var start = m.index + m[0].length;
    var end = s.indexOf("</article>", start);
    if (end === -1) end = s.length;
    return s.substring(start, end);
  }

  function findEpisodeHub(html, episode) {
    var ep = parseInt(episode, 10) || 1;
    var body = contentRegion(html);
    var marks = [];
    var m;

    var re = /\b(?:EP?|Episode)\s*0*(\d{1,3})\b/gi;
    while ((m = re.exec(body)) !== null) {
      marks.push({ num: parseInt(m[1], 10), index: m.index });
    }
    re = /\bS\d{1,2}\s*E(\d{1,3})\b/gi;
    while ((m = re.exec(body)) !== null) {
      marks.push({ num: parseInt(m[1], 10), index: m.index });
    }

    marks.sort(function (a, b) { return a.index - b.index; });

    for (var i = 0; i < marks.length; i++) {
      if (marks[i].num !== ep) continue;
      var end = body.length;
      for (var j = i + 1; j < marks.length; j++) {
        if (marks[j].index > marks[i].index) { end = marks[j].index; break; }
      }
      var hub = findHubcloud(body.substring(marks[i].index, end));
      if (hub) return hub;
    }

    if (!marks.length) {
      var title = extractTitle(html);
      if (new RegExp("\\b(?:ep|episode|e)\\s*0*" + ep + "\\b", "i").test(title)) {
        return findHubcloud(body);
      }
    }
    return null;
  }

  // --------------------------------------------------------- stream build

  function makeStream(info, meta, url, season, episode) {
    var display = info.title + (info.year ? " (" + info.year + ")" : "");
    if (info.mediaType === "tv") {
      display += " S" + pad2(season) + "E" + pad2(episode);
    }
    var tag = meta.codec ? " " + meta.codec : "";
    return {
      name: "MoviesDrive - " + meta.quality + tag,
      title: display + "\n" + (meta.detail || meta.quality),
      url: url,
      quality: meta.quality,
      isM3u8: false,
      provider: "moviesdrive",
      type: "direct",
      subtitles: []
    };
  }

  function qSort(list) {
    var hd = list.filter(function (s) { return qualityRank(s.quality) >= 2.5; });
    var base = hd.length ? hd : list;
    base.sort(function (a, b) { return qualityRank(b.quality) - qualityRank(a.quality); });
    return base;
  }

  function resolveMovieCandidate(info, cand) {
    return fetchText(cand.url, BASE + "/").then(function (page) {
      var hub = findHubcloud(page);
      if (!hub) {
        console.log("[MoviesDrive] No HubCloud link (" + cand.meta.quality + ")");
        return null;
      }
      return resolveHubcloud(hub, cand.url).then(function (direct) {
        if (!direct) {
          console.log("[MoviesDrive] Direct link failed (" + cand.meta.quality + ")");
          return null;
        }
        return makeStream(info, cand.meta, direct);
      });
    }).catch(function (err) {
      console.log("[MoviesDrive] Candidate error (" + cand.meta.quality + "): " + (err && err.message));
      return null;
    });
  }

  function resolveDirectTv(info, group, season, episode) {
    return fetchText(group.url, BASE + "/").then(function (page) {
      var hub = findHubcloud(page);
      if (!hub) {
        console.log("[MoviesDrive] No HubCloud link (" + group.meta.quality + ")");
        return null;
      }
      return resolveHubcloud(hub, group.url).then(function (direct) {
        if (!direct) return null;
        return makeStream(info, group.meta, direct, season, episode);
      });
    }).catch(function (err) {
      console.log("[MoviesDrive] Direct episode error: " + (err && err.message));
      return null;
    });
  }

  function resolveTvGroup(info, group, season, episode) {
    return fetchText(group.url, BASE + "/").then(function (page) {
      var pageTitle = extractTitle(page);
      var sn = seasonNumbers(pageTitle);
      if (!sn.length) sn = seasonNumbers(stripTags(page.substring(0, 4000)));
      if (sn.length && sn.indexOf(parseInt(season, 10) || 1) === -1) {
        console.log("[MoviesDrive] Skip wrong season: " + pageTitle);
        return null;
      }
      var hub = findEpisodeHub(page, episode);
      if (!hub) {
        console.log("[MoviesDrive] Episode not found in " + group.meta.quality + " (" + pageTitle + ")");
        return null;
      }
      return resolveHubcloud(hub, group.url).then(function (direct) {
        if (!direct) return null;
        return makeStream(info, group.meta, direct, season, episode);
      });
    }).catch(function (err) {
      console.log("[MoviesDrive] Episode group error: " + (err && err.message));
      return null;
    });
  }

  function resolveWithFallback(list, resolver) {
    var hd = list.filter(function (item) { return qualityRank(item.meta.quality) >= 2.5; });
    var low = list.filter(function (item) { return qualityRank(item.meta.quality) < 2.5; });
    var first = hd.length ? hd.slice(0, MAX_MOVIE_LINKS) : low.slice(0, MAX_MOVIE_LINKS);

    return Promise.all(first.map(resolver)).then(function (results) {
      var streams = results.filter(function (s) { return !!s; });
      if (streams.length || !hd.length || !low.length) return streams;
      console.log("[MoviesDrive] HD failed, trying lower qualities");
      return Promise.all(low.slice(0, MAX_MOVIE_LINKS).map(resolver)).then(function (more) {
        return more.filter(function (s) { return !!s; });
      });
    });
  }

  function resolveMovie(info, content) {
    var candidates = buildMovieCandidates(content);
    var quals = candidates.map(function (c) { return c.meta.quality; });
    console.log("[MoviesDrive] " + candidates.length + " movie candidates (" + quals.join(", ") + ")");
    if (!candidates.length) return Promise.resolve([]);
    return resolveWithFallback(candidates, function (cand) {
      return resolveMovieCandidate(info, cand);
    }).then(function (streams) {
      console.log("[MoviesDrive] Found " + streams.length + " streams");
      return qSort(streams);
    });
  }

  function resolveTv(info, content, season, episode) {
    var groups = buildTvGroups(content, season, episode);
    console.log("[MoviesDrive] " + groups.length + " tv groups for S" + season + "E" + episode);
    if (!groups.length) return Promise.resolve([]);
    return resolveWithFallback(groups, function (group) {
      if (group.type === "direct") return resolveDirectTv(info, group, season, episode);
      return resolveTvGroup(info, group, season, episode);
    }).then(function (streams) {
      console.log("[MoviesDrive] Found " + streams.length + " streams");
      return qSort(streams);
    });
  }

  // ----------------------------------------------------------- entrypoint

  function getStreams(tmdbId, mediaType, season, episode) {
    var type = mediaType === "tv" ? "tv" : "movie";
    season = parseInt(season, 10) || 1;
    episode = parseInt(episode, 10) || 1;
    console.log("[MoviesDrive] Fetching " + type + " " + tmdbId +
      (type === "tv" ? " S" + season + "E" + episode : ""));

    return tmdbLookup(tmdbId, type).then(function (info) {
      info.mediaType = type;
      if (!info.title) throw new Error("TMDB title missing");
      return findPost(info, type, season).then(function (post) {
        if (!post) {
          console.log("[MoviesDrive] No matching post");
          return [];
        }
        return fetchPost(post).then(function (full) {
          var content = full.content && full.content.rendered ? full.content.rendered : "";
          if (!content) return [];
          if (type === "tv") return resolveTv(info, content, season, episode);
          return resolveMovie(info, content);
        });
      });
    }).catch(function (err) {
      console.log("[MoviesDrive] Error: " + (err && err.message));
      return [];
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { getStreams: getStreams };
  } else {
    this.getStreams = getStreams;
  }
})();
