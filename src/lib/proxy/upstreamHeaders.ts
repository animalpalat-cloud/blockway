import {
  buildAcceptForKind,
  buildRefererAndOrigin,
  buildSecFetchHeaders,
  inferResourceKind,
  pickAcceptLanguage,
  pickUserAgentForUpstream,
  pickSecChUa,
  DEFAULT_ACCEPT_ENCODING,
} from "./browserHeaders";
import { cookieHeaderForHost } from "./cookieJar";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
  "max-forwards",
  "cookie",
  "authorization",
]);

/** Replaced with browser-like values so the upstream sees a real client, not a generic bot. */
const INCOMING_STRIP = new Set([
  "user-agent",
  "accept",
  "accept-language",
  "accept-encoding",
  "referer",
  "origin",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-fetch-dest-fragment",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "downlink",
  "dpr",
  "save-data",
  "viewport-width",
  "width",
  "device-memory",
  "rtt",
  "ect",
  "priority",
  ...HOP_BY_HOP,
]);

export type UpstreamRequestOptions = {
  sessionId: string;
  jarHost: string;
  /** From `&ref=` — page URL to send as `Referer` / `Origin` for cross-origin CDN requests */
  documentReferer?: string | null;
};

/**
 * Build headers for upstream fetch. Uses a **rotated** Chrome-like User-Agent,
 * `Accept*`, `Sec-Fetch-*`, and `Referer`/`Origin` derived from the target URL
 * and optional `documentReferer` (mirrors a browser subresource or navigation).
 */
export function buildUpstreamRequestHeaders(
  incoming: Headers,
  target: URL,
  options: UpstreamRequestOptions,
): Headers {
  const out = new Headers();
  const ref = options.documentReferer ?? null;
  const kind = inferResourceKind(target);

  incoming.forEach((value, key) => {
    const l = key.toLowerCase();
    if (INCOMING_STRIP.has(l)) return;
    if (l === "cookie" || l === "authorization") return;
    out.set(key, value);
  });

  out.set("user-agent", pickUserAgentForUpstream());
  out.set("accept", buildAcceptForKind(kind));
  out.set("accept-language", pickAcceptLanguage());
  out.set("accept-encoding", DEFAULT_ACCEPT_ENCODING);

  const ua = out.get("user-agent") || "";
  const ch = pickSecChUa(ua);
  Object.entries(ch).forEach(([k, v]) => out.set(k, v));

  const { referer, origin } = buildRefererAndOrigin(target, ref);
  out.set("referer", referer);
  out.set("origin", origin);

  const sec = buildSecFetchHeaders(target, kind, ref);
  out.set("sec-fetch-dest", sec["sec-fetch-dest"]);
  out.set("sec-fetch-mode", sec["sec-fetch-mode"]);
  out.set("sec-fetch-site", sec["sec-fetch-site"]);
  out.set("sec-fetch-user", sec["sec-fetch-user"]);
  if (target.protocol === "https:") {
    out.set("upgrade-insecure-requests", "1");
  }

  const jar = cookieHeaderForHost(options.sessionId, options.jarHost);
  if (jar) {
    out.set("cookie", jar);
  }

  out.set("cache-control", "no-cache");
  return out;
}

const NOT_FOR_PUPPETEER_EXTRA = new Set([
  "cookie",
  "host",
  "connection",
  "content-length",
  "referer",
  "origin",
  "accept-encoding",
  "user-agent",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-fetch-storage-access",
  "upgrade-insecure-requests",
  "trailer",
  "te",
  "expect",
  "date",
  "dnt",
  "alt-used",
  "http2-settings",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
]);

function recordHasHeader(o: Record<string, string>, lname: string): boolean {
  return Object.keys(o).some((k) => k.toLowerCase() === lname);
}

/**
 * Key/value object for `page.setExtraHTTPHeaders`. Do not set Cookie, Referer,
 * or User-Agent here — those are applied via setCookie, goto#referer, setUserAgent.
 */
export function headersToForwardForPuppeteer(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((value, key) => {
    const l = key.toLowerCase();
    if (NOT_FOR_PUPPETEER_EXTRA.has(l)) return;
    if (l === "x-forwarded-for" || l === "x-forwarded-proto" || l === "x-forwarded-host")
      return;
    o[key] = value;
  });
  if (!recordHasHeader(o, "accept")) {
    o["Accept"] = h.get("accept") || "";
  }
  if (!recordHasHeader(o, "accept-language")) {
    o["Accept-Language"] = h.get("accept-language") || "en-US,en;q=0.9";
  }
  return o;
}

export const STRIP_FROM_RESPONSE = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
  "access-control-allow-private-network",
  "timing-allow-origin",
  "vary",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "clear-site-data",
]);
