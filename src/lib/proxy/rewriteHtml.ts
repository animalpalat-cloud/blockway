import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { buildClientRuntimePatch } from "./clientRuntime";
import { absUrl, isLikelyUrl, proxyParamUrl, skipRewrite } from "./urls";

const URL_ATTRS: { sel: string; attr: string }[] = [
  { sel: "a[href]", attr: "href" },
  { sel: "img[src]", attr: "src" },
  { sel: "link[href]", attr: "href" },
];

const TRACKING_PATTERNS = [
  "cloudflareinsights.com",
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "redditstatic.com/ads",
  "reddit.com/tracking",
  "/analytics",
  "/track",
  "/pixel",
];

const AUTH_PATH_PATTERNS = [
  "/login",
  "/signin",
  "/signup",
  "/register",
  "/oauth",
  "/auth",
  "/session",
  "/account",
];

function isTrackingOrThirdPartyScript(url: string): boolean {
  const s = url.toLowerCase();
  return TRACKING_PATTERNS.some((p) => s.includes(p));
}

function isAuthLikeEndpoint(url: string): boolean {
  const s = url.toLowerCase();
  return AUTH_PATH_PATTERNS.some((p) => s.includes(p));
}

function rewriteAttributeValue(val: string, base: string): string | null {
  const trimmed = (val ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return trimmed;
  if (skipRewrite(trimmed) || trimmed.includes("proxy?url=")) return null;
  if (isTrackingOrThirdPartyScript(trimmed)) return null;
  if (isAuthLikeEndpoint(trimmed)) return null;
  if (/\.woff2?(?:$|\?)/i.test(trimmed)) return null;
  if (!isLikelyUrl(val)) return null;
  const abs = absUrl(trimmed, base);
  if (!abs) return null;
  if (isAuthLikeEndpoint(abs) || isTrackingOrThirdPartyScript(abs)) return null;
  if (/\.woff2?(?:$|\?)/i.test(abs)) return null;
  return proxyParamUrl(abs, base);
}

/** Steps 0–7: URL rewrites, CSP metas, styles, no head injection. */
function applyCoreRewrites($: CheerioAPI, base: string): void {
  $("meta").each((_, el) => {
    const he = String($(el).attr("http-equiv") ?? "").trim().toLowerCase();
    if (he === "content-security-policy" || he === "content-security-policy-report-only") {
      $(el).remove();
      return;
    }
    const nm = String($(el).attr("name") ?? "").trim().toLowerCase();
    if (nm === "referrer" || nm === "content-security-policy" || nm === "csp") {
      $(el).remove();
      return;
    }
  });

  $(
    'link[rel="preconnect"], link[rel=preconnect], link[rel="dns-prefetch"], link[rel=dns-prefetch], link[rel="prerender"]',
  ).remove();
  $('link[rel="manifest"], link[rel=manifest], link[rel="serviceworker"], link[rel=serviceworker]').remove();
  $("script").each((_, el) => {
    const src = String($(el).attr("src") || "");
    const type = String($(el).attr("type") || "").toLowerCase();
    // Static-browsing mode: remove executable scripts.
    if (type !== "application/ld+json") {
      $(el).remove();
      return;
    }
    if (src && isTrackingOrThirdPartyScript(src)) $(el).remove();
  });
  $("iframe[src], embed[src], object[data]").remove();
  $("form[action], input[formaction], button[formaction]").remove();

  for (const { sel, attr } of URL_ATTRS) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      if (sel === "link[href]") {
        const rel = String($(el).attr("rel") || "").toLowerCase();
        const isCss = rel.includes("stylesheet") || /\.css(?:$|\?)/i.test(v);
        if (!isCss) return;
      }
      if (sel === "a[href]") {
        const aAbs = absUrl(v, base) || v;
        if (isAuthLikeEndpoint(aAbs)) {
          $(el).attr(attr, "#");
          return;
        }
      }
      const next = rewriteAttributeValue(v, base);
      if (next && next !== v) $(el).attr(attr, next);
    });
  }
}

/** Inert <template> / <noscript> content: rewrites only, no <base> / runtime. */
function rewriteInertSubfragments($: CheerioAPI, base: string): void {
  $("template, noscript").each((_, el) => {
    const inner = $(el).html();
    if (inner) {
      $(el).html(rewriteInertFragment(inner, base));
    }
  });
}

function rewriteInertFragment(html: string, base: string): string {
  const $ = cheerio.load(html, { xml: false });
  applyCoreRewrites($, base);
  rewriteInertSubfragments($, base);
  return $.html();
}

export function rewriteHtml(
  html: string,
  base: string,
  injectClientRuntime: boolean,
): string {
  const $ = cheerio.load(html, { xml: false });
  applyCoreRewrites($, base);
  rewriteInertSubfragments($, base);

  const safeBase = base.replace(/"/g, "&quot;");
  const origin = new URL(base).origin;
  const headInject: string[] = [
    `<base href="${safeBase}">`,
  ];
  if (injectClientRuntime) {
    headInject.push(
      `<script data-proxy="runtime" type="text/javascript">\n${buildClientRuntimePatch(origin)}<\/script>`,
    );
  }
  headInject.push('<meta name="referrer" content="no-referrer">');

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
