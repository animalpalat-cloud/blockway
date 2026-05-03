import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { buildClientRuntimePatch } from "./clientRuntime";
import { absUrl, isLikelyUrl, proxyParamUrl, skipRewrite } from "./urls";
import { getRootDomain, encodeHostToSubdomain, isSubdomainModeEnabled } from "./subdomainRouter";

const URL_ATTRS: { sel: string; attr: string }[] = [
  { sel: "a[href]",              attr: "href" },
  { sel: "img[src]",             attr: "src" },
  { sel: "img[longdesc]",        attr: "longdesc" },
  { sel: "link[href]",           attr: "href" },
  { sel: "script[src]",          attr: "src" },
  { sel: "iframe[src]",          attr: "src" },
  { sel: "source[src]",          attr: "src" },
  { sel: "video[src]",           attr: "src" },
  { sel: "video[poster]",        attr: "poster" },
  { sel: "audio[src]",           attr: "src" },
  { sel: "source[srcset]",       attr: "srcset" },
  { sel: "img[srcset]",          attr: "srcset" },
  { sel: "object[data]",         attr: "data" },
  { sel: "embed[src]",           attr: "src" },
  { sel: "input[src]",           attr: "src" },
  { sel: "track[src]",           attr: "src" },
  { sel: "image[href]",          attr: "href" },
  { sel: "image[xlink\\:href]",  attr: "xlink:href" },
  { sel: "[background]",         attr: "background" },
  { sel: "form[action]",         attr: "action" },
  { sel: "input[formaction]",    attr: "formaction" },
  { sel: "button[formaction]",   attr: "formaction" },
  { sel: "meta[content][http-equiv='refresh']", attr: "content" },
];

/**
 * Tracking/analytics scripts — we still strip these to reduce noise,
 * but we keep all CDN/media/asset scripts.
 */
const TRACKING_PATTERNS = [
  "google-analytics.com/analytics",
  "googletagmanager.com/gtag",
  "doubleclick.net",
  "hotjar.com",
  "fullstory.com",
  "heap.io",
  "mixpanel.com/lib",
  "segment.com/analytics",
];

function isTrackingScript(url: string): boolean {
  const s = url.toLowerCase();
  return TRACKING_PATTERNS.some((p) => s.includes(p));
}

function rewriteAttributeValue(val: string, base: string): string | null {
  const trimmed = (val ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return trimmed;
  if (skipRewrite(trimmed)) return null;
  // Already proxied in either mode
  if (trimmed.includes("/proxy?url=")) return null;
  if (isSubdomainModeEnabled()) {
    const root = getRootDomain();
    if (trimmed.includes(`.${root}`)) return null; // already subdomain-proxied
  }
  if (isTrackingScript(trimmed)) return null;
  if (!isLikelyUrl(val)) return null;
  const abs = absUrl(trimmed, base);
  if (!abs) return null;
  if (isTrackingScript(abs)) return null;
  return proxyParamUrl(abs, base); // proxyParamUrl is now subdomain-aware
}

function rewriteSrcsetValue(srcset: string, base: string): string {
  const splitCandidates = (value: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let depth = 0;
    for (const ch of value) {
      if (ch === "(") depth += 1;
      else if (ch === ")" && depth > 0) depth -= 1;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };

  return splitCandidates(String(srcset))
    .map((part) => {
      const token = part.trim();
      if (!token) return token;
      const bits = token.split(/\s+/);
      const url = bits[0] ?? "";
      const rewritten = rewriteAttributeValue(url, base) ?? url;
      return bits.length <= 1 ? rewritten : `${rewritten} ${bits.slice(1).join(" ")}`;
    })
    .join(", ");
}

function rewriteMetaRefresh(content: string, base: string): string {
  const m = content.match(/^(\d+(?:\.\d+)?\s*;?\s*url=)(.+)$/i);
  if (!m) return content;
  const rewritten = rewriteAttributeValue(m[2].trim(), base);
  return rewritten ? `${m[1]}${rewritten}` : content;
}

function applyCoreRewrites($: CheerioAPI, base: string): void {
  // Strip CSP — it would block our injected scripts
  $("meta").each((_, el) => {
    const he = String($(el).attr("http-equiv") ?? "").trim().toLowerCase();
    if (he === "content-security-policy" || he === "content-security-policy-report-only") {
      $(el).remove(); return;
    }
    const nm = String($(el).attr("name") ?? "").trim().toLowerCase();
    if (nm === "referrer" || nm === "content-security-policy" || nm === "csp") {
      $(el).remove();
    }
  });

  // Remove preconnect/DNS-prefetch — these would leak target hostname to CDNs
  $('link[rel="preconnect"], link[rel=preconnect], link[rel="dns-prefetch"], link[rel=dns-prefetch], link[rel="prerender"]').remove();

  // Remove SW manifests — they'd intercept our proxy SW
  $('link[rel="manifest"], link[rel=manifest]').remove();

  // Remove SRI hashes — rewriting changes content so hashes would fail
  $("[integrity]").removeAttr("integrity");

  // Remove use-credentials crossorigin — changes CORS mode
  $("[crossorigin]").each((_, el) => {
    if ($(el).attr("crossorigin") === "use-credentials") $(el).removeAttr("crossorigin");
  });

  // Rewrite all URL attributes
  for (const { sel, attr } of URL_ATTRS) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;

      if (attr === "srcset") {
        const next = rewriteSrcsetValue(v, base);
        if (next && next !== v) $(el).attr(attr, next);
        return;
      }

      if (attr === "content" && sel.includes("refresh")) {
        const next = rewriteMetaRefresh(v, base);
        if (next !== v) $(el).attr(attr, next);
        return;
      }

      if (sel === "link[href]") {
        const rel = String($(el).attr("rel") || "").toLowerCase();
        const isCss = rel.includes("stylesheet") || /\.css(?:$|\?)/i.test(v);
        if (!isCss) return;
      }

      const next = rewriteAttributeValue(v, base);
      if (next && next !== v) $(el).attr(attr, next);
    });
  }

  // Rewrite inline style url() references
  $("[style]").each((_, el) => {
    const style = $(el).attr("style") ?? "";
    const rewritten = rewriteInlineStyleUrls(style, base);
    if (rewritten !== style) $(el).attr("style", rewritten);
  });
}

function rewriteInlineStyleUrls(style: string, base: string): string {
  return style.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_match, quote, url) => {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("data:") || skipRewrite(trimmed)) return _match;
    const abs = absUrl(trimmed, base);
    if (!abs) return _match;
    const proxied = proxyParamUrl(abs, base);
    return `url(${quote}${proxied}${quote})`;
  });
}

function rewriteInertSubfragments($: CheerioAPI, base: string): void {
  $("template, noscript").each((_, el) => {
    const inner = $(el).html();
    if (inner) $(el).html(rewriteInertFragment(inner, base));
  });
}

function rewriteInertFragment(html: string, base: string): string {
  const $ = cheerio.load(html, { xml: false });
  applyCoreRewrites($, base);
  rewriteInertSubfragments($, base);
  return $.html();
}

/**
 * Main HTML rewriter.
 *
 * @param html               Raw HTML from upstream
 * @param base               The final URL of this document (after redirects)
 * @param injectClientRuntime Whether to inject our JS patch
 */
export function rewriteHtml(
  html: string,
  base: string,
  injectClientRuntime: boolean,
): string {
  const $ = cheerio.load(html, { xml: false });
  applyCoreRewrites($, base);
  rewriteInertSubfragments($, base);

  const headInject: string[] = [];

  if (injectClientRuntime) {
    let targetOrigin = "";
    try { targetOrigin = new URL(base).origin; } catch { targetOrigin = base; }

    // Build opts for subdomain mode
    const opts: { rootDomain?: string; subdomainPrefix?: string } = {};
    if (isSubdomainModeEnabled()) {
      opts.rootDomain = getRootDomain();
      try {
        const u = new URL(base);
        opts.subdomainPrefix = encodeHostToSubdomain(u.hostname);
      } catch { /* ignore */ }
    }

    // SW registration
    headInject.push(
      "<script>(function(){" +
      "if(!('serviceWorker' in navigator))return;" +
      "navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){});" +
      "})();</script>",
    );

    // Main runtime patch
    headInject.push(`<script>${buildClientRuntimePatch(targetOrigin, opts)}</script>`);
  }

  // Always suppress referrer leaks
  headInject.push('<meta name="referrer" content="no-referrer">');

  // Viewport
  if (!$('meta[name="viewport"]').length) {
    headInject.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }

  const joined = headInject.join("");
  const heads = $("head");
  if (heads.length) {
    heads.prepend(joined);
  } else {
    const c = $.root().children();
    if (c.length) c.first().prepend(joined);
    else $.root().prepend(joined);
  }

  return $.html();
}
