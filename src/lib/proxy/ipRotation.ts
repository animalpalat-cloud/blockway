/**
 * ipRotation.ts
 *
 * Uses IPRoyal's OFFICIAL method: undici ProxyAgent with dispatcher
 * This is the ONLY correct way to use IPRoyal Unblocker in Node.js
 *
 * PROXY_MODE=direct   — plain fetch with retry
 * PROXY_MODE=iproyal  — undici ProxyAgent (IPRoyal official method)
 * PROXY_MODE=tor      — SOCKS5 via socks-proxy-agent
 */

import * as net from "net";

// ── Mode ───────────────────────────────────────────────────────────────────────

type ProxyMode = "direct" | "tor" | "iproyal";

const PROXY_MODE: ProxyMode = (() => {
  const m = (process.env.PROXY_MODE || "direct").toLowerCase();
  if (m === "tor" || m === "iproyal") return m as ProxyMode;
  return "direct";
})();

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 800;
const BLOCKED_CODES  = new Set([403, 407, 429, 503, 451]);

// ── IPRoyal config ─────────────────────────────────────────────────────────────

const IPROYAL_HOST    = process.env.IPROYAL_HOST || "unblocker.iproyal.com";
const IPROYAL_PORT    = process.env.IPROYAL_PORT || "12323";
const IPROYAL_USER    = process.env.IPROYAL_USER || "";
const IPROYAL_PASS    = process.env.IPROYAL_PASS || "";
const IPROYAL_COUNTRY = process.env.IPROYAL_COUNTRY || "";

function buildProxyUri(): string {
  // Build password with optional geo-targeting suffix
  let pass = IPROYAL_PASS;
  if (IPROYAL_COUNTRY && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY.toLowerCase()}`;
  }
  // Use raw credentials in URI — undici handles encoding internally
  return `http://${IPROYAL_USER}:${pass}@${IPROYAL_HOST}:${IPROYAL_PORT}`;
}

// ── IPRoyal fetch using undici ProxyAgent ─────────────────────────────────────

async function ipRoyalFetch(url: string, options: RequestInit): Promise<Response> {
  // Dynamically import undici — avoids issues with Next.js bundling
  const { fetch: undiciFetch, ProxyAgent } = await import("undici");

  // Disable TLS verification for IPRoyal Unblocker
  // (required as per IPRoyal's own documentation)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const proxyUri = buildProxyUri();
  let lastErr: Error | null = null;
  let lastRes: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[iproyal] Retry ${attempt + 1}/${MAX_RETRIES} → ${url}`);
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      // Create fresh ProxyAgent per request (ensures IP rotation)
      const dispatcher = new ProxyAgent(proxyUri);

      // Extract headers from RequestInit
      const reqHeaders: Record<string, string> = {};
      if (options.headers) {
        const h = options.headers as Record<string, string>;
        Object.keys(h).forEach((k) => { reqHeaders[k] = h[k]; });
      }

      // Use undici fetch with dispatcher — THIS IS THE CORRECT IPROYAL METHOD
      const res = await undiciFetch(url, {
        method:     (options.method || "GET") as any,
        headers:    reqHeaders,
        body:       options.body as any,
        redirect:   "follow",
        dispatcher, // ← This is how IPRoyal works
      });

      // 407 = wrong credentials or IP not whitelisted
      if (res.status === 407) {
        console.error("[iproyal] 407 Proxy Auth Failed — check credentials or whitelist VPS IP in IPRoyal dashboard");
        // Convert undici response to standard Response
        const body = await res.text();
        return new Response(body, { status: 407, headers: Object.fromEntries(res.headers) });
      }

      if (BLOCKED_CODES.has(res.status) && attempt < MAX_RETRIES - 1) {
        console.log(`[iproyal] Got ${res.status} — retrying...`);
        lastRes = res;
        continue;
      }

      // Convert undici response to standard Web API Response
      const responseBody = await res.arrayBuffer();
      const responseHeaders = new Headers();
      res.headers.forEach((value: string, key: string) => {
        responseHeaders.set(key, value);
      });

      return new Response(responseBody, {
        status:  res.status,
        headers: responseHeaders,
      });

    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[iproyal] Attempt ${attempt + 1} error: ${lastErr.message}`);
    }
  }

  if (lastRes) {
    const body = await lastRes.arrayBuffer();
    const headers = new Headers();
    lastRes.headers.forEach((v: string, k: string) => headers.set(k, v));
    return new Response(body, { status: lastRes.status, headers });
  }

  throw lastErr ?? new Error("IPRoyal: all retries failed");
}

// ── Tor fetch ──────────────────────────────────────────────────────────────────

const TOR_HOST         = "127.0.0.1";
const TOR_SOCKS_PORT   = 9050;
const TOR_CONTROL_PORT = 9051;

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
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await rotateTorCircuit();
      await sleep(RETRY_DELAY_MS * attempt);
    }
    try {
      const agent = new SocksProxyAgent(`socks5://${TOR_HOST}:${TOR_SOCKS_PORT}`);
      return await (fetch as any)(url, { ...options, agent, cache: "no-store" });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[tor] Attempt ${attempt + 1} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error("Tor: all retries failed");
}

// ── Direct fetch ───────────────────────────────────────────────────────────────

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