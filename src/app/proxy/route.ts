/**
 * src/app/proxy/route.ts
 *
 * Main proxy route handler. All browser requests go through here.
 * Handles Google batchexecute, CORS preflight, and all HTTP methods.
 */

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
    "X-Forwarded-For, DNT, Cache-Control, Pragma, " +
    "X-Same-Domain, X-Goog-AuthUser, X-Goog-Encode-Response-If-Executable",
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
 * Extract the raw `url` query param without Next.js auto-decoding it twice.
 */
function extractTargetUrl(request: NextRequest): string {
  const raw = request.url;
  const qIdx = raw.indexOf("?");
  if (qIdx === -1) return "";
  const qs = raw.slice(qIdx + 1);
  for (const part of qs.split("&")) {
    if (part.startsWith("url=")) {
      try {
        return decodeURIComponent(part.slice(4));
      } catch {
        return part.slice(4);
      }
    }
  }
  return "";
}

export async function GET(request: NextRequest) {
  const url = extractTargetUrl(request);
  if (!url.trim()) {
    const accept = (request.headers.get("accept") ?? "").toLowerCase();
    if (accept.includes("text/html")) {
      return applyCors(
        new NextResponse(
          "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
          "<title>Blockway</title></head><body style=\"font-family:sans-serif;padding:2rem\">" +
          "<h1>Blockway Proxy</h1><p>Usage: <code>/proxy?url=https://example.com</code></p>" +
          "</body></html>",
          { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      );
    }
    return jsonError("Missing url query parameter.", 400);
  }
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
  // Handle CORS preflight — must respond 204 with correct headers
  // This is critical for Google batchexecute and XHR requests
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