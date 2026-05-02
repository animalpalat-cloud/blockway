/* global self, clients, caches */
"use strict";

/**
 * Proxy Service Worker — intercepts "leaked" same-origin asset requests
 * and reroutes them through /proxy?url=...
 *
 * How assets leak:
 *   The proxied page loads at /proxy?url=https://example.com
 *   A script does: fetch('/api/data') — resolved to https://yoursite.com/api/data
 *   But the SW knows the page's "real" origin is https://example.com
 *   So it rewrites to /proxy?url=https://example.com/api/data
 *
 * What we DON'T intercept (bypass list):
 *   - /_next/* (Next.js framework assets)
 *   - /proxy?url=* (already proxied)
 *   - /api/* (proxy API endpoints)
 *   - /sw.js, /pwa.js (this file itself)
 */

const PROXY_PATH = "/proxy";
const BYPASS_PREFIXES = [
  "/_next/",
  "/api/",
  "/__next",
];
const BYPASS_EXACT = new Set(["/sw.js", "/pwa.js", "/manifest.json", "/favicon.ico"]);

const ASSET_EXT_RE =
  /\.(?:avif|bmp|css|eot|gif|ico|jpeg|jpg|js|json|m3u8|m4a|m4s|mp3|mp4|ogg|otf|png|svg|ttf|txt|wasm|webm|webp|woff2?|xml)(?:$|\?)/i;

const SW_VERSION = "v4";
const CACHE_NAME = `proxy-sw-${SW_VERSION}`;

// ─── Install & Activate ───────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  // Skip waiting so the new SW activates immediately
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      // Claim all clients so the SW takes effect immediately
      self.clients.claim(),
      // Clean up old cache versions
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("proxy-sw-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      ),
    ])
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isProxyRequest(url) {
  return (
    url.pathname === PROXY_PATH ||
    url.pathname.startsWith(PROXY_PATH + "/")
  );
}

function isBypass(url) {
  if (url.origin !== self.location.origin) return true;
  if (BYPASS_EXACT.has(url.pathname)) return true;
  for (const prefix of BYPASS_PREFIXES) {
    if (url.pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Given a client's URL (e.g. /proxy?url=https://example.com/page),
 * extract the proxied target URL.
 */
function fromProxyTarget(clientUrl) {
  try {
    const u = new URL(clientUrl);
    const raw = u.searchParams.get("url");
    if (!raw) return null;
    return new URL(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/**
 * An asset request that arrived at the proxy origin without /proxy?url=...
 * path. This means the JS on the page made a relative request that resolved
 * to the proxy server instead of the target server.
 */
function shouldReroute(url) {
  if (url.origin !== self.location.origin) return false;
  if (isProxyRequest(url)) return false;
  if (isBypass(url)) return false;
  // Reroute if it's a known asset extension or has a query string
  return ASSET_EXT_RE.test(url.pathname) || url.search.length > 1;
}

// ─── Fetch handler ────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET requests — POST/etc. are API calls, not asset loads
  if (req.method !== "GET") return;

  const reqUrl = new URL(req.url);

  // Fast exit for requests we should not intercept
  if (!shouldReroute(reqUrl)) return;

  event.respondWith(handleFetch(event, req, reqUrl));
});

async function handleFetch(event, req, reqUrl) {
  // Find the client (page) that made this request to determine its proxy context
  let currentTarget = null;

  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) currentTarget = fromProxyTarget(client.url);
  }

  // Also check resultingClientId (for navigation requests)
  if (!currentTarget && event.resultingClientId) {
    const client = await self.clients.get(event.resultingClientId);
    if (client) currentTarget = fromProxyTarget(client.url);
  }

  if (!currentTarget) {
    // No proxy context — pass through normally
    return fetch(req);
  }

  // Build the real target URL: resolve the relative path against the proxied origin
  const targetAssetUrl = new URL(
    reqUrl.pathname + reqUrl.search,
    currentTarget.origin + "/"
  );

  // Build the proxied URL
  const proxied = new URL(PROXY_PATH, self.location.origin);
  proxied.searchParams.set("url", targetAssetUrl.toString());
  proxied.searchParams.set("ref", currentTarget.toString());

  // Build clean request headers (strip SW/Next.js internal headers)
  const headers = new Headers(req.headers);
  headers.delete("x-middleware-subrequest");
  headers.delete("x-nextjs-data");
  headers.delete("x-next-router-prefetch");

  try {
    return await fetch(
      new Request(proxied.toString(), {
        method:      "GET",
        headers,
        mode:        "same-origin",
        credentials: "include",
        redirect:    "follow",
        cache:       "no-store",
      })
    );
  } catch (err) {
    // On failure, fall back to original request
    console.warn("[proxy-sw] Failed to proxy asset, falling back:", reqUrl.pathname, err);
    return fetch(req);
  }
}

// ─── Message handler (for manual cache clearing) ──────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data && event.data.type === "CLEAR_CACHE") {
    caches.delete(CACHE_NAME);
  }
});
