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
  "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, " +
  "User-Agent, Cookie, Range, X-Requested-With, Origin, Referer, " +
  "X-Forwarded-For, DNT, Cache-Control, Pragma";
const CORS_EXPOSE_HEADERS =
  "x-proxy-final-url, content-type, x-proxy-cookie-replay, x-proxy-render";

type HttpMethod = "GET" | "POST" | "HEAD" | "PUT" | "PATCH" | "DELETE";

function isApiLikeRequest(request: NextRequest, target: URL): boolean {
  const p = target.pathname.toLowerCase();
  if (p.startsWith("/api/") || p.includes("/api/")) return true;
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (accept.includes("application/json")) return true;
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) return true;
  const xhr = (request.headers.get("x-requested-with") || "").toLowerCase();
  return xhr === "xmlhttprequest";
}

function applyCorsHeaders(headers: Headers): void {
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", CORS_ALLOW_METHODS);
  headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
  headers.set("access-control-max-age", "86400");
  headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
}

function getSessionId(request: NextRequest): string {
  return request.cookies.get(SESSION_COOKIE)?.value || newSessionId();
}

function attachSessionCookie(res: NextResponse, sessionId: string): void {
  res.cookies.set(SESSION_COOKIE, sessionId, {
    path:     "/",
    maxAge:   COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "lax",
    secure:   process.env.NODE_ENV === "production",
  });
}

function json(message: string, status: number, sessionId: string): NextResponse {
  const res = NextResponse.json({ error: message }, { status });
  applyCorsHeaders(res.headers);
  attachSessionCookie(res, sessionId);
  return res;
}

function buildPuppeteerProxyResponse(
  body: Buffer,
  options: {
    status: number;
    sessionId: string;
    jarHost: string;
    finalUrl: string;
  },
): NextResponse {
  const { status, sessionId, jarHost, finalUrl } = options;
  const resHeaders = new Headers();
  resHeaders.set("content-type", "text/html; charset=utf-8");
  resHeaders.set("x-proxy-render", "puppeteer");
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  applyCorsHeaders(resHeaders);
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
  if (!parsed) return json("Invalid URL.", 400, sessionId);
  if (isBlockedTarget(parsed)) {
    return json("Target URL is blocked for security reasons.", 403, sessionId);
  }

  const jarHost = parsed.hostname;
  const documentReferer = safeDocumentRefererParam(
    request.nextUrl.searchParams.get("ref"),
  );
  const maxBytes = MAX_SIZE_MB * 1024 * 1024;
  const apiLike = isApiLikeRequest(request, parsed);

  // Puppeteer path — for JS-heavy sites (YouTube, Reddit, etc.)
  if (method === "GET" && shouldRenderHtmlWithPuppeteer(request, parsed)) {
    try {
      const r = await renderWithPuppeteer(
        parsed, request.headers, sessionId, jarHost, documentReferer,
      );
      absorbPuppeteerCookies(sessionId, r.cookies);
      const out = Buffer.from(rewriteHtml(r.html, r.finalUrl, false), "utf-8");
      if (out.length > maxBytes) return json("Response too large.", 413, sessionId);
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

  const headers = buildUpstreamRequestHeaders(
    request.headers, parsed,
    { sessionId, jarHost, documentReferer },
  );

  let upstream: Response;
  try {
    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await request.arrayBuffer();
    }

    upstream = await fetch(parsed.toString(), {
      method,
      redirect:   "follow",
      signal:     controller.signal,
      headers,
      body,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return json("Request timed out.", 504, sessionId);
    }
    const msg = err instanceof Error ? err.message : "Could not reach target URL.";
    return json(msg, 502, sessionId);
  }
  clearTimeout(timer);

  absorbSetCookieHeaders(sessionId, jarHost, upstream.headers);

  // Check content-length early to reject oversized responses
  const cl = Number(upstream.headers.get("content-length") ?? 0);
  if (cl && cl > maxBytes) return json("Response too large.", 413, sessionId);

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl = upstream.url || parsed.toString();
  const hasBody = method !== "HEAD";
  const buf = hasBody
    ? Buffer.from(await upstream.arrayBuffer())
    : Buffer.alloc(0);

  if (buf.length > maxBytes) return json("Response too large.", 413, sessionId);

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

  // Build response headers
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  });

  // Force correct content types for rewritten resources
  if (!apiLike && sniffHtml) {
    resHeaders.set("content-type", "text/html; charset=utf-8");
  } else if (!apiLike && isCss) {
    resHeaders.set("content-type", "text/css; charset=utf-8");
  }

  resHeaders.set("x-proxy-render", "fetch");

  // Always strip CSP — our injected scripts need to run
  resHeaders.delete("content-security-policy");
  resHeaders.delete("content-security-policy-report-only");

  // Prevent downstream caching of proxied content
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  resHeaders.delete("age");
  resHeaders.delete("expires");

  applyCorsHeaders(resHeaders);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sessionId, jarHost) ? "1" : "0");

  // Must remove these — body may be rewritten/differently sized
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
