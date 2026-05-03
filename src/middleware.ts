/**
 * Next.js Edge Middleware — Subdomain Request Router
 *
 * This runs on EVERY request before it reaches any route handler.
 * It intercepts requests to subdomains like xhpingcdn--com.daddyproxy.com
 * and rewrites them to /subdomain-proxy with the real target URL in a header.
 *
 * WHY MIDDLEWARE AND NOT A CATCH-ALL ROUTE:
 *   Next.js routing is based on the URL PATH, not the hostname.
 *   You cannot create a route file like [host]/[...path]/route.ts that
 *   catches requests from different hostnames — Next.js doesn't work that way.
 *   Middleware runs before routing, has access to the host header, and can
 *   rewrite the request to any internal path. This is the correct pattern.
 *
 * WHAT HAPPENS:
 *   1. Request arrives: GET https://xhpingcdn--com.daddyproxy.com/css/main.css
 *   2. Middleware detects the subdomain (xhpingcdn--com)
 *   3. Decodes it: xhpingcdn.com
 *   4. Builds target URL: https://xhpingcdn.com/css/main.css
 *   5. Rewrites request internally to: /subdomain-proxy
 *   6. Adds header: x-proxy-target-url: https://xhpingcdn.com/css/main.css
 *   7. The /subdomain-proxy route handler fetches & returns the content
 *
 * COOKIE SCOPING:
 *   The session cookie __ph_jar is set with Domain=.daddyproxy.com so it's
 *   shared across ALL subdomains. This is critical — the user's session/auth
 *   state must persist whether they browse xhopen.com or xhpingcdn.com
 *   through the proxy.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ROOT_DOMAIN = (process.env.PROXY_ROOT_DOMAIN ?? "").toLowerCase().trim();

/** Paths that should NEVER be proxied — Next.js internal routes */
const BYPASS_PATHS = [
  "/_next/",
  "/api/",
  "/sw.js",
  "/pwa.js",
  "/manifest.json",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/subdomain-proxy",   // avoid redirect loops
  "/proxy",             // query-param proxy still works
];

function isBypassPath(pathname: string): boolean {
  return BYPASS_PATHS.some((p) => pathname === p || pathname.startsWith(p));
}

function decodeSubdomainToHost(encoded: string): string {
  return encoded.replace(/--/g, ".");
}

export function middleware(request: NextRequest): NextResponse {
  // If PROXY_ROOT_DOMAIN is not configured, skip all subdomain logic
  if (!ROOT_DOMAIN) return NextResponse.next();

  const url = request.nextUrl;
  if (isBypassPath(url.pathname)) return NextResponse.next();

  // Get the incoming hostname (strip port)
  const hostHeader =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "";
  const incomingHost = hostHeader.split(":")[0]?.toLowerCase() ?? "";

  // Must end with .rootdomain
  const suffix = `.${ROOT_DOMAIN}`;
  if (!incomingHost.endsWith(suffix)) return NextResponse.next();

  // Extract subdomain prefix
  const prefix = incomingHost.slice(0, incomingHost.length - suffix.length);
  if (!prefix) return NextResponse.next(); // root domain — pass through

  // Validate prefix: only allow a-z, 0-9, hyphens
  // (Our encoding uses -- for dots, so -- is valid, but never .)
  if (!/^[a-z0-9-]+$/.test(prefix)) return NextResponse.next();

  // Decode subdomain → real target hostname
  const targetHost = decodeSubdomainToHost(prefix);

  // Basic hostname sanity check — must look like domain.tld
  if (!targetHost.includes(".")) return NextResponse.next();
  if (targetHost.startsWith(".") || targetHost.endsWith(".")) return NextResponse.next();

  // Determine protocol
  const proto =
    (request.headers.get("x-forwarded-proto") ?? url.protocol).replace(/:$/, "");
  const targetProto = proto === "http" ? "http" : "https";

  // Build the full target URL
  const targetUrl = `${targetProto}://${targetHost}${url.pathname}${url.search}${url.hash}`;

  // Rewrite the request to our internal handler
  const rewritten = request.nextUrl.clone();
  rewritten.pathname = "/subdomain-proxy";
  rewritten.search   = "";          // clean: target URL goes in header, not query

  const headers = new Headers(request.headers);
  headers.set("x-proxy-target-url",  targetUrl);
  headers.set("x-proxy-target-host", targetHost);
  headers.set("x-proxy-subdomain",   prefix);

  return NextResponse.rewrite(rewritten, { request: { headers } });
}

/**
 * Matcher config: run middleware on ALL routes.
 * We filter internally to avoid double-processing.
 * Must include all paths that might be subdomain requests.
 */
export const config = {
  matcher: [
    /*
     * Match all paths EXCEPT:
     * - _next/static (static assets)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
