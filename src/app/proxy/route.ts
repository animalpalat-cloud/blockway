/**
 * Self-contained proxy route handler.
 * Fetches the target URL server-side and rewrites HTML/CSS so assets
 * can load through the same origin. Optional runtime patch for fetch/XHR
 * helps many SPAs (e.g. Reddit) that call same-origin APIs from JS.
 */
import * as cheerio from "cheerio";
import { type NextRequest, NextResponse } from "next/server";

// ── Next.js: never cache /proxy (stale assets break pages) ───────────────────
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ── Config ────────────────────────────────────────────────────────────────────
const TIMEOUT_MS  = 30_000;
const MAX_SIZE_MB = 20;

// Hop-by-hop & unsafe — never forward to upstream
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
  "cookie", // do not send our site cookies to arbitrary upstreams
  "authorization", // do not forward user secrets to target sites
]);

// Do not pass these from *upstream* response* to the browser
const STRIP_RESPONSE = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie", // our origin ≠ target; passing Set-Cookie is misleading
  "clear-site-data",
]);

// ─── URL helpers ────────────────────────────────────────────────────────────
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

function proxyHref(absolute: string): string {
  return `/proxy?url=${encodeURIComponent(absolute)}`;
}

function skipRewrite(v: string): boolean {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return true;
  if (t.startsWith("#") || t.startsWith("data:") || t.startsWith("javascript:") ||
      t.startsWith("mailto:") || t.startsWith("tel:") || t.startsWith("about:") ||
      t === "void(0)" || t === "void(0);") return true;
  return false;
}

function absUrl(value: string, base: string): string | null {
  if (skipRewrite(value)) return null;
  try {
    return new URL(value, base).toString();
  } catch { return null; }
}

// ─── HTML rewriting ───────────────────────────────────────────────────────────
/** Attributes that contain a single resource URL. */
const URL_ATTRS: { sel: string; attr: string }[] = [
  { sel: "a[href]",          attr: "href" },
  { sel: "area[href]",        attr: "href" },
  { sel: "link[href]",        attr: "href" },
  { sel: "img[src]",          attr: "src" },
  { sel: "img[data-src]",     attr: "data-src" },
  { sel: "img[data-original]", attr: "data-original" },
  { sel: "img[data-lazy]",    attr: "data-lazy" },
  { sel: "img[data-lazy-src]", attr: "data-lazy-src" },
  { sel: "script[src]",        attr: "src" },
  { sel: "iframe[src]",        attr: "src" },
  { sel: "embed[src]",         attr: "src" },
  { sel: "object[data]",        attr: "data" },
  { sel: "source[src]",        attr: "src" },
  { sel: "track[src]",         attr: "src" },
  { sel: "video[src]",         attr: "src" },
  { sel: "video[poster]",      attr: "poster" },
  { sel: "audio[src]",         attr: "src" },
  { sel: "form[action]",      attr: "action" },
  { sel: "use[href]",         attr: "href" },
  { sel: "image[href]",        attr: "href" },
  { sel: "source[data-src]",   attr: "data-src" },
  { sel: "source[data-srcset]", attr: "data-srcset" },
];

function rewriteStyleAttr(style: string, base: string): string {
  return style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _q, url) => {
    const t = (url as string).trim();
    if (skipRewrite(t)) return match;
    const abs = absUrl(t, base);
    if (!abs) return match;
    return `url(${proxyHref(abs)})`;
  });
}

function rewriteSrcset(value: string, base: string): string {
  return value.split(",").map((entry) => {
    const p = entry.trim().split(/\s+/);
    const u = p[0];
    const rest = p.slice(1).join(" ");
    if (!u || skipRewrite(u)) return entry;
    const abs = absUrl(u, base);
    if (!abs) return entry;
    return rest ? `${proxyHref(abs)} ${rest}` : proxyHref(abs);
  }).join(", ");
}

function rewriteImportMapJson(text: string, base: string): string {
  try {
    const j = JSON.parse(text) as { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> };
    if (j.imports) {
      for (const k of Object.keys(j.imports)) {
        const v = j.imports[k];
        if (typeof v !== "string") continue;
        const abs = absUrl(v, base) ?? new URL(v, base).toString();
        j.imports[k] = proxyHref(abs);
      }
    }
    if (j.scopes) {
      for (const scope of Object.values(j.scopes)) {
        for (const k of Object.keys(scope)) {
          const v = scope[k];
          if (typeof v === "string") {
            const abs = absUrl(v, base) ?? new URL(v, base).toString();
            scope[k] = proxyHref(abs);
          }
        }
      }
    }
    return JSON.stringify(j);
  } catch { return text; }
}

/**
 * Injected at top of <head>. Redirects same-origin fetches to /proxy?url=…
 * so client-side code that calls the site's own API (e.g. Reddit) still works
 * from our origin. (Does not cover WebSocket, import(), or all edge cases.)
 */
function buildRuntimePatch(origin: string): string {
  const O = JSON.stringify(origin);
  return [
    "(function(){",
    "var O=" + O + ";",
    "function p(u){if(u==null||u==='')return u;try{",
    "var s=String(u),a=/^[a-zA-Z][a-zA-Z+.-]*:/.test(s)?new URL(s):new URL(s,O);",
    "if(a.origin===O)return '/proxy?url='+encodeURIComponent(a.href);",
    "}catch(e){}return u;}",
    "if(typeof window.fetch==='function'){",
    "var _f=window.fetch;window.fetch=function(i,init){",
    "if(typeof i==='string')return _f.call(this,p(i),init);",
    "return _f.call(this,i,init);};",
    "}",
    "if(window.XMLHttpRequest){",
    "var _o=XMLHttpRequest.prototype.open;",
    "XMLHttpRequest.prototype.open=function(){",
    "var a=[].slice.call(arguments);a[1]=p(a[1]);return _o.apply(this,a);};",
    "}",
    "})();",
  ].join("");
}

function rewriteHtml(html: string, base: string, injectPatch: boolean): string {
  const $ = cheerio.load(html, { xml: false });

  // 1) URL attributes
  for (const { sel, attr } of URL_ATTRS) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const abs = absUrl(v, base);
      if (abs) $(el).attr(attr, proxyHref(abs));
    });
  }

  // 2) Any [srcset] / [data-srcset] / [imagesrcset] (include link preload)
  $("[srcset], [data-srcset], [imagesrcset]").each((_, el) => {
    for (const a of ["srcset", "data-srcset", "imagesrcset"] as const) {
      const v = $(el).attr(a);
      if (v) $(el).attr(a, rewriteSrcset(v, base));
    }
  });

  // 3) Inline style url()
  $("[style]").each((_, el) => {
    const s = $(el).attr("style");
    if (s) $(el).attr("style", rewriteStyleAttr(s, base));
  });

  // 4) style tags (inline CSS)
  $("style").each((_, el) => {
    const t = $(el).html();
    if (t) $(el).html(rewriteCss(t, base));
  });

  // 5) importmap
  {
    const sel = 'script[type="importmap"], script[type="importmap+json"]';
    $(sel).each((_, el) => {
      const t = $(el).html();
      if (t) $(el).html(rewriteImportMapJson(t, base));
    });
  }

  // 6) meta refresh
  $("meta").each((_, el) => {
    const h = String($(el).attr("http-equiv") ?? "");
    if (h.toLowerCase() !== "refresh") return;
    const c = $(el).attr("content");
    if (!c) return;
    const m = c.match(/url\s*=\s*(['"]?)([^'";]+)\1/i);
    if (m?.[2]) {
      const abs = absUrl(m[2], base);
      if (abs) $(el).attr("content", c.replace(m[0], `url=${proxyHref(abs)}`));
    }
  });

  // 7) Base + referrer + optional runtime patch (first in <head>)
  const safeBase = base.replace(/"/g, "&quot;");
  const headInject = [
    `<base href="${safeBase}">`,
    '<meta name="referrer" content="no-referrer">',
  ];
  if (injectPatch) {
    const origin = new URL(base).origin;
    headInject.push(
      `<script data-proxy-patch="1">\n${buildRuntimePatch(origin)}\n<\/script>`,
    );
  }
  $("head").prepend(headInject.join(""));

  return $.html();
}

// ─── CSS rewriting ──────────────────────────────────────────────────────────
function rewriteCss(css: string, base: string): string {
  let out = css;

  // url( ... ) — also catches @import url(...)
  out = out.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _q, url) => {
    const t = String(url).trim();
    if (skipRewrite(t)) return match;
    const abs = absUrl(t, base);
    if (!abs) return match;
    return `url(\"${proxyHref(abs)}\")`;
  });

  // @import "foo.css" (no url())
  out = out.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (match, _q, path: string) => {
      if (skipRewrite(path)) return match;
      const abs = absUrl(path, base);
      if (!abs) return match;
      return `@import \"${proxyHref(abs)}\"`;
    },
  );

  return out;
}

// ─── Upstream request headers ──────────────────────────────────────────────
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function buildUpstreamRequestHeaders(incoming: Headers, target: URL): Headers {
  const out = new Headers();

  // Copy everything from the browser that is safe (Sec-Fetch-*, Sec-CH-*, Accept, …)
  incoming.forEach((value, key) => {
    const l = key.toLowerCase();
    if (HOP_BY_HOP.has(l)) return;
    // Never send our-site session to the target origin
    if (l === "cookie" || l === "authorization") return;
    out.set(key, value);
  });

  // Realistic defaults when the client omits them (server-side fetch)
  if (!out.get("user-agent")) out.set("user-agent", DEFAULT_UA);
  if (!out.get("accept-language")) out.set("accept-language", "en-US,en;q=0.9");
  if (!out.get("accept")) {
    out.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    );
  }
  if (!out.get("accept-encoding")) out.set("accept-encoding", "br, gzip, deflate");

  // Looks like a first-party request to the target (helps CDNs / anti-bot)
  out.set("referer", `${target.origin}/`);
  out.set("origin", target.origin);
  out.set("cache-control", "no-cache");
  return out;
}

// ─── Core proxy ──────────────────────────────────────────────────────────────
async function doProxy(
  targetUrlStr: string,
  reqHeaders: Headers,
  method: "GET" | "HEAD" = "GET",
): Promise<NextResponse> {
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
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream: Response;
  try {
    const headers = buildUpstreamRequestHeaders(reqHeaders, parsed);
    upstream = await fetch(parsed.toString(), {
      method: method,
      redirect: "follow",
      signal:   controller.signal,
      headers,
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

  const maxBytes = MAX_SIZE_MB * 1024 * 1024;
  const cl = Number(upstream.headers.get("content-length") ?? 0);
  if (cl && cl > maxBytes) {
    return NextResponse.json({ error: "Response too large." }, { status: 413 });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const finalUrl = upstream.url || parsed.toString();
  const fullBody = method !== "HEAD";
  const buf = fullBody
    ? Buffer.from(await upstream.arrayBuffer())
    : Buffer.alloc(0);
  if (buf.length > maxBytes) {
    return NextResponse.json({ error: "Response too large." }, { status: 413 });
  }

  const ct = contentType.toLowerCase();
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml+xml");
  const isCss  = ct.includes("text/css");
  // Some servers mislabel; sniff HTML
  const sniffHtml =
    isHtml || (ct.includes("text/plain") && /^\s*</.test(buf.toString("utf-8", 0, 512)));

  let body: Buffer = buf;
  if (fullBody && sniffHtml) {
    body = Buffer.from(rewriteHtml(buf.toString("utf-8"), finalUrl, true), "utf-8");
  } else if (fullBody && isCss) {
    body = Buffer.from(rewriteCss(buf.toString("utf-8"), finalUrl), "utf-8");
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) resHeaders.set(key, value);
  });

  if (sniffHtml) {
    resHeaders.set("content-type", "text/html; charset=utf-8");
  } else if (isCss) {
    resHeaders.set("content-type", "text/css; charset=utf-8");
  }
  // Prevent caching of proxied HTML/JS in browser (stale bundles)
  resHeaders.set("cache-control", "no-store, no-cache, must-revalidate, private");
  resHeaders.set("pragma", "no-cache");
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.set("access-control-expose-headers", "x-proxy-final-url, content-type");
  resHeaders.set("x-proxy-final-url", finalUrl);
  if (resHeaders.has("content-length")) {
    resHeaders.delete("content-length");
  }
  if (resHeaders.has("content-encoding")) {
    resHeaders.delete("content-encoding");
  }

  return new NextResponse(
    new Uint8Array(body),
    { status: upstream.status, headers: resHeaders },
  );
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// ─── Exports ────────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url) return jsonError("Missing url query parameter.", 400);
  return doProxy(url, request.headers, "GET");
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { url?: string };
    return doProxy(body?.url ?? "", request.headers, "GET");
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
}

export async function HEAD(request: NextRequest) {
  const url = request.nextUrl.searchParams.get("url") ?? "";
  if (!url) return new NextResponse(null, { status: 400 });
  return doProxy(url, request.headers, "HEAD");
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Language, Accept-Encoding",
      "Access-Control-Max-Age":       "86400",
    },
  });
}
