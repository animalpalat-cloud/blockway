/**
 * Injected into proxied <head>. Routes http(s) / ws(s) fetches, fixes URLs that were
 * mis-resolved to `https://<targetHost>/proxy?url=...` (because of <base href> on the
 * target origin), and patches the DOM and common URL/network APIs.
 */
export function buildClientRuntimePatch(targetOrigin: string): string {
  const O = JSON.stringify(targetOrigin);
  // One IIFE, mostly string-built so the HTML embed stays safe and compact.
  return `(function () {
  "use strict";
  var O = ${O};
  var U0 = window.URL;
  if (typeof U0 === "undefined") return;

  var mainLoc = window.location;
  var P = mainLoc && mainLoc.origin ? mainLoc.origin : "";
  var Oi = (function () {
    try { return new U0(O + "/").origin; } catch (e) { return O.replace(/\\/$/, ""); }
  })();

  function isSkip(s) {
    if (s == null) return true;
    var t = String(s).trim().toLowerCase();
    if (!t) return true;
    if (t[0] === "#") return true;
    if (t.indexOf("data:") === 0 || t.indexOf("javascript:") === 0) return true;
    if (t.indexOf("mailto:") === 0 || t.indexOf("tel:") === 0 || t.indexOf("about:") === 0) return true;
    return t.indexOf("blob:") === 0;
  }

  function targetPSH() {
    try {
      var sp = new U0(mainLoc.href).searchParams;
      var raw = sp.get("url");
      if (raw) {
        var t = new U0(decodeURIComponent(raw));
        return { p: t.pathname, s: t.search, h: t.hash, ok: true };
      }
    } catch (e1) {}
    return { p: mainLoc.pathname, s: mainLoc.search, h: mainLoc.hash, ok: false };
  }

  function targetHrefForLocation() {
    var x = targetPSH();
    var b = (function () {
      try { return new U0(O + "/"); } catch (e2) { return null; }
    })();
    if (!b) return O + x.p + x.s + x.h;
    return b.origin + x.p + x.s + x.h;
  }

  function baseUrl() {
    if (typeof document === "undefined") return O + "/";
    var el = document.querySelector("base[href]");
    if (el) {
      try { return el.href; } catch (e3) {}
    }
    return O + "/";
  }

  function isAlreadyProxied(s) {
    if (typeof s !== "string") return false;
    if (s.indexOf("/proxy?url=") === 0) return true;
    if (P && s.indexOf(P + "/proxy?url=") === 0) return true;
    if (typeof mainLoc !== "undefined" && mainLoc && mainLoc.origin) {
      try {
        var a = new U0(s, mainLoc.href);
        if (a.origin === mainLoc.origin && a.pathname.indexOf("/proxy") === 0 && a.searchParams.get("url")) {
          return true;
        }
      } catch (e4) {}
    }
    return false;
  }

  /** e.g. new URL("/proxy?url=...", "https://target/") -> https://target/proxy?... */
  function fixBaseMisresolvedProxy(x) {
    if (!P || !x) return x;
    try {
      if (x.origin === Oi) {
        if (x.pathname === "/proxy" || x.pathname.indexOf("/proxy/") === 0) {
          if (x.search && x.search.indexOf("url=") >= 0) {
            return new U0(P + x.pathname + x.search + (x.hash || ""));
          }
        }
      }
    } catch (e5) {}
    return x;
  }

  function p(u) {
    if (u == null || u === "") return u;
    if (isSkip(String(u))) return u;
    if (isAlreadyProxied(String(u))) return u;
    var s = String(u);
    var r = mainLoc && mainLoc.href ? mainLoc.href : O + "/";
    try {
      var x = /^[a-zA-Z][a-zA-Z+.-]*:/.test(s) ? new U0(s) : new U0(s, baseUrl());
      x = fixBaseMisresolvedProxy(x) || x;
      var okP =
        x.protocol === "http:" || x.protocol === "https:" || x.protocol === "ws:" || x.protocol === "wss:";
      if (!okP) return u;
      if (isAlreadyProxied(x.href)) return x.href;
      if (P && x.origin === Oi && (x.pathname === "/proxy" || x.pathname.indexOf("/proxy/") === 0) && x.search && x.search.indexOf("url=") >= 0) {
        return P + x.pathname + x.search + (x.hash || "");
      }
      return "/proxy?url=" + encodeURIComponent(x.href) + "&ref=" + encodeURIComponent(r);
    } catch (e6) {
      return u;
    }
  }

  var URL1 = function (input, base) {
    var u = base !== undefined ? new U0(input, base) : new U0(input);
    return fixBaseMisresolvedProxy(u) || u;
  };
  try {
    URL1.prototype = U0.prototype;
    Object.setPrototypeOf(URL1, U0);
    for (var k in U0) {
      if (U0.hasOwnProperty(k) && !URL1[k]) {
        try { URL1[k] = U0[k]; } catch (e8) {}
      }
    }
    if (U0.createObjectURL) URL1.createObjectURL = U0.createObjectURL.bind(U0);
    if (U0.revokeObjectURL) URL1.revokeObjectURL = U0.revokeObjectURL.bind(U0);
    if (U0.canParse) URL1.canParse = U0.canParse.bind(U0);
    if (U0.parse) URL1.parse = U0.parse.bind(U0);
    window.URL = URL1;
  } catch (e9) {
    // keep native URL; p() and fetch still cover most cases
  }

  function srcsetP(v) {
    return String(v)
      .split(",")
      .map(function (part) {
        var a = part.trim().split(/\\s+/);
        var u0 = a[0];
        if (!u0) return part;
        var nu = p(u0);
        return a.length > 1 ? nu + " " + a.slice(1).join(" ") : nu;
      })
      .join(", ");
  }

  if (typeof window !== "undefined" && typeof window.fetch === "function") {
    var f0 = window.fetch;
    window.fetch = function (i, init) {
      if (typeof i === "string") return f0.call(this, p(i), init);
      if (typeof Request !== "undefined" && i && typeof i === "object" && i instanceof Request) {
        var u2 = p(i.url);
        if (u2 === i.url) return f0.call(this, i, init);
        return f0.call(
          this,
          new Request(u2, {
            method: i.method,
            headers: i.headers,
            body: i.body,
            mode: i.mode,
            credentials: i.credentials,
            cache: i.cache,
            redirect: i.redirect,
            referrer: i.referrer,
            integrity: i.integrity,
            keepalive: i.keepalive,
            signal: i.signal,
            referrerPolicy: i.referrerPolicy
          }),
          init
        );
      }
      return f0.call(this, i, init);
    };
  }

  if (window.XMLHttpRequest) {
    var o = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      var a = [].slice.call(arguments);
      if (typeof a[1] === "string") a[1] = p(a[1]);
      return o.apply(this, a);
    };
  }

  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    var sb0 = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, data) {
      return sb0(p(String(u)), data);
    };
  }

  if (typeof WebSocket !== "undefined") {
    var Ws0 = WebSocket;
    var Ws1 = function (url, proto) {
      if (url instanceof U0) return new Ws0(p(url.href), proto);
      if (typeof url === "string") return new Ws0(p(url), proto);
      return new Ws0(url, proto);
    };
    Ws1.prototype = Ws0.prototype;
    Ws1.CONNECTING = Ws0.CONNECTING;
    Ws1.OPEN = Ws0.OPEN;
    Ws1.CLOSING = Ws0.CLOSING;
    Ws1.CLOSED = Ws0.CLOSED;
    window.WebSocket = Ws1;
  }

  if (typeof Image !== "undefined") {
    var Img0 = Image;
    var Im = function (w, h) {
      return typeof w === "number" || h !== undefined ? new Img0(w, h) : new Img0();
    };
    Im.prototype = Img0.prototype;
    window.Image = Im;
  }

  if (window.history) {
    var psh = history.pushState, rst = history.replaceState;
    var tOrigin = (function () {
      try { return new U0(O + "/").origin; } catch (eA) { return null; }
    })();
    history.pushState = function (st, ti, ur) {
      if (typeof ur === "string" && ur) {
        try {
          var u2 = new U0(ur, O + "/");
          if (tOrigin && u2.origin === tOrigin) ur = p(u2.href);
        } catch (eB) {}
      }
      return psh.apply(this, arguments);
    };
    history.replaceState = function (st, ti, ur) {
      if (typeof ur === "string" && ur) {
        try {
          var u3 = new U0(ur, O + "/");
          if (tOrigin && u3.origin === tOrigin) ur = p(u3.href);
        } catch (eC) {}
      }
      return rst.apply(this, arguments);
    };
  }

  var patch = function (proto, nam) {
    if (!proto) return;
    try {
      var d = Object.getOwnPropertyDescriptor(proto, nam);
      if (!d || !d.set || !d.get) return;
      var oset = d.set, oget = d.get;
      Object.defineProperty(proto, nam, {
        configurable: true,
        enumerable: d.enumerable,
        get: function () { return oget.call(this); },
        set: function (v) {
          return oset.call(this, nam === "srcset" || nam === "imagesrcset" ? srcsetP(v) : p(String(v)));
        }
      });
    } catch (x) {}
  };
  if (typeof HTMLImageElement !== "undefined") {
    patch(HTMLImageElement.prototype, "src");
    patch(HTMLImageElement.prototype, "srcset");
  }
  if (typeof HTMLScriptElement !== "undefined") patch(HTMLScriptElement.prototype, "src");
  if (typeof HTMLIFrameElement !== "undefined") patch(HTMLIFrameElement.prototype, "src");
  if (typeof HTMLSourceElement !== "undefined") {
    patch(HTMLSourceElement.prototype, "src");
    patch(HTMLSourceElement.prototype, "srcset");
  }
  if (typeof HTMLVideoElement !== "undefined") patch(HTMLVideoElement.prototype, "src");
  if (typeof HTMLAudioElement !== "undefined") patch(HTMLAudioElement.prototype, "src");
  if (typeof HTMLEmbedElement !== "undefined") patch(HTMLEmbedElement.prototype, "src");
  if (typeof HTMLTrackElement !== "undefined") patch(HTMLTrackElement.prototype, "src");
  if (typeof HTMLObjectElement !== "undefined") patch(HTMLObjectElement.prototype, "data");
  if (typeof HTMLInputElement !== "undefined") patch(HTMLInputElement.prototype, "src");
  if (typeof HTMLLinkElement !== "undefined") patch(HTMLLinkElement.prototype, "href");
  if (typeof HTMLAnchorElement !== "undefined") patch(HTMLAnchorElement.prototype, "href");
  if (typeof HTMLFormElement !== "undefined") patch(HTMLFormElement.prototype, "action");
  if (typeof HTMLAreaElement !== "undefined") patch(HTMLAreaElement.prototype, "href");
  if (typeof Element !== "undefined" && Element.prototype.setAttribute) {
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      n = String(n);
      if (v != null) {
        if (
          /^(src|href|action|formaction|srcset|imagesrcset|poster|data)$/i.test(n) ||
          (n.indexOf("data-") === 0 && /src|href|url|set/i.test(n))
        ) {
          v = /^srcset$/i.test(n) || /imagesrcset/i.test(n) ? srcsetP(String(v)) : p(String(v));
        }
      }
      return sa.call(this, n, v);
    };
  }
  if (typeof Worker !== "undefined") {
    var W0 = Worker;
    window.Worker = function (u, opt) {
      if (u instanceof U0) return new W0(p(u.href), opt);
      if (typeof u === "string") return new W0(p(u), opt);
      return new W0(u, opt);
    };
    window.Worker.prototype = W0.prototype;
  }
  if (typeof SharedWorker !== "undefined") {
    var SW0 = SharedWorker;
    window.SharedWorker = function (u, o) {
      if (u instanceof U0) return new SW0(p(u.href), o);
      if (typeof u === "string") return new SW0(p(u), o);
      return new SW0(u, o);
    };
    try { window.SharedWorker.prototype = SW0.prototype; } catch (eS) {}
  }
  if (typeof window.EventSource !== "undefined" && EventSource.prototype) {
    var E0 = EventSource, Ev1 = function (u, cfg) {
      if (u instanceof U0) return new E0(p(u.href), cfg);
      if (typeof u === "string") return new E0(p(u), cfg);
      return new E0(u, cfg);
    };
    Ev1.prototype = E0.prototype;
    window.EventSource = Ev1;
  }

  try {
    if (Location && Location.prototype) {
      var tBase = (function () {
        try { return new U0(O + "/"); } catch (eL) { return null; }
      })();
      if (tBase) {
        var propMap = { hostname: 1, host: 1, origin: 1, port: 1, protocol: 1, pathname: 1, search: 1, hash: 1, href: 1 };
        Object.keys(propMap).forEach(function (name) {
          try {
            var d0 = Object.getOwnPropertyDescriptor(Location.prototype, name);
            if (!d0 || !d0.get) return;
            var og = d0.get, os = d0.set;
            Object.defineProperty(Location.prototype, name, {
              configurable: true,
              get: function () {
                if (this === mainLoc) {
                  if (name === "hostname") return tBase.hostname;
                  if (name === "host") return tBase.host;
                  if (name === "origin") return tBase.origin;
                  if (name === "port") return tBase.port;
                  if (name === "protocol") return tBase.protocol;
                  if (name === "pathname" || name === "search" || name === "hash" || name === "href") {
                    var t = targetPSH();
                    if (name === "href") return targetHrefForLocation();
                    if (name === "pathname") return t.p;
                    if (name === "search") return t.s;
                    if (name === "hash") return t.h;
                  }
                }
                return og.call(this);
              },
              set: os
                ? function (v) {
                    if (this === mainLoc) return os.call(this, p(String(v)));
                    return os.call(this, v);
                  }
                : undefined
            });
          } catch (eM) {}
        });
        if (Location && Location.prototype.assign) {
          var la0 = Location.prototype.assign;
          Location.prototype.assign = function (u) { return la0.call(this, p(String(u))); };
        }
        if (Location && Location.prototype.replace) {
          var lr0 = Location.prototype.replace;
          Location.prototype.replace = function (u) { return lr0.call(this, p(String(u))); };
        }
      }
    }
  } catch (eLoc) {}

  try {
    if (P) {
      Object.defineProperty(window, "origin", { configurable: true, get: function () { return Oi; } });
    }
  } catch (eW) {}
  try {
    var tBase2 = new U0(O + "/");
    var domHost = tBase2.hostname;
    if (domHost) {
      Object.defineProperty(document, "domain", {
        configurable: true,
        get: function () { return domHost; },
        set: function () { /* no-op: assignment could throw */ }
      });
    }
  } catch (eD) {}
  try {
    var docHref = (function () {
      var t = targetPSH();
      var tb = (function () { try { return new U0(O + "/").origin; } catch (e) { return ""; } })();
      if (t.ok && tb) return tb + t.p + t.s + t.h;
      return String(mainLoc.href);
    })();
    Object.defineProperty(document, "URL", { configurable: true, get: function () { return docHref; } });
    Object.defineProperty(document, "documentURI", { configurable: true, get: function () { return docHref; } });
  } catch (eDoc) {}

  var moR = 0;
  var ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, data: 1, srcset: 1, imagesrcset: 1, cite: 1, background: 1, form: 1 };
  function runMoAttr(el) {
    if (moR > 0) return;
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (!a) continue;
      var n = a.name, v = a.value;
      if (!v) continue;
      var l = n.toLowerCase();
      if (ATTRS[l] || (l.indexOf("data-") === 0 && /src|href|url|set/i.test(l)) || l === "xlink:href") {
        var nv = /srcset$|imagesrcset$/.test(l) ? srcsetP(v) : p(v);
        if (nv !== v) {
          try {
            ++moR;
            el.setAttribute(n, nv);
            --moR;
            return;
          } catch (eN) { --moR; }
        }
      }
    }
  }
  function runMoNode(root) {
    if (!root) return;
    if (root.nodeType === 1) {
      if (root.tagName === "A" && root.hasAttribute("href")) runMoAttr(root);
      if (root.tagName === "FORM" && root.hasAttribute("action")) runMoAttr(root);
      if (
        (root.tagName === "IMG" && root.hasAttribute("src")) ||
        (root.tagName === "SCRIPT" && root.hasAttribute("src")) ||
        (root.tagName === "IFRAME" && root.hasAttribute("src")) ||
        (root.tagName === "LINK" && root.hasAttribute("href")) ||
        (root.tagName === "SOURCE" && (root.hasAttribute("src") || root.hasAttribute("srcset")))
      ) {
        runMoAttr(root);
      }
    }
    var c = root.children || root.childNodes, j;
    for (j = 0; c && j < c.length; j++) runMoNode(c[j]);
  }
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    new MutationObserver(function (recs) {
      var i, r, j, n, el;
      for (i = 0; i < recs.length; i++) {
        r = recs[i];
        if (r.type === "attributes" && r.target) runMoAttr(r.target);
        if (r.type === "childList" && r.addedNodes) {
          for (j = 0; j < r.addedNodes.length; j++) {
            n = r.addedNodes[j];
            runMoNode(n);
          }
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  }

  if (Node && Node.prototype) {
    var aCh = Node.prototype.appendChild, iBef = Node.prototype.insertBefore, rC = Node.prototype.replaceChild;
    if (aCh) {
      Node.prototype.appendChild = function (n) {
        if (n && n.nodeType === 1) runMoNode(n);
        return aCh.apply(this, arguments);
      };
    }
    if (iBef) {
      Node.prototype.insertBefore = function (n, ref) {
        if (n && n.nodeType === 1) runMoNode(n);
        return iBef.apply(this, arguments);
      };
    }
    if (rC) {
      Node.prototype.replaceChild = function (n, o) {
        if (n && n.nodeType === 1) runMoNode(n);
        return rC.apply(this, arguments);
      };
    }
  }

  if (window.webkitURL) {
    try { window.webkitURL = window.URL; } catch (eWk) {}
  }

  document.addEventListener("click", function (e) {
    var t = e.target, n = 0;
    while (t && t.tagName !== "A" && n++ < 14) t = t.parentNode;
    if (!t || t.tagName !== "A") return;
    var h = t.getAttribute("href");
    if (!h || h[0] === "#") return;
    try {
      var w = new U0(t.href, mainLoc.href);
      if (w.protocol === "http:" || w.protocol === "https:") {
        e.preventDefault();
        e.stopImmediatePropagation && e.stopImmediatePropagation();
        mainLoc.assign(p(w.href));
      }
    } catch (b) {}
  }, !0);
}());
`.replace(/<\s*\/\s*script/gi, "<\\\\/script");
}
