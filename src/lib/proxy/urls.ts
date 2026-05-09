/**
 * Shared URL helpers, security checks, and proxy URL builders.
 */

import { isSubdomainModeEnabled, rewriteUrlToProxy as _subdomainRewrite } from "./subdomainRouter";

const BLOCKED_PROTOCOLS = new Set([
  "file:", "ftp:", "ws:", "wss:", "data:", "javascript:", "gopher:", "blob:",
]);

export const PROXY_PATH    = "/proxy";
export const SESSION_COOKIE = "__ph_jar";

export function proxyParamUrl(absolute: string, documentPageUrl?: string): string {
  const docIsQueryParam = documentPageUrl
    ? documentPageUrl.includes("/proxy?url=") || documentPageUrl.includes("/proxy%3Furl")
    : false;

  if (isSubdomainModeEnabled() && !docIsQueryParam) {
    return _subdomainRewrite(absolute, documentPageUrl);
  }

  let u = `${PROXY_PATH}?url=${encodeURIComponent(absolute)}`;
  if (documentPageUrl) {
    const t = documentPageUrl.trim();
    if (t.length > 0 && t.length <= 8_192) {
      u += `&ref=${encodeURIComponent(t)}`;
    }
  }
  return u;
}

export function normalizeUrl(input: string): URL | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return new URL(candidate); } catch { return null; }
}

export function isBlockedTarget(url: URL): boolean {
  if (BLOCKED_PROTOCOLS.has(url.protocol)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const h = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(h)) return true;
  if (h.endsWith(".local")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

// Hosts we NEVER proxy — leave their URLs unchanged in HTML.
// IMPORTANT: accounts.google.com is REMOVED from this list.
// It must be proxied so Google auth requests go through our server
// instead of directly from the browser (which causes CORS blocks).
const PASSTHROUGH_HOSTS = new Set([
  // Public font/CDN — no need to proxy, fast and open
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "ajax.googleapis.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "unpkg.com",
  // Analytics — not needed for proxy functionality
  "ssl.google-analytics.com",
  "www.google-analytics.com",
  // NOTE: accounts.google.com intentionally NOT in this list
  // NOTE: maps.googleapis.com intentionally NOT in this list
  // Both must be proxied to prevent CORS errors on Google auth pages
]);

export function skipRewrite(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return true;
  if (t.startsWith("#") || t.startsWith("data:") || t.startsWith("javascript:") ||
      t.startsWith("mailto:") || t.startsWith("tel:") || t.startsWith("about:") ||
      t === "void(0)" || t === "void(0);") return true;
  if (t.startsWith("blob:") || t.startsWith("chrome-extension:")) return true;

  try {
    const u = new URL(t);
    if (PASSTHROUGH_HOSTS.has(u.hostname)) return true;
  } catch { /* not a full URL, continue */ }

  return false;
}

export function absUrl(value: string, base: string): string | null {
  if (skipRewrite(value)) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

export function isLikelyUrl(value: string): boolean {
  const t = (value ?? "").trim();
  if (!t || t.length > 8_000) return false;
  if (/^#/.test(t)) return false;
  if (/^javascript:/i.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\/\//.test(t)) return true;
  if (/^\/(?!\/)/.test(t)) return true;
  if (/^\.\.\?\//.test(t)) return true;
  return false;
}