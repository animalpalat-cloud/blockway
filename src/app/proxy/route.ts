/**
 * src/app/proxy/route.ts
 * Robust proxy for Google services (accounts.google.com, batchexecute, etc.) + general use.
 * All frontend requests to Google must go through /proxy?url=...
 */

import { type NextRequest, NextResponse } from "next/server";
import { doProxy } from "@/lib/proxy/doProxyRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 120;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, " +
    "User-Agent, Cookie, Range, X-Requested-With, X-Proxy-Url, " +
    "X-Goog-AuthUser, X-Goog-Encode-Response-If-Executable, X-Client-Data",
  "Access-Control-Expose-Headers": "x-proxy-final-url, content-type, x-proxy-cookie-replay",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res: NextResponse): NextResponse {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => {
    res.headers.set(k, v);
  });
  return res;
}

function jsonError(message: string, status: number = 502): NextResponse {
  const res = NextResponse.json({ error: message, success: false }, { status });
  return applyCors(res);
}

/**
 * Safely extract target URL (handles double-encoding issues).
 */
function extractTargetUrl(request: NextRequest): string {
  const urlParam = request.nextUrl.searchParams.get("url");
  if (urlParam) {
    try {
      return decodeURIComponent(urlParam);
    } catch {
      return urlParam;
    }
  }
  return "";
}

export async function GET(request: NextRequest) {
  const target = extractTargetUrl(request);
  if (!target) {
    return jsonError("Missing ?url= parameter", 400);
  }
  return doProxy(request, target, "GET");
}

export async function POST(request: NextRequest) {
  const qpUrl = extractTargetUrl(request);
  if (qpUrl) {
    return doProxy(request, qpUrl, "POST");
  }

  // Support JSON body with { url: "..." } for batchexecute etc.
  try {
    const body = await request.json();
    const target = body?.url?.trim();
    if (!target) return jsonError("Missing url in request body", 400);
    return doProxy(request, target, "POST");
  } catch {
    return jsonError("Invalid JSON body or missing url", 400);
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// Support other methods
export async function HEAD(request: NextRequest) {
  const target = extractTargetUrl(request);
  if (!target) return new NextResponse(null, { status: 400, headers: CORS_HEADERS });
  return doProxy(request, target, "HEAD");
}

export async function PUT(request: NextRequest) {
  const target = extractTargetUrl(request);
  if (!target) return jsonError("Missing ?url=", 400);
  return doProxy(request, target, "PUT");
}

export async function PATCH(request: NextRequest) {
  const target = extractTargetUrl(request);
  if (!target) return jsonError("Missing ?url=", 400);
  return doProxy(request, target, "PATCH");
}

export async function DELETE(request: NextRequest) {
  const target = extractTargetUrl(request);
  if (!target) return jsonError("Missing ?url=", 400);
  return doProxy(request, target, "DELETE");
}