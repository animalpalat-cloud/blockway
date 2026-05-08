/**
 * Subdomain-based proxy router
 *
 * HOW BLOCKAWAY-STYLE SUBDOMAIN PROXYING WORKS:
 * ─────────────────────────────────────────────
 * Instead of: daddyproxy.com/proxy?url=https://xhpingcdn.com/image.jpg
 * We use:     xhpingcdn-com.daddyproxy.com/image.jpg
 *
 * WHY THIS DEFEATS CDN HOTLINK PROTECTION:
 *   CDNs check the "Host" header and "Referer" header. When using query-param
 *   proxying, the Host is always "daddyproxy.com" — CDNs see this as hotlinking
 *   and block it. With subdomain proxying:
 *     - The subdomain encodes the target domain
 *     - Your server forwards the request with Host: xhpingcdn.com
 *     - The CDN thinks it's talking to its own domain
 *     - Referer is set to https://xhpingcdn.com/ (the real target)
 *
 * SUBDOMAIN ENCODING FORMAT:
 *   dots (.) → double dash (--)    e.g. xhpingcdn.com → xhpingcdn--com
 *   single dash (-) → single dash  (preserved as-is in hostnames)
 *   The separator between encoded domain and your root domain is a single dot.
 *
 *   xhpingcdn.com  →  xhpingcdn--com.daddyproxy.com
 *   static.xhpingcdn.com  →  static-xhpingcdn--com.daddyproxy.com
 *     Wait — dots become -- so:
 *   static.xhpingcdn.com  →  static--xhpingcdn--com.daddyproxy.com
 *
 * COOKIE SCOPING:
 *   Cookies set by the proxied page use Domain=.daddyproxy.com
 *   so they are shared across all subdomains of your root domain.
 *   The session cookie __ph_jar is always set on .daddyproxy.com
 *   The per-site cookie jar (cookieJar.ts) stores cookies keyed by jarHost
 *   so each target site maintains separate cookie state.
 *
 * ENVIRONMENT:
 *   Set PROXY_ROOT_DOMAIN=daddyproxy.com in your .env.local / VPS environment.
 *   If not set, falls back to query-param mode.
 */

/** The root domain of your proxy (without leading dot) */
export function getRootDomain(): string {
  return (process.env.PROXY_ROOT_DOMAIN ?? "").replace(/^\./, "").toLowerCase().trim();
}

/** Whether subdomain mode is enabled (requires PROXY_ROOT_DOMAIN to be set) */
export function isSubdomainModeEnabled(): boolean {
  return getRootDomain().length > 0;
}

/**
 * Encode a target hostname into a safe subdomain prefix.
 *
 * Rules:
 *   - Dots become double-dashes: xhpingcdn.com → xhpingcdn--com
 *   - Already-safe chars (a-z, 0-9, -) pass through
 *   - Max 63 chars per DNS label (we truncate gracefully)
 *
 * Examples:
 *   static.xhpingcdn.com → static--xhpingcdn--com
 *   ic-vt-nss.xhpingcdn.com → ic-vt-nss--xhpingcdn--com
 *   www.google.com → www--google--com
 */
// Hosts where we strip "www." to avoid 4-level subdomain DNS failures.
// Cloudflare wildcard *.daddyproxy.com only covers ONE level deep.
// www.youtube.com → www--youtube--com.daddyproxy.com would be 4 levels and fail DNS.
// So we canonicalize: www.youtube.com → youtube.com → youtube--com.daddyproxy.com
const WWW_STRIP_HOSTS = new Set([
  // Major sites — strip www. to keep subdomain to single level
  "youtube.com",
  "google.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "netflix.com",
  "twitch.tv",
  "linkedin.com",
  "pinterest.com",
  "tumblr.com",
  "wikipedia.org",
  "github.com",
  "amazon.com",
  "ebay.com",
  "dailymotion.com",
  "vimeo.com",
  "xhamster.com",
  "xhamster18.com",
  "xvideos.com",
  "pornhub.com",
  "xnxx.com",
  "xaccess.com",
  "xhaccess.com",
  "bing.com",
  "yahoo.com",
  "duckduckgo.com",
]);

export function encodeHostToSubdomain(hostname: string): string {
  let h = hostname.toLowerCase().replace(/\.+$/, "");

  // Strip www. prefix for known major sites to avoid multi-level subdomain DNS issues
  // www.youtube.com → youtube.com → youtube--com (resolves correctly)
  if (h.startsWith("www.")) {
    const withoutWww = h.slice(4);
    if (WWW_STRIP_HOSTS.has(withoutWww)) {
      h = withoutWww;
    }
  }

  return h.replace(/\./g, "--");
}

/**
 * Decode a subdomain prefix back into a hostname.
 *
 * Examples:
 *   static--xhpingcdn--com → static.xhpingcdn.com
 *   ic-vt-nss--xhpingcdn--com → ic-vt-nss.xhpingcdn.com
 */
export function decodeSubdomainToHost(encoded: string): string {
  return encoded.replace(/--/g, ".");
}

/**
 * Build a full subdomain proxy URL for a target absolute URL.
 *
 * Given target: https://static.xhpingcdn.com/css/main.css
 * Returns:      https://static--xhpingcdn--com.daddyproxy.com/css/main.css
 *
 * Falls back to query-param URL if subdomain mode is disabled.
 */
export function buildSubdomainUrl(
  targetAbsolute: string,
  protocol: "https" | "http" = "https",
): string {
  const root = getRootDomain();
  if (!root) {
    // Fallback: query param mode
    return `/proxy?url=${encodeURIComponent(targetAbsolute)}`;
  }
  try {
    const u = new URL(targetAbsolute);
    const encodedHost = encodeHostToSubdomain(u.hostname);
    // Preserve original protocol of the target
    const tProto = u.protocol === "http:" ? "http" : protocol;
    const portPart = u.port ? `:${u.port}` : "";
    const pathAndQuery = u.pathname + u.search + u.hash;
    return `${tProto}://${encodedHost}.${root}${portPart}${pathAndQuery}`;
  } catch {
    return `/proxy?url=${encodeURIComponent(targetAbsolute)}`;
  }
}

/**
 * Extract the target info from a subdomain-based incoming request.
 *
 * Given request to: https://static--xhpingcdn--com.daddyproxy.com/css/main.css
 * Returns: {
 *   isSubdomainRequest: true,
 *   targetHost: "static.xhpingcdn.com",
 *   targetUrl: "https://static.xhpingcdn.com/css/main.css",
 *   encodedPrefix: "static--xhpingcdn--com"
 * }
 *
 * Returns isSubdomainRequest: false for requests to the root domain.
 */
export type SubdomainInfo =
  | { isSubdomainRequest: false }
  | {
      isSubdomainRequest: true;
      targetHost: string;
      targetUrl: string;
      encodedPrefix: string;
      /** Original protocol to use when fetching (always https unless explicitly http) */
      targetProtocol: "https:" | "http:";
    };

export function parseSubdomainRequest(request: Request): SubdomainInfo {
  const root = getRootDomain();
  if (!root) return { isSubdomainRequest: false };

  // Get the hostname from the request — works with Cloudflare/Nginx forwarding
  const hostHeader =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "";

  // Strip port if present
  const incomingHost = hostHeader.split(":")[0]?.toLowerCase() ?? "";
  if (!incomingHost) return { isSubdomainRequest: false };

  // Must end with .rootdomain (e.g. .daddyproxy.com)
  const suffix = `.${root}`;
  if (!incomingHost.endsWith(suffix)) return { isSubdomainRequest: false };

  // Extract the subdomain prefix (everything before .daddyproxy.com)
  const prefix = incomingHost.slice(0, incomingHost.length - suffix.length);
  if (!prefix) return { isSubdomainRequest: false }; // root domain itself — not subdomain

  // Decode the encoded hostname back to the real target
  const targetHost = decodeSubdomainToHost(prefix);

  // Sanity check: must look like a valid hostname
  if (!/^[a-zA-Z0-9.-]+$/.test(targetHost)) return { isSubdomainRequest: false };
  if (targetHost.startsWith(".") || targetHost.endsWith(".")) return { isSubdomainRequest: false };

  // Build the full target URL from the request path
  const url = new URL(request.url);
  const targetProtocol: "https:" | "http:" =
    (request.headers.get("x-forwarded-proto") ?? url.protocol) === "http:" ? "http:" : "https:";

  const targetUrl = `${targetProtocol}//${targetHost}${url.pathname}${url.search}${url.hash}`;

  return {
    isSubdomainRequest: true,
    targetHost,
    targetUrl,
    encodedPrefix: prefix,
    targetProtocol,
  };
}

/**
 * Rewrite an absolute URL to its subdomain-proxy form.
 * Used by rewriteHtml and rewriteCss.
 *
 * If subdomain mode is disabled, returns the query-param form.
 */
export function rewriteUrlToProxy(
  absoluteUrl: string,
  _documentPageUrl?: string,
): string {
  const root = getRootDomain();
  if (!root) {
    // Legacy query-param mode
    const base = _documentPageUrl ? `&ref=${encodeURIComponent(_documentPageUrl)}` : "";
    return `/proxy?url=${encodeURIComponent(absoluteUrl)}${base}`;
  }
  return buildSubdomainUrl(absoluteUrl);
}

/**
 * Given a subdomain request host and a relative URL, build the full
 * target subdomain URL preserving the correct proxy domain.
 *
 * Used by clientRuntime to rewrite navigations from within subdomain pages.
 *
 * e.g. targetHost=xhpingcdn.com, path=/video/test.mp4
 * → https://xhpingcdn--com.daddyproxy.com/video/test.mp4
 */
export function buildSubdomainUrlForHost(
  targetHost: string,
  pathAndQuery: string,
  protocol: "https:" | "http:" = "https:",
): string {
  const root = getRootDomain();
  if (!root) return `/proxy?url=${encodeURIComponent(`${protocol}//${targetHost}${pathAndQuery}`)}`;
  const encodedHost = encodeHostToSubdomain(targetHost);
  const proto = protocol === "http:" ? "http" : "https";
  return `${proto}://${encodedHost}.${root}${pathAndQuery}`;
}
