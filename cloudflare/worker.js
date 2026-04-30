export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const targetParam = incomingUrl.searchParams.get("url");
    const refParam = incomingUrl.searchParams.get("ref");
    if (!targetParam) {
      return new Response("Missing ?url=", { status: 400 });
    }

    const normalizedTarget = normalizeTargetParam(targetParam, refParam);
    if (!normalizedTarget) {
      return new Response("Invalid target URL", { status: 400 });
    }
    const targetUrl = normalizedTarget;

    const masked = buildMaskedNavigationContext(targetUrl, refParam);

    const upstreamHeaders = new Headers(request.headers);
    stripProxyIdentityHeaders(upstreamHeaders);

    // Spoof browser-like request shape for anti-hotlink media/CDN endpoints.
    upstreamHeaders.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    );
    upstreamHeaders.set("referer", masked.referer);
    upstreamHeaders.set("origin", masked.origin);
    if (!upstreamHeaders.has("accept")) {
      upstreamHeaders.set(
        "accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      );
    }

    const upstreamRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "follow",
      cf: {
        cacheEverything: false,
      },
    });

    const upstream = await fetch(upstreamRequest);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("content-security-policy-report-only");
    responseHeaders.delete("x-frame-options");
    responseHeaders.delete("frame-options");
    responseHeaders.delete("cross-origin-opener-policy");
    responseHeaders.delete("cross-origin-embedder-policy");
    responseHeaders.delete("cross-origin-resource-policy");
    responseHeaders.delete("set-cookie");
    rewriteSetCookieHeaders(upstream.headers, responseHeaders, incomingUrl.hostname);
    responseHeaders.set("x-proxy-upstream", targetUrl.origin);

    // Stream body directly to client to support large MP4/HLS segment traffic.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

function normalizeTargetParam(raw, refParam) {
  if (!raw) return null;
  const seen = new Set();
  let cur = String(raw).trim();
  if (!cur) return null;
  const safeRef = safeHttpUrl(refParam);

  // Handle double-encoded query values from nested proxy hops.
  for (let i = 0; i < 4; i += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const candidate = safeHttpUrl(cur);
    if (candidate) return new URL(candidate);
    if (safeRef) {
      try {
        const maybeRelative = new URL(cur, safeRef);
        if (maybeRelative.protocol === "http:" || maybeRelative.protocol === "https:") {
          return maybeRelative;
        }
      } catch {}
    }
    try {
      const decoded = decodeURIComponent(cur);
      if (decoded === cur) break;
      cur = decoded.trim();
    } catch {
      break;
    }
  }
  return null;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function stripProxyIdentityHeaders(headers) {
  const strip = [
    "host",
    "origin",
    "referer",
    "forwarded",
    "cf-connecting-ip",
    "cf-ew-via",
    "cf-worker",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-server",
    "x-real-ip",
    "true-client-ip",
    "cdn-loop",
    "via",
    "cf-ray",
    "cf-ipcountry",
    "x-middleware-subrequest",
    "x-nextjs-data",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
  ];
  for (const name of strip) headers.delete(name);
}

function buildMaskedNavigationContext(targetUrl, refParam) {
  const safeRef = safeHttpUrl(refParam);
  if (safeRef) {
    try {
      const ref = new URL(safeRef);
      // Keep same-site referers; otherwise mask to target origin to avoid 403 anti-hotlinking.
      if (ref.hostname === targetUrl.hostname) {
        return { referer: ref.toString(), origin: ref.origin };
      }
    } catch {}
  }
  return { referer: `${targetUrl.origin}/`, origin: targetUrl.origin };
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

function rewriteCookieForProxyHost(cookie, proxyHost) {
  let out = String(cookie);
  out = out.replace(/;\s*domain=[^;]*/gi, "");
  out = out.replace(/;\s*samesite=none/gi, "; SameSite=Lax");
  if (!/;\s*path=/i.test(out)) out += "; Path=/";
  if (!/;\s*domain=/i.test(out)) out += `; Domain=${proxyHost}`;
  return out;
}

function rewriteSetCookieHeaders(upstreamHeaders, responseHeaders, proxyHost) {
  const values = getSetCookies(upstreamHeaders);
  for (const cookie of values) {
    if (!cookie) continue;
    responseHeaders.append("set-cookie", rewriteCookieForProxyHost(cookie, proxyHost));
  }
}