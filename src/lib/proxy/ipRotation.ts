/**
 * ipRotation.ts — Outbound fetch with IPRoyal Unblocker (undici official method)
 *
 * IPRoyal MUST use undici ProxyAgent with dispatcher — not https-proxy-agent.
 * Using the wrong method causes the HTML wrapper issue where IPRoyal wraps
 * all responses in <html><body><pre>ENCODED_CONTENT</pre></body></html>
 *
 * PROXY_MODE=direct   — plain fetch with retry
 * PROXY_MODE=iproyal  — undici ProxyAgent (CORRECT IPRoyal method)
 * PROXY_MODE=tor      — SOCKS5 Tor
 */

import * as net from "net";

type ProxyMode = "direct" | "tor" | "iproyal";

const PROXY_MODE: ProxyMode = (() => {
  const m = (process.env.PROXY_MODE || "direct").toLowerCase();
  if (m === "tor" || m === "iproyal") return m as ProxyMode;
  return "direct";
})();

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 800;
const BLOCKED_CODES  = new Set([403, 407, 429, 503, 451]);

// ── IPRoyal ────────────────────────────────────────────────────────────────────

const IPROYAL_HOST    = process.env.IPROYAL_HOST || "unblocker.iproyal.com";
const IPROYAL_PORT    = process.env.IPROYAL_PORT || "12323";
const IPROYAL_USER    = process.env.IPROYAL_USER || "";
const IPROYAL_PASS    = process.env.IPROYAL_PASS || "";
const IPROYAL_COUNTRY = process.env.IPROYAL_COUNTRY || "";

function buildProxyUri(): string {
  let pass = IPROYAL_PASS;
  if (IPROYAL_COUNTRY && !pass.includes("_country-")) {
    pass = `${pass}_country-${IPROYAL_COUNTRY.toLowerCase()}`;
  }
  // Raw credentials — undici handles them correctly
  return `http://${IPROYAL_USER}:${pass}@${IPROYAL_HOST}:${IPROYAL_PORT}`;
}

async function ipRoyalFetch(url: string, options: RequestInit): Promise<Response> {
  // Use undici — the ONLY correct method for IPRoyal Unblocker
  const { fetch: undiciFetch, ProxyAgent } = await import("undici");

  // Required by IPRoyal documentation
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const proxyUri = buildProxyUri();
  let lastErr: Error | null = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[iproyal] Retry ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      // Fresh dispatcher per request = fresh IP rotation
      const dispatcher = new ProxyAgent({
        uri: proxyUri,
        connect: { rejectUnauthorized: false },
      });

      // Build headers object from RequestInit
      const reqHeaders: Record<string, string> = {};
      if (options.headers) {
        if (options.headers instanceof Headers) {
          options.headers.forEach((v, k) => { reqHeaders[k] = v; });
        } else {
          const h = options.headers as Record<string, string>;
          Object.keys(h).forEach((k) => { reqHeaders[k] = h[k]; });
        }
      }

      // undici fetch with dispatcher — THIS is how IPRoyal Unblocker works
      const undiciRes = await undiciFetch(url, {
        method:     (options.method || "GET") as any,
        headers:    reqHeaders,
        body:       options.body as any,
        redirect:   "follow",
        dispatcher,
      } as any);

      lastStatus = undiciRes.status;

      if (undiciRes.status === 407) {
        console.error("[iproyal] 407 — check credentials or whitelist VPS IP in IPRoyal dashboard");
        const b = await undiciRes.arrayBuffer();
        const h = new Headers();
        undiciRes.headers.forEach((v: string, k: string) => h.set(k, v));
        return new Response(b, { status: 407, headers: h });
      }

      if (BLOCKED_CODES.has(undiciRes.status) && attempt < MAX_RETRIES - 1) {
        console.log(`[iproyal] Got ${undiciRes.status} — retrying with fresh IP...`);
        continue;
      }

      // Convert undici response → standard Web API Response
      const body    = await undiciRes.arrayBuffer();
      const headers = new Headers();
      undiciRes.headers.forEach((v: string, k: string) => headers.set(k, v));

      return new Response(body, { status: undiciRes.status, headers });

    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.warn(`[iproyal] Attempt ${attempt + 1} error: ${lastErr.message}`);
    }
  }

  throw lastErr ?? new Error(`IPRoyal: all retries failed (last status: ${lastStatus})`);
}

// ── Tor ────────────────────────────────────────────────────────────────────────

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

// ── Direct ─────────────────────────────────────────────────────────────────────

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