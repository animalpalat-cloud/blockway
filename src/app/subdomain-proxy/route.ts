/**
 * Subdomain Proxy Route Handler
 *
 * This file handles requests arriving on subdomain URLs like:
 *   xhpingcdn--com.daddyproxy.com/css/main.css
 *   static--xhpingcdn--com.daddyproxy.com/js/app.js
 *
 * In Next.js 14 you cannot natively catch subdomain requests via the file
 * router. Instead, you use Next.js middleware (middleware.ts) to rewrite
 * subdomain requests to this internal route, passing the real target URL
 * via a header (x-proxy-target-url).
 *
 * Flow:
 *   Browser → xhpingcdn--com.daddyproxy.com/image.jpg
 *   Middleware detects subdomain, rewrites internally to:
 *     /subdomain-proxy with header x-proxy-target-url: https://xhpingcdn.com/image.jpg
 *   This handler fetches & returns the proxied content.
 */

import { doProxy } from "@/lib/proxy/doProxyRequest";
import { type NextRequest, NextResponse } from "next/server";
import { parseSubdomainRequest } from "@/lib/proxy/subdomainRouter";
import { isBlockedTarget, normalizeUrl } from "@/lib/proxy/urls";

export const runtime     = "nodejs";
export const dynamic     = "force-dynamic";
export const revalidate  = 0;
export const maxDuration = 120;

type HttpMethod = "GET" | "POST" | "HEAD" | "PUT" | "PATCH" | "DELETE";

function jsonErr(msg: string, status: number) {
  return NextResponse.json({ error: msg }, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

/**
 * Resolve the target URL for this subdomain request.
 * Priority:
 *  1. x-proxy-target-url header (set by middleware)
 *  2. Parse the incoming host directly (when running in a true wildcard setup)
 */
function resolveTargetUrl(request: NextRequest): string | null {
  // Set by middleware.ts — most reliable
  const fromHeader = request.headers.get("x-proxy-target-url");
  if (fromHeader) return fromHeader;

  // Direct subdomain parse fallback
  const info = parseSubdomainRequest(request);
  if (info.isSubdomainRequest) return info.targetUrl;

  return null;
}

async function handle(request: NextRequest, method: HttpMethod): Promise<NextResponse> {
  const targetUrl = resolveTargetUrl(request);
  if (!targetUrl) return jsonErr("Could not determine target URL from subdomain.", 400);

  const parsed = normalizeUrl(targetUrl);
  if (!parsed) return jsonErr("Invalid target URL.", 400);
  if (isBlockedTarget(parsed)) return jsonErr("Target URL is blocked.", 403);

  return doProxy(request, targetUrl, method);
}

export async function GET(request: NextRequest)    { return handle(request, "GET"); }
export async function POST(request: NextRequest)   { return handle(request, "POST"); }
export async function HEAD(request: NextRequest)   { return handle(request, "HEAD"); }
export async function PUT(request: NextRequest)    { return handle(request, "PUT"); }
export async function PATCH(request: NextRequest)  { return handle(request, "PATCH"); }
export async function DELETE(request: NextRequest) { return handle(request, "DELETE"); }

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Range, Authorization, Cookie",
      "Access-Control-Max-Age":       "86400",
    },
  });
}
