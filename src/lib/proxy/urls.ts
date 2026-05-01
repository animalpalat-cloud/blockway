/** Shared URL + security checks for the proxy. */

const BLOCKED_PROTOCOLS = new Set([
  "file:", "ftp:", "ws:", "wss:", "data:", "javascript:", "gopher:", "blob:",
]);

export const PROXY_PATH = "/proxy";
export const SESSION_COOKIE = "__ph_jar";

/**
 * @param documentPageUrl — current document URL, sent as `&ref=` so the proxy can send a
 *   realistic `Referer`/`Origin` to cross-origin CDNs.
 */
export function proxyParamUrl(absolute: string, documentPageUrl?: string): string {
  let u = `${PROXY_PATH}?url=${encodeURIComponent(absolute)}`;
  if (documentPageUrl) {
    const t = documentPageUrl.trim();
    if (t.length > 0 && t.length <= 8_192) {
      u += `&ref=${encodeURIComponent(t)}`;
    }
  }
  if (/[()\[\]]/.test(absolute) || /[()]/.test(u)) {

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
  
  // 1. Literal hostnames
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "::", "0:0:0:0:0:0:0:1"].includes(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".test") || h.endsWith(".invalid") || h.endsWith(".example")) return true;

  // 2. IPv4 Decimal/Hex/Octal bypass protection
  // Node's new URL() normalizes most of these to dotted-quad, so we check the result.
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
    if (a >= 224) return true; // Multicast/Reserved
  }

  // 3. IPv6 Private/Reserved ranges
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80:")) return true; // Link-local
    if (v6.startsWith("fc00:") || v6.startsWith("fd00:")) return true; // Unique local
    if (v6.startsWith("ff00:")) return true; // Multicast
  }

  return false;
}

export function skipRewrite(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return true;
  if (t.startsWith("#") || t.startsWith("data:") || t.startsWith("javascript:") ||
      t.startsWith("mailto:") || t.startsWith("tel:") || t.startsWith("about:") ||
      t === "void(0)" || t === "void(0);") return true;
  if (t.startsWith("blob:") || t.startsWith("chrome-extension:")) return true;
  return false;
}

export function absUrl(value: string, base: string): string | null {
  if (skipRewrite(value)) return null;
  try { return new URL(value, base).toString(); } catch { return null; }
}

/** Heuristic: attribute value might be a linkable URL worth proxying. */
export function isLikelyUrl(value: string): boolean {
  const t = (value ?? "").trim();
  if (!t || t.length > 8_000) return false;
  if (/^#/.test(t)) return false;
  if (/^javascript:/i.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\/\//.test(t)) return true;
  if (/^\/(?!\/)/.test(t)) return true; // same-origin path on target
  if (/^\.\.?\//.test(t)) return true;
  return false;
}
