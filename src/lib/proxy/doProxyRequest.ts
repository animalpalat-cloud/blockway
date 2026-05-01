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
import { MAX_SIZE_MB, PROXY_TIMEOUT_MS, SOCKS5_PROXY, shouldRenderHtmlWithPuppeteer } from "./proxyConfig";
import * as https from "https";
import * as http from "http";
import { SocksProxyAgent } from "socks-proxy-agent";

const socksAgent = new SocksProxyAgent(SOCKS5_PROXY);

import * as zlib from "zlib";

function decompress(buffer: Buffer, encoding: string | null): Buffer {
  if (!encoding) return buffer;
  try {
    if (encoding.includes("gzip")) return zlib.gunzipSync(buffer);
    if (encoding.includes("deflate")) return zlib.inflateSync(buffer);
    if (encoding.includes("br")) return zlib.brotliDecompressSync(buffer);
  } catch (err) {
    console.error("[proxy] Decompression failed:", err instanceof Error ? err.message : err);
  }
  return buffer;
}

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
  method: string = "GET",
  overrideBody?: Buffer,
): Promise<NextResponse> {
  const sessionId = getSessionId(request);

  // Manual URL extraction to avoid searchParams decoding
  let rawUrl = targetUrlStr;
  const fullUrl = request.url;
  const urlIdx = fullUrl.indexOf("url=");
  if (urlIdx !== -1) {
    const afterUrl = fullUrl.slice(urlIdx + 4);
    const refIdx = afterUrl.indexOf("&ref=");
    const rawTarget = refIdx !== -1 ? afterUrl.slice(0, refIdx) : afterUrl;
    try {
      // Decode once. If client double-encoded (e.g. strictEncode), this restores the original encoded string.
      // If they didn't, it restores the plain string.
      rawUrl = decodeURIComponent(rawTarget);
    } catch {
      rawUrl = targetUrlStr;
    }
  }

  const parsed = normalizeUrl(rawUrl);
  if (!parsed) {

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


  const headers = buildUpstreamRequestHeaders(
    request.headers,
    parsed,
    { sessionId, jarHost, documentReferer },
  );

  try {
    const methodsWithBody = ["POST", "PUT", "PATCH", "DELETE"];
    let reqBody: Buffer | undefined = overrideBody;

    if (!reqBody && methodsWithBody.includes(method)) {
        try {
            reqBody = Buffer.from(await request.arrayBuffer());
        } catch (e) {
            // Body might be already consumed or empty
        }
    }

    // Call target directly via SOCKS5 proxy
    const upstreamRes: { status: number, headers: Headers, body: ReadableStream | Buffer, url: string, isStream: boolean } = await new Promise((resolve, reject) => {
      const isTargetHttps = parsed.protocol === 'https:';
      const requestModule = isTargetHttps ? https : http;

      if (reqBody !== undefined) {
        headers.set("content-length", String(reqBody.length));
        const incomingContentType = request.headers.get("content-type");
        if (incomingContentType && !headers.has("content-type")) {
            headers.set("content-type", incomingContentType);
        }
      }

      const proxyOptions = {
        method: method,
        hostname: parsed.hostname,
        port: parsed.port || (isTargetHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: Object.fromEntries(headers.entries()),
        agent: socksAgent,
        signal: controller.signal
      };

      const req = requestModule.request(proxyOptions, (res) => {
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

        const contentType = resHeaders.get("content-type") || "";
        const isStreamingType = /video|audio|image|zip|pdf|octet-stream/i.test(contentType) || 
                               res.statusCode === 206 || 
                               (method === "GET" && !/html|css|javascript|json/i.test(contentType));

        if (isStreamingType) {
          const stream = new ReadableStream({
            start(controller) {
              res.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
              res.on("end", () => controller.close());
              res.on("error", (err) => controller.error(err));
            },
            cancel() {
              res.destroy();
            }
          });
          resolve({
            status: res.statusCode || 200,
            headers: resHeaders,
            body: stream,
            url: parsed.toString(),
            isStream: true
          });
        } else {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode || 200,
              headers: resHeaders,
              body: Buffer.concat(chunks),
              url: parsed.toString(),
              isStream: false
            });
          });
        }
      });

      req.on('error', (err) => reject(err));
      if (reqBody) req.write(reqBody);
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
    absorbSetCookieHeaders(sessionId, jarHost, upstreamRes.headers);

    const resHeaders = new Headers();
    upstreamRes.headers.forEach((value, key) => {
      if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
        resHeaders.set(key, value);
      }
    });

    resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
    resHeaders.set("pragma", "no-cache");
    applyCorsHeaders(resHeaders);
    resHeaders.set("x-proxy-final-url", upstreamRes.url);
    resHeaders.set("x-proxy-cookie-replay", cookieHeaderForHost(sessionId, jarHost) ? "1" : "0");
    
    const locationHeader = resHeaders.get("location");
    if (locationHeader) {
      try {
        const absLocation = new URL(locationHeader, upstreamRes.url).toString();
        resHeaders.set("location", `/proxy?url=${encodeURIComponent(absLocation)}`);
      } catch (e) {}
    }

    if (upstreamRes.isStream) {
      clearTimeout(timer);
      const streamRes = new NextResponse(upstreamRes.body as ReadableStream, {
        status: upstreamRes.status,
        headers: resHeaders
      });
      attachSessionCookie(streamRes, sessionId);
      return streamRes;
    }

    const buf = upstreamRes.body as Buffer;
    const encoding = upstreamRes.headers.get("content-encoding");
    const decompressed = decompress(buf, encoding);
    
    if (decompressed.length > maxBytes) {
      clearTimeout(timer);
      return json("Response too large.", 413, sessionId);
    }

    const contentType = upstreamRes.headers.get("content-type") ?? "application/octet-stream";
    const ct = contentType.toLowerCase();
    const isHtml = ct.includes("text/html") || ct.includes("application/xhtml+xml");
    const isCss = ct.includes("text/css");

    const sniffHtml = (!apiLike && isHtml) ||
      (!apiLike && ct.includes("text/plain") && /^\s*</.test(decompressed.toString("utf-8", 0, 512)));

    let body: Buffer | string = decompressed;
    if (method !== "HEAD") {
      if (sniffHtml) {
        body = rewriteHtml(decompressed.toString("utf-8"), upstreamRes.url, true);
        resHeaders.set("content-type", "text/html; charset=utf-8");
      } else if (isCss) {
        body = rewriteCss(decompressed.toString("utf-8"), upstreamRes.url);
        resHeaders.set("content-type", "text/css; charset=utf-8");
      }
    }

    resHeaders.delete("content-length");
    resHeaders.delete("content-encoding");
    if (!resHeaders.get("x-proxy-render")) resHeaders.set("x-proxy-render", "fetch");

    clearTimeout(timer);
    const finalRes = new NextResponse(body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
    attachSessionCookie(finalRes, sessionId);
    return finalRes;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return json("Request timed out.", 504, sessionId);
    }
    const msg = err instanceof Error ? err.message : "Could not reach target URL.";
    return json(msg, 502, sessionId);
  }
}
}
