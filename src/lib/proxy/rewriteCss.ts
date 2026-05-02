import { absUrl, proxyParamUrl, skipRewrite } from "./urls";

/**
 * Rewrite url(...) and @import in CSS so assets load through the proxy.
 * This handles stylesheets fetched via /proxy?url=... that reference
 * relative or root-relative asset paths.
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
      const proxied = proxyParamUrl(abs, base);
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
      const proxied = proxyParamUrl(abs, base);
      return `@import url("${proxied}")`;
    }
  );

  return out;
}
