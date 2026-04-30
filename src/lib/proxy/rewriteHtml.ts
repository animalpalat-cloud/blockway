import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { buildClientRuntimePatch } from "./clientRuntime";
import { absUrl, isLikelyUrl, proxyParamUrl, skipRewrite } from "./urls";

const URL_ATTRS: { sel: string; attr: string }[] = [
  { sel: "a[href]", attr: "href" },
  { sel: "img[src]", attr: "src" },
  { sel: "img[longdesc]", attr: "longdesc" },
  { sel: "link[href]", attr: "href" },
  { sel: "script[src]", attr: "src" },
  { sel: "iframe[src]", attr: "src" },
  { sel: "source[src]", attr: "src" },
  { sel: "video[src]", attr: "src" },
  { sel: "video[poster]", attr: "poster" },
  { sel: "audio[src]", attr: "src" },
  { sel: "source[srcset]", attr: "srcset" },
  { sel: "img[srcset]", attr: "srcset" },
  { sel: "object[data]", attr: "data" },
  { sel: "embed[src]", attr: "src" },
  { sel: "input[src]", attr: "src" },
  { sel: "track[src]", attr: "src" },
  { sel: "image[href]", attr: "href" },
  { sel: "image[xlink\\:href]", attr: "xlink:href" },
  { sel: "[background]", attr: "background" },
  { sel: "form[action]", attr: "action" },
  { sel: "input[formaction]", attr: "formaction" },
  { sel: "button[formaction]", attr: "formaction" },
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
  if (!isLikelyUrl(val)) return null;
  const abs = absUrl(trimmed, base);
  if (!abs) return null;
  if (isAuthLikeEndpoint(abs) || isTrackingOrThirdPartyScript(abs)) return null;
  return proxyParamUrl(abs, base);
}

function rewriteSrcsetValue(srcset: string, base: string): string {
  const splitCandidates = (value: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let depth = 0;
    for (const ch of value) {
      if (ch === "(") depth += 1;
      else if (ch === ")" && depth > 0) depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
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
      if (bits.length <= 1) return rewritten;
      return `${rewritten} ${bits.slice(1).join(" ")}`;
    })
    .join(", ");
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

  for (const { sel, attr } of URL_ATTRS) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      if (attr === "srcset") {
        const next = rewriteSrcsetValue(v, base);
        if (next && next !== v) $(el).attr(attr, next);
        return;
      }
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

  const headInject: string[] = [];
  if (injectClientRuntime) {
    const origin = new URL(base).origin;
    headInject.push("<script>(function(){if(!('serviceWorker' in navigator))return;function reg(path){return navigator.serviceWorker.register(path,{scope:'/'});}reg('/sw.js').catch(function(){return reg('/pwa.js');}).catch(function(){});})();</script>");
    headInject.push(`<script>${buildClientRuntimePatch(origin)}</script>`);
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
