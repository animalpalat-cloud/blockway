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
  // do not pass browser's Cookie to target — we use jar instead
  "cookie",
  "authorization",
]);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Build headers for upstream fetch. Merges replay cookies from the session jar.
 */
export function buildUpstreamRequestHeaders(
  incoming: Headers,
  target: URL,
  options: { sessionId: string; jarHost: string },
): Headers {
  const out = new Headers();

  incoming.forEach((value, key) => {
    const l = key.toLowerCase();
    if (HOP_BY_HOP.has(l)) return;
    if (l === "cookie" || l === "authorization") return;
    out.set(key, value);
  });

  if (!out.get("user-agent")) out.set("user-agent", DEFAULT_UA);
  if (!out.get("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  if (!out.get("accept")) {
    out.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    );
  }
  if (!out.get("accept-encoding")) {
    out.set("accept-encoding", "br, gzip, deflate");
  }

  const jar = cookieHeaderForHost(options.sessionId, options.jarHost);
  if (jar) {
    out.set("cookie", jar);
  }

  out.set("referer", `${target.origin}/`);
  out.set("origin", target.origin);
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
  "accept-encoding", // set by the browser; avoids mismatch
  "user-agent", // set via page.setUserAgent
  "sec-fetch-dest", // can break navigation; browser sets
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-fetch-storage-access",
  "upgrade-insecure-requests",
  "trailer",
  "te",
  "expect",
  "date",
  "dnt", // may be disallowed; skip if needed
  "alt-used",
  "http2-settings",
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
    o["Accept"] =
      h.get("accept") ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
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
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "clear-site-data",
]);
