/**
 * ipRotation.ts — Outbound IP rotation
 *
 * Supports three modes, set via environment variables:
 *
 *   MODE=direct  (default) — No proxy, direct fetch with retry
 *   MODE=tor               — Route through Tor SOCKS5 (free, slow)
 *   MODE=iproyal           — Route through IPRoyal residential proxies (paid, fast)
 *
 * IPRoyal setup:
 *   1. Sign up at iproyal.com → Residential Proxies
 *   2. Add to .env.local:
 *        PROXY_MODE=iproyal
 *        IPROYAL_HOST=unblocker.iproyal.com
 *        IPROYAL_PORT=12323
 *        IPROYAL_USER=tGlLbo1320889
 *        IPROYAL_PASS=jtPwvuYzPMPDrv72
 *
 * Geo-targeting (route through specific country):
 *   IPRoyal uses password suffixes for country selection:
 *        IPROYAL_PASS=your_password_country-US   → US exit IP
 *        IPROYAL_PASS=your_password_country-GB   → UK exit IP
 *        IPROYAL_PASS=your_password_country-DE   → Germany exit IP
 *   Or set IPROYAL_COUNTRY=US and the code adds the suffix automatically.
 *
 * Tor setup (free alternative):
 *   apt-get install -y tor && systemctl start tor
 *   PROXY_MODE=tor
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as net from "net";

// ── Mode detection ─────────────────────────────────────────────────────────────

type ProxyMode = "direct" | "tor" | "iproyal";

const PROXY_MODE: ProxyMode = (() => {
  const m = (process.env.PROXY_MODE || "direct").toLowerCase();
  if (m === "tor" || m === "iproyal" || m === "direct") return m as ProxyMode;
  return "direct";
})();

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 600;

// Status codes that mean "you're blocked, rotate IP and retry"
const BLOCKED_CODES = new Set([403, 429, 503, 451]);

// ── IPRoyal configuration ──────────────────────────────────────────────────────

const IPROYAL_HOST    = process.env.IPROYAL_HOST || "geo.iproyal.com";
const IPROYAL_PORT    = process.env.IPROYAL_PORT || "12321";
const IPROYAL_USER    = process.env.IPROYAL_USER || "";
const IPROYAL_PASS    = process.env.IPROYAL_PASS || "";
const IPROYAL_COUNTRY = process.env.IPROYAL_COUNTRY || ""; // e.g. "US", "GB", "DE"

/**
 * Build the IPRoyal proxy URL.
 * IPRoyal rotates the IP automatically on each request — no extra code needed.
 * For geo-targeting, append _country-XX to the password.
 */
function buildIPRoyalProxyUrl(): string {
  let pass = IPROYAL_PASS;
  if (IPROYAL_COUNTRY && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY}`;
  }
  return `http://${IPROYAL_USER}:${pass}@${IPROYAL_HOST}:${IPROYAL_PORT}`;
}

function makeIPRoyalAgent(): HttpsProxyAgent<string> {
  return new HttpsProxyAgent(buildIPRoyalProxyUrl());
}

// ── Tor configuration ──────────────────────────────────────────────────────────

const TOR_HOST         = "127.0.0.1";
const TOR_SOCKS_PORT   = 9050;
const TOR_CONTROL_PORT = 9051;

function makeTorAgent(): SocksProxyAgent {
  return new SocksProxyAgent(`socks5://${TOR_HOST}:${TOR_SOCKS_PORT}`, { timeout: 20000 });
}

async function rotateTorCircuit(): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection(TOR_CONTROL_PORT, TOR_HOST);
    const timeout = setTimeout(() => { socket.destroy(); resolve(); }, 3000);
    let buf = "";
    socket.on("connect", () => socket.write(`AUTHENTICATE ""\r\n`));
    socket.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("250 OK") && !buf.includes("SIGNAL")) {
        socket.write("SIGNAL NEWNYM\r\n");
      } else if (buf.includes("250 OK") && buf.includes("SIGNAL")) {
        clearTimeout(timeout); socket.end(); resolve();
      } else if (buf.includes("515") || buf.includes("551")) {
        clearTimeout(timeout); socket.destroy(); resolve();
      }
    });
    socket.on("error", () => { clearTimeout(timeout); resolve(); });
  });
}

// ── Core fetch functions ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function directFetch(
  url: string,
  options: RequestInit,
  maxAttempts = 2,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS);
    try { return await fetch(url, options); }
    catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (lastErr.name === "AbortError") throw lastErr;
    }
  }
  throw lastErr ?? new Error("Fetch failed");
}

async function ipRoyalFetch(
  url: string,
  options: RequestInit,
): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // IPRoyal auto-rotates per request — just wait briefly before retry
      console.log(`[iproyal] Retry ${attempt + 1}/${MAX_RETRIES} for ${url}`);
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      const agent = makeIPRoyalAgent();
      const res = await fetch(url, {
        ...options,
        // @ts-ignore — Node fetch supports agent
        agent,
      });

      if (BLOCKED_CODES.has(res.status) && attempt < MAX_RETRIES - 1) {
        console.log(`[iproyal] Got ${res.status} — rotating IP and retrying...`);
        lastRes = res;
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[iproyal] Attempt ${attempt + 1} failed: ${lastErr.message}`);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error("IPRoyal: all retries failed");
}

async function torFetch(
  url: string,
  options: RequestInit,
): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[tor] Rotating circuit (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await rotateTorCircuit();
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      const agent = makeTorAgent();
      const res = await fetch(url, {
        ...options,
        // @ts-ignore
        agent,
      });

      if (BLOCKED_CODES.has(res.status) && attempt < MAX_RETRIES - 1) {
        console.log(`[tor] Got ${res.status} — rotating exit node...`);
        lastRes = res;
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[tor] Attempt ${attempt + 1} failed: ${lastErr.message}`);
    }
  }

  if (lastRes) return lastRes;
  throw lastErr ?? new Error("Tor: all retries failed");
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * fetchWithRotation — the single outbound fetch function used by doProxyRequest.ts
 *
 * Automatically uses whichever proxy mode is configured in .env.local.
 * Zero changes needed in doProxyRequest.ts when switching modes.
 */
export async function fetchWithRotation(
  url: string,
  options: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  switch (PROXY_MODE) {
    case "iproyal":
      return ipRoyalFetch(url, options);
    case "tor":
      return torFetch(url, options);
    case "direct":
    default:
      return directFetch(url, options);
  }
}

export { PROXY_MODE, BLOCKED_CODES };
