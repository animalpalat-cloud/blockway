import { type NextRequest, NextResponse } from "next/server";
import {
  absorbPuppeteerCookies,
  absorbSetCookieHeaders,
  cookieHeaderForHost,
  newSessionId,
} from "./cookieJar";
import { rewriteHtml } from "./rewriteHtml";
import { rewriteCss } from "./rewriteCss";
import { renderWithPuppeteer } from "./puppeteerRender";
import { safeDocumentRefererParam } from "./browserHeaders";
import { STRIP_FROM_RESPONSE, buildUpstreamRequestHeaders } from "./upstreamHeaders";
import { isBlockedTarget, normalizeUrl, SESSION_COOKIE } from "./urls";
import { MAX_SIZE_MB, PROXY_TIMEOUT_MS, shouldRenderHtmlWithPuppeteer } from "./proxyConfig";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const CORS_ALLOW_METHODS = "GET, POST, HEAD, PUT, PATCH, DELETE";
const CORS_ALLOW_HEADERS =
  // Standard headers
  "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, " +
  "User-Agent, Cookie, Range, X-Requested-With, Origin, Referer, " +
  "X-Forwarded-For, DNT, Cache-Control, Pragma, " +
  // Custom headers that target sites send in preflights (x-request-id, x-client-info, etc.)
  // We must allow ALL of these or the OPTIONS preflight returns 403 and the real request fails.
  "X-Request-ID, X-Request-Id, X-Client-ID, X-Client-Info, X-Api-Key, X-Api-Version, " +
  "X-Trace-ID, X-Correlation-ID, X-Session-ID, X-User-Agent, X-Device-ID, " +
  "X-Platform, X-App-Version, X-Build-Version, X-Access-Token, X-Auth-Token, " +
  "X-CSRF-Token, X-Csrf-Token, X-Custom-Header, X-Forwarded-Host, " +
  "If-Modified-Since, If-None-Match, If-Range, If-Unmodified-Since";
const CORS_EXPOSE_HEADERS =
  "x-proxy-final-url, content-type, x-proxy-cookie-replay, x-proxy-render";

// Streaming content types — never buffer these, pass through as stream
const STREAMING_CONTENT_TYPES = [
  "video/", "audio/", "application/octet-stream",
  "application/x-mpegurl", "application/vnd.apple.mpegurl",
  "application/dash+xml", "video/mp4", "video/webm",
  "video/ogg", "audio/mpeg", "audio/ogg",
];

type HttpMethod = "GET" | "POST" | "HEAD" | "PUT" | "PATCH" | "DELETE";

/**
 * Detect if the incoming browser request is for a JSON/XHR API.
 * Only check INCOMING request headers — NEVER check the target URL path.
 * Checking the target path was wrong: it blocked /api/ routes on target sites.
 */
function isApiLikeRequest(request: NextRequest): boolean {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  // Must explicitly want JSON AND not be a navigation (navigations also accept *)
  if (accept.includes("application/json") && !accept.includes("text/html")) return true;
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) return true;
  const xhr = (request.headers.get("x-requested-with") || "").toLowerCase();
  return xhr === "xmlhttprequest";
}

function isStreamingContentType(ct: string): boolean {
  const c = ct.toLowerCase();
  return STREAMING_CONTENT_TYPES.some((t) => c.includes(t));
}

function applyCorsHeaders(headers: Headers, requestOrigin?: string): void {
  // Use specific origin when available — required for requests with credentials (withCredentials=true)
  // Using "*" with credentials causes: "wildcard not allowed when credentials mode is include"
  const origin = requestOrigin || "*";
  headers.set("access-control-allow-origin", origin);
  if (origin !== "*") {
    headers.set("access-control-allow-credentials", "true");
  }
  headers.set("access-control-allow-methods", CORS_ALLOW_METHODS);
  headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
  headers.set("access-control-max-age", "86400");
  headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  headers.set("vary", "Origin");
}

function getSessionId(request: NextRequest): string {
  return request.cookies.get(SESSION_COOKIE)?.value || newSessionId();
}

function attachSessionCookie(res: NextResponse, sessionId: string): void {
  const root = getRootDomain();
  // CRITICAL FOR SUBDOMAIN MODE:
  // Setting Domain=.daddyproxy.com makes the cookie available on ALL subdomains
  // (xhopen--com.daddyproxy.com, static--xhpingcdn--com.daddyproxy.com, etc.)
  // Without this, each subdomain would have an isolated cookie jar and the user
  // would lose their session every time a different CDN subdomain loads an asset.
  const cookieOptions: Parameters<typeof res.cookies.set>[2] = {
    path:     "/",
    maxAge:   COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "lax",
    secure:   process.env.NODE_ENV === "production",
  };
  if (root) {
    // Leading dot means the cookie is sent to all subdomains
    (cookieOptions as Record<string, unknown>)["domain"] = `.${root}`;
  }
  res.cookies.set(SESSION_COOKIE, sessionId, cookieOptions);
}

function errorJson(message: string, status: number, sessionId: string, origin?: string): NextResponse {
  const res = NextResponse.json({ error: message }, { status });
  applyCorsHeaders(res.headers, origin);
  attachSessionCookie(res, sessionId);
  return res;
}

/**
 * Build a streaming pass-through response for media content.
 * This handles Range requests for video seeking without buffering the entire file.
 */
function buildStreamingResponse(
  upstream: Response,
  sessionId: string,
  finalUrl: string,
): NextResponse {
  const resHeaders = new Headers();

  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (STRIP_FROM_RESPONSE.has(k)) return;
    // Forward these streaming-critical headers
    if (["content-type", "content-range", "accept-ranges", "content-length",
         "last-modified", "etag", "x-content-duration", "cache-control"].includes(k)) {
      resHeaders.set(key, value);
    }
  });

  const reqOrigin = request.headers.get("origin") ?? undefined;
  applyCorsHeaders(resHeaders, reqOrigin);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-render", "stream");
  resHeaders.delete("content-security-policy");
  resHeaders.delete("content-security-policy-report-only");

  const res = new NextResponse(upstream.body, {
    status:  upstream.status,
    headers: resHeaders,
  });
  attachSessionCookie(res, sessionId);
  return res;
}

function buildPuppeteerProxyResponse(
  body: Buffer,
  options: { status: number; sessionId: string; jarHost: string; finalUrl: string },
): NextResponse {
  const { status, sessionId, jarHost, finalUrl } = options;
  const resHeaders = new Headers();
  resHeaders.set("content-type", "text/html; charset=utf-8");
  resHeaders.set("x-proxy-render", "puppeteer");
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  const reqOrigin = request.headers.get("origin") ?? undefined;
  applyCorsHeaders(resHeaders, reqOrigin);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sessionId, jarHost) ? "1" : "0");
  const res = new NextResponse(new Uint8Array(body), { status, headers: resHeaders });
  attachSessionCookie(res, sessionId);
  return res;
}

export async function doProxy(
  request: NextRequest,
  targetUrlStr: string,
  method: HttpMethod = "GET",
): Promise<NextResponse> {
  const sessionId = getSessionId(request);

  const parsed = normalizeUrl(targetUrlStr);
  if (!parsed) return errorJson("Invalid URL.", 400, sessionId);
  if (isBlockedTarget(parsed)) {
    return errorJson("Target URL is blocked for security reasons.", 403, sessionId);
  }

  const jarHost = parsed.hostname;

  // Extract ref param — unwrap proxy URL if needed (safeDocumentRefererParam handles this)
  const rawRef = request.nextUrl.searchParams.get("ref") ??
    (() => {
      const raw = request.url;
      const qi = raw.indexOf("?");
      if (qi === -1) return null;
      const qs = raw.slice(qi + 1);
      for (const part of qs.split("&")) {
        if (part.startsWith("ref=")) {
          try { return decodeURIComponent(part.slice(4)); } catch { return part.slice(4); }
        }
      }
      return null;
    })();

  const documentReferer = safeDocumentRefererParam(rawRef);
  const maxBytes = MAX_SIZE_MB * 1024 * 1024;
  const apiLike = isApiLikeRequest(request);

  // Puppeteer render path (JS-heavy sites)
  if (method === "GET" && !apiLike && shouldRenderHtmlWithPuppeteer(request, parsed)) {
    try {
      const r = await renderWithPuppeteer(
        parsed, request.headers, sessionId, jarHost, documentReferer,
      );
      absorbPuppeteerCookies(sessionId, r.cookies);
      const out = Buffer.from(rewriteHtml(r.html, r.finalUrl, false), "utf-8");
      if (out.length > maxBytes) return errorJson("Response too large.", 413, sessionId);
      return buildPuppeteerProxyResponse(out, {
        status: r.status, sessionId, jarHost, finalUrl: r.finalUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Puppeteer render failed.";
      console.error("[proxy] Puppeteer failed, falling back to fetch:", msg);
    }
  }

  // Standard fetch path
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  const upstreamHeaders = buildUpstreamRequestHeaders(
    request.headers, parsed, { sessionId, jarHost, documentReferer },
  );

  // Forward Range header for video seeking
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) upstreamHeaders.set("range", rangeHeader);

  let upstream: Response;
  try {
    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await request.arrayBuffer();
    }

    upstream = await fetch(parsed.toString(), {
      method,
      redirect: "follow",
      signal:   controller.signal,
      headers:  upstreamHeaders,
      body,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return errorJson("Request timed out.", 504, sessionId);
    }
    const msg = err instanceof Error ? err.message : "Could not reach target URL.";
    return errorJson(msg, 502, sessionId);
  }
  clearTimeout(timer);

  absorbSetCookieHeaders(sessionId, jarHost, upstream.headers);

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl = upstream.url || parsed.toString();

  // ── STREAMING path: for media/video, pass through without buffering ───────
  if (isStreamingContentType(contentType) && upstream.body) {
    return buildStreamingResponse(upstream, sessionId, finalUrl);
  }

  // ── Buffered path: for HTML/CSS/JS/JSON ──────────────────────────────────
  const cl = Number(upstream.headers.get("content-length") ?? 0);
  if (cl && cl > maxBytes) return errorJson("Response too large.", 413, sessionId);

  const hasBody = method !== "HEAD";

  // Read body once — this prevents the "Response body already used" error
  // that happens when site JS tries to response.clone() after we've consumed it.
  // Our fetch patch never consumes the upstream body; only we do here.
  const buf = hasBody
    ? Buffer.from(await upstream.arrayBuffer())
    : Buffer.alloc(0);

  if (buf.length > maxBytes) return errorJson("Response too large.", 413, sessionId);

  const ct = contentType.toLowerCase();
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml+xml");
  const isCss  = ct.includes("text/css");

  const sniffHtml =
    (!apiLike && isHtml) ||
    (!apiLike && ct.includes("text/plain") && /^\s*</.test(buf.toString("utf-8", 0, 512)));

  let responseBody: Buffer = buf;
  if (hasBody && sniffHtml) {
    responseBody = Buffer.from(rewriteHtml(buf.toString("utf-8"), finalUrl, true), "utf-8");
  } else if (hasBody && isCss) {
    responseBody = Buffer.from(rewriteCss(buf.toString("utf-8"), finalUrl), "utf-8");
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  });

  if (!apiLike && sniffHtml) resHeaders.set("content-type", "text/html; charset=utf-8");
  else if (!apiLike && isCss) resHeaders.set("content-type", "text/css; charset=utf-8");

  resHeaders.set("x-proxy-render", "fetch");
  resHeaders.delete("content-security-policy");
  resHeaders.delete("content-security-policy-report-only");
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  resHeaders.delete("age");
  resHeaders.delete("expires");

  const reqOrigin = request.headers.get("origin") ?? undefined;
  applyCorsHeaders(resHeaders, reqOrigin);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sessionId, jarHost) ? "1" : "0");

  // Remove these — body is rewritten/differently sized
  resHeaders.delete("content-length");
  resHeaders.delete("content-encoding");
  resHeaders.delete("transfer-encoding");

  const res = new NextResponse(
    new Uint8Array(responseBody),
    { status: upstream.status, headers: resHeaders },
  );
  attachSessionCookie(res, sessionId);
  return res;
}
