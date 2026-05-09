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
  "X-Request-ID, X-Request-Id, X-Client-ID, X-Client-Info, X-Api-Key, " +
  "X-CSRF-Token, X-Csrf-Token, X-Access-Token, X-Auth-Token, " +
  "If-Modified-Since, If-None-Match, If-Range, If-Unmodified-Since";
const CORS_EXPOSE_HEADERS =
  "x-proxy-final-url, content-type, x-proxy-cookie-replay, x-proxy-render";

// ONLY real media goes through streaming — everything else is buffered
// so we can inspect and unwrap IPRoyal wrappers
const STREAMING_TYPES = [
  "video/", "audio/",
  "application/x-mpegurl", "application/vnd.apple.mpegurl",
  "application/dash+xml",
];

type HttpMethod = "GET" | "POST" | "HEAD" | "PUT" | "PATCH" | "DELETE";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isApiLike(request: NextRequest): boolean {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) return true;
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return true;
  return (request.headers.get("x-requested-with") || "").toLowerCase() === "xmlhttprequest";
}

function isStreaming(ct: string): boolean {
  const c = ct.toLowerCase();
  return STREAMING_TYPES.some((t) => c.includes(t));
}

function applyCorHeaders(headers: Headers, origin?: string): void {
  const o = origin || "*";
  headers.set("access-control-allow-origin", o);
  if (o !== "*") headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", CORS_ALLOW_METHODS);
  headers.set("access-control-allow-headers", CORS_ALLOW_HEADERS);
  headers.set("access-control-max-age", "86400");
  headers.set("access-control-expose-headers", CORS_EXPOSE_HEADERS);
  headers.set("vary", "Origin");
}

function stripSecurityHeaders(headers: Headers): void {
  // These headers break proxying — must always be removed
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");        // Allows YouTube/Facebook to render in proxy
  headers.delete("x-content-type-options");
  headers.delete("strict-transport-security");
  headers.delete("alt-svc");               // Prevents QUIC/HTTP3 issues
}

function getSession(request: NextRequest): string {
  return request.cookies.get(SESSION_COOKIE)?.value || newSessionId();
}

function setSessionCookie(res: NextResponse, sid: string): void {
  const root = getRootDomain();
  const opts: Parameters<typeof res.cookies.set>[2] = {
    path: "/", maxAge: COOKIE_MAX_AGE, httpOnly: true,
    sameSite: "lax", secure: process.env.NODE_ENV === "production",
  };
  if (root) (opts as Record<string, unknown>)["domain"] = `.${root}`;
  res.cookies.set(SESSION_COOKIE, sid, opts);
}

function errResponse(msg: string, status: number, sid: string, origin?: string): NextResponse {
  const res = NextResponse.json({ error: msg }, { status });
  applyCorHeaders(res.headers, origin);
  setSessionCookie(res, sid);
  return res;
}

// ─── IPRoyal Response Normalizer ──────────────────────────────────────────────
//
// IPRoyal Unblocker can return responses in MULTIPLE formats:
//
// FORMAT 1 — Normal response (most sites):
//   Content-Type: text/html / application/javascript / etc.
//   Body: actual content directly
//
// FORMAT 2 — HTML-wrapped response (YouTube JS, some APIs):
//   Content-Type: text/plain
//   Body: <html><head>...</head><body><pre style="...">HTML_ENCODED_CONTENT</pre></body></html>
//   The actual content is HTML-entity-encoded inside <pre>
//
// FORMAT 3 — Double-wrapped (rare):
//   Same as Format 2 but the <pre> content is wrapped again
//
// This function normalizes ALL formats into the actual content.

function normalizeIPRoyalResponse(raw: Buffer): { buf: Buffer; wasWrapped: boolean } {
  // Quick check — only process if starts with <html
  const start = raw.slice(0, 10).toString("utf-8").trimStart().toLowerCase();
  if (!start.startsWith("<html")) {
    return { buf: raw, wasWrapped: false };
  }

  const str = raw.toString("utf-8");

  // Try to extract content from <pre> tag (IPRoyal wrapper pattern)
  const preMatch = str.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!preMatch || !preMatch[1]) {
    // Has <html> but no <pre> — this IS the actual HTML page, not a wrapper
    // Only treat as wrapper if it has the specific IPRoyal meta tags
    const hasIPRoyalMeta = str.includes('name="referrer"') &&
                           str.includes('name="viewport"') &&
                           str.includes("word-wrap: break-word");
    if (!hasIPRoyalMeta) return { buf: raw, wasWrapped: false };
    return { buf: raw, wasWrapped: false };
  }

  // Check if this looks like an IPRoyal wrapper
  // (has their specific meta tags OR the pre has HTML-encoded content)
  const preContent = preMatch[1];
  const hasHTMLEntities = preContent.includes("&lt;") ||
                          preContent.includes("&amp;") ||
                          preContent.includes("&gt;");

  const hasIPRoyalSignature = str.includes('name="referrer"') ||
                              str.includes('name="color-scheme"') ||
                              str.includes("word-wrap: break-word");

  if (!hasIPRoyalSignature && !hasHTMLEntities) {
    // Regular HTML page, not a wrapper
    return { buf: raw, wasWrapped: false };
  }

  // Decode HTML entities from the <pre> content
  const decoded = preContent
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x60;/g, "`")
    .replace(/&#x3D;/g, "=");

  console.log("[proxy] Unwrapped IPRoyal HTML wrapper, decoded length:", decoded.length);
  return { buf: Buffer.from(decoded, "utf-8"), wasWrapped: true };
}

// ─── What content type does the request expect? ───────────────────────────────
function detectRequestedType(request: NextRequest): "js" | "css" | "html" | "other" {
  const url = request.nextUrl.searchParams.get("url") || request.nextUrl.pathname;
  if (/\.(js|mjs|jsx)(\?|$|#|&)/.test(url)) return "js";
  if (/\.css(\?|$|#|&)/.test(url)) return "css";
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (accept.includes("text/html")) return "html";
  return "other";
}

// ─── Streaming response builder ───────────────────────────────────────────────
function buildStreamResponse(
  upstream: Response, sid: string, finalUrl: string, origin?: string,
): NextResponse {
  const h = new Headers();
  upstream.headers.forEach((v, k) => {
    const kl = k.toLowerCase();
    if (!STRIP_FROM_RESPONSE.has(kl) &&
        ["content-type","content-range","accept-ranges","content-length",
         "last-modified","etag","cache-control"].includes(kl)) {
      h.set(k, v);
    }
  });
  applyCorHeaders(h, origin);
  stripSecurityHeaders(h);
  h.set("x-proxy-final-url", finalUrl);
  h.set("x-proxy-render", "stream");
  const res = new NextResponse(upstream.body, { status: upstream.status, headers: h });
  return res;
}

// ─── Main proxy function ──────────────────────────────────────────────────────
export async function doProxy(
  request: NextRequest,
  targetUrlStr: string,
  method: HttpMethod = "GET",
): Promise<NextResponse> {
  const sid = getSession(request);
  const origin = request.headers.get("origin") ?? undefined;
  const requestedType = detectRequestedType(request);

  const parsed = normalizeUrl(targetUrlStr);
  if (!parsed) return errResponse("Invalid URL.", 400, sid);
  if (isBlockedTarget(parsed)) return errResponse("Target blocked.", 403, sid);

  const jarHost = parsed.hostname;
  const rawRef = request.nextUrl.searchParams.get("ref") ?? null;
  const documentReferer = safeDocumentRefererParam(rawRef);
  const maxBytes = MAX_SIZE_MB * 1024 * 1024;
  const apiLike = isApiLike(request);

  // ── Puppeteer path ──────────────────────────────────────────────────────────
  if (method === "GET" && !apiLike && shouldRenderHtmlWithPuppeteer(request, parsed)) {
    try {
      const r = await renderWithPuppeteer(parsed, request.headers, sid, jarHost, documentReferer);
      absorbPuppeteerCookies(sid, r.cookies);
      const out = Buffer.from(rewriteHtml(r.html, r.finalUrl, false, request.url), "utf-8");
      if (out.length > maxBytes) return errResponse("Response too large.", 413, sid);
      const h = new Headers();
      h.set("content-type", "text/html; charset=utf-8");
      h.set("x-proxy-render", "puppeteer");
      h.set("cache-control", "no-store");
      applyCorHeaders(h, origin);
      h.set("x-proxy-final-url", r.finalUrl);
      const res = new NextResponse(new Uint8Array(out), { status: r.status, headers: h });
      setSessionCookie(res, sid);
      return res;
    } catch (err) {
      console.error("[proxy] Puppeteer failed:", err instanceof Error ? err.message : err);
    }
  }

  // ── Fetch path ──────────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  const upstreamHeaders = buildUpstreamRequestHeaders(
    request.headers, parsed, { sessionId: sid, jarHost, documentReferer },
  );
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) upstreamHeaders.set("range", rangeHeader);

  let upstream: Response;
  try {
    let bodyData: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      bodyData = await request.arrayBuffer();
    }
    upstream = await fetchWithRotation(parsed.toString(), {
      method,
      redirect: "follow",
      signal:   controller.signal,
      headers:  upstreamHeaders,
      body:     bodyData,
      // @ts-ignore
      cache:    "no-store",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return errResponse("Request timed out.", 504, sid);
    }
    return errResponse(err instanceof Error ? err.message : "Fetch failed.", 502, sid);
  }
  clearTimeout(timer);

  absorbSetCookieHeaders(sid, jarHost, upstream.headers);

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl    = upstream.url || parsed.toString();

  // ── Streaming path (real media only) ────────────────────────────────────────
  if (isStreaming(contentType) && upstream.body) {
    const res = buildStreamResponse(upstream, sid, finalUrl, origin);
    setSessionCookie(res, sid);
    return res;
  }

  // ── Buffer the response ─────────────────────────────────────────────────────
  const cl = Number(upstream.headers.get("content-length") ?? 0);
  if (cl > maxBytes) return errResponse("Response too large.", 413, sid);

  const hasBody = method !== "HEAD";
  let buf: Buffer = hasBody
    ? Buffer.from(await upstream.arrayBuffer())
    : Buffer.alloc(0);

  if (buf.length > maxBytes) return errResponse("Response too large.", 413, sid);

  // ── STEP 1: Return empty stub for blocked JS/CSS ────────────────────────────
  // Prevents "Unexpected token '<'" — browser gets empty JS instead of HTML error
  if (upstream.status >= 400) {
    if (requestedType === "js") {
      const res = new NextResponse(`/* proxy: ${upstream.status} */`, {
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
      applyCorHeaders(res.headers, origin);
      setSessionCookie(res, sid);
      return res;
    }
    if (requestedType === "css") {
      const res = new NextResponse(`/* proxy: ${upstream.status} */`, {
        status: 200,
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
      });
      applyCorHeaders(res.headers, origin);
      setSessionCookie(res, sid);
      return res;
    }
  }

  // ── STEP 2: Unwrap IPRoyal HTML wrapper ─────────────────────────────────────
  // Handles ALL IPRoyal wrapper formats — see normalizeIPRoyalResponse() above
  if (hasBody && buf.length > 0) {
    const { buf: unwrapped, wasWrapped } = normalizeIPRoyalResponse(buf);
    if (wasWrapped) buf = unwrapped;
  }

  // ── STEP 3: Detect actual content type after unwrapping ─────────────────────
  const ct = contentType.toLowerCase();
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml+xml");
  const isCss  = ct.includes("text/css");
  const isJs   = ct.includes("javascript") || ct.includes("ecmascript");

  // After unwrapping, check if content actually looks like HTML
  const preview = buf.slice(0, 512).toString("utf-8");
  const contentIsHtml = /^\s*(<!(DOCTYPE|doctype)\s+html|<html[\s>]|<head[\s>])/.test(preview);

  // Sniff HTML: trust content-type OR detect from content
  // But NEVER treat JS/CSS URLs as HTML even if content-type says text/plain
  const sniffHtml =
    (!apiLike && isHtml) ||
    (!apiLike && requestedType !== "js" && requestedType !== "css" &&
     ct.includes("text/plain") && contentIsHtml);

  // ── STEP 4: Force correct content-type for JS requests ─────────────────────
  // If URL was for JS but IPRoyal returned text/plain, treat as JS
  const treatAsJs  = requestedType === "js"  || isJs;
  const treatAsCss = requestedType === "css" || isCss;

  // ── STEP 5: Rewrite content ─────────────────────────────────────────────────
  let responseBody: Buffer = buf;
  if (hasBody && sniffHtml) {
    responseBody = Buffer.from(
      rewriteHtml(buf.toString("utf-8"), finalUrl, true, request.url),
      "utf-8",
    );
  } else if (hasBody && treatAsCss && !sniffHtml) {
    responseBody = Buffer.from(rewriteCss(buf.toString("utf-8"), finalUrl), "utf-8");
  }
  // JS: pass through as-is (already unwrapped in step 2)

  // ── STEP 6: Build response ──────────────────────────────────────────────────
  const resHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!STRIP_FROM_RESPONSE.has(k.toLowerCase())) resHeaders.set(k, v);
  });

  // Set correct content-type
  if (sniffHtml)       resHeaders.set("content-type", "text/html; charset=utf-8");
  else if (treatAsCss) resHeaders.set("content-type", "text/css; charset=utf-8");
  else if (treatAsJs)  resHeaders.set("content-type", "application/javascript; charset=utf-8");

  // Strip ALL headers that block proxying
  stripSecurityHeaders(resHeaders);

  resHeaders.set("x-proxy-render", "fetch");
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  resHeaders.delete("age");
  resHeaders.delete("expires");
  resHeaders.delete("content-length");
  resHeaders.delete("content-encoding");
  resHeaders.delete("transfer-encoding");

  applyCorHeaders(resHeaders, origin);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sid, jarHost) ? "1" : "0");

  const res = new NextResponse(new Uint8Array(responseBody), {
    status: upstream.status,
    headers: resHeaders,
  });
  setSessionCookie(res, sid);
  return res;
}