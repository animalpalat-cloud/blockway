import type { Browser, HTTPResponse, Page } from "puppeteer";
import puppeteer from "puppeteer";
import { cookieHeaderForHost } from "./cookieJar";
import { buildUpstreamRequestHeaders, headersToForwardForPuppeteer } from "./upstreamHeaders";
import {
  PROXY_PUPPETEER_SETTLE_MS,
  PROXY_PUPPETEER_TIMEOUT_MS,
} from "./proxyConfig";

const g = globalThis as unknown as { __phPuppeteerBrowser?: Promise<Browser> };

function getLaunchArgs(): string[] {
  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
  ];
}

function getBrowser(): Promise<Browser> {
  if (!g.__phPuppeteerBrowser) {
    g.__phPuppeteerBrowser = puppeteer.launch({
      headless: true,
      args: getLaunchArgs(),
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return g.__phPuppeteerBrowser;
}

let queue: Promise<unknown> = Promise.resolve();

function withRenderLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(() => fn());
  queue = next.then(() => {}).catch(() => {});
  return next;
}

async function applyJarToPage(
  page: Page,
  sessionId: string,
  target: URL,
): Promise<void> {
  const h = cookieHeaderForHost(sessionId, target.hostname);
  if (!h) return;
  const base = target.origin;
  for (const part of h.split(";").map((s) => s.trim())) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1);
    if (!name) continue;
    await page.setCookie({ name, value, url: `${base}/` });
  }
}

export type PuppeteerRenderResult = {
  html: string;
  finalUrl: string;
  status: number;
  cookies: { name: string; value: string; domain?: string }[];
};

/**
 * Renders a URL in headless Chrome (redirects followed by the browser),
 * then returns serialized HTML for rewriting. Subresource requests in
 * the page are not the proxy's `fetch` — callers should use this only
 * for the main document; assets still use the fast fetch path.
 */
export function renderWithPuppeteer(
  target: URL,
  requestHeaders: Headers,
  sessionId: string,
  jarHost: string,
): Promise<PuppeteerRenderResult> {
  return withRenderLock(() =>
    doRenderWithPuppeteer(target, requestHeaders, sessionId, jarHost),
  );
}

async function doRenderWithPuppeteer(
  target: URL,
  requestHeaders: Headers,
  sessionId: string,
  jarHost: string,
): Promise<PuppeteerRenderResult> {
  const upstreamH = buildUpstreamRequestHeaders(
    requestHeaders,
    target,
    { sessionId, jarHost },
  );
  const extra = headersToForwardForPuppeteer(upstreamH);

  const browser = await getBrowser();
  const page = await browser.newPage();
  const urlStr = target.toString();

  try {
    const ua = upstreamH.get("user-agent") || "";
    if (ua) await page.setUserAgent(ua);

    await page.setExtraHTTPHeaders(extra);
    await applyJarToPage(page, sessionId, target);

    const referer = upstreamH.get("referer") || `${target.origin}/`;
    const response: HTTPResponse | null = await page.goto(urlStr, {
      waitUntil: "domcontentloaded",
      timeout: PROXY_PUPPETEER_TIMEOUT_MS,
      referer,
    });

    const st = response?.status() ?? 200;

    if (st < 500) {
      await page
        .evaluate(
          (ms) =>
            new Promise<void>((r) => {
              setTimeout(r, Math.min(8_000, Math.max(0, ms)));
            }),
          PROXY_PUPPETEER_SETTLE_MS,
        )
        .catch(() => {});
    }

    const finalUrl = page.url();
    const [html, cookies] = await Promise.all([
      page.content(),
      page.cookies(),
    ]);
    return {
      html,
      finalUrl: finalUrl || urlStr,
      status: st,
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
      })),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
