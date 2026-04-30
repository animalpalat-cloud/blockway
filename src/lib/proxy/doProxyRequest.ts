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
import * as https from "https";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const CORS_ALLOW_METHODS = "GET, POST, HEAD";
const CORS_ALLOW_HEADERS =
  "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer";
const CORS_EXPOSE_HEADERS =
  "x-proxy-final-url, content-type, x-proxy-cookie-replay, x-proxy-render";

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
  resHeaders.delete("content-length");
  resHeaders.delete("content-encoding");
  const res = new NextResponse(new Uint8Array(body), { status, headers: resHeaders });
  attachSessionCookie(res, sessionId);
  return res;
}

export async function doProxy(
  request: NextRequest,
  targetUrlStr: string,
  method: "GET" | "POST" | "HEAD" = "GET",
): Promise<NextResponse> {
  const sessionId = getSessionId(request);

  const parsed = normalizeUrl(targetUrlStr);
  if (!parsed) {
    // #region agent log
    fetch("http://127.0.0.1:7485/ingest/18796190-1e32-40e9-8ca0-68b2c2dd4451", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "caef94" },
      body: JSON.stringify({
        sessionId: "caef94",
        runId: "run1",
        hypothesisId: "H1",
        location: "src/lib/proxy/doProxyRequest.ts:doProxy",
        message: "normalizeUrl returned null",
        data: { targetUrlStrSample: String(targetUrlStr).slice(0, 260), method },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return json("Invalid URL.", 400, sessionId);
  }
  if (isBlockedTarget(parsed)) {
    return json("Target URL is blocked for security reasons.", 403, sessionId);
  }

  const jarHost = parsed.hostname;
  const documentReferer = safeDocumentRefererParam(
    request.nextUrl.searchParams.get("ref"),
  );
  const maxBytes = MAX_SIZE_MB * 1024 * 1024;
  const apiLike = isApiLikeRequest(request, parsed);

  if (method === "GET" && shouldRenderHtmlWithPuppeteer(request, parsed)) {
    try {
      const r = await renderWithPuppeteer(
        parsed,
        request.headers,
        sessionId,
        jarHost,
        documentReferer,
      );
      absorbPuppeteerCookies(sessionId, r.cookies);
      const out = Buffer.from(rewriteHtml(r.html, r.finalUrl, false), "utf-8");
      if (out.length > maxBytes) {
        return json("Response too large.", 413, sessionId);
      }
      return buildPuppeteerProxyResponse(out, {
        status: r.status,
        sessionId,
        jarHost,
        finalUrl: r.finalUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Puppeteer render failed.";
      console.error("[proxy] Puppeteer failed, falling back to fetch:", msg);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  let upstream: Response;
  const headers = buildUpstreamRequestHeaders(
    request.headers,
    parsed,
    { sessionId, jarHost, documentReferer },
  );

  try {
    const reqBody =
      method === "POST"
        ? Buffer.from(await request.arrayBuffer())
        : undefined;

    if (apiLike || method === "POST") {
      // #region agent log
      fetch("http://127.0.0.1:7485/ingest/18796190-1e32-40e9-8ca0-68b2c2dd4451", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "caef94" },
        body: JSON.stringify({
          sessionId: "caef94",
          runId: "run1",
          hypothesisId: "H3",
          location: "src/lib/proxy/doProxyRequest.ts:upstreamFetch",
          message: "about to call RapidAPI upstream",
          data: {
            method,
            apiLike,
            url: parsed.toString().slice(0, 260),
            hasBody: !!reqBody,
            bodyBytes: reqBody ? reqBody.length : 0,
            referer: headers.get("referer"),
            origin: headers.get("origin"),
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    }

    // Call RapidAPI bypass-akamai-cloudflare endpoint
    upstream = await new Promise<Response>((resolve, reject) => {
      const rapidApiOptions = {
        method: 'POST',
        hostname: 'bypass-akamai-cloudflare.p.rapidapi.com',
        port: null,
        path: '/paid/akamai',
        headers: {
          'x-rapidapi-key': '1c527b6cbfmshd48e2f54850385bp1730d3jsnea2a99dd803b',
          'x-rapidapi-host': 'bypass-akamai-cloudflare.p.rapidapi.com',
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      };

      const req = https.request(rapidApiOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const resBody = Buffer.concat(chunks);
          
          // Relay the response headers from RapidAPI
          const resHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) {
              if (Array.isArray(value)) {
                value.forEach(v => resHeaders.append(key, v));
              } else {
                resHeaders.set(key, value);
              }
            }
          }

          // Build a Response object to remain compatible with existing logic
          resolve(new Response(resBody, {
            status: res.statusCode || 200,
            headers: resHeaders
          }));
        });
      });

      req.on('error', (err) => reject(err));

      req.write(JSON.stringify({
        url: parsed.toString(),
        method,
        headers: Object.fromEntries(headers.entries()),
        payload: reqBody ? reqBody.toString('base64') : {}, // Encode body if present
        proxy: '',
        impersonate: 'chrome120'
      }));
      req.end();
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

  const cl = Number(upstream.headers.get("content-length") ?? 0);
  if (cl && cl > maxBytes) {
    return json("Response too large.", 413, sessionId);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl = upstream.url || parsed.toString();
  const hasBody = method !== "HEAD";
  const buf = hasBody
    ? Buffer.from(await upstream.arrayBuffer())
    : Buffer.alloc(0);
  if (buf.length > maxBytes) {
    return json("Response too large.", 413, sessionId);
  }

  const ct = contentType.toLowerCase();
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml+xml");
  const isCss = ct.includes("text/css");
  if (isCss) {
    const cssProbe = buf.toString("utf-8", 0, Math.min(buf.length, 8_192));
    if (/url\((["']?)\/(?:icons|xh-desktop|flags)[^)]*\)/i.test(cssProbe)) {
      // #region agent log
      fetch("http://127.0.0.1:7485/ingest/18796190-1e32-40e9-8ca0-68b2c2dd4451", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "caef94" },
        body: JSON.stringify({
          sessionId: "caef94",
          runId: "run1",
          hypothesisId: "H2",
          location: "src/lib/proxy/doProxyRequest.ts:cssProbe",
          message: "css contains root-relative asset URLs",
          data: { finalUrl: finalUrl.slice(0, 260), cssSample: cssProbe.slice(0, 320) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    }
  }
  const sniffHtml =
    (!apiLike && isHtml) ||
    (!apiLike && ct.includes("text/plain") && /^\s*</.test(buf.toString("utf-8", 0, 512)));

  let body: Buffer = buf;
  if (hasBody && sniffHtml) {
    body = Buffer.from(rewriteHtml(buf.toString("utf-8"), finalUrl, true), "utf-8");
  } else if (hasBody && isCss) {
    // Rewrite root-relative CSS asset URLs so they stay inside /proxy routing.
    body = Buffer.from(rewriteCss(buf.toString("utf-8"), finalUrl), "utf-8");
  }
  if (apiLike && upstream.status >= 400) {
    // #region agent log
    fetch("http://127.0.0.1:7485/ingest/18796190-1e32-40e9-8ca0-68b2c2dd4451", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "caef94" },
      body: JSON.stringify({
        sessionId: "caef94",
        runId: "run1",
        hypothesisId: "H4",
        location: "src/lib/proxy/doProxyRequest.ts:apiError",
        message: "api-like upstream returned error",
        data: {
          status: upstream.status,
          contentType: contentType.slice(0, 120),
          finalUrl: finalUrl.slice(0, 260),
          bodySample: buf.toString("utf-8", 0, 320),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  });

  if (!apiLike && sniffHtml) {
    resHeaders.set("content-type", "text/html; charset=utf-8");
  } else if (!apiLike && isCss) {
    resHeaders.set("content-type", "text/css; charset=utf-8");
  }
  if (!resHeaders.get("x-proxy-render")) {
    resHeaders.set("x-proxy-render", "fetch");
  }
  // Never forward CSP: proxied + injected assets must be allowed
  resHeaders.delete("content-security-policy");
  resHeaders.delete("content-security-policy-report-only");

  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  applyCorsHeaders(resHeaders);
  resHeaders.set("x-proxy-final-url", finalUrl);
  resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sessionId, jarHost) ? "1" : "0");
  resHeaders.delete("content-length");
  resHeaders.delete("content-encoding");

  const res = new NextResponse(
    new Uint8Array(body),
    { status: upstream.status, headers: resHeaders },
  );
  attachSessionCookie(res, sessionId);
  return res;
}
