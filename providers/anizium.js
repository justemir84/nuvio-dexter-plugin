/**
 * anizium - Anizium (anizium.co) provider for Nuvio
 *
 * Akis:
 *   TMDB id -> TMDB basligi (tr) + alternatifler + yil
 *   -> API /page/search?value=  (XOR Cf-Control basligi)
 *   -> /anime/source?id=&site=main&plan=&season=&episode=&server=1
 *   -> groups (ses grubu) + items (480p-2160p MP4) + subtitles (VTT)
 *
 * Notlar:
 * - API sorgulari XOR tabanli "Cf-Control" basligi ve CLIENT_KEY ile calisir.
 * - Kaynak ucretli/tekil fark etmeksizin guest token ile acilir.
 * - Video sunucusu Referer: https://x.anizium.co/ gerektirir.
 * - Gruplar ses grubudur: original (Japonca), trdub (Turkce), endub (Ingilizce).
 * - Hermes uyumlu: async/await yok, yalnizca Promise zinciri.
 */
(function () {
  "use strict";

  var BASE = "https://anizium.co";
  var API = "https://api.anizium.co";
  var ADMIN = "https://x.anizium.co";
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  var TOKEN_KEY = "hlxjl1c2w281ax473rt1ofgrvhyjvi";
  var CLIENT_KEY = "16ghkdz5qnwinkyebwopbd94b49xhs";
  var SOURCE_TOKEN = "134e0b52025e565655080906584c070e024345015e5f550f";
  var TMDB_KEY_FALLBACK = "439c478a771f35c05022f9feabcca01c";
  var TIMEOUT = 15000;

  // ---------------------------------------------------------------- helpers

  function getSettings(settings) {
    if (typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS) return SCRAPER_SETTINGS;
    return settings || {};
  }

  function getTmdbKey(settings) {
    var s = getSettings(settings);
    return s.tmdbApiKey || (typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "") || TMDB_KEY_FALLBACK;
  }

  function getSourceToken(settings) {
    var s = getSettings(settings);
    return s.sourceToken || SOURCE_TOKEN;
  }

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

  function norm(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9çğıöşü]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  var TR_MAP = {
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
    "â": "a", "Â": "a", "î": "i", "Î": "i", "û": "u", "Û": "u",
    "é": "e", "è": "e", "ê": "e", "á": "a", "à": "a", "ä": "a",
    "å": "a", "ñ": "n", "ø": "o", "æ": "ae", "ß": "ss",
    "'": "", "’": "", "&": " ve "
  };

  function slugify(title) {
    var src = String(title || "");
    var ascii = "";
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      ascii += TR_MAP[ch] !== undefined ? TR_MAP[ch] : ch;
    }
    return ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // ------------------------------------------------------- XOR / Cf-Control

  function xorHex(str, key) {
    var a = [], k = [], i;
    for (i = 0; i < String(str).length; i++) a.push(String(str).charCodeAt(i));
    for (i = 0; i < String(key).length; i++) k.push(String(key).charCodeAt(i));
    var out = [];
    for (i = 0; i < a.length; i++) {
      out.push((a[i] ^ k[i % k.length]).toString(16).padStart(2, "0"));
    }
    return out.join("");
  }

  // Istanbul (UTC+3) haftanin gunu - toLocaleString destegi guvenilir degil.
  function istanbulWeekday() {
    var now = new Date();
    var utc = now.getTime() + now.getTimezoneOffset() * 60000;
    var ist = new Date(utc + 3 * 3600000);
    var days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    return days[ist.getDay()];
  }

  function cfControl() {
    var n = istanbulWeekday();
    var e = TOKEN_KEY + "_" + n;
    var rand = "";
    for (var i = 0; i < 6; i++) rand += (Math.random() + 1).toString(36)[2];
    var t = {};
    for (i = 0; i < rand.length; i++) t[i] = rand.charAt(i);
    return xorHex(JSON.stringify(t), e);
  }

  function apiHeaders() {
    return {
      "User-Agent": UA,
      "Cf-Control": cfControl(),
      "device": "browser",
      "user-session": "",
      "user-profile": "",
      "language": "tr",
      "site": "main",
      "Accept": "application/json"
    };
  }

  // ------------------------------------------------------------------ TMDB

  function tmdbInfo(tmdbId, isTv, apiKey) {
    var path = isTv ? "tv" : "movie";
    var url = "https://api.themoviedb.org/3/" + path + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(apiKey) +
      "&language=tr-TR&append_to_response=alternative_titles";
    return fetchText(url, { "User-Agent": UA, Accept: "application/json" }).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || d.success === false) return null;

      var main = isTv ? (d.name || "") : (d.title || "");
      var original = isTv ? (d.original_name || "") : (d.original_title || "");
      var altList = (d.alternative_titles && (isTv ? d.alternative_titles.results : d.alternative_titles.titles)) || [];
      var altTitles = [];
      for (var i = 0; i < altList.length && altTitles.length < 6; i++) {
        var t = altList[i] && altList[i].title;
        if (t && norm(t) !== norm(main) && altTitles.indexOf(t) === -1) altTitles.push(t);
      }

      return {
        title: main,
        original: original,
        alternatives: altTitles,
        year: String((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4)
      };
    });
  }

  // -------------------------------------------------------------- searching

  function searchSite(query) {
    var url = API + "/page/search?value=" + encodeURIComponent(query);
    return fetchText(url, apiHeaders()).then(function (txt) {
      if (!txt) return [];
      var d;
      try { d = JSON.parse(txt); } catch (e) { return []; }
      var list = (d && d.page && d.page.data) || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it || !it.ID) continue;
        out.push({ id: String(it.ID), name: it.name || "", type: it.type || "" });
      }
      return out;
    });
  }

  function getBySef(slug) {
    var url = API + "/anime/get?id=" + encodeURIComponent(slug);
    return fetchText(url, apiHeaders()).then(function (txt) {
      if (!txt) return null;
      var d;
      try { d = JSON.parse(txt); } catch (e) { return null; }
      if (!d || !d.success || !d.data || !d.data.ID) return null;
      return { id: String(d.data.ID), name: d.data.name || "", type: d.data.type || "" };
    });
  }

  function matchScore(itemTitle, title) {
    if (!itemTitle || !title) return 0;
    if (itemTitle === title) return 12;
    if (itemTitle.indexOf(title) !== -1 || title.indexOf(itemTitle) !== -1) return 7;
    var words = title.split(" ").filter(function (w) { return w.length > 2; });
    if (!words.length) return 0;
    for (var i = 0; i < words.length; i++) {
      if (itemTitle.indexOf(words[i]) === -1) return 0;
    }
    return 4;
  }

  function score(item, titles) {
    var best = 0;
    var itemTitle = norm(item.name);
    for (var i = 0; i < titles.length; i++) {
      var t = norm(titles[i]);
      if (!t) continue;
      var s = matchScore(itemTitle, t);
      if (s > best) best = s;
    }
    return best;
  }

  function pickBest(items, titles) {
    var best = null, bestScore = 0;
    for (var i = 0; i < (items || []).length; i++) {
      var s = score(items[i], titles);
      if (s > bestScore) { bestScore = s; best = items[i]; }
    }
    return best;
  }

  var NON_LATIN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function findTarget(titles, isTv) {
    var latin = [], other = [];
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (!t) continue;
      if (NON_LATIN_RE.test(t)) other.push(t); else latin.push(t);
    }
    var ordered = latin.concat(other).slice(0, 6);

    function searchAll(idx, best) {
      if (idx >= ordered.length) {
        if (best) return Promise.resolve(best);
        return trySef(0, null);
      }
      return searchSite(ordered[idx]).then(function (items) {
        var item = pickBest(items, titles);
        if (item) {
          var s = score(item, titles);
          if (!best || s > score(best, titles)) best = item;
          if (s >= 7) return best;
        }
        return searchAll(idx + 1, best);
      });
    }

    function trySef(idx, found) {
      if (found) return Promise.resolve(found);
      if (idx >= ordered.length) return Promise.resolve(null);
      var slug = slugify(ordered[idx]);
      if (!slug) return trySef(idx + 1, null);
      return getBySef(slug).then(function (item) {
        return trySef(idx + 1, item || null);
      });
    }

    return searchAll(0, null);
  }

  // --------------------------------------------------------------- sources

  function fetchSource(id, isTv, s, e, token) {
    var url = API + "/anime/source?id=" + encodeURIComponent(id) +
      "&site=main&plan=" +
      (isTv ? "&season=" + s + "&episode=" + e : "") +
      "&server=1";
    return fetchText(url, {
      "User-Agent": UA,
      "Cf-Control": token,
      "language": "tr",
      "user": ""
    }).then(function (txt) {
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    });
  }

  function qualityLabel(q) {
    var n = parseInt(q, 10);
    if (isNaN(n)) return String(q || "Auto");
    if (n >= 2000) return "4K";
    if (n >= 1400) return "1440p";
    if (n >= 1000) return "1080p";
    if (n >= 700) return "720p";
    if (n >= 450) return "480p";
    return n + "p";
  }

  function qRank(q) {
    var n = parseInt(q, 10);
    return isNaN(n) ? 0 : n;
  }

  function buildSubtitles(subs) {
    var out = [], seen = {};
    for (var i = 0; i < (subs || []).length; i++) {
      var s = subs[i];
      if (!s || !s.link) continue;
      var lang = s.group || "und";
      if (seen[lang]) continue;
      seen[lang] = true;
      out.push({ url: s.link, language: lang, name: s.name || lang, lang: lang });
    }
    return out;
  }

  function buildStreams(data, display, id) {
    var groups = (data && data.groups) || [];
    var subs = buildSubtitles((data && data.subtitles) || []);
    var out = [], seen = {};

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var items = g.items || [];
      var audio = g.name || g.group || "";
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (!it || !it.link) continue;
        if (seen[it.link]) continue;
        seen[it.link] = true;
        var q = qualityLabel(it.quality);
        var isM3u8 = /\.m3u8($|\?)/i.test(it.link) || it.type === "hls";
        out.push({
          name: "Anizium - " + audio + " " + q,
          title: display + " | " + q + " | " + audio + (isM3u8 ? " [HLS]" : " [MP4]"),
          url: it.link,
          quality: q,
          isM3u8: isM3u8,
          type: isM3u8 ? "hls" : "mp4",
          language: "tr",
          provider: "anizium",
          headers: { "User-Agent": UA, Referer: ADMIN + "/", Origin: ADMIN },
          subtitles: subs,
          behaviorHints: { bingeGroup: "anizium-" + id }
        });
      }
    }

    out.sort(function (a, b) { return qRank(b.quality) - qRank(a.quality); });
    return out;
  }

  // -------------------------------------------------------------- getStreams

  function getStreams(tmdbId, mediaType, season, episode, settings) {
    var tag = "[anizium]";
    var isTv = mediaType === "tv" || mediaType === "series";
    var s = parseInt(season, 10) || 1;
    var e = parseInt(episode, 10) || 1;
    var apiKey = getTmdbKey(settings);
    var sourceToken = getSourceToken(settings);

    return tmdbInfo(tmdbId, isTv, apiKey).then(function (info) {
      if (!info || !info.title) {
        console.log(tag + " TMDB bilgisi alinamadi");
        return [];
      }

      var titles = [info.title, info.original].concat(info.alternatives || []);
      titles = titles.filter(function (t, i) { return t && titles.indexOf(t) === i; });

      console.log(tag + " Araniyor: " + titles.join(" | ") + (info.year ? " (" + info.year + ")" : ""));

      return findTarget(titles, isTv).then(function (target) {
        if (!target) {
          console.log(tag + " Sayfa bulunamadi");
          return [];
        }

        var id = target.id;
        var display = (target.name || info.title) + (info.year ? " (" + info.year + ")" : "");
        if (isTv) display += " S" + s + "E" + e;
        console.log(tag + " Kaynak: " + id + " (" + target.type + ")");

        return fetchSource(id, isTv, s, e, sourceToken).then(function (data) {
          if (!data || !data.success) {
            console.log(tag + " Kaynak yanitisi gecersiz");
            return [];
          }
          var streams = buildStreams(data, display, id);
          console.log(tag + " Kaynak bulundu: " + streams.length + " kaynak");
          return streams;
        });
      });
    }).catch(function (err) {
      console.log(tag + " Hata: " + (err && err.message));
      return [];
    });
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
