/**
 * vegamovies - VegaMovies provider for Nuvio
 * Flow: TMDB -> ts-search.php -> detail -> nexdrive -> vcloud/megaup/vegadrive
 * - 480p entries are skipped (kalabalik yapmasin)
 * Hermes-safe: Promise chains only, no deps (embedded base64).
 */
(function () {
  "use strict";

  var BASE = "https://vegamovies.gallery";
  var TMDB_KEY = "90b2cae8d7161e8ba0f3836240d7d352";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TIMEOUT = 12000;
  var MAX_ENTRIES = 6;

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

  function headers(ref) {
    var h = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };
    if (ref) h.Referer = ref;
    return h;
  }

  var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function b64decode(str) {
    str = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
    var out = [], i, e0, e1, e2, e3;
    for (i = 0; i < str.length; i += 4) {
      e0 = B64C.indexOf(str.charAt(i)); e1 = B64C.indexOf(str.charAt(i + 1));
      e2 = str.charAt(i + 2) === "=" ? 0 : B64C.indexOf(str.charAt(i + 2));
      e3 = str.charAt(i + 3) === "=" ? 0 : B64C.indexOf(str.charAt(i + 3));
      out.push((e0 << 2) | (e1 >> 4));
      if (str.charAt(i + 2) !== "=") out.push(((e1 & 15) << 4) | (e2 >> 2));
      if (str.charAt(i + 3) !== "=") out.push(((e2 & 3) << 6) | e3);
    }
    var s = "";
    for (i = 0; i < out.length; i++) s += String.fromCharCode(out[i] & 255);
    return s;
  }

  function parseRelease(s) {
    s = " " + String(s || "").toLowerCase().replace(/[^a-z0-9+.]+/g, " ") + " ";
    var codec = /x265|hevc|h265/.test(s) ? "HEVC x265" : (/x264|h264|avc/.test(s) ? "H.264" : "");
    var depth = /10bit|10 bit|hi10/.test(s) ? "10bit" : "";
    var hdr = /dolby.?vision|\bdv\b|\bdovi\b/.test(s) ? "DV" : (/hdr10\+/.test(s) ? "HDR10+" : (/hdr10/.test(s) ? "HDR10" : (/hdr\b/.test(s) ? "HDR" : "")));
    var audio = /truehd/.test(s) ? "TrueHD" : (/atmos/.test(s) ? "Atmos" : (/dts/.test(s) ? "DTS" : ""));
    var ach = /ddp.?5\.1|dd.?5\.1|ac.?3|5\.1/.test(s) ? "5.1" : (/7\.1/.test(s) ? "7.1" : "");
    var lang = /dual/.test(s) ? "Dual Audio" : (/hindi/.test(s) && /english/.test(s) ? "Hindi-English" : (/hindi/.test(s) ? "Hindi" : ""));
    return { codec: codec, depth: depth, hdr: hdr, audio: (audio + (ach ? " " + ach : "")).trim(), lang: lang };
  }

  function parseQuality(label) {
    var s = String(label || "").toLowerCase();
    if (/2160p/.test(s) || /\b4k\b/.test(s)) return "2160p";
    if (/1080p/.test(s)) return "1080p";
    if (/720p/.test(s)) return "720p";
    if (/480p/.test(s)) return "480p";
    return "HD";
  }

  function is480(label) { return /480p/i.test(String(label || "")); }

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }

  function tmdbLookup(tmdbId, mediaType) {
    var type = mediaType === "tv" ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(tmdbId) + "?api_key=" + TMDB_KEY + "&language=en-US";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error("TMDB " + r.status);
      return r.json();
    }).then(function (d) {
      var ext = d.external_ids || {};
      return {
        title: d.name || d.title || d.original_name || d.original_title || "",
        year: (d.first_air_date || d.release_date || "").substring(0, 4),
        imdbId: ext.imdb_id || d.imdb_id || null
      };
    });
  }

  function vmSearch(title) {
    var url = BASE + "/ts-search.php?q=" + encodeURIComponent(title) + "&page=1";
    return fetchTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: BASE + "/" } }).then(function (r) {
      if (!r.ok) throw new Error("Search " + r.status);
      return r.json();
    }).then(function (d) {
      return (d && Array.isArray(d.hits) ? d.hits : []).map(function (h) { return h.document || h; });
    }).catch(function () { return []; });
  }

  function pickDetail(docs, info, mediaType) {
    var i, best = null, bestScore = -1;
    var words = String(info.title).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; });
    for (i = 0; i < docs.length; i++) {
      var d = docs[i] || {};
      var slug = norm((d.permalink || "") + " " + (d.post_title || ""));
      var hit = 0, w;
      for (w = 0; w < words.length; w++) if (slug.indexOf(norm(words[w])) !== -1) hit++;
      var score = hit * 10;
      if (info.imdbId && d.imdb_id === info.imdbId) score += 50;
      if (info.year && ((d.post_title || "").indexOf(info.year) !== -1 || (d.category || []).join(" ").indexOf(info.year) !== -1)) score += 5;
      if (mediaType === "tv" && /season/i.test(d.post_title || "")) score += 5;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    var need = words.length >= 2 ? 20 : 10;
    return bestScore >= need ? best.permalink : null;
  }

  function fullUrl(p) {
    if (/^https?:\/\//i.test(p)) return p;
    return BASE + (p.charAt(0) === "/" ? p : "/" + p);
  }

  // detail page -> [{label, url}] (480p haric)
  function parseDetail(html) {
    var out = [];
    var re = /<h[345][^>]*>([\s\S]{5,220}?)<\/h[345]>\s*<p[^>]*><a href="(https:\/\/(?:nexdrive\.(?:fit|beer)|vglist\.lol)[^"]+)"/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var label = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 140);
      if (!label || is480(label)) continue;
      out.push({ label: label, url: m[2] });
    }
    // yedek: basliksiz nexdrive linkleri
    if (!out.length) {
      var re2 = /<a[^>]+href="(https:\/\/(?:nexdrive\.(?:fit|beer)|vglist\.lol)[^"]+)"/gi;
      var seen = {};
      while ((m = re2.exec(html)) !== null) {
        if (seen[m[1]]) continue;
        seen[m[1]] = true;
        out.push({ label: "", url: m[1] });
      }
    }
    return out;
  }

  function sizeOf(label) {
    var m = String(label || "").match(/(\d+(?:\.\d+)?\s*(?:MB|GB))/i);
    return m ? m[1] : "";
  }

  // nexdrive movie page -> {vcloud:[], filebee:[], megaup:[], gofile:[]}
  function parseNex(html) {
    var res = { vcloud: [], filebee: [], megaup: [], gofile: [] };
    var re = /<a[^>]+href="([^"]+)"[^>]*>/gi, m, seen = {};
    while ((m = re.exec(html)) !== null) {
      var u = m[1];
      if (seen[u] || u.indexOf("vegamovies.gallery") !== -1) continue;
      seen[u] = true;
      if (/vcloud\.\w+\//.test(u)) res.vcloud.push(u);
      else if (/filebee\.xyz\/file\//.test(u) || /filepress/i.test(u)) res.filebee.push(u);
      else if (/megaup\.net\//.test(u)) res.megaup.push(u);
      else if (/gofile\.io\/d\//.test(u)) res.gofile.push(u);
    }
    return res;
  }

  // vcloud page -> token URL -> R2 direct + hubcloud instant
  function resolveVcloud(vurl, referer) {
    return fetchTimeout(vurl, { headers: headers(referer) }).then(function (r) {
      if (!r.ok) throw new Error("vc " + r.status);
      return r.text();
    }).then(function (html) {
      var m = html.match(/var url = atob\(atob\('([^']+)'\)\)/);
      if (!m) return [];
      var tokenUrl;
      try { tokenUrl = b64decode(b64decode(m[1])); } catch (e) { return []; }
      if (!/^https?:\/\//.test(tokenUrl)) return [];
      return fetchTimeout(tokenUrl, { headers: headers(vurl) }).then(function (r2) {
        if (!r2.ok) throw new Error("vc2 " + r2.status);
        return r2.text();
      }).then(function (html2) {
        var found = [];
        var re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{0,60})<\/a>/gi, a, seen = {};
        while ((a = re.exec(html2)) !== null) {
          var u = a[1];
          if (seen[u]) continue;
          seen[u] = true;
          if (/r2\.(dev|cloudflarestorage\.com)/.test(u)) found.push({ url: u, via: "R2", ref: vurl });
          else if (/hubcloud\.\w+\//.test(u)) found.push({ url: u, via: "Hub", ref: vurl });
        }
        return found;
      }).catch(function () { return []; });
    }).catch(function () { return []; });
  }

  // hubcloud instant (?id=) -> redirect yakala
  function resolveHub(hurl, referer) {
    return fetchTimeout(hurl, { headers: headers(referer), redirect: "manual" }).then(function (r) {
      var loc = null;
      try { loc = r.headers.get("location"); } catch (e) {}
      if (loc && /^https?:\/\//.test(loc) && loc.indexOf("hubcloud") === -1) return [{ url: loc, via: "Hub", ref: hurl }];
      if (r.url && /^https?:\/\//.test(r.url) && r.url.indexOf("hubcloud") === -1 && r.url !== hurl) return [{ url: r.url, via: "Hub", ref: hurl }];
      return [];
    }).catch(function () { return []; });
  }

  // filebee page -> drive/direct link
  function resolveFilebee(furl, referer) {
    return fetchTimeout(furl, { headers: headers(referer) }).then(function (r) {
      if (!r.ok) throw new Error("fb " + r.status);
      return r.text();
    }).then(function (html) {
      var re = /<a[^>]+href="(https?:\/\/(?:drive\.google\.com|docs\.google\.com|filebee\.xyz)[^"]+)"/gi, m;
      while ((m = re.exec(html)) !== null) {
        if (/uc\?|export=download|download/i.test(m[1])) return [{ url: m[1], via: "Drive", ref: furl }];
      }
      return [];
    }).catch(function () { return []; });
  }

  // vegadrive episode -> mirror poll -> direct
  function resolveMirror(vdId, mirror, referer) {
    var api = "https://one.vegadrive.me/download-link/" + vdId + "/" + mirror;
    function attempt(left) {
      return fetchTimeout(api, { headers: { "User-Agent": UA, Accept: "application/json", Referer: referer } }).then(function (r) {
        return r.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) { return []; }
          if (d && d.ready && d.download_url && /^https?:\/\//.test(d.download_url)) return [{ url: d.download_url, via: "Drive", ref: referer }];
          if (d && d.ready === false && left > 0) {
            var wait = Math.min(d.retry_after_ms || 2500, 8000);
            return new Promise(function (res) { setTimeout(res, wait); }).then(function () { return attempt(left - 1); });
          }
          return [];
        });
      }).catch(function () { return []; });
    }
    return attempt(2);
  }

  function vdIdOf(vdUrl) {
    var m = String(vdUrl).match(/\/s\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  function makeStream(display, quality, url, via, extra, size, ref) {
    return {
      name: "VegaMovies - " + quality + " (" + via + ")",
      title: display + "\n" + quality + (extra ? " | " + extra : "") + (size ? " | " + size : ""),
      url: url,
      quality: quality,
      isM3u8: false,
      provider: "vegamovies",
      type: "direct",
      headers: { Referer: ref || BASE + "/", "User-Agent": UA }
    };
  }

  function richExtra(label) {
    var r = parseRelease(label);
    var parts = [[r.codec, r.depth].join(" "), [r.hdr, r.audio].join(" "), r.lang].filter(Boolean);
    return parts.join(" | ");
  }

  // ---- movie: entry -> vcloud/megaup/filebee ----
  function resolveMovieEntry(entry, referer, display) {
    return fetchTimeout(entry.url, { headers: headers(referer) }).then(function (r) {
      if (!r.ok) throw new Error("nx " + r.status);
      return r.text();
    }).then(function (html) {
      var nx = parseNex(html);
      var quality = parseQuality(entry.label);
      if (quality === "480p") return [];
      var extra = richExtra(entry.label), size = sizeOf(entry.label);
      var found = [];
      nx.megaup.slice(0, 2).forEach(function (u) { found.push({ url: u, via: "Direct", ref: entry.url }); });
      var chain = Promise.resolve(found);
      nx.vcloud.slice(0, 2).forEach(function (u) {
        chain = chain.then(function (acc) {
          return resolveVcloud(u, entry.url).then(function (streams) {
            return acc.concat(streams);
          });
        });
      });
      nx.filebee.slice(0, 1).forEach(function (u) {
        chain = chain.then(function (acc) {
          return resolveFilebee(u, entry.url).then(function (streams) {
            return acc.concat(streams);
          });
        });
      });
      return chain.then(function (all) {
        return all.slice(0, 4).map(function (f) {
          return makeStream(display, quality, f.url, f.via, extra, size, f.ref);
        });
      });
    }).catch(function () { return []; });
  }

  // ---- tv: entry(season) -> episode vegadrive -> mirror poll ----
  function epNumOf(txt, want) {
    var t = " " + String(txt).replace(/[^a-z0-9]+/gi, " ").toLowerCase() + " ";
    var e = parseInt(want, 10);
    var pats = [" episode " + e + " ", " ep " + e + " ", " e" + (e < 10 ? "0" + e : e) + " "];
    for (var i = 0; i < pats.length; i++) if (t.indexOf(pats[i]) !== -1) return true;
    return false;
  }

  function resolveTvEntry(entry, season, episode, referer, display) {
    return fetchTimeout(entry.url, { headers: headers(referer) }).then(function (r) {
      if (!r.ok) throw new Error("nx " + r.status);
      return r.text();
    }).then(function (html) {
      // bolum linkleri: "Episodes: NN" + vegadrive href
      var eps = [];
      var re = /Episodes?:?\s*0?(\d+)[\s\S]{0,300}?https?:\/\/one\.vegadrive\.(?:me|app)\/s\/([A-Za-z0-9]+)/gi, m;
      var html2 = html.replace(/<[^>]+>/g, " ");
      var re2 = /(episode[s]?:?\s*0?(\d+))[^]*?one\.vegadrive\.(?:me|app)\/s\/([A-Za-z0-9]+)/gi;
      while ((m = re2.exec(html)) !== null) {
        if (parseInt(m[2], 10) === parseInt(episode, 10)) eps.push(m[3]);
      }
      if (!eps.length) {
        // yedek: tum vegadrive id'leri, siraya gore sec
        var all = [], r3 = /one\.vegadrive\.(?:me|app)\/s\/([A-Za-z0-9]+)/g, a;
        var seen = {};
        while ((a = r3.exec(html)) !== null) {
          if (!seen[a[1]]) { seen[a[1]] = true; all.push(a[1]); }
        }
        var idx = parseInt(episode, 10) - 1;
        if (all.length === 1 || (idx >= 0 && idx < all.length)) eps.push(all.length === 1 ? all[0] : all[idx]);
      }
      if (!eps.length) return [];
      var quality = parseQuality(entry.label);
      if (quality === "480p") return [];
      var extra = richExtra(entry.label), size = sizeOf(entry.label);
      var id = eps[0];
      var page = "https://one.vegadrive.me/s/" + id;
      var mirrors = ["pixeldrain", "skydrop", "gofile"];
      var chain = Promise.resolve([]);
      mirrors.forEach(function (mi) {
        chain = chain.then(function (acc) {
          if (acc.length) return acc;
          return resolveMirror(id, mi, page).then(function (streams) {
            return acc.concat(streams);
          });
        });
      });
      return chain.then(function (all) {
        return all.slice(0, 2).map(function (f) {
          return makeStream(display, quality, f.url, f.via === "Drive" ? "VegaDrive" : f.via, extra, size, f.ref);
        });
      });
    }).catch(function () { return []; });
  }

  function getStreams(tmdbId, mediaType, season, episode) {
    var tag = "[VegaMovies]";
    console.log(tag + " Fetching " + mediaType + " " + tmdbId + (season ? " S" + season + (episode ? "E" + episode : "") : ""));
    var ctx = {};
    return tmdbLookup(tmdbId, mediaType).then(function (info) {
      if (!info.title) { console.log(tag + " TMDB lookup failed"); return []; }
      ctx.info = info;
      return vmSearch(info.title).then(function (docs) {
        var url = pickDetail(docs, info, mediaType);
        if (!url && info.title.split(" ").length > 2) {
          var short = info.title.split(" ").slice(0, 2).join(" ");
          return vmSearch(short).then(function (docs2) { return pickDetail(docs2, info, mediaType); });
        }
        return url;
      });
    }).then(function (detailUrl) {
      if (!detailUrl) { console.log(tag + " No match"); return []; }
      ctx.detailUrl = detailUrl;
      console.log(tag + " Match: " + detailUrl);
      return fetchTimeout(fullUrl(detailUrl), { headers: headers(BASE + "/") }).then(function (r) {
        if (!r.ok) throw new Error("Detail " + r.status);
        return r.text();
      });
    }).then(function (html) {
      if (!html || typeof html !== "string") return html || [];
      var entries = parseDetail(html).slice(0, MAX_ENTRIES);
      if (!entries.length) { console.log(tag + " No entries"); return []; }
      var display = ctx.info.title + (ctx.info.year ? " (" + ctx.info.year + ")" : "");
      if (mediaType === "tv") {
        var s = parseInt(season || 1, 10);
        var matched = entries.filter(function (e) {
          return new RegExp("season\\s*0?" + s + "\\b", "i").test(e.label);
        });
        if (!matched.length) matched = entries.slice(0, 3);
        display += " S" + (s < 10 ? "0" + s : s) + "E" + (function (e) { return e < 10 ? "0" + e : "" + e; })(parseInt(episode || 1, 10));
        var chain = Promise.resolve([]);
        matched.slice(0, 3).forEach(function (en) {
          chain = chain.then(function (acc) {
            if (acc.length >= 3) return acc;
            return resolveTvEntry(en, s, episode || 1, ctx.detailUrl, display).then(function (ss) {
              return acc.concat(ss);
            });
          });
        });
        return chain.then(function (all) {
          console.log(tag + " Found " + all.length + " streams");
          return all.slice(0, 4);
        });
      }
      var chain2 = Promise.resolve([]);
      entries.forEach(function (en) {
        chain2 = chain2.then(function (acc) {
          if (acc.length >= 8) return acc;
          return resolveMovieEntry(en, ctx.detailUrl, display).then(function (ss) {
            return acc.concat(ss);
          });
        });
      });
      return chain2.then(function (all) {
        console.log(tag + " Found " + all.length + " streams");
        return all.slice(0, 10);
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
