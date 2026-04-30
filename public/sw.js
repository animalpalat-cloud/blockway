/* global self, clients */
"use strict";

const PROXY_PATH = "/proxy";
const ASSET_EXT_RE =
  /\.(?:avif|bmp|css|eot|gif|ico|jpeg|jpg|js|json|m3u8|m4a|m4s|mp3|mp4|ogg|otf|png|svg|ttf|txt|wasm|webm|webp|woff2?|xml)(?:$|\?)/i;

function isProxyRequest(url) {
  return url.pathname === PROXY_PATH || url.pathname.startsWith(`${PROXY_PATH}/`);
}

function fromProxyTarget(clientUrl) {
  try {
    const u = new URL(clientUrl);
    const raw = u.searchParams.get("url");
    if (!raw) return null;
    const target = new URL(decodeURIComponent(raw));
    return target;
  } catch {
    return null;
  }
}

function shouldHandleLeakedSameOriginAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (isProxyRequest(url)) return false;
  if (url.pathname.startsWith("/_next/")) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname === "/sw.js") return false;
  return ASSET_EXT_RE.test(url.pathname) || !!url.search;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const reqUrl = new URL(req.url);
  if (!shouldHandleLeakedSameOriginAsset(reqUrl)) return;

  event.respondWith(
    (async () => {
      const client = event.clientId ? await clients.get(event.clientId) : null;
      const currentTarget = client ? fromProxyTarget(client.url) : null;
      if (!currentTarget) {
        return fetch(req);
      }

      const targetAssetUrl = new URL(`${reqUrl.pathname}${reqUrl.search}`, currentTarget.href);
      const proxied = new URL(PROXY_PATH, self.location.origin);
      proxied.searchParams.set("url", targetAssetUrl.toString());
      proxied.searchParams.set("ref", currentTarget.toString());

      const headers = new Headers(req.headers);
      headers.delete("x-middleware-subrequest");
      headers.delete("x-nextjs-data");

      return fetch(
        new Request(proxied.toString(), {
          method: "GET",
          headers,
          mode: "same-origin",
          credentials: "include",
          redirect: "follow",
          cache: "no-store",
        }),
      );
    })(),
  );
});