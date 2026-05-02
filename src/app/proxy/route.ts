import { doProxy } from "@/lib/proxy/doProxyRequest";
import { type NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 120;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, " +
    "User-Agent, Cookie, Range, X-Requested-With, Origin, Referer, " +
    "X-Forwarded-For, DNT, Cache-Control, Pragma",
  "Access-Control-Expose-Headers":
    "x-proxy-final-url, content-type, x-proxy-cookie-replay, x-proxy-render",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function jsonError(message: string, status: number) {
  return applyCors(NextResponse.json({ error: message }, { status }));
}

/**
 * Extract the raw `url` query param without Next.js auto-decoding it a second time.
 *
 * WHY: Next.js searchParams.get("url") auto-decodes the value once.
 * But our clientRuntime and sw.js encode target URLs with encodeURIComponent,
 * so the raw query string contains url=https%3A%2F%2Fexample.com%2Fpath.
 * Next.js decodes that to https://example.com/path — fine for simple URLs.
 * BUT for URLs with encoded slashes or special chars inside paths
 * (e.g. https%3A%2F%2Fxopen.com%2F becomes https://xopen.com/ and then
 * Next.js may further mangle it), we lose the original structure → 400.
 *
 * SOLUTION: Read the raw request.url string, find url=..., decode exactly once.
 */
function extractTargetUrl(request: NextRequest): string {
  // request.url is the full URL including origin and query string
  const raw = request.url;
  const qIdx = raw.indexOf("?");
  if (qIdx === -1) return "";
  const qs = raw.slice(qIdx + 1);
  for (const part of qs.split("&")) {
    if (part.startsWith("url=")) {
      try {
        return decodeURIComponent(part.slice(4));
      } catch {
        // If malformed encoding, return as-is
        return part.slice(4);
      }
    }
  }
  return "";
}

export async function GET(request: NextRequest) {
  const url = extractTargetUrl(request);
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "GET");
}

export async function POST(request: NextRequest) {
  const qpUrl = extractTargetUrl(request).trim();
  if (qpUrl) return doProxy(request, qpUrl, "POST");
  try {
    const body = (await request.json()) as { url?: string };
    const target = body?.url?.trim() ?? "";
    if (!target) return jsonError("Missing url in JSON body.", 400);
    return doProxy(request, target, "POST");
  } catch {
    return jsonError("Missing url query parameter or valid JSON body.", 400);
  }
}

export async function HEAD(request: NextRequest) {
  const url = extractTargetUrl(request);
  if (!url.trim()) return applyCors(new NextResponse(null, { status: 400 }));
  return doProxy(request, url, "HEAD");
}

export async function PUT(request: NextRequest) {
  const url = extractTargetUrl(request);
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "PUT");
}

export async function PATCH(request: NextRequest) {
  const url = extractTargetUrl(request);
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "PATCH");
}

export async function DELETE(request: NextRequest) {
  const url = extractTargetUrl(request);
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "DELETE");
}

export async function OPTIONS(request: NextRequest) {
  const reqHeaders = request.headers.get("access-control-request-headers");
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Headers":
        reqHeaders || CORS_HEADERS["Access-Control-Allow-Headers"],
    },
  });
}
