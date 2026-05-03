/**
 * Next.js Edge Middleware — Subdomain Proxy Router
 *
 * CRITICAL FIX: On subdomain requests (xhaccess--com.daddyproxy.com),
 * we must NOT bypass /_next/ paths — those belong to the PROXIED SITE,
 * not our Next.js app. Only bypass /_next/ on the ROOT domain (daddyproxy.com).
 *
 * Bug that was happening:
 *   Browser: GET xhaccess--com.daddyproxy.com/_next/static/media/font.woff2
 *   Middleware: saw /_next/ → bypassed → Next.js returned OUR app's font
 *   Result: CORS error (daddyproxy.com font on xhaccess--com.daddyproxy.com page)
 *
 * Fix: bypass list only applies to ROOT domain. All subdomain paths go to proxy.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ROOT_DOMAIN = (process.env.PROXY_ROOT_DOMAIN ?? "").toLowerCase().replace(/^\./, "").trim();

// These paths on the ROOT DOMAIN should NOT be proxied — they are our own app routes
const ROOT_DOMAIN_BYPASS_EXACT = new Set([
  "/sw.js", "/pwa.js", "/manifest.json", "/favicon.ico",
  "/robots.txt", "/sitemap.xml",
]);

const ROOT_DOMAIN_BYPASS_PREFIXES = [
  "/_next/",           // Our Next.js build assets
  "/api/",             // Our own API routes
  "/subdomain-proxy",  // Internal proxy handler — prevent loop
  "/proxy",            // Query-param proxy
];

function isRootDomainBypass(pathname: string): boolean {
  if (ROOT_DOMAIN_BYPASS_EXACT.has(pathname)) return true;
  return ROOT_DOMAIN_BYPASS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?")
  );
}

function getIncomingHost(request: NextRequest): string {
  const raw =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") || "";
  return raw.split(":")[0]?.toLowerCase().trim() ?? "";
}

function getProto(request: NextRequest): "https" | "http" {
  const fwd = request.headers.get("x-forwarded-proto");
  if (fwd) return fwd.replace(/:$/, "") === "http" ? "http" : "https";
  return request.nextUrl.protocol === "http:" ? "http" : "https";
}

type DecodedSubdomain =
  | { found: false }
  | { found: true; targetHost: string; format: "double-dash" | "dot-passthrough" };

function decodeSubdomainPrefix(prefix: string): DecodedSubdomain {
  if (!prefix) return { found: false };

  // FORMAT 1: double-dash encoded (google--com, static--xhpingcdn--com)
  if (prefix.includes("--") && !prefix.includes(".")) {
    if (!/^[a-z0-9-]+$/.test(prefix)) return { found: false };
    const targetHost = prefix.replace(/--/g, ".");
    if (!isValidHostname(targetHost)) return { found: false };
    return { found: true, targetHost, format: "double-dash" };
  }

  // FORMAT 2: dot pass-through (google.com, www.youtube.com)
  if (prefix.includes(".") && !prefix.includes("--")) {
    if (!isValidHostname(prefix)) return { found: false };
    return { found: true, targetHost: prefix, format: "dot-passthrough" };
  }

  return { found: false };
}

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.startsWith(".") || host.endsWith(".")) return false;
  if (!host.includes(".")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return false;
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;
  const labels = host.split(".");
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) return false;
  }
  return true;
}

export function middleware(request: NextRequest): NextResponse {
  if (!ROOT_DOMAIN) return NextResponse.next();

  const incomingHost = getIncomingHost(request);
  if (!incomingHost) return NextResponse.next();

  const rootSuffix = `.${ROOT_DOMAIN}`;

  // Root domain — apply bypass rules and pass through normally
  if (incomingHost === ROOT_DOMAIN || incomingHost === `www.${ROOT_DOMAIN}`) {
    // Only bypass specific internal paths on the root domain
    if (isRootDomainBypass(request.nextUrl.pathname)) return NextResponse.next();
    return NextResponse.next();
  }

  // Must be a subdomain
  if (!incomingHost.endsWith(rootSuffix)) return NextResponse.next();

  const prefix = incomingHost.slice(0, incomingHost.length - rootSuffix.length);
  if (!prefix) return NextResponse.next();

  const decoded = decodeSubdomainPrefix(prefix);
  if (!decoded.found) {
    return new NextResponse(
      JSON.stringify({ error: "Invalid proxy subdomain format.", received: prefix }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { targetHost } = decoded;
  const proto = getProto(request);
  const url = request.nextUrl;

  // Build target URL — ALL paths go through proxy (including /_next/, /api/, etc.)
  // because on a subdomain, those paths belong to the TARGET SITE, not our app
  const targetUrl = `${proto}://${targetHost}${url.pathname}${url.search}${url.hash}`;

  // Only skip proxy for our internal management paths
  // These should never appear on subdomain requests in normal usage
  const pathname = url.pathname;
  if (pathname === "/subdomain-proxy" || pathname.startsWith("/subdomain-proxy/")) {
    return NextResponse.next();
  }

  // Rewrite to /subdomain-proxy handler
  const rewritten = request.nextUrl.clone();
  rewritten.pathname = "/subdomain-proxy";
  rewritten.search = "";

  const headers = new Headers(request.headers);
  headers.set("x-proxy-target-url",  targetUrl);
  headers.set("x-proxy-target-host", targetHost);
  headers.set("x-proxy-subdomain",   prefix);
  headers.set("x-proxy-format",      decoded.format);

  return NextResponse.rewrite(rewritten, { request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
