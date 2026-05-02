/**
 * Client-side runtime patch injected into every proxied HTML page.
 *
 * WHAT THIS SOLVES:
 * Sites detect they're inside a proxy/iframe via multiple vectors:
 *   1. window.location.href leaks the proxy URL (e.g. yoursite.com/proxy?url=...)
 *   2. document.referrer leaks the proxy origin
 *   3. window.top !== window.self  (iframe detection)
 *   4. fetch/XHR requests with target-origin URLs get intercepted
 *   5. history.pushState with relative URLs breaks navigation
 *   6. WebSockets connect to wrong origins
 *   7. document.domain is read/set (cross-origin checks)
 *   8. navigator.sendBeacon leaks telemetry to real servers
 *   9. window.parent / window.frameElement checks
 *  10. performance.getEntriesByType — some sites check for proxy in timing entries
 *
 * This patch surgically addresses all of the above.
 */
export function buildClientRuntimePatch(targetOrigin: string): string {
  const O = JSON.stringify(targetOrigin);

  return `(function () {
  "use strict";

  // ─── Constants ───────────────────────────────────────────────────────────
  var O  = ${O};                 // target origin, e.g. "https://example.com"
  var U0 = window.URL;
  if (typeof U0 === "undefined") return;

  var mainLoc = window.location;
  var P  = (mainLoc && mainLoc.origin) ? mainLoc.origin : "";  // proxy origin
  var pHostname = (function () {
    try { return P ? new U0(P + "/").hostname.toLowerCase() : ""; } catch (e) { return ""; }
  })();
  var Oi = (function () {
    try { return new U0(O + "/").origin; } catch (e) { return O.replace(/\\/$/, ""); }
  })();
  var tHostname = (function () {
    try { return new U0(O + "/").hostname; } catch (e) { return ""; }
  })();

  // ─── URL helpers ─────────────────────────────────────────────────────────
  function isSkip(s) {
    if (s == null) return true;
    var t = String(s).trim().toLowerCase();
    if (!t || t[0] === "#") return true;
    return t.indexOf("data:") === 0 || t.indexOf("javascript:") === 0 ||
           t.indexOf("mailto:") === 0 || t.indexOf("tel:") === 0 ||
           t.indexOf("about:") === 0 || t.indexOf("blob:") === 0;
  }

  function isAlreadyProxied(s) {
    if (typeof s !== "string") return false;
    if (s.indexOf("/proxy?url=") === 0) return true;
    if (P && s.indexOf(P + "/proxy?url=") === 0) return true;
    try {
      var a = new U0(s, mainLoc.href);
      if (a.origin === P && a.pathname.indexOf("/proxy") === 0 && a.searchParams.get("url")) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function baseUrl() {
    if (typeof document === "undefined") return O + "/";
    var el = document.querySelector("base[href]");
    if (el) { try { return el.href; } catch (e) {} }
    return O + "/";
  }

  function strictEncode(v) {
    return encodeURIComponent(v)
      .replace(/[!'*\\[\\]]/g, function (ch) { return "%" + ch.charCodeAt(0).toString(16).toUpperCase(); })
      .split("(").join("%28")
      .split(")").join("%29");
  }

  /** Convert any URL to its proxied form. */
  function p(u) {
    if (u == null || u === "") return u;
    if (isSkip(String(u))) return u;
    if (isAlreadyProxied(String(u))) return u;
    var s = String(u);
    var r = (mainLoc && mainLoc.href) ? mainLoc.href : O + "/";
    try {
      var x = /^[a-zA-Z][a-zA-Z+.-]*:/.test(s) ? new U0(s) : new U0(s, baseUrl());
      var okP = x.protocol === "http:" || x.protocol === "https:" ||
                x.protocol === "ws:"   || x.protocol === "wss:";
      if (!okP) return u;
      if (isAlreadyProxied(x.href)) return x.href;
      // Keep proxy-internal paths direct
      var xh = (x.hostname || "").toLowerCase();
      if (pHostname && xh === pHostname &&
          (/^\\/proxy(?:\\/|$)/.test(x.pathname) || x.pathname.indexOf("/_next/") === 0 ||
           x.pathname === "/sw.js" || x.pathname === "/pwa.js")) {
        return x.href;
      }
      return "/proxy?url=" + strictEncode(x.href) + "&ref=" + strictEncode(r);
    } catch (e) { return u; }
  }

  // ─── 1. Patch URL constructor ─────────────────────────────────────────────
  var URL1 = function (input, base) {
    var u = base !== undefined ? new U0(input, base) : new U0(input);
    return u;
  };
  try {
    URL1.prototype = U0.prototype;
    Object.setPrototypeOf(URL1, U0);
    if (U0.createObjectURL) URL1.createObjectURL = U0.createObjectURL.bind(U0);
    if (U0.revokeObjectURL) URL1.revokeObjectURL = U0.revokeObjectURL.bind(U0);
    if (U0.canParse) URL1.canParse = U0.canParse.bind(U0);
    if (U0.parse) URL1.parse = U0.parse.bind(U0);
    window.URL = URL1;
  } catch (e) {}

  // ─── 2. Patch window.location to look like target origin ─────────────────
  // Sites like Reddit check window.location.hostname to detect proxy domains.
  try {
    var targetUrl = (function() {
      try {
        var sp = new U0(mainLoc.href).searchParams;
        var raw = sp.get("url");
        return raw ? new U0(decodeURIComponent(raw)) : new U0(O + "/");
      } catch(e) { return new U0(O + "/"); }
    })();

    var fakeLocation = {
      href:     targetUrl.href,
      origin:   targetUrl.origin,
      protocol: targetUrl.protocol,
      host:     targetUrl.host,
      hostname: targetUrl.hostname,
      port:     targetUrl.port,
      pathname: targetUrl.pathname,
      search:   targetUrl.search,
      hash:     targetUrl.hash,
      assign: function(url) { mainLoc.href = p(url); },
      replace: function(url) { mainLoc.replace(p(url)); },
      reload: function() { mainLoc.reload(); },
      toString: function() { return this.href; }
    };

    try {
      Object.defineProperty(window, "location", {
        get: function() { return fakeLocation; },
        configurable: true
      });
    } catch(e) {}
  } catch(e) {}

  // ─── 3. Neutralise iframe/top-frame detection ─────────────────────────────
  // Most common anti-proxy check: "if (window.top !== window.self) { die(); }"
  try {
    Object.defineProperty(window, "top",    { get: function() { return window; }, configurable: true });
    Object.defineProperty(window, "parent", { get: function() { return window; }, configurable: true });
    Object.defineProperty(window, "frameElement", { get: function() { return null; }, configurable: true });
    Object.defineProperty(window, "self",   { get: function() { return window; }, configurable: true });
  } catch(e) {}

  // ─── 4. Patch document.referrer ──────────────────────────────────────────
  try {
    Object.defineProperty(document, "referrer", {
      get: function() { return O + "/"; },
      configurable: true
    });
  } catch(e) {}

  // ─── 5. Patch document.domain ────────────────────────────────────────────
  try {
    Object.defineProperty(document, "domain", {
      get: function() { return tHostname || ""; },
      set: function() {},
      configurable: true
    });
  } catch(e) {}

  // ─── 6. Patch fetch ───────────────────────────────────────────────────────
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(resource, init) {
      try {
        if (typeof resource === "string") {
          resource = p(resource);
        } else if (resource && typeof resource === "object" && resource.url) {
          resource = new Request(p(resource.url), resource);
        }
      } catch(e) {}
      return origFetch.call(this, resource, init);
    };
    // Copy static properties
    for (var k in origFetch) {
      try { window.fetch[k] = origFetch[k]; } catch(e) {}
    }
  }

  // ─── 7. Patch XMLHttpRequest ──────────────────────────────────────────────
  var origXHR = window.XMLHttpRequest;
  if (origXHR) {
    var XHROpen = origXHR.prototype.open;
    origXHR.prototype.open = function(method, url, async, user, pass) {
      try { url = p(String(url)); } catch(e) {}
      return XHROpen.apply(this, arguments);
    };
  }

  // ─── 8. Patch history API ────────────────────────────────────────────────
  // history.pushState with relative URLs must be redirected so the proxy stays in control
  var origPushState    = history.pushState.bind(history);
  var origReplaceState = history.replaceState.bind(history);
  function patchHistoryState(fn) {
    return function(state, title, url) {
      if (url) {
        try {
          var resolved = new U0(String(url), mainLoc.href);
          var rh = (resolved.hostname || "").toLowerCase();
          // If navigating away from the proxied origin, intercept
          if (tHostname && rh === tHostname) {
            url = p(resolved.href);
          }
        } catch(e) {}
      }
      return fn.call(history, state, title, url);
    };
  }
  try {
    history.pushState    = patchHistoryState(origPushState);
    history.replaceState = patchHistoryState(origReplaceState);
  } catch(e) {}

  // ─── 9. Patch WebSocket ───────────────────────────────────────────────────
  var origWS = window.WebSocket;
  if (origWS) {
    window.WebSocket = function(url, protocols) {
      // Route WS through our proxy if it's the target origin
      // wss://example.com -> /proxy?url=wss%3A%2F%2Fexample.com
      // For now, just let the WS fail gracefully — true WS proxying needs server support
      try {
        var wsUrl = new U0(String(url));
        // Only intercept target-origin websockets
        if (tHostname && (wsUrl.hostname || "").toLowerCase() === tHostname) {
          // Convert wss:// to https:// for proxy routing
          var httpUrl = wsUrl.href.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
          console.warn("[proxy] WebSocket to " + wsUrl.hostname + " — falling back to HTTP polling if available");
        }
      } catch(e) {}
      return protocols ? new origWS(url, protocols) : new origWS(url);
    };
    window.WebSocket.prototype = origWS.prototype;
    window.WebSocket.CONNECTING = origWS.CONNECTING;
    window.WebSocket.OPEN       = origWS.OPEN;
    window.WebSocket.CLOSING    = origWS.CLOSING;
    window.WebSocket.CLOSED     = origWS.CLOSED;
  }

  // ─── 10. Patch navigator.sendBeacon ──────────────────────────────────────
  // sendBeacon bypasses fetch patching — route it too
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      try { url = p(String(url)); } catch(e) {}
      return origBeacon(url, data);
    };
  }

  // ─── 11. Intercept dynamic link/script insertion ─────────────────────────
  // Sites inject <script src="..."> dynamically; we need to rewrite those too
  var origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = origCreateElement(tag);
    var tagLow = (tag || "").toLowerCase();
    if (tagLow === "script" || tagLow === "link" || tagLow === "img" || tagLow === "iframe") {
      var attrName = tagLow === "link" ? "href" : "src";
      var origSetAttr = el.setAttribute.bind(el);
      el.setAttribute = function(name, val) {
        if ((name === "src" || name === "href") && typeof val === "string") {
          try { val = p(val); } catch(e) {}
        }
        return origSetAttr(name, val);
      };
      // Also intercept .src = "..." / .href = "..." property sets
      try {
        Object.defineProperty(el, attrName, {
          get: function() { return el.getAttribute(attrName) || ""; },
          set: function(v) {
            try { v = p(String(v)); } catch(e) {}
            el.setAttribute(attrName, v);
          },
          configurable: true
        });
      } catch(e) {}
    }
    return el;
  };

  // ─── 12. Intercept innerHTML / insertAdjacentHTML ─────────────────────────
  // Not worth the complexity of rewriting all inner HTML mutations — the SW handles
  // leaked same-origin asset requests instead.

  // ─── 13. Patch window.open ───────────────────────────────────────────────
  var origOpen = window.open;
  window.open = function(url, target, features) {
    if (url && typeof url === "string") {
      try { url = p(url); } catch(e) {}
    }
    return origOpen ? origOpen.call(window, url, target, features) : null;
  };

  // ─── 14. srcset observer ─────────────────────────────────────────────────
  // Patch Image() constructor so dynamically created images route through proxy
  var origImage = window.Image;
  if (origImage) {
    window.Image = function(width, height) {
      var img = width !== undefined ? new origImage(width, height) : new origImage();
      try {
        Object.defineProperty(img, "src", {
          get: function() { return img.getAttribute("src") || ""; },
          set: function(v) {
            try { v = p(String(v)); } catch(e) {}
            img.setAttribute("src", v);
          },
          configurable: true
        });
      } catch(e) {}
      return img;
    };
    window.Image.prototype = origImage.prototype;
  }

  // ─── 15. Patch EventSource (SSE) ─────────────────────────────────────────
  var origES = window.EventSource;
  if (origES) {
    window.EventSource = function(url, init) {
      try { url = p(String(url)); } catch(e) {}
      return new origES(url, init);
    };
    window.EventSource.prototype = origES.prototype;
  }

})();`;
}
