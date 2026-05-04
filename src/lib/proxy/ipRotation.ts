/**
 * ipRotation.ts — Outbound IP rotation via Tor SOCKS5
 *
 * How it works:
 *   All outbound fetch requests go through Tor's SOCKS5 proxy (127.0.0.1:9050).
 *   Tor automatically routes requests through different exit nodes globally.
 *   If a request gets blocked (403/429/connection reset), we request a new
 *   Tor circuit and retry — effectively changing our exit IP.
 *
 * Requirements on VPS:
 *   apt-get install -y tor
 *   systemctl enable tor && systemctl start tor
 *
 * Tor gives a new IP roughly every 10 seconds or when we send NEWNYM signal.
 * We send NEWNYM on 403/429 responses to rotate immediately.
 */

import { Agent } from "https";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as net from "net";

// ── Configuration ─────────────────────────────────────────────────────────────

const TOR_SOCKS5_HOST = "127.0.0.1";
const TOR_SOCKS5_PORT = 9050;
const TOR_CONTROL_PORT = 9051;
const TOR_CONTROL_PASSWORD = ""; // empty = no auth (our torrc config)

const USE_TOR = process.env.USE_TOR === "true" || process.env.USE_TOR === "1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 800;

// HTTP status codes we treat as "blocked" → rotate IP and retry
const BLOCKED_STATUS_CODES = new Set([403, 429, 503, 451]);

// ── Tor circuit rotation ───────────────────────────────────────────────────────

/**
 * Send NEWNYM signal to Tor control port.
 * This asks Tor to build a new circuit with a different exit node.
 * The new circuit is ready in ~2-5 seconds.
 */
async function rotateTorCircuit(): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection(TOR_CONTROL_PORT, TOR_CONTROL_HOST());
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(); // don't block on failure
    }, 3000);

    socket.on("connect", () => {
      // Authenticate (empty password = AUTHENTICATE "")
      const auth = TOR_CONTROL_PASSWORD
        ? `AUTHENTICATE "${TOR_CONTROL_PASSWORD}"\r\n`
        : `AUTHENTICATE ""\r\n`;
      socket.write(auth);
    });

    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.includes("250 OK") && !buffer.includes("SIGNAL")) {
        // Auth succeeded, send NEWNYM
        socket.write("SIGNAL NEWNYM\r\n");
      } else if (buffer.includes("250 OK") && buffer.includes("SIGNAL")) {
        // NEWNYM acknowledged
        clearTimeout(timeout);
        socket.end();
        resolve();
      } else if (buffer.includes("515") || buffer.includes("551")) {
        // Auth failed or error
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(); // don't crash on Tor control failure
    });
  });
}

function TOR_CONTROL_HOST(): string {
  return TOR_SOCKS5_HOST;
}

// ── Tor-enabled fetch ──────────────────────────────────────────────────────────

/**
 * Build a SOCKS5 agent that routes through Tor.
 * Each call creates a fresh agent (no connection reuse across circuits).
 */
function makeTorAgent(): SocksProxyAgent {
  return new SocksProxyAgent(
    `socks5://${TOR_SOCKS5_HOST}:${TOR_SOCKS5_PORT}`,
    { timeout: 20000 }
  );
}

/**
 * Fetch a URL with automatic Tor-based IP rotation on block.
 *
 * @param url       Target URL
 * @param options   Standard RequestInit options (method, headers, body, signal)
 * @returns         The Response from the target server
 */
export async function fetchWithRotation(
  url: string,
  options: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  // If Tor is not enabled, fall through to normal fetch with retry
  if (!USE_TOR) {
    return fetchWithRetry(url, options);
  }

  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Rotate Tor circuit before retry
      console.log(`[tor] Rotating circuit (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await rotateTorCircuit();
      // Wait for new circuit to be ready
      await sleep(RETRY_DELAY_MS * attempt);
    }

    try {
      const agent = makeTorAgent();

      const response = await fetch(url, {
        ...options,
        // @ts-ignore — Node fetch supports agent for SOCKS5
        agent,
      });

      // Check if we're blocked
      if (BLOCKED_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES - 1) {
        console.log(`[tor] Got ${response.status} from ${url}, rotating IP...`);
        lastResponse = response;
        continue;
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[tor] Fetch failed attempt ${attempt + 1}: ${lastError.message}`);

      if (attempt === MAX_RETRIES - 1) break;
    }
  }

  // All attempts failed — if we have a response, return it; otherwise throw
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error("All retry attempts failed");
}

/**
 * Fetch without Tor but with simple retry on network errors.
 * Used when USE_TOR=false or as fallback.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit & { signal?: AbortSignal },
  maxAttempts = 2,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS);
    }
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry on network errors, not on AbortError
      if (lastError.name === "AbortError") throw lastError;
    }
  }

  throw lastError ?? new Error("Fetch failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Exports ───────────────────────────────────────────────────────────────────

export { USE_TOR, MAX_RETRIES, BLOCKED_STATUS_CODES };
