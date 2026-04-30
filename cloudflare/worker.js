export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const targetParam = incomingUrl.searchParams.get("url");
    const refParam = incomingUrl.searchParams.get("ref");
    if (!targetParam) {
      return new Response("Missing ?url=", { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetParam);
    } catch {
      return new Response("Invalid target URL", { status: 400 });
    }

    const normalizedReferer = safeHttpUrl(refParam) || `${targetUrl.origin}/`;
    const refererUrl = new URL(normalizedReferer);

    const upstreamHeaders = new Headers(request.headers);
    stripProxyIdentityHeaders(upstreamHeaders);

    // Spoof browser-like request shape for anti-hotlink media/CDN endpoints.
    upstreamHeaders.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    );
    upstreamHeaders.set("referer", normalizedReferer);
    upstreamHeaders.set("origin", refererUrl.origin);
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
    responseHeaders.set("x-proxy-upstream", targetUrl.origin);

    // Stream body directly to client to support large MP4/HLS segment traffic.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

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
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
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
