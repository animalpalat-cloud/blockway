import type { NextRequest } from "next/server";

export const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 45_000;
export const PROXY_PUPPETEER_TIMEOUT_MS =
  Number(process.env.PROXY_PUPPETEER_TIMEOUT_MS) || 60_000;
export const PROXY_PUPPETEER_SETTLE_MS =
  Number(process.env.PROXY_PUPPETEER_SETTLE_MS) || 1_500;
export const MAX_SIZE_MB = Number(process.env.PROXY_MAX_SIZE_MB) || 32;

/** "0" disables the Puppeteer path entirely. */
export const PROXY_PUPPETEER_ENABLED = process.env.PROXY_PUPPETEER !== "0";

const DEFAULT_HEADLESS_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "twitter.com",
  "x.com",
  "www.x.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "tiktok.com",
  "www.tiktok.com",
];

/**
 * Comma-separated hostnames (or suffix match). If empty, only
 * `?headless=1` / `?render=1` triggers Puppeteer.
 */
function parsedHeadlessHostList(): string[] {
  const raw = process.env.PROXY_PUPPETEER_HOSTS;
  if (raw === undefined) return DEFAULT_HEADLESS_HOSTS;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameMatchesList(hostname: string, list: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const e of list) {
    if (e.startsWith("*.")) {
      const base = e.slice(2);
      if (h === base || h.endsWith(`.${base}`)) return true;
    } else if (h === e || h.endsWith(`.${e}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Lightweight Cloudflare challenge heuristics so problematic pages can
 * automatically use headless rendering.
 */
function looksLikeCloudflareProtected(request: NextRequest, target: URL): boolean {
  const q = target.search.toLowerCase();
  const p = target.pathname.toLowerCase();
  if (p.includes("/cdn-cgi/")) return true;
  if (
    q.includes("__cf_chl_tk") ||
    q.includes("cf_chl_") ||
    q.includes("__cf_chl_rt_tk")
  ) {
    return true;
  }

  const cookie = (request.headers.get("cookie") || "").toLowerCase();
  if (cookie.includes("cf_clearance=") || cookie.includes("__cf_bm=")) {
    return true;
  }

  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  if (ua.includes("cloudflare")) return true;

  return false;
}

/**
 * When to render the top-level HTML with Puppeteer (JS-heavy pages).
 * Assets and subresources still go through the normal fetch proxy.
 */
export function shouldRenderHtmlWithPuppeteer(
  request: NextRequest,
  target: URL,
): boolean {
  if (!PROXY_PUPPETEER_ENABLED) return false;
  const sp = request.nextUrl.searchParams;
  if (sp.get("headless") === "1" || sp.get("render") === "1") return true;
  if (sp.get("headless") === "0" || sp.get("render") === "0") return false;

  const list = parsedHeadlessHostList();
  if (list.length > 0 && hostnameMatchesList(target.hostname, list)) return true;
  if (looksLikeCloudflareProtected(request, target)) return true;
  return false;
}
