import { type NextRequest, NextResponse } from "next/server";
import {
  absorbSetCookieHeaders,
  cookieHeaderForHost,
  newSessionId,
} from "./cookieJar";
import { rewriteHtml } from "./rewriteHtml";
import { rewriteCss } from "./rewriteCss";
import { STRIP_FROM_RESPONSE, buildUpstreamRequestHeaders } from "./upstreamHeaders";
import { isBlockedTarget, normalizeUrl, SESSION_COOKIE } from "./urls";

const TIMEOUT_MS  = 45_000;
const MAX_SIZE_MB = 32;

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

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
  attachSessionCookie(res, sessionId);
  return res;
}

export async function doProxy(
  request: NextRequest,
  targetUrlStr: string,
  method: "GET" | "HEAD" = "GET",
): Promise<NextResponse> {
  const sessionId = getSessionId(request);

  const parsed = normalizeUrl(targetUrlStr);
  if (!parsed) {
    return json("Invalid URL.", 400, sessionId);
  }
  if (isBlockedTarget(parsed)) {
    return json("Target URL is blocked for security reasons.", 403, sessionId);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream: Response;
  const jarHost = parsed.hostname;
  const headers   = buildUpstreamRequestHeaders(
    request.headers,
    parsed,
    { sessionId, jarHost },
  );

  try {
    upstream = await fetch(parsed.toString(), {
      method,
      redirect: "follow",
      signal:   controller.signal,
      headers,
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

  const maxBytes     = MAX_SIZE_MB * 1024 * 1024;
  const cl             = Number(upstream.headers.get("content-length") ?? 0);
  if (cl && cl > maxBytes) {
    return json("Response too large.", 413, sessionId);
  }

  const contentType  = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl     = upstream.url || parsed.toString();
  const hasBody      = method !== "HEAD";
  const buf = hasBody
    ? Buffer.from(await upstream.arrayBuffer())
    : Buffer.alloc(0);
  if (buf.length > maxBytes) {
    return json("Response too large.", 413, sessionId);
  }

  const ct         = contentType.toLowerCase();
  const isHtml     = ct.includes("text/html") || ct.includes("application/xhtml+xml");
  const isCss      = ct.includes("text/css");
  const sniffHtml  =
    isHtml ||
    (ct.includes("text/plain") && /^\s*</.test(buf.toString("utf-8", 0, 512)));

  let body: Buffer = buf;
  if (hasBody && sniffHtml) {
    body = Buffer.from(rewriteHtml(buf.toString("utf-8"), finalUrl, true), "utf-8");
  } else if (hasBody && isCss) {
    body = Buffer.from(rewriteCss(buf.toString("utf-8"), finalUrl), "utf-8");
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  });

  if (sniffHtml) {
    resHeaders.set("content-type", "text/html; charset=utf-8");
  } else if (isCss) {
    resHeaders.set("content-type", "text/css; charset=utf-8");
  }

  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  resHeaders.set("pragma", "no-cache");
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.set(
    "access-control-expose-headers",
    "x-proxy-final-url, content-type, x-proxy-session",
  );
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
