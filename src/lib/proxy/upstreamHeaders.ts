import {
  buildAcceptForKind,
  buildRefererAndOrigin,
  buildSecFetchHeaders,
  inferResourceKind,
  pickAcceptLanguage,
  pickUserAgentForUpstream,
  DEFAULT_ACCEPT_ENCODING,
} from "./browserHeaders";
import { cookieHeaderForHost } from "./cookieJar";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
  "content-length", "expect", "max-forwards",
]);

/**
 * Headers we strip from the client request and replace with browser-like values.
 * This is the core anti-detection mechanism: we never forward the proxy's own
 * server-side headers to the upstream — instead we build realistic browser headers.
 */
const INCOMING_STRIP = new Set([
  "user-agent", "accept", "accept-language", "accept-encoding",
  "referer", "origin", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site", "sec-fetch-user", "sec-fetch-dest-fragment",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list", "sec-ch-ua-model", "sec-ch-ua-wow64",
  "downlink", "dpr", "save-data", "viewport-width", "width",
  "device-memory", "rtt", "ect", "priority",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-real-ip", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
  "x-vercel-ip-country", "x-vercel-forwarded-for",
  "cookie", "authorization",
  ...HOP_BY_HOP,
]);

export type UpstreamRequestOptions = {
  sessionId: string;
  jarHost: string;
  documentReferer?: string | null;
};

/**
 * Build headers for upstream fetch, mimicking a real Chrome browser navigating
 * to the target URL. This is the primary anti-bot-detection mechanism.
 *
 * Key techniques:
 * 1. Rotated Chrome user agents (Windows/Mac/Linux)
 * 2. Correct Sec-Fetch-* headers based on resource type
 * 3. Realistic Accept, Accept-Language, Accept-Encoding
 * 4. Proper Referer and Origin derived from the proxied page context
 * 5. Client Hint headers that match the user agent
 */
export function buildUpstreamRequestHeaders(
  incoming: Headers,
  target: URL,
  options: UpstreamRequestOptions,
): Headers {
  const out = new Headers();
  const ref = options.documentReferer ?? null;
  const kind = inferResourceKind(target);
  const ua = pickUserAgentForUpstream();

  // Forward safe passthrough headers (e.g. Range for video streaming)
  incoming.forEach((value, key) => {
    const l = key.toLowerCase();
    if (INCOMING_STRIP.has(l)) return;
    out.set(key, value);
  });

  // Core browser identity
  out.set("user-agent", ua);
  out.set("accept", buildAcceptForKind(kind));
  out.set("accept-language", pickAcceptLanguage());
  out.set("accept-encoding", DEFAULT_ACCEPT_ENCODING);

  // Client Hints — must match the user agent string to avoid fingerprint mismatch
  const chHeaders = buildClientHintHeaders(ua);
  for (const [k, v] of Object.entries(chHeaders)) out.set(k, v);

  // Referer and Origin — critical for sites that check these
  const { referer, origin } = buildRefererAndOrigin(target, ref);
  out.set("referer", referer);
  out.set("origin", origin);

  // Sec-Fetch headers — browsers always send these; missing = bot signal
  const sec = buildSecFetchHeaders(target, kind, ref);
  out.set("sec-fetch-dest", sec["sec-fetch-dest"]);
  out.set("sec-fetch-mode", sec["sec-fetch-mode"]);
  out.set("sec-fetch-site", sec["sec-fetch-site"]);
  if (sec["sec-fetch-user"] !== "?0") out.set("sec-fetch-user", sec["sec-fetch-user"]);

  if (target.protocol === "https:") {
    out.set("upgrade-insecure-requests", "1");
  }

  // Inject cookies from our session jar for this host
  const jar = cookieHeaderForHost(options.sessionId, options.jarHost);
  if (jar) out.set("cookie", jar);

  // Prevent caching of proxied content server-side
  out.set("cache-control", "no-cache");
  out.set("pragma", "no-cache");

  // DNT is commonly sent by real browsers
  out.set("dnt", "1");

  return out;
}

/**
 * Build Sec-CH-UA Client Hint headers to match the given UA string.
 * Browsers that omit these while sending a Chrome UA look like bots.
 */
function buildClientHintHeaders(ua: string): Record<string, string> {
  const out: Record<string, string> = {};

  // Parse Chrome version from UA
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  if (!chromeMatch) return out;
  const majorVer = chromeMatch[1];

  // Detect platform
  const isWindows = ua.includes("Windows NT");
  const isMac = ua.includes("Macintosh") || ua.includes("Mac OS X");
  const isLinux = ua.includes("X11; Linux") || ua.includes("Linux x86_64");
  const isEdge = ua.includes("Edg/");

  // Sec-CH-UA: list of brands with versions
  if (isEdge) {
    out["sec-ch-ua"] =
      `"Microsoft Edge";v="${majorVer}", "Not(A:Brand";v="99", "Chromium";v="${majorVer}"`;
  } else {
    out["sec-ch-ua"] =
      `"Google Chrome";v="${majorVer}", "Not(A:Brand";v="99", "Chromium";v="${majorVer}"`;
  }

  out["sec-ch-ua-mobile"] = "?0";

  if (isWindows) out["sec-ch-ua-platform"] = '"Windows"';
  else if (isMac) out["sec-ch-ua-platform"] = '"macOS"';
  else if (isLinux) out["sec-ch-ua-platform"] = '"Linux"';
  else out["sec-ch-ua-platform"] = '"Windows"';

  return out;
}

// Headers for Puppeteer's setExtraHTTPHeaders (no Cookie/UA/Referer — those go via API)
const NOT_FOR_PUPPETEER_EXTRA = new Set([
  "cookie", "host", "connection", "content-length", "referer", "origin",
  "accept-encoding", "user-agent", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site", "sec-fetch-user", "sec-fetch-storage-access",
  "upgrade-insecure-requests", "trailer", "te", "expect", "date", "dnt",
  "alt-used", "http2-settings", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
]);

export function headersToForwardForPuppeteer(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((value, key) => {
    const l = key.toLowerCase();
    if (NOT_FOR_PUPPETEER_EXTRA.has(l)) return;
    if (l === "x-forwarded-for" || l === "x-forwarded-proto" || l === "x-forwarded-host") return;
    o[key] = value;
  });
  if (!Object.keys(o).some((k) => k.toLowerCase() === "accept")) {
    o["Accept"] = h.get("accept") || "";
  }
  if (!Object.keys(o).some((k) => k.toLowerCase() === "accept-language")) {
    o["Accept-Language"] = h.get("accept-language") || "en-US,en;q=0.9";
  }
  return o;
}

export const STRIP_FROM_RESPONSE = new Set([
  // Strip Alt-Svc to prevent browser from attempting QUIC/HTTP3 directly to origin
  // This avoids ERR_QUIC_PROTOCOL_ERROR which happens when browser tries h3 without proxy
  "alt-svc",
  // Security headers that break proxied content
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  // CORS — we set our own
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
  "access-control-allow-private-network",
  "timing-allow-origin",
  // Encoding/transfer — we handle these ourselves
  "vary",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  // Cookie management is handled by our jar
  "set-cookie",
  "clear-site-data",
  // Reporting endpoints — don't proxy these back
  "report-to",
  "nel",
  "expect-ct",
  "permissions-policy",
  "feature-policy",
]);

