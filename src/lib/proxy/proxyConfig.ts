import type { NextRequest } from "next/server";

export const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 45_000;
export const PROXY_PUPPETEER_TIMEOUT_MS =
  Number(process.env.PROXY_PUPPETEER_TIMEOUT_MS) || 60_000;
export const PROXY_PUPPETEER_SETTLE_MS =
  Number(process.env.PROXY_PUPPETEER_SETTLE_MS) || 2_000;
export const MAX_SIZE_MB = Number(process.env.PROXY_MAX_SIZE_MB) || 32;

/** Set PROXY_PUPPETEER=0 to disable Puppeteer entirely (e.g. low-memory VPS). */
export const PROXY_PUPPETEER_ENABLED = process.env.PROXY_PUPPETEER !== "0";

/**
 * Sites that are known to require full browser rendering.
 * These are sent through Puppeteer automatically.
 */
const DEFAULT_HEADLESS_HOSTS = [
  // Video platforms
  "youtube.com", "www.youtube.com", "youtu.be",
  "vimeo.com", "www.vimeo.com",
  // Social media
  "twitter.com", "x.com", "www.x.com",
  "facebook.com", "www.facebook.com",
  "instagram.com", "www.instagram.com",
  "linkedin.com", "www.linkedin.com",
  "tiktok.com", "www.tiktok.com",
  "snapchat.com", "www.snapchat.com",
  "pinterest.com", "www.pinterest.com",
  // Reddit family
  "reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com",
  "redd.it",
  // News sites with heavy JS
  "nytimes.com", "www.nytimes.com",
  "washingtonpost.com", "www.washingtonpost.com",
  "wsj.com", "www.wsj.com",
  // Google properties
  "google.com", "www.google.com",
  "google.co.uk", "google.com.pk",
  // Cloudflare-protected sites (detected separately, but list some common ones)
  "cloudflare.com", "www.cloudflare.com",
];

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
 * Cloudflare challenge / bot-protection heuristics.
 * When detected, we automatically escalate to Puppeteer which can solve JS challenges.
 */
function looksLikeCloudflareProtected(_request: NextRequest, target: URL): boolean {
  const q = target.search.toLowerCase();
  const p = target.pathname.toLowerCase();
  if (p.includes("/cdn-cgi/")) return true;
  if (
    q.includes("__cf_chl_tk") ||
    q.includes("cf_chl_") ||
    q.includes("__cf_chl_rt_tk")
  ) return true;
  return false;
}

/**
 * Determines whether the top-level HTML document should be fetched via Puppeteer.
 * Individual sub-resources (CSS, JS, images) always use the fast fetch path.
 */
export function shouldRenderHtmlWithPuppeteer(
  request: NextRequest,
  target: URL,
): boolean {
  if (!PROXY_PUPPETEER_ENABLED) return false;

  // Explicit override via query param
  const sp = request.nextUrl.searchParams;
  if (sp.get("headless") === "1" || sp.get("render") === "1") return true;
  if (sp.get("headless") === "0" || sp.get("render") === "0") return false;

  // Host-based auto-detection
  const list = parsedHeadlessHostList();
  if (list.length > 0 && hostnameMatchesList(target.hostname, list)) return true;

  // Cloudflare challenge detection
  if (looksLikeCloudflareProtected(request, target)) return true;

  return false;
}
