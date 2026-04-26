import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { buildClientRuntimePatch } from "./clientRuntime";
import { absUrl, isLikelyUrl, proxyParamUrl, skipRewrite } from "./urls";
import { rewriteCss, rewriteUrlCallsInString } from "./rewriteCss";

// Prefer explicit first pass; then generic sweep
const URL_ATTRS: { sel: string; attr: string }[] = [
  { sel: "a[href]",              attr: "href" },
  { sel: "area[href]",         attr: "href" },
  { sel: "link[href]",         attr: "href" },
  { sel: "img[src]",            attr: "src" },
  { sel: "img[data-src]",       attr: "data-src" },
  { sel: "img[data-original]",  attr: "data-original" },
  { sel: "img[data-lazy-src]",  attr: "data-lazy-src" },
  { sel: "img[data-lazy]",     attr: "data-lazy" },
  { sel: "img[data-srcset]",   attr: "data-srcset" },
  { sel: "script[src]",         attr: "src" },
  { sel: "iframe[src]",         attr: "src" },
  { sel: "embed[src]",         attr: "src" },
  { sel: "object[data]",         attr: "data" },
  { sel: "source[src]",         attr: "src" },
  { sel: "track[src]",         attr: "src" },
  { sel: "video[src]",         attr: "src" },
  { sel: "video[poster]",      attr: "poster" },
  { sel: "audio[src]",         attr: "src" },
  { sel: "form[action]",       attr: "action" },
  { sel: "form[formaction]",   attr: "formaction" },
  { sel: "input[formaction]",  attr: "formaction" },
  { sel: "button[formaction]", attr: "formaction" },
  { sel: "use[href]",          attr: "href" },
  { sel: "image[href]",        attr: "href" },
  { sel: "source[data-src]",   attr: "data-src" },
  { sel: "source[data-srcset]", attr: "data-srcset" },
];

function shouldAttrRewrite(n: string): boolean {
  const l = n.toLowerCase();
  if (
    ["href", "src", "poster", "action", "formaction", "cite", "srcset", "imagesrcset", "data-srcset"].includes(l)
  ) {
    return true;
  }
  if (l.startsWith("data-") && /src|href|url|load|image|icon|file/i.test(l)) return true;
  if (l === "xlink:href" || l.endsWith(":href")) return true;
  return false;
}

function rewriteAttributeValue(val: string, base: string): string | null {
  if (skipRewrite(val) || val.includes("proxy?url=")) return null;
  if (!isLikelyUrl(val)) return null;
  const abs = absUrl(val, base);
  if (!abs) return null;
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
    const t = String($(el).html() || "");
    if (/\bnavigator\.serviceWorker\.register\b/.test(t)) {
      $(el).remove();
    }
  });

  for (const { sel, attr } of URL_ATTRS) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const next = rewriteAttributeValue(v, base);
      if (next) $(el).attr(attr, next);
    });
  }

  $("[srcset], [data-srcset], [imagesrcset]").each((_, el) => {
    for (const a of ["srcset", "data-srcset", "imagesrcset"] as const) {
      const v = $(el).attr(a);
      if (!v) continue;
      const parts = v.split(",").map((entry) => {
        const p = entry.trim().split(/\s+/);
        const u = p[0];
        const rest = p.slice(1).join(" ");
        if (!u) return entry;
        const n = rewriteAttributeValue(u, base);
        return n ? (rest ? `${n} ${rest}` : n) : entry;
      });
      $(el).attr(a, parts.join(", "));
    }
  });

  $("[style]").each((_, el) => {
    const s = $(el).attr("style");
    if (s) $(el).attr("style", rewriteUrlCallsInString(s, base));
  });

  $("style").each((_, el) => {
    const t = $(el).html();
    if (t) $(el).html(rewriteCss(t, base));
  });

  $('script[type="importmap"], script[type=importmap], script[type="importmap+json"]').each((_, el) => {
    const t = $(el).html();
    if (!t) return;
    try {
      const j = JSON.parse(t) as {
        imports?: Record<string, string>;
        scopes?: Record<string, Record<string, string>>;
      };
      if (j.imports) {
        for (const k of Object.keys(j.imports)) {
          const v = j.imports[k];
          if (typeof v !== "string") continue;
          const abs = absUrl(v, base) ?? new URL(v, base).toString();
          j.imports[k] = proxyParamUrl(abs, base);
        }
      }
      if (j.scopes) {
        for (const sc of Object.values(j.scopes)) {
          for (const k of Object.keys(sc)) {
            const v = sc[k];
            if (typeof v === "string") {
              const abs = absUrl(v, base) ?? new URL(v, base).toString();
              sc[k] = proxyParamUrl(abs, base);
            }
          }
        }
      }
      $(el).html(JSON.stringify(j));
    } catch { /* keep */ }
  });

  $("meta").each((_, el) => {
    const h = String($(el).attr("http-equiv") ?? "");
    if (h.toLowerCase() !== "refresh") return;
    const c = $(el).attr("content");
    if (!c) return;
    const m = c.match(/url\s*=\s*(['"]?)([^'";]+)\1/i);
    if (m?.[2]) {
      const abs = absUrl(m[2], base);
      if (abs) $(el).attr("content", c.replace(m[0], `url=${proxyParamUrl(abs, base)}`));
    }
  });

  $("*").each((_, n) => {
    const node = $(n).get(0) as { type?: string; attribs?: Record<string, string> } | undefined;
    if (!node || node.type !== "tag" || !node.attribs) return;
    for (const name of Object.keys(node.attribs)) {
      if (!shouldAttrRewrite(name)) continue;
      const v = node.attribs[name];
      if (v == null) continue;
      const next = rewriteAttributeValue(String(v), base);
      if (next) node.attribs[name] = next;
    }
  });
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
