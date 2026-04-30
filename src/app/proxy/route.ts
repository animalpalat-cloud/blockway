import { doProxy } from "@/lib/proxy/doProxyRequest";
import { type NextRequest, NextResponse } from "next/server";

/** Puppeteer only runs in the Node.js runtime, not Edge. */
export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 120;

function jsonError(message: string, status: number) {
  const res = NextResponse.json({ error: message }, { status });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer",
  );
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) {
    return jsonError("Missing url query parameter.", 400);
  }
  return doProxy(request, url, "GET");
}

export async function POST(request: NextRequest) {
  const qpUrl = request.nextUrl.searchParams.get("url")?.trim() ?? "";
  if (qpUrl) {
    return doProxy(request, qpUrl, "POST");
  }
  try {
    const body = (await request.json()) as { url?: string };
    const target = body?.url?.trim() ?? "";
    if (!target) {
      return jsonError("Missing url in JSON body.", 400);
    }
    return doProxy(request, target, "POST");
  } catch {
    return jsonError("Missing url query parameter or valid JSON body.", 400);
  }
}

export async function HEAD(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) {
    const res = new NextResponse(null, { status: 400 });
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer",
    );
    res.headers.set("Access-Control-Max-Age", "86400");
    return res;
  }
  return doProxy(request, url, "HEAD");
}

export async function OPTIONS(request: NextRequest) {
  const reqHeaders = request.headers.get("access-control-request-headers");
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": reqHeaders
        || "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization, User-Agent, Cookie, Range, X-Requested-With, Origin, Referer",
      "Access-Control-Max-Age":       "86400",
    },
  });
}
