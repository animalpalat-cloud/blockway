const express = require('express');
const https   = require('https');
const http    = require('http');
const url     = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app  = express();
const port = process.env.PORT || 3000;

// ─── SOCKS5 / Cloudflare WARP Configuration ───────────────────────────────────
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || 'socks5h://127.0.0.1:40000';

// One reusable agent for both http and https targets
const socksAgent = new SocksProxyAgent(SOCKS5_PROXY);

console.log(`[Proxy] Routing all traffic through SOCKS5: ${SOCKS5_PROXY}`);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// ─── Headers that must NOT be forwarded to the target ─────────────────────────
const HOP_BY_HOP_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
]);

// ─── Headers we must NOT relay back to the browser ────────────────────────────
const STRIP_FROM_RESPONSE = new Set([
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
]);

/**
 * Build the outgoing header set:
 * - Strips hop-by-hop headers.
 * - Replaces `host` with the target host.
 * - Preserves User-Agent, Cookie, Accept-Language, etc. from the client.
 */
function buildUpstreamHeaders(incomingHeaders, targetParsed) {
    const out = {};
    for (const [key, value] of Object.entries(incomingHeaders)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
            out[key] = value;
        }
    }
    // Always set the correct Host for the target
    out['host'] = targetParsed.hostname;
    return out;
}

// ─── Universal Proxy Handler ───────────────────────────────────────────────────
app.all('/proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing ?url= query parameter.' });
    }

    let targetParsed;
    try {
        targetParsed = new url.URL(targetUrl);
    } catch {
        return res.status(400).json({ error: 'Invalid target URL.' });
    }

    console.log(`[Proxy] ${req.method} → ${targetUrl}`);

    const isHttps  = targetParsed.protocol === 'https:';
    const driver   = isHttps ? https : http;
    const upstream = isHttps ? https : http;

    const upstreamHeaders = buildUpstreamHeaders(req.headers, targetParsed);

    // Collect the request body (already parsed by express.raw above)
    const body = req.body && req.body.length > 0 ? req.body : null;

    if (body) {
        upstreamHeaders['content-length'] = Buffer.byteLength(body).toString();
    }

    const options = {
        agent:    socksAgent,           // ← Route through Cloudflare WARP
        method:   req.method,
        hostname: targetParsed.hostname,
        port:     targetParsed.port || (isHttps ? 443 : 80),
        path:     targetParsed.pathname + targetParsed.search,
        headers:  upstreamHeaders,
        timeout:  30_000,
    };

    const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
        // Relay status and safe headers back to the browser
        const outHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
                outHeaders[key] = value;
            }
        }

        // CORS passthrough so browser-based clients work too
        outHeaders['access-control-allow-origin']  = '*';
        outHeaders['access-control-allow-methods'] = 'GET, POST, HEAD, OPTIONS, PUT, DELETE, PATCH';
        outHeaders['access-control-allow-headers'] = 'Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Language, Referer, Origin';

        res.writeHead(proxyRes.statusCode || 200, outHeaders);

        // Stream the response body directly — no buffering needed
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({ error: 'Gateway timeout reaching target.' });
        }
    });

    proxyReq.on('error', (err) => {
        console.error('[Proxy Error]', err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Failed to reach target.', details: err.message });
        }
    });

    if (body) {
        proxyReq.write(body);
    }
    proxyReq.end();
});

// ─── OPTIONS pre-flight (CORS) ────────────────────────────────────────────────
app.options('/proxy', (req, res) => {
    res.set({
        'access-control-allow-origin':  '*',
        'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS, PUT, DELETE, PATCH',
        'access-control-allow-headers': 'Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Language, Referer, Origin',
        'access-control-max-age':       '86400',
    }).sendStatus(204);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status:  'running',
        gateway: 'Blockway SOCKS5 Proxy Gateway',
        warp:    SOCKS5_PROXY,
        usage:   `GET /proxy?url=https://example.com`,
    });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(port, () => {
    console.log(`[Server] Running on port ${port}`);
    console.log(`[Server] Proxy endpoint: http://localhost:${port}/proxy?url=<TARGET_URL>`);
});
