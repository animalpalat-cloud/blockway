import { isBlockedTarget, normalizeUrl } from "./urls";

/**
 * Current Chrome/Edge-style user agents. Rotated per upstream request
 * to reduce "datacenter" fingerprinting with a single static UA.
 */
const CHROME_LIKE_UAS: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/131.0.0.0 Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/132.0.0.0 Chrome/132.0.0.0 Safari/537.36",
];

const ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const ACCEPT_SCRIPT = "*/*";
const ACCEPT_STYLE = "text/css,*/*;q=0.1";
const ACCEPT_IMAGE =
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
const ACCEPT_FONT =
  "application/font-woff2;q=1.0,font/woff2;q=1.0,font/woff;q=1.0,*/*;q=0.8";
const ACCEPT_JSON = "application/json, text/plain, */*";
const ACCEPT_DEFAULT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type InferredResourceKind =
  | "document"
  | "script"
  | "style"
  | "image"
  | "font"
  | "other";

let rng = (): number => {
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0]! / 0xffffffff;
  } catch {
    return Math.random();
  }
};

/** Override RNG (tests). */
export function setBrowserHeaderRng(f: () => number): void {
  rng = f;
}

/**
 * Picks a user agent from the pool. Set `PROXY_USER_AGENT` to pin a single string.
 */
export function pickUserAgentForUpstream(): string {
  const pinned = process.env.PROXY_USER_AGENT?.trim();
  if (pinned) return pinned;
  const i = Math.floor(rng() * CHROME_LIKE_UAS.length);
  return CHROME_LIKE_UAS[i] ?? CHROME_LIKE_UAS[0]!;
}

function pathNameLower(target: URL): string {
  let p: string;
  try {
    p = new URL(target.href).pathname;
  } catch {
    p = target.pathname;
  }
  return p.toLowerCase();
}

export function inferResourceKind(target: URL): InferredResourceKind {
  const p = pathNameLower(target);
  const m = p.match(/\.([a-z0-9]+)(?:$|\?|#)/i);
  const ext = m?.[1]?.toLowerCase() ?? "";

  if (ext) {
    if (["js", "mjs", "cjs", "jsx", "ts", "tsx"].includes(ext)) return "script";
    if (ext === "css") return "style";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "bmp", "apng"].includes(ext)) {
      return "image";
    }
    if (["woff", "woff2", "ttf", "otf", "eot"].includes(ext)) return "font";
    if (ext === "json") return "other";
  }

  if (p === "/" || p === "" || ext === "html" || ext === "htm" || ext === "php" || ext === "asp" || ext === "aspx") {
    return "document";
  }

  if (!ext && /\/[^./]+\/?$/.test(p) && p.endsWith("/")) return "document";

  if (!m) {
    if (p === "/" || p === "" || p.endsWith("/")) return "document";
    return "other";
  }

  return "other";
}

export function buildAcceptForKind(kind: InferredResourceKind): string {
  switch (kind) {
    case "document":
      return ACCEPT_HTML;
    case "script":
      return ACCEPT_SCRIPT;
    case "style":
      return ACCEPT_STYLE;
    case "image":
      return ACCEPT_IMAGE;
    case "font":
      return ACCEPT_FONT;
    case "other":
    default:
      return ACCEPT_DEFAULT;
  }
}

function secFetchSite(
  target: URL,
  documentReferer: string | null,
): "same-origin" | "same-site" | "cross-site" {
  if (!documentReferer) {
    return "same-origin";
  }
  const ref = normalizeUrl(documentReferer);
  if (!ref) return "cross-site";
  if (isBlockedTarget(ref)) return "cross-site";
  if (ref.origin === target.origin) return "same-origin";
  // Best-effort: no PSL, treat different hosts as cross-site
  return "cross-site";
}

type SecFetchSite = "none" | "same-origin" | "same-site" | "cross-site";

type SecFetch = {
  "sec-fetch-dest": string;
  "sec-fetch-mode": string;
  "sec-fetch-site": SecFetchSite;
  "sec-fetch-user": "?0" | "?1";
};

export function buildSecFetchHeaders(
  target: URL,
  kind: InferredResourceKind,
  documentReferer: string | null,
): SecFetch {
  const site = secFetchSite(target, documentReferer);
  // Server-side fetch: never claim a user gesture
  const user: "?0" = "?0";

  if (kind === "document") {
    const fetchSite: SecFetchSite = documentReferer ? site : "none";
    return {
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": fetchSite,
      "sec-fetch-user": user,
    };
  }

  if (kind === "script" || kind === "style" || kind === "image" || kind === "font") {
    const dest =
      kind === "script"
        ? "script"
        : kind === "style"
          ? "style"
          : kind === "image"
            ? "image"
            : "font";
    return {
      "sec-fetch-dest": dest,
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": site,
      "sec-fetch-user": user,
    };
  }

  return {
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": site,
    "sec-fetch-user": user,
  };
}

const ACCEPT_LANG_POOL: readonly string[] = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en;q=0.9",
];

export function pickAcceptLanguage(): string {
  const pinned = process.env.PROXY_ACCEPT_LANGUAGE?.trim();
  if (pinned) return pinned;
  return ACCEPT_LANG_POOL[Math.floor(rng() * ACCEPT_LANG_POOL.length)] ?? ACCEPT_LANG_POOL[0]!;
}

export const DEFAULT_ACCEPT_ENCODING = "gzip, deflate, br";

/** Validated `ref` query value for `/proxy?url=...&ref=...` (parent document URL). */
export function safeDocumentRefererParam(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const p = String(raw).trim();
  if (!p || p.length > 8_192) return null;
  const u = normalizeUrl(p);
  if (!u || isBlockedTarget(u)) return null;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.toString();
}

/**
 * `documentReferer`: full page URL the browser would show as Referer (e.g. main site) when
 * loading a cross-origin asset; from `&ref=` on `/proxy?url=...&ref=...`.
 */
export function buildRefererAndOrigin(
  target: URL,
  documentReferer: string | null,
): { referer: string; origin: string } {
  if (documentReferer) {
    const u = normalizeUrl(documentReferer);
    if (u && !isBlockedTarget(u) && (u.protocol === "https:" || u.protocol === "http:")) {
      return { referer: u.toString(), origin: u.origin };
    }
  }
  return { referer: `${target.origin}/`, origin: target.origin };
}
