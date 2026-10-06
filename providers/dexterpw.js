/**
 * dexterpw - Built from src/dexterpw/
 * Generated: 2026-10-06T20:00:59.164Z
 */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/dexterpw/http.js
var require_http = __commonJS({
  "src/dexterpw/http.js"(exports2, module2) {
    var BASE_URL = "https://dexter.pw";
    function fetchDetails2(tmdbId, mediaType, season, episode) {
      let url = BASE_URL + "/api/" + mediaType + "/" + tmdbId + "?site=dexter";
      if (mediaType === "tv" && season && episode) {
        url += "&season=" + season + "&episode=" + episode;
      }
      return fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json"
        }
      }).then(function(res) {
        return res.json();
      });
    }
    module2.exports = { fetchDetails: fetchDetails2 };
  }
});

// src/dexterpw/extractor.js
var require_extractor = __commonJS({
  "src/dexterpw/extractor.js"(exports2, module2) {
    "use strict";
    var BASE_URL = "https://dexter.pw";
    function makeAbsoluteUrl(rawUrl) {
      if (typeof rawUrl !== "string" || !rawUrl.trim())
        return null;
      const value = rawUrl.trim();
      if (/^https?:\/\//i.test(value))
        return value;
      if (value.indexOf("//") === 0)
        return "https:" + value;
      if (value.charAt(0) === "/")
        return BASE_URL + value;
      return BASE_URL + "/" + value;
    }
    function extractStreams2(details) {
      if (!details || !Array.isArray(details.sources)) {
        return Promise.resolve([]);
      }
      const title = details.title || "Video";
      const streams = [];
      details.sources.forEach(function(source) {
        if (!source || typeof source.url !== "string")
          return;
        const url = makeAbsoluteUrl(source.url);
        if (!url)
          return;
        streams.push({
          name: "Dexter - " + (source.label || "Server"),
          title,
          url,
          quality: "Auto",
          provider: "dexter"
        });
      });
      return Promise.resolve(streams);
    }
    module2.exports = { extractStreams: extractStreams2 };
  }
});

// src/dexterpw/index.js
var import_http = __toESM(require_http());
var import_extractor = __toESM(require_extractor());
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    console.log("[Dexter] Fetching " + mediaType + " " + tmdbId);
    const details = yield (0, import_http.fetchDetails)(tmdbId, mediaType, season, episode);
    if (!details || !details.playable) {
      return [];
    }
    const streams = yield (0, import_extractor.extractStreams)(details);
    return streams;
  });
}
module.exports = { getStreams };
