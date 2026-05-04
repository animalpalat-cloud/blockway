/**
 * Blockway Service Worker
 *
 * CRITICAL RULES:
 * 1. Never intercept /proxy or /subdomain-proxy routes — these are our server-side handlers
 * 2. Never intercept /_next/ routes — Next.js build assets
 * 3. For subdomain requests (*.daddyproxy.com), pass through everything
 * 4. Only cache static assets on the ROOT domain
 */

const CACHE_NAME = "blockway-v2";
const STATIC_ASSETS = ["/", "/favicon.ico"];

// Paths we must NEVER intercept — they must go to server
const BYPASS_PATHS = [
  "/proxy",
  "/subdomain-proxy",
  "/api/",
  "/_next/",
  "/gen_204",
  "/xjs/",
  "/async/",
];

function shouldBypass(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname;

    // Never intercept requests to external domains
    if (!host.endsWith(".daddyproxy.com") && host !== "daddyproxy.com") {
      return true;
    }

    // Never intercept proxy routes
    for (const bp of BYPASS_PATHS) {
      if (path === bp || path.startsWith(bp)) return true;
    }

    // Never intercept subdomain requests — let them go directly to server
    if (host !== "daddyproxy.com" && host !== "www.daddyproxy.com") {
      return true;
    }

    return false;
  } catch (e) {
    return true; // If we can't parse the URL, don't intercept
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Always bypass non-GET and anything we shouldn't intercept
  if (request.method !== "GET" || shouldBypass(request.url)) {
    return; // Let browser handle it normally
  }

  // For root domain static assets only — try cache first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => {
        return new Response("Offline", { status: 503 });
      });
    })
  );
});
