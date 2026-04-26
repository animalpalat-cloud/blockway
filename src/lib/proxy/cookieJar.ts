/**
 * In-memory per-session cookie store for upstream fetch().
 * Browsers cannot hold reddit.com cookies on your domain; we store
 * Set-Cookie from the origin server and replay Cookie on later requests
 * to the same host. Works for single PM2 / Node process.
 *
 * For multiple servers use Redis and shared store.
 */
// sessionId -> (hostname -> "name=val" pairs, deduped by cookie name)
type Jar = Map<string, Map<string, string>>;

const g = globalThis as unknown as { __phCookieJar?: Map<string, Jar> };
if (!g.__phCookieJar) g.__phCookieJar = new Map();
const bySession: Map<string, Jar> = g.__phCookieJar!;

function jarForSession(sessionId: string): Map<string, Map<string, string>> {
  let j = bySession.get(sessionId);
  if (!j) {
    j = new Map();
    bySession.set(sessionId, j);
  }
  return j;
}

function hostKey(hostname: string): string {
  return hostname.toLowerCase();
}

/** First part of a Set-Cookie before ; is name=value (best-effort). */
function parseSetCookieNameValue(line: string): { name: string; nv: string } | null {
  const idx = line.indexOf(";");
  const first = (idx === -1 ? line : line.slice(0, idx)).trim();
  const eq = first.indexOf("=");
  if (eq < 1) return null;
  const name = first.slice(0, eq).trim();
  if (!name) return null;
  return { name, nv: first };
}

/**
 * Read Set-Cookie lines from a fetch Response and merge into the jar for
 * the given request hostname (or Domain= from cookie if we parse it later).
 */
export function absorbSetCookieHeaders(
  sessionId: string,
  requestHost: string,
  headers: Headers,
): void {
  const cookieLines = getSetCookieLines(headers);
  if (cookieLines.length === 0) return;

  const jar = jarForSession(sessionId);
  let forHost = jar.get(hostKey(requestHost)) ?? new Map<string, string>();

  for (const line of cookieLines) {
    const parsed = parseSetCookieNameValue(line);
    if (!parsed) continue;
    // Optional: if Domain= is present, store under that host — keep simple: request host
    forHost.set(parsed.name, parsed.nv);
  }

  jar.set(hostKey(requestHost), forHost);
  bySession.set(sessionId, jar);
}

/**
 * Merge cookies returned from Puppeteer's `page.cookies()` into the jar
 * (per cookie domain) so the next fetch/visit replays the same state.
 */
export function absorbPuppeteerCookies(
  sessionId: string,
  cookies: { name: string; value: string; domain?: string }[],
): void {
  if (cookies.length === 0) return;
  const jar = jarForSession(sessionId);
  for (const c of cookies) {
    const d = (c.domain ?? "").replace(/^\./, "").toLowerCase();
    if (!d) continue;
    const forHost = jar.get(d) ?? new Map<string, string>();
    forHost.set(c.name, `${c.name}=${c.value}`);
    jar.set(d, forHost);
  }
  bySession.set(sessionId, jar);
}

function getSetCookieLines(headers: Headers): string[] {
  const h = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie() ?? [];
  }
  const one = headers.get("set-cookie");
  if (!one) return [];
  // Fallback: one combined header; split is imperfect but rare in Node
  return [one];
}

/**
 * Return Cookie: header value for upstream, or null if nothing stored.
 */
export function cookieHeaderForHost(sessionId: string, host: string): string | null {
  const jar = bySession.get(sessionId);
  if (!jar) return null;
  const m = jar.get(hostKey(host));
  if (!m || m.size === 0) return null;
  return [...m.values()].join("; ");
}

export function newSessionId(): string {
  try {
    // randomUUID is always on Crypto in our TS lib; do not `if (fn)`-check it (always truthy)
    return globalThis.crypto.randomUUID();
  } catch {
    return `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}
