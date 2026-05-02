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

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "GET");
}

export async function POST(request: NextRequest) {
  const qpUrl = request.nextUrl.searchParams.get("url")?.trim() ?? "";
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
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) {
    return applyCors(new NextResponse(null, { status: 400 }));
  }
  return doProxy(request, url, "HEAD");
}

export async function PUT(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "PUT");
}

export async function PATCH(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) return jsonError("Missing url query parameter.", 400);
  return doProxy(request, url, "PATCH");
}

export async function DELETE(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
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
