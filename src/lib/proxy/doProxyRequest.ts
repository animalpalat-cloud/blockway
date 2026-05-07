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
import { getRootDomain } from "./subdomainRouter";
import { fetchWithRotation } from "./ipRotation";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const CORS_ALLOW_METHODS = "GET, POST, HEAD, PUT, PATCH, DELETE";
const CORS_ALLOW_HEADERS =
  "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, " +
  "User-Agent, Cookie, Range, X-Requested-With, Origin, Referer, " +
  "X-Forwarded-For, DNT, Cache-Control, Pragma, " +
  "X-Request-ID, X-Request-Id, X-Client-ID, X-Client-Info, X-Api-Key, X-Api-Version, " +
  "X-Trace-ID, X-Correlation-ID, X-Session-ID, X-User-Agent, X-Device-ID, " +
  "X-Platform, X-App-Version, X-Build-Version, X-Access-Token, X-Auth-Token, " +
  "X-CSRF-Token, X-Csrf-Token, X-Custom-Header, X-Forwarded-Host, " +
  "If-Modified-Since, If-None-Match, If-Range, If-Unmodified-Since";
const CORS_EXPOSE_HEADERS =
  "x-proxy-final-url, content-type, x-proxy-cookie-replay, x-proxy-render";

const STREAMING_CONTENT_TYPES = [
  "video/", "audio/", "application/octet-stream",
  "application/x-mpegurl", "application/vnd.apple.mpegurl",
  "application/dash+xml", "video/mp4", "video/webm",
  "video/ogg", "audio/mpeg", "audio/ogg",
];

type HttpMethod = "GET" | "POST" | "HEAD" | "PUT" | "PATCH" | "DELETE";

function isApiLikeRequest(request: NextRequest): boolean {
  const accept = (request.headers.get("accept") || "").toLowerCase();
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
  const cookieOptions: Parameters<typeof res.cookies.set>[2] = {
    path:     "/",
    maxAge:   COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "lax",
    secure:   process.env.NODE_ENV === "production",
  };
  if (root) {
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

function buildStreamingResponse(
  upstream: Response,
  sessionId: string,
  finalUrl: string,
  requestOrigin?: string,
): NextResponse {
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (STRIP_FROM_RESPONSE.has(k)) return;
    if (["content-type", "content-range", "accept-ranges", "content-length",
         "last-modified", "etag", "x-content-duration", "cache-control"].includes(k)) {
      resHeaders.set(key, value);
    }
  });
  applyCorsHeaders(resHeaders, requestOrigin);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-render", "stream");
  resHeaders.delete("content-security-policy");
  resHeaders.delete("content-security-policy-report-only");
  const res = new NextResponse(upstream.body, { status: upstream.status, headers: resHeaders });
  attachSessionCookie(res, sessionId);
  return res;
}

function buildPuppeteerProxyResponse(
  body: Buffer,
  options: { status: number; sessionId: string; jarHost: string; finalUrl: string; requestOrigin?: string },
): NextResponse {
  const { status, sessionId, jarHost, finalUrl, requestOrigin } = options;
  const resHeaders = new Headers();
  resHeaders.set("content-type", "text/html; charset=utf-8");
  resHeaders.set("x-proxy-render", "puppeteer");
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  applyCorsHeaders(resHeaders, requestOrigin);
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
  const requestOrigin = request.headers.get("origin") ?? undefined;

  const parsed = normalizeUrl(targetUrlStr);
  if (!parsed) return errorJson("Invalid URL.", 400, sessionId);
  if (isBlockedTarget(parsed)) {
    return errorJson("Target URL is blocked for security reasons.", 403, sessionId);
  }

  const jarHost = parsed.hostname;

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
      const out = Buffer.from(rewriteHtml(r.html, r.finalUrl, false, request.url), "utf-8");
      if (out.length > maxBytes) return errorJson("Response too large.", 413, sessionId);
      return buildPuppeteerProxyResponse(out, {
        status: r.status, sessionId, jarHost, finalUrl: r.finalUrl, requestOrigin,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Puppeteer render failed.";
      console.error("[proxy] Puppeteer failed, falling back to fetch:", msg);
    }
  }

  // Standard fetch path with auto-rotation
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  const upstreamHeaders = buildUpstreamRequestHeaders(
    request.headers, parsed, { sessionId, jarHost, documentReferer },
  );

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) upstreamHeaders.set("range", rangeHeader);

  let upstream: Response;
  try {
    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await request.arrayBuffer();
    }

    // fetchWithRotation handles: auto-retry on 403/429, Tor circuit rotation if USE_TOR=true
    upstream = await fetchWithRotation(parsed.toString(), {
      method,
      redirect: "follow",
      signal:   controller.signal,
      headers:  upstreamHeaders,
      body,
      // @ts-ignore — prevents QUIC/HTTP3 which causes ERR_QUIC_PROTOCOL_ERROR
      cache: "no-store",
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

  if (isStreamingContentType(contentType) && upstream.body) {
    return buildStreamingResponse(upstream, sessionId, finalUrl, requestOrigin);
  }

  const cl = Number(upstream.headers.get("content-length") ?? 0);
  if (cl && cl > maxBytes) return errorJson("Response too large.", 413, sessionId);

  const hasBody = method !== "HEAD";
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
    responseBody = Buffer.from(rewriteHtml(buf.toString("utf-8"), finalUrl, true, request.url), "utf-8");
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

  applyCorsHeaders(resHeaders, requestOrigin);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sessionId, jarHost) ? "1" : "0");

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
