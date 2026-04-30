const express = require('express');
const https   = require('https');
const http    = require('http');
const url     = require('url');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app  = express();
const port = process.env.PORT || 3000;

// ─── SOCKS5 / Cloudflare WARP Configuration ───────────────────────────────────
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || 'socks5h://127.0.0.1:40000';
const socksAgent = new SocksProxyAgent(SOCKS5_PROXY);

console.log(`[Proxy] Routing all traffic through SOCKS5 (Remote DNS): ${SOCKS5_PROXY}`);

app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '10mb' }));

const HOP_BY_HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']);
const STRIP_FROM_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function buildUpstreamHeaders(incomingHeaders, targetParsed) {
    const out = {};
    for (const [key, value] of Object.entries(incomingHeaders)) {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) out[key] = value;
    }
    out['host'] = targetParsed.hostname;
    return out;
}

app.all('/proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= query parameter.' });

    let targetParsed;
    try { targetParsed = new url.URL(targetUrl); } catch { return res.status(400).json({ error: 'Invalid target URL.' }); }

    console.log(`[Proxy] ${req.method} → ${targetUrl}`);
    const isHttps = targetParsed.protocol === 'https:';
    const upstreamHeaders = buildUpstreamHeaders(req.headers, targetParsed);
    const body = req.body && req.body.length > 0 ? req.body : null;

    if (body) upstreamHeaders['content-length'] = Buffer.byteLength(body).toString();

    const options = {
        agent: socksAgent,
        method: req.method,
        hostname: targetParsed.hostname,
        port: targetParsed.port || (isHttps ? 443 : 80),
        path: targetParsed.pathname + targetParsed.search,
        headers: upstreamHeaders,
        timeout: 30000,
    };

    const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
        const outHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) outHeaders[key] = value;
        }
        outHeaders['access-control-allow-origin'] = '*';
        outHeaders['access-control-allow-methods'] = 'GET, POST, HEAD, OPTIONS, PUT, DELETE, PATCH';
        outHeaders['access-control-allow-headers'] = 'Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Language, Referer, Origin';

        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('[Proxy Error]', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Failed to reach target.', details: err.message });
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
});

app.listen(port, () => console.log(`[Server] Proxy endpoint: http://localhost:${port}/proxy?url=<TARGET_URL>`));
