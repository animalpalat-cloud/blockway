/* global self, clients, caches */
"use strict";

/**
 * Proxy Service Worker — Updated for subdomain mode
 *
 * In SUBDOMAIN MODE (PROXY_ROOT_DOMAIN set):
 *   Pages load on: xhopen--com.daddyproxy.com
 *   Assets from xhopen.com CDNs go to: static--xhpingcdn--com.daddyproxy.com
 *   The SW's job is minimal — subdomain routing handles most assets.
 *   We mainly intercept relative-path requests that bypass subdomain rewriting.
 *
 * In QUERY-PARAM MODE:
 *   Pages load on: daddyproxy.com/proxy?url=https://xhopen.com
 *   The SW intercepts leaked asset requests (relative paths) and rerouts them.
 */

const SW_VERSION = "v5-subdomain";
const CACHE_NAME = `proxy-sw-${SW_VERSION}`;

const BYPASS_PREFIXES = ["/_next/", "/api/", "/__next"];
const BYPASS_EXACT    = new Set(["/sw.js", "/pwa.js", "/manifest.json", "/favicon.ico"]);
const ASSET_EXT_RE    =
  /\.(?:avif|bmp|css|eot|gif|ico|jpeg|jpg|js|json|m3u8|m4a|m4s|mp3|mp4|ogg|otf|png|svg|ttf|txt|wasm|webm|webp|woff2?|xml)(?:[?#]|$)/i;

self.addEventListener("install",  () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("proxy-sw-") && k !== CACHE_NAME).map((k) => caches.delete(k)))
    ),
  ]));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isBypass(url) {
  if (url.origin !== self.location.origin) return true;
  if (BYPASS_EXACT.has(url.pathname))      return true;
  return BYPASS_PREFIXES.some((p) => url.pathname.startsWith(p));
}

/**
 * Detect if this SW is running in subdomain mode by checking its own location.
 * In subdomain mode the SW is registered from xhopen--com.daddyproxy.com
 * or from daddyproxy.com — but in all cases self.location.hostname tells us.
 */
function getRootDomainFromSelf() {
  // self.location.hostname is e.g. "xhopen--com.daddyproxy.com" or "daddyproxy.com"
  // We need to recover the root domain.
  // Strategy: look for the longest suffix that doesn't contain "--"
  const h = self.location.hostname;
  const parts = h.split(".");
  // Walk from the right, collecting until we find a label with "--"
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("--")) {
      // Everything to the right of here is the root domain
      return parts.slice(i + 1).join(".");
    }
  }
  return h; // must be the root domain itself
}

function isSubdomainRequest(url) {
  const root = getRootDomainFromSelf();
  if (!root || root === url.hostname) return false;
  return url.hostname.endsWith("." + root);
}

function decodeSubdomainToHost(prefix) {
  return prefix.replace(/--/g, ".");
}

/** Extract the proxied target origin from a client URL */
function getClientTargetOrigin(clientUrl) {
  try {
    const u = new URL(clientUrl);

    // Subdomain mode: xhopen--com.daddyproxy.com → https://xhopen.com
    if (isSubdomainRequest(u)) {
      const root = getRootDomainFromSelf();
      const prefix = u.hostname.slice(0, u.hostname.length - root.length - 1);
      const host = decodeSubdomainToHost(prefix);
      return { host, origin: `${u.protocol}//${host}`, proto: u.protocol };
    }

    // Query-param mode: daddyproxy.com/proxy?url=https://xhopen.com/
    const sp = u.searchParams;
    const raw = sp.get("url");
    if (raw) {
      const target = new URL(decodeURIComponent(raw));
      return { host: target.hostname, origin: target.origin, proto: target.protocol };
    }
  } catch {}
  return null;
}

// ─── Fetch handler ────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const reqUrl = new URL(event.request.url);
  if (isBypass(reqUrl)) return;

  // In subdomain mode: if this is a direct CDN request (no --encoding in host),
  // it means it leaked from JS without our patch catching it. Reroute it.
  // If it IS a subdomain request, pass through — the server handles it.
  if (isSubdomainRequest(reqUrl)) return; // already routed correctly

  // Only intercept same-origin requests (leaked relative-path assets)
  if (reqUrl.origin !== self.location.origin) return;

  // Only intercept asset-like paths
  if (!ASSET_EXT_RE.test(reqUrl.pathname) && !reqUrl.search) return;

  event.respondWith(handleFetch(event, reqUrl));
});

async function handleFetch(event, reqUrl) {
  let clientTarget = null;

  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) clientTarget = getClientTargetOrigin(client.url);
  }
  if (!clientTarget && event.resultingClientId) {
    const client = await self.clients.get(event.resultingClientId);
    if (client) clientTarget = getClientTargetOrigin(client.url);
  }

  if (!clientTarget) return fetch(event.request);

  const root = getRootDomainFromSelf();

  let proxyUrl;
  if (root) {
    // Subdomain mode: rewrite to subdomain URL
    const { host, proto } = clientTarget;
    const encodedHost = host.replace(/\./g, "--");
    const p = proto.replace(/:$/, "");
    proxyUrl = `${p}://${encodedHost}.${root}${reqUrl.pathname}${reqUrl.search}`;
  } else {
    // Query-param mode: rewrite to /proxy?url=...
    const targetAssetUrl = `${clientTarget.origin}${reqUrl.pathname}${reqUrl.search}`;
    proxyUrl = `/proxy?url=${encodeURIComponent(targetAssetUrl)}&ref=${encodeURIComponent(clientTarget.origin)}`;
  }

  try {
    return await fetch(new Request(proxyUrl, {
      method:      "GET",
      headers:     event.request.headers,
      mode:        "same-origin",
      credentials: "include",
      redirect:    "follow",
      cache:       "no-store",
    }));
  } catch {
    return fetch(event.request);
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_CACHE")  caches.delete(CACHE_NAME);
});
