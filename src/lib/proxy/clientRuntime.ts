/**
 * Client-side runtime patch — injected into every proxied HTML page.
 *
 * In SUBDOMAIN MODE (preferred):
 *   All URLs are rewritten to: https://target--com.daddyproxy.com/path
 *   This makes the browser's Host header look like the target CDN, bypassing
 *   hotlink protection. The proxy runtime intercepts JS-generated URLs too.
 *
 * In QUERY-PARAM MODE (fallback):
 *   All URLs become: /proxy?url=https%3A%2F%2Ftarget.com%2Fpath
 */
export function buildClientRuntimePatch(
  targetOrigin: string,
  opts: {
    rootDomain?: string;   // e.g. "daddyproxy.com" — set when subdomain mode active
    subdomainPrefix?: string; // e.g. "xhopen--com" — the prefix for the current page
  } = {},
): string {
  const O          = JSON.stringify(targetOrigin);                   // "https://xhopen.com"
  const ROOT       = JSON.stringify(opts.rootDomain ?? "");         // "daddyproxy.com"
  const SUB_PREFIX = JSON.stringify(opts.subdomainPrefix ?? "");    // "xhopen--com"

  return `(function () {
  "use strict";

  // ─── Config injected by server ────────────────────────────────────────────
  var _targetOrigin  = ${O};          // "https://xhopen.com"
  var _rootDomain    = ${ROOT};       // "daddyproxy.com" (empty = query-param mode)
  var _subPrefix     = ${SUB_PREFIX}; // "xhopen--com"
  var _subdomainMode = _rootDomain.length > 0;

  var _origURL = window.URL;
  if (typeof _origURL === "undefined") return;

  var _loc = window.location;
  var _proxyOrigin = (function () { try { return _loc.origin; } catch (e) { return ""; } })();
  var _proxyHost   = (function () {
    try { return new _origURL(_proxyOrigin + "/").hostname.toLowerCase(); } catch (e) { return ""; }
  })();
  var _targetHost  = (function () {
    try { return new _origURL(_targetOrigin + "/").hostname.toLowerCase(); } catch (e) { return ""; }
  })();

  // ─── Subdomain helpers ────────────────────────────────────────────────────

  /** Encode a hostname into its subdomain proxy form. dots → double dash */
  function encodeHost(h) {
    return h.toLowerCase().replace(/\\.+$/, "").replace(/\\./g, "--");
  }

  /**
   * Convert an absolute URL to its proxy form.
   * Subdomain mode:   https://cdn.example.com/img.png
   *                → https://cdn--example--com.daddyproxy.com/img.png
   * Query-param mode: → /proxy?url=https%3A%2F%2Fcdn.example.com%2Fimg.png
   */
  function toProxyUrl(abs) {
    if (_subdomainMode) {
      try {
        var u = new _origURL(abs);
        var proto = u.protocol === "http:" ? "http" : "https";
        var encoded = encodeHost(u.hostname);
        return proto + "://" + encoded + "." + _rootDomain + u.pathname + u.search + u.hash;
      } catch (e) {
        return "/proxy?url=" + encodeComponent(abs);
      }
    }
    return "/proxy?url=" + encodeComponent(abs) + "&ref=" + encodeComponent(currentRef());
  }

  /** RFC-3986 encode — also encodes ( ) ! ' * which break query strings */
  function encodeComponent(v) {
    return encodeURIComponent(String(v)).replace(/[!'()*]/g, function (c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function currentRef() {
    try { return _loc.href; } catch (e) { return _targetOrigin + "/"; }
  }

  // ─── URL classification ───────────────────────────────────────────────────

  function isSkip(s) {
    var t = (s == null ? "" : String(s)).trim().toLowerCase();
    if (!t || t[0] === "#") return true;
    return /^(data:|javascript:|mailto:|tel:|about:|blob:|chrome-extension:)/.test(t);
  }

  /** Check if a URL is already routed through our proxy (either mode) */
  function isAlreadyProxied(s) {
    if (typeof s !== "string") return false;
    // Query-param mode
    if (s.indexOf("/proxy?url=") === 0) return true;
    if (_proxyOrigin && s.indexOf(_proxyOrigin + "/proxy?url=") === 0) return true;
    // Subdomain mode — check if host ends with .rootDomain
    if (_subdomainMode) {
      try {
        var u = new _origURL(s);
        var h = u.hostname.toLowerCase();
        if (h.endsWith("." + _rootDomain) && h !== _rootDomain) return true;
        if (h === _rootDomain) return true;
      } catch (e) {}
    }
    return false;
  }

  /** Is this URL for a Next.js internal or proxy management path? */
  function isInternalPath(u) {
    var p = u.pathname;
    return p.indexOf("/_next/") === 0 || p === "/sw.js" || p === "/pwa.js" ||
           p.indexOf("/proxy") === 0  || p.indexOf("/subdomain-proxy") === 0 ||
           p.indexOf("/api/") === 0;
  }

  function baseUrl() {
    if (typeof document === "undefined") return _targetOrigin + "/";
    try {
      var el = document.querySelector("base[href]");
      if (el) return el.href;
    } catch (e) {}
    return _targetOrigin + "/";
  }

  // ─── Main proxy rewrite function ──────────────────────────────────────────

  /** The core: convert ANY URL to its proxied equivalent */
  function p(u) {
    if (u == null || u === "") return u;
    var s = String(u);
    if (isSkip(s)) return u;
    if (isAlreadyProxied(s)) return u;

    try {
      var x;
      if (/^[a-zA-Z][a-zA-Z+.-]*:\\/\\//.test(s)) {
        x = new _origURL(s);
      } else if (s.indexOf("//") === 0) {
        x = new _origURL("https:" + s);
      } else {
        x = new _origURL(s, baseUrl());
      }

      var proto = x.protocol;
      var isHttp = proto === "http:" || proto === "https:";
      var isWs   = proto === "ws:"   || proto === "wss:";
      if (!isHttp && !isWs) return u;

      // Don't proxy requests back to our own proxy infrastructure
      var xh = (x.hostname || "").toLowerCase();
      if (_proxyHost && xh === _proxyHost && isInternalPath(x)) return x.href;
      if (_subdomainMode && xh === _rootDomain && isInternalPath(x)) return x.href;

      // Already proxied after full URL resolution
      if (isAlreadyProxied(x.href)) return x.href;

      return toProxyUrl(x.href);
    } catch (e) { return u; }
  }

  // ─── 1. window.location spoofing ─────────────────────────────────────────
  try {
    var _targetUrlObj = (function () {
      try {
        // In subdomain mode, the page URL IS already the target (with encoded hostname)
        // We need to return the real target URL as location
        if (_subdomainMode) {
          // Decode our subdomain back to the real hostname
          var decoded = _loc.hostname.replace(/--/g, ".").replace(new RegExp("\\\\." + _rootDomain.replace(/\\./g, "\\\\.") + "$"), "");
          // Wait — _loc.hostname is the full subdomain.rootdomain
          // e.g. xhopen--com.daddyproxy.com
          // We need xhopen.com
          var h = _loc.hostname;
          var sfx = "." + _rootDomain;
          if (h.endsWith(sfx)) {
            var enc = h.slice(0, h.length - sfx.length);
            var realHost = enc.replace(/--/g, ".");
            return new _origURL(_loc.protocol + "//" + realHost + _loc.pathname + _loc.search + _loc.hash);
          }
        }
        // Query-param mode
        var sp = new _origURL(_loc.href).searchParams;
        var raw = sp.get("url");
        return raw ? new _origURL(decodeURIComponent(raw)) : new _origURL(_targetOrigin + "/");
      } catch (e) { return new _origURL(_targetOrigin + "/"); }
    })();

    var _fakeLoc = {
      href:     _targetUrlObj.href,
      origin:   _targetUrlObj.origin,
      protocol: _targetUrlObj.protocol,
      host:     _targetUrlObj.host,
      hostname: _targetUrlObj.hostname,
      port:     _targetUrlObj.port,
      pathname: _targetUrlObj.pathname,
      search:   _targetUrlObj.search,
      hash:     _targetUrlObj.hash,
      assign:   function (url) { _loc.assign(p(url)); },
      replace:  function (url) { _loc.replace(p(url)); },
      reload:   function ()    { _loc.reload(); },
      toString: function ()    { return this.href; }
    };
    try { Object.defineProperty(window, "location", { get: function () { return _fakeLoc; }, configurable: true }); } catch (e) {}
  } catch (e) {}

  // ─── 2. Frame detection bypass ────────────────────────────────────────────
  try { Object.defineProperty(window, "top",         { get: function () { return window; }, configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, "parent",      { get: function () { return window; }, configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, "frameElement",{ get: function () { return null;   }, configurable: true }); } catch (e) {}
  try { Object.defineProperty(window, "self",        { get: function () { return window; }, configurable: true }); } catch (e) {}

  // ─── 3. document.referrer & domain ───────────────────────────────────────
  try { Object.defineProperty(document, "referrer", { get: function () { return _targetOrigin + "/"; }, configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, "domain",   { get: function () { return _targetHost; }, set: function () {}, configurable: true }); } catch (e) {}

  // ─── 4. fetch patch ───────────────────────────────────────────────────────
  var _origFetch = window.fetch;
  if (_origFetch) {
    window.fetch = function (resource, init) {
      try {
        if (typeof resource === "string") {
          resource = p(resource);
        } else if (resource && typeof resource === "object" && typeof resource.url === "string") {
          resource = new Request(p(resource.url), resource);
        }
      } catch (e) {}
      return _origFetch.call(this, resource, init);
    };
  }

  // ─── 5. XMLHttpRequest patch ──────────────────────────────────────────────
  var _origXHR = window.XMLHttpRequest;
  if (_origXHR) {
    var _xhrOpen = _origXHR.prototype.open;
    _origXHR.prototype.open = function (method, url) {
      try { url = p(String(url)); } catch (e) {}
      var args = Array.prototype.slice.call(arguments);
      args[1] = url;
      return _xhrOpen.apply(this, args);
    };
  }

  // ─── 6. history API patch ─────────────────────────────────────────────────
  function _patchHistory(fn) {
    return function (state, title, url) {
      if (url) {
        try {
          var resolved = new _origURL(String(url), _loc.href);
          url = p(resolved.href);
        } catch (e) {}
      }
      return fn.call(history, state, title, url);
    };
  }
  try { history.pushState    = _patchHistory(history.pushState.bind(history));    } catch (e) {}
  try { history.replaceState = _patchHistory(history.replaceState.bind(history)); } catch (e) {}

  // ─── 7. navigator.sendBeacon patch ───────────────────────────────────────
  if (navigator && navigator.sendBeacon) {
    var _origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try { url = p(String(url)); } catch (e) {}
      return _origBeacon(url, data);
    };
  }

  // ─── 8. window.open ───────────────────────────────────────────────────────
  var _origWinOpen = window.open;
  if (_origWinOpen) {
    window.open = function (url, target, features) {
      if (url && typeof url === "string") { try { url = p(url); } catch (e) {} }
      return _origWinOpen.call(window, url, target, features);
    };
  }

  // ─── 9. Dynamic element creation ─────────────────────────────────────────
  var _origCreate = document.createElement.bind(document);
  document.createElement = function (tag) {
    var el = _origCreate(tag);
    var tl = (tag || "").toLowerCase();
    if (tl === "script" || tl === "img" || tl === "iframe" ||
        tl === "source"  || tl === "video" || tl === "audio" || tl === "embed") {
      _patchAttr(el, "src");
    } else if (tl === "link") {
      _patchAttr(el, "href");
    }
    return el;
  };

  function _patchAttr(el, attrName) {
    var _origSet = el.setAttribute.bind(el);
    el.setAttribute = function (name, val) {
      if ((name === "src" || name === "href" || name === "data") && typeof val === "string") {
        try { val = p(val); } catch (e) {}
      }
      return _origSet(name, val);
    };
    try {
      Object.defineProperty(el, attrName, {
        get: function () { return el.getAttribute(attrName) || ""; },
        set: function (v) { try { v = p(String(v)); } catch (e) {} el.setAttribute(attrName, v); },
        configurable: true
      });
    } catch (e) {}
  }

  // ─── 10. Image() constructor ──────────────────────────────────────────────
  var _origImage = window.Image;
  if (_origImage) {
    var _PI = function (w, h) {
      var img = w !== undefined ? (h !== undefined ? new _origImage(w, h) : new _origImage(w)) : new _origImage();
      _patchAttr(img, "src");
      return img;
    };
    _PI.prototype = _origImage.prototype;
    try { window.Image = _PI; } catch (e) {}
  }

  // ─── 11. EventSource (SSE) patch ─────────────────────────────────────────
  var _origES = window.EventSource;
  if (_origES) {
    window.EventSource = function (url, init) {
      try { url = p(String(url)); } catch (e) {}
      return init ? new _origES(url, init) : new _origES(url);
    };
    window.EventSource.prototype = _origES.prototype;
  }

  // ─── 12. WebSocket passthrough (placeholder) ─────────────────────────────
  // True WS proxying requires a separate ws:// server — not handled here.
  // We keep the original WebSocket as-is to avoid breaking sites that use WS.

  // ─── 13. CSS.paintWorklet and other non-standard loaders ─────────────────
  if (typeof CSS !== "undefined" && CSS.paintWorklet && CSS.paintWorklet.addModule) {
    var _origAddModule = CSS.paintWorklet.addModule.bind(CSS.paintWorklet);
    CSS.paintWorklet.addModule = function (url) {
      try { url = p(String(url)); } catch (e) {}
      return _origAddModule(url);
    };
  }

  // ─── 14. Expose helper for SW and inline scripts ─────────────────────────
  // Sites sometimes call new URL(relPath, location.href) to build API URLs.
  // Our location spoof handles this for most cases, but expose p() globally
  // under a non-suspicious name for cross-script use.
  try { window.__bwProxy = p; } catch (e) {}

})();`;
}
