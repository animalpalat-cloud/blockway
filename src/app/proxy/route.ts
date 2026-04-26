/**
 * Self-contained proxy route handler.
 * Fetches the target URL server-side and rewrites HTML/CSS so all
 * asset links stay on the same origin — no separate backend needed.
 */
import * as cheerio from "cheerio";
import { type NextRequest, NextResponse } from "next/server";

// ─── Config ──────────────────────────────────────────────────────────────────
const TIMEOUT_MS  = 20_000;
const MAX_SIZE_MB = 12;

// ─── Security: blocked protocols & targets ────────────────────────────────────
const BLOCKED_PROTOCOLS = new Set([
  "file:", "ftp:", "ws:", "wss:", "data:", "javascript:", "gopher:",
]);

function normalizeUrl(input: string): URL | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return new URL(candidate); } catch { return null; }
}

function isBlockedTarget(url: URL): boolean {
  if (BLOCKED_PROTOCOLS.has(url.protocol)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const h = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(h)) return true;
  if (h.endsWith(".local")) return true;
  // Block private IPv4 ranges
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

// ─── Headers ─────────────────────────────────────────────────────────────────
const STRIP_HEADERS = new Set([
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
]);

// ─── Rewriting helpers ────────────────────────────────────────────────────────
function proxyHref(absolute: string): string {
  return `/proxy?url=${encodeURIComponent(absolute)}`;
}

function skipRewrite(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return !t || t.startsWith("#") || t.startsWith("data:") ||
         t.startsWith("javascript:") || t.startsWith("mailto:") || t.startsWith("tel:");
}

function rewriteHtml(html: string, base: string): string {
  const $ = cheerio.load(html, { decodeEntities: false });

  const ATTRS: { sel: string; attr: string }[] = [
    { sel: "a[href]",       attr: "href"   },
    { sel: "img[src]",      attr: "src"    },
    { sel: "script[src]",   attr: "src"    },
    { sel: "link[href]",    attr: "href"   },
    { sel: "iframe[src]",   attr: "src"    },
    { sel: "source[src]",   attr: "src"    },
    { sel: "video[src]",    attr: "src"    },
    { sel: "audio[src]",    attr: "src"    },
    { sel: "form[action]",  attr: "action" },
    { sel: "object[data]",  attr: "data"   },
  ];

  ATTRS.forEach(({ sel, attr }) => {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v || skipRewrite(v)) return;
      try { $(el).attr(attr, proxyHref(new URL(v, base).toString())); } catch { /* keep original */ }
    });
  });

  $("[srcset]").each((_, el) => {
    const v = $(el).attr("srcset");
    if (!v) return;
    const rewritten = v.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url   = parts[0];
      const desc  = parts.slice(1).join(" ");
      if (!url || skipRewrite(url)) return entry;
      try {
        const abs = new URL(url, base).toString();
        return desc ? `${proxyHref(abs)} ${desc}` : proxyHref(abs);
      } catch { return entry; }
    }).join(", ");
    $(el).attr("srcset", rewritten);
  });

  $("head").prepend(
    `<base href="${base}"><meta name="referrer" content="no-referrer">`,
  );

  return $.html();
}

function rewriteCss(css: string, base: string): string {
  return css.replace(/url\((['"]?)(.*?)\1\)/gi, (match, q, url) => {
    if (skipRewrite(url)) return match;
    try { return `url(${q}${proxyHref(new URL(url, base).toString())}${q})`; }
    catch { return match; }
  });
}

// ─── Core proxy logic ─────────────────────────────────────────────────────────
async function doProxy(targetUrlStr: string, reqHeaders: Headers): Promise<NextResponse> {
  const parsed = normalizeUrl(targetUrlStr);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid URL." }, { status: 400 });
  }
  if (isBlockedTarget(parsed)) {
    return NextResponse.json(
      { error: "Target URL is blocked for security reasons." },
      { status: 403 },
    );
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      method:   "GET",
      redirect: "follow",
      signal:   controller.signal,
      headers: {
        "user-agent":
          reqHeaders.get("user-agent") ??
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        accept:
          reqHeaders.get("accept") ??
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language":
          reqHeaders.get("accept-language") ?? "en-US,en;q=0.9",
        "cache-control": "no-cache",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json({ error: "Request timed out." }, { status: 504 });
    }
    const msg = err instanceof Error ? err.message : "Could not reach target URL.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  clearTimeout(timer);

  // Size guard
  const maxBytes     = MAX_SIZE_MB * 1024 * 1024;
  const declaredSize = Number(upstream.headers.get("content-length") ?? 0);
  if (declaredSize && declaredSize > maxBytes) {
    return NextResponse.json({ error: "Response too large." }, { status: 413 });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl    = upstream.url || parsed.toString();

  let bodyBuffer = Buffer.from(await upstream.arrayBuffer());
  if (bodyBuffer.length > maxBytes) {
    return NextResponse.json({ error: "Response too large." }, { status: 413 });
  }

  // Rewrite HTML / CSS
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  const isCss  = contentType.includes("text/css");

  if (isHtml) {
    bodyBuffer = Buffer.from(rewriteHtml(bodyBuffer.toString("utf-8"), finalUrl), "utf-8");
  } else if (isCss) {
    bodyBuffer = Buffer.from(rewriteCss(bodyBuffer.toString("utf-8"), finalUrl), "utf-8");
  }

  // Build clean response headers
  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) resHeaders.set(key, value);
  });

  if (isHtml) resHeaders.set("content-type", "text/html; charset=utf-8");
  if (isCss)  resHeaders.set("content-type", "text/css; charset=utf-8");

  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.set("x-proxy-final-url", finalUrl);

  return new NextResponse(bodyBuffer, { status: upstream.status, headers: resHeaders });
}

// ─── Route exports ─────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  return doProxy(url, request.headers);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { url?: string };
    return doProxy(body?.url ?? "", request.headers);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
}
