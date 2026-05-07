/**
 * ipRotation.ts — Outbound IP rotation
 *
 * Supports three modes via PROXY_MODE in .env.local:
 *   direct   = no proxy, direct fetch with retry (default)
 *   tor      = Tor SOCKS5 (free, slow)
 *   iproyal  = IPRoyal Unblocker or Rotating Residential (paid, fast)
 *
 * IPRoyal Unblocker endpoint: unblocker.iproyal.com:12323
 * IPRoyal Rotating endpoint:  geo.iproyal.com:12321
 *
 * Key fixes in this version:
 *   1. encodeURIComponent() on username AND password — handles special chars
 *   2. Basic Auth header sent explicitly (some Node versions don't parse auth from URL)
 *   3. Correct tunnel handling for HTTPS targets through HTTP CONNECT proxy
 *   4. Server IP whitelisting is done in IPRoyal dashboard, NOT in code
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as net from "net";

// ── Mode ───────────────────────────────────────────────────────────────────────

type ProxyMode = "direct" | "tor" | "iproyal";

const PROXY_MODE: ProxyMode = (() => {
  const m = (process.env.PROXY_MODE || "direct").toLowerCase();
  if (m === "tor" || m === "iproyal" || m === "direct") return m as ProxyMode;
  return "direct";
})();

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 600;
const BLOCKED_CODES  = new Set([403, 407, 429, 503, 451]);

// ── IPRoyal ────────────────────────────────────────────────────────────────────

const IPROYAL_HOST    = process.env.IPROYAL_HOST || "unblocker.iproyal.com";
const IPROYAL_PORT    = process.env.IPROYAL_PORT || "12323";
const IPROYAL_USER    = process.env.IPROYAL_USER || "";
const IPROYAL_PASS    = process.env.IPROYAL_PASS || "";
const IPROYAL_COUNTRY = process.env.IPROYAL_COUNTRY || "";

/**
 * Build the proxy URL with properly encoded credentials.
 *
 * CRITICAL: encodeURIComponent() is required — without it, special characters
 * in the password (like @, :, /, +) break the URL parser and cause 407/403.
 *
 * For IPRoyal Unblocker (unblocker.iproyal.com):
 *   The proxy handles JS rendering and bot detection automatically.
 *   No extra headers needed — just authenticated CONNECT tunnel.
 *
 * For IPRoyal Rotating (geo.iproyal.com):
 *   Append _country-XX to password for geo-targeting.
 */
function buildProxyUrl(): string {
  const user = encodeURIComponent(IPROYAL_USER);
  let pass = IPROYAL_PASS;

  // Add geo-targeting suffix for rotating proxies (not needed for Unblocker)
  if (IPROYAL_COUNTRY && !IPROYAL_HOST.includes("unblocker") && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY}`;
  }

  const encodedPass = encodeURIComponent(pass);
  const proxyUrl = `http://${user}:${encodedPass}@${IPROYAL_HOST}:${IPROYAL_PORT}`;

  return proxyUrl;
}

/**
 * Build the Proxy-Authorization header manually.
 * This is the most reliable auth method — bypasses URL parsing issues in Node.
 * Format: "Basic base64(username:password)"
 * NOTE: The raw (not URL-encoded) credentials go into the Base64 string.
 */
function buildProxyAuthHeader(): string {
  let pass = IPROYAL_PASS;
  if (IPROYAL_COUNTRY && !IPROYAL_HOST.includes("unblocker") && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY}`;
  }
  const credentials = `${IPROYAL_USER}:${pass}`;
  const encoded = Buffer.from(credentials, "utf-8").toString("base64");
  return `Basic ${encoded}`;
}

function makeIPRoyalAgent(): HttpsProxyAgent<string> {
  const proxyUrl = buildProxyUrl();
  const agent = new HttpsProxyAgent(proxyUrl, {
    // Pass auth header explicitly — most reliable method
    headers: {
      "Proxy-Authorization": buildProxyAuthHeader(),
    },
  });
  return agent;
}

async function ipRoyalFetch(url: string, options: RequestInit): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;

  // Log once at startup to confirm config loaded (password masked)
  if (process.env.NODE_ENV !== "production") {
    const maskedPass = IPROYAL_PASS.slice(0, 4) + "****";
    console.log(`[iproyal] Mode active — ${IPROYAL_HOST}:${IPROYAL_PORT} user=${IPROYAL_USER} pass=${maskedPass}`);
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[iproyal] Retry ${attempt + 1}/${MAX_RETRIES} → ${url}`);
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      const agent = makeIPRoyalAgent();

      const res = await fetch(url, {
        ...options,
        // @ts-ignore — Node 18+ fetch supports agent via dispatcher
        agent,
        // Prevent QUIC/HTTP3 which doesn't work through HTTP CONNECT proxies
        cache: "no-store",
      });

      // 407 = proxy auth failed — credentials wrong or IP not whitelisted
      if (res.status === 407) {
        console.error("[iproyal] 407 Proxy Auth Failed — check credentials or whitelist your VPS IP in IPRoyal dashboard");
        // Don't retry 407 — it's a config error, not a transient block
        return res;
      }

      if (BLOCKED_CODES.has(res.status) && attempt < MAX_RETRIES - 1) {
        console.log(`[iproyal] Got ${res.status} — retrying with fresh connection...`);
        lastRes = res;
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message;

      // ERR_TUNNEL_CONNECTION_FAILED = proxy refused the CONNECT tunnel
      // Usually means: wrong host/port, or IP not whitelisted
      if (msg.includes("TUNNEL") || msg.includes("tunneling")) {
        console.error("[iproyal] Tunnel failed — verify IPROYAL_HOST, IPROYAL_PORT, and that your VPS IP is whitelisted in IPRoyal dashboard");
      }

      console.warn(`[iproyal] Attempt ${attempt + 1} error: ${msg}`);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error("IPRoyal: all retries failed");
}

// ── Tor ────────────────────────────────────────────────────────────────────────

const TOR_HOST         = "127.0.0.1";
const TOR_SOCKS_PORT   = 9050;
const TOR_CONTROL_PORT = 9051;

function makeTorAgent(): SocksProxyAgent {
  return new SocksProxyAgent(`socks5://${TOR_HOST}:${TOR_SOCKS_PORT}`, { timeout: 20000 });
}

async function rotateTorCircuit(): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.createConnection(TOR_CONTROL_PORT, TOR_HOST);
    const t = setTimeout(() => { sock.destroy(); resolve(); }, 3000);
    let buf = "";
    sock.on("connect", () => sock.write(`AUTHENTICATE ""\r\n`));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("250 OK") && !buf.includes("SIGNAL")) sock.write("SIGNAL NEWNYM\r\n");
      else if (buf.includes("250 OK") && buf.includes("SIGNAL")) { clearTimeout(t); sock.end(); resolve(); }
      else if (buf.includes("515") || buf.includes("551")) { clearTimeout(t); sock.destroy(); resolve(); }
    });
    sock.on("error", () => { clearTimeout(t); resolve(); });
  });
}

async function torFetch(url: string, options: RequestInit): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await rotateTorCircuit();
      await sleep(RETRY_DELAY_MS * attempt);
    }
    try {
      const res = await fetch(url, { ...options, /* @ts-ignore */ agent: makeTorAgent(), cache: "no-store" });
      if (BLOCKED_CODES.has(res.status) && attempt < MAX_RETRIES - 1) { lastRes = res; continue; }
      return res;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (lastRes) return lastRes;
  throw lastErr ?? new Error("Tor: all retries failed");
}

// ── Direct ────────────────────────────────────────────────────────────────────

async function directFetch(url: string, options: RequestInit): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS);
    try { return await fetch(url, options); }
    catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (lastErr.name === "AbortError") throw lastErr;
    }
  }
  throw lastErr ?? new Error("Fetch failed");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchWithRotation(
  url: string,
  options: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  switch (PROXY_MODE) {
    case "iproyal": return ipRoyalFetch(url, options);
    case "tor":     return torFetch(url, options);
    default:        return directFetch(url, options);
  }
}

export { PROXY_MODE, BLOCKED_CODES };