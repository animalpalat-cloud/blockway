import { doProxy } from "@/lib/proxy/doProxyRequest";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic   = "force-dynamic";
export const revalidate = 0;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) {
    return jsonError("Missing url query parameter.", 400);
  }
  return doProxy(request, url, "GET");
}

export async function POST(request: NextRequest) {
  try {
    const body   = (await request.json()) as { url?: string };
    const target = body?.url?.trim() ?? "";
    if (!target) {
      return jsonError("Missing url in JSON body.", 400);
    }
    return doProxy(request, target, "GET");
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
}

export async function HEAD(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url.trim()) {
    return new NextResponse(null, { status: 400 });
  }
  return doProxy(request, url, "HEAD");
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Accept-Language, Accept-Encoding, Authorization",
      "Access-Control-Max-Age":       "86400",
    },
  });
}
