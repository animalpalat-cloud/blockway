/**
 * Shared URL helpers, security checks, and proxy URL builders.
 *
 * This module is aware of BOTH routing modes:
 *   1. Query-param mode:   daddyproxy.com/proxy?url=https://example.com/path
 *   2. Subdomain mode:     example--com.daddyproxy.com/path   ← preferred
 *
 * rewriteUrlToProxy() is the single entry point for all URL rewriting.
 * It delegates to subdomainRouter.ts based on PROXY_ROOT_DOMAIN env var.
 */

import { isSubdomainModeEnabled, rewriteUrlToProxy as _subdomainRewrite } from "./subdomainRouter";

const BLOCKED_PROTOCOLS = new Set([
  "file:", "ftp:", "ws:", "wss:", "data:", "javascript:", "gopher:", "blob:",
]);

export const PROXY_PATH    = "/proxy";
export const SESSION_COOKIE = "__ph_jar";

// ─── URL builders ──────────────────────────────────────────────────────────────

/**
 * The ONE function all rewriters call to produce a proxied URL.
 *
 * In subdomain mode:  https://cdn.example.com/img.png
 *                  →  https://cdn--example--com.daddyproxy.com/img.png
 *
 * In query-param mode: https://cdn.example.com/img.png
 *                  →  /proxy?url=https%3A%2F%2Fcdn.example.com%2Fimg.png&ref=...
 */
export function proxyParamUrl(absolute: string, documentPageUrl?: string): string {
  if (isSubdomainModeEnabled()) {
    return _subdomainRewrite(absolute, documentPageUrl);
  }
  // Legacy query-param fallback
  let u = `${PROXY_PATH}?url=${encodeURIComponent(absolute)}`;
  if (documentPageUrl) {
    const t = documentPageUrl.trim();
    if (t.length > 0 && t.length <= 8_192) {
      u += `&ref=${encodeURIComponent(t)}`;
    }
  }
  return u;
}

// ─── URL parsing ───────────────────────────────────────────────────────────────

export function normalizeUrl(input: string): URL | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return new URL(candidate); } catch { return null; }
}

// ─── Security ─────────────────────────────────────────────────────────────────

export function isBlockedTarget(url: URL): boolean {
  if (BLOCKED_PROTOCOLS.has(url.protocol)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const h = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(h)) return true;
  if (h.endsWith(".local")) return true;
  // SSRF protection
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

// ─── Rewrite helpers ───────────────────────────────────────────────────────────

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
