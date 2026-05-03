import { absUrl, proxyParamUrl, skipRewrite } from "./urls";

/**
 * Rewrite url(...) and @import in CSS so assets load through the proxy.
 *
 * In subdomain mode, CSS assets from CDNs like static.xhpingcdn.com are
 * rewritten to static--xhpingcdn--com.daddyproxy.com/...
 * so the browser's requests look like they originate from that domain —
 * bypassing CDN hotlink protection.
 */
export function rewriteCss(css: string, base: string): string {
  // Rewrite url("...") / url('...') / url(...)
  let out = css.replace(
    /url\(\s*(['"]?)([^)'"]+?)\1\s*\)/gi,
    (_match, quote, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || skipRewrite(trimmed) || trimmed.startsWith("data:")) {
        return _match;
      }
      const abs = absUrl(trimmed, base);
      if (!abs) return _match;
      const proxied = proxyParamUrl(abs, base); // subdomain-aware
      return `url(${quote}${proxied}${quote})`;
    }
  );

  // Rewrite @import "..." / @import url(...)
  out = out.replace(
    /@import\s+(?:url\(\s*)?(['"]?)([^'"\s;)]+)\1(?:\s*\))?/gi,
    (_match, _q, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || skipRewrite(trimmed)) return _match;
      const abs = absUrl(trimmed, base);
      if (!abs) return _match;
      const proxied = proxyParamUrl(abs, base); // subdomain-aware
      return `@import url("${proxied}")`;
    }
  );

  return out;
}
