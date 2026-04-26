import { absUrl, skipRewrite, proxyParamUrl } from "./urls";

function oneUrl(
  m: string,
  inner: string,
  base: string,
): string {
  const t = inner.trim();
  if (skipRewrite(t)) return m;
  const abs = absUrl(t, base);
  if (!abs) return m;
  return `url(\"${esc(proxyParamUrl(abs))}\")`;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

/** `url()` only — for HTML style="" and inline <style> */
export function rewriteUrlCallsInString(text: string, base: string): string {
  let out = text;
  out = out.replace(
    /url\(\s*["']([^"']*)["']\s*\)/gi,
    (m, inner) => oneUrl(m, inner, base),
  );
  out = out.replace(
    /url\(\s*([^\)\"']+?)\s*\)/gi,
    (m, inner) => {
      const t = String(inner).trim();
      if (t.includes("\"/proxy?url=") || t.includes("proxy?url=")) return m;
      return oneUrl(m, t, base);
    },
  );
  return out;
}

/**
 * Full stylesheet: url(...) and @import.
 */
export function rewriteCss(css: string, base: string): string {
  let out = rewriteUrlCallsInString(css, base);
  out = out.replace(
    /@import\s+([\"'])([^\"']+)\1/gi,
    (match, _q, path: string) => {
      if (skipRewrite(path)) return match;
      const abs = absUrl(path, base);
      if (!abs) return match;
      return `@import \"${esc(proxyParamUrl(abs))}\"`;
    },
  );
  return out;
}
