/**
 * ipRotation.ts
 *
 * Handles outbound fetch with three modes:
 *   PROXY_MODE=direct   — plain fetch with retry (default)
 *   PROXY_MODE=tor      — route through Tor SOCKS5
 *   PROXY_MODE=iproyal  — route through IPRoyal residential proxy
 *
 * The TypeScript "agent does not exist in RequestInit" error is fixed
 * by casting fetch options to (any) when passing the agent.
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as net from "net";

// ── Mode ───────────────────────────────────────────────────────────────────────

type ProxyMode = "direct" | "tor" | "iproyal";

const PROXY_MODE: ProxyMode = (() => {
  const m = (process.env.PROXY_MODE || "direct").toLowerCase();
  if (m === "tor" || m === "iproyal") return m;
  return "direct";
})();

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 800;

// Status codes that mean "blocked — rotate IP and retry"
const BLOCKED_CODES = new Set([403, 407, 429, 503, 451]);

// ── IPRoyal ────────────────────────────────────────────────────────────────────

const IPROYAL_HOST    = process.env.IPROYAL_HOST || "unblocker.iproyal.com";
const IPROYAL_PORT    = process.env.IPROYAL_PORT || "12323";
const IPROYAL_USER    = process.env.IPROYAL_USER || "";
const IPROYAL_PASS    = process.env.IPROYAL_PASS || "";
const IPROYAL_COUNTRY = process.env.IPROYAL_COUNTRY || "";

function buildIPRoyalProxyUrl(): string {
  // encodeURIComponent is REQUIRED — special chars in password break URL parsing
  const user = encodeURIComponent(IPROYAL_USER);
  let pass = IPROYAL_PASS;

  // Geo-targeting: append _country-XX to password (not needed for Unblocker)
  if (IPROYAL_COUNTRY && !IPROYAL_HOST.includes("unblocker") && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY}`;
  }

  return `http://${user}:${encodeURIComponent(pass)}@${IPROYAL_HOST}:${IPROYAL_PORT}`;
}

function buildProxyAuthHeader(): string {
  // Explicit Proxy-Authorization header — most reliable auth method
  // Uses raw (not URL-encoded) credentials in Base64
  let pass = IPROYAL_PASS;
  if (IPROYAL_COUNTRY && !IPROYAL_HOST.includes("unblocker") && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY}`;
  }
  return `Basic ${Buffer.from(`${IPROYAL_USER}:${pass}`, "utf-8").toString("base64")}`;
}

function makeIPRoyalAgent(): HttpsProxyAgent<string> {
  return new HttpsProxyAgent(buildIPRoyalProxyUrl(), {
    headers: { "Proxy-Authorization": buildProxyAuthHeader() },
  });
}

async function ipRoyalFetch(url: string, options: RequestInit): Promise<Response> {
  let lastErr: Error | null = null;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[iproyal] Retry ${attempt + 1}/${MAX_RETRIES} → ${url}`);
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      const agent = makeIPRoyalAgent();

      // FIX: Cast to (any) to pass agent — TypeScript's RequestInit doesn't
      // include agent but Node.js fetch supports it at runtime
      const res = await (fetch as any)(url, {
        ...options,
        agent,
        cache: "no-store",
      });

      // 407 = wrong credentials or IP not whitelisted in IPRoyal dashboard
      if (res.status === 407) {
        console.error("[iproyal] 407 Proxy Auth Failed — check credentials or whitelist VPS IP in IPRoyal dashboard");
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

      if (msg.includes("TUNNEL") || msg.includes("tunneling")) {
        console.error("[iproyal] Tunnel failed — verify IPROYAL_HOST/PORT and whitelist VPS IP in dashboard");
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
      if (buf.includes("250 OK") && !buf.includes("SIGNAL")) {
        sock.write("SIGNAL NEWNYM\r\n");
      } else if (buf.includes("250 OK") && buf.includes("SIGNAL")) {
        clearTimeout(t); sock.end(); resolve();
      } else if (buf.includes("515") || buf.includes("551")) {
        clearTimeout(t); sock.destroy(); resolve();
      }
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
      // FIX: Cast to (any) to pass agent
      const res = await (fetch as any)(url, {
        ...options,
        agent: makeTorAgent(),
        cache: "no-store",
      });
      if (BLOCKED_CODES.has(res.status) && attempt < MAX_RETRIES - 1) {
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

// ── Direct ─────────────────────────────────────────────────────────────────────

async function directFetch(url: string, options: RequestInit): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS);
    try {
      return await fetch(url, options);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (lastErr.name === "AbortError") throw lastErr;
    }
  }
  throw lastErr ?? new Error("Fetch failed");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main export ────────────────────────────────────────────────────────────────

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