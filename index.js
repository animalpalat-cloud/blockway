const express = require('express');
const https   = require('https');
const http    = require('http');
const url     = require('url');
const zlib    = require('zlib');
const cheerio = require('cheerio');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app  = express();
const port = process.env.PORT || 3000;

// ─── SOCKS5 / Cloudflare WARP Configuration ───────────────────────────────────
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || 'socks5h://127.0.0.1:40000';
const socksAgent = new SocksProxyAgent(SOCKS5_PROXY);

console.log(`[Proxy] Routing all traffic through SOCKS5 (Remote DNS): ${SOCKS5_PROXY}`);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.raw({ type: '*/*', limit: '30mb' })); // Higher limit for heavy sites

// ─── Constants ─────────────────────────────────────────────────────────────────
const PROXY_PATH = '/proxy';
const STRIP_FROM_RESPONSE = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'content-encoding',
    'content-length',
    'transfer-encoding',
]);

// ─── Client Runtime Generator (Injected into HTML) ─────────────────────────────
function buildClientRuntime(targetOrigin, proxyUrlBase) {
    return `
    (function() {
        const origin = ${JSON.stringify(targetOrigin)};
        const proxyBase = ${JSON.stringify(proxyUrlBase)};
        
        function p(u) {
            if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('blob:')) return u;
            try {
                const abs = new URL(u, origin).href;
                if (abs.startsWith(proxyBase)) return abs;
                return proxyBase + '?url=' + encodeURIComponent(abs);
            } catch(e) { return u; }
        }

        // Patch fetch
        const oFetch = window.fetch;
        window.fetch = function(i, init) {
            if (typeof i === 'string') return oFetch.call(this, p(i), init);
            return oFetch.apply(this, arguments);
        };

        // Patch XHR
        const oOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(m, u) {
            if (typeof u === 'string') u = p(u);
            return oOpen.apply(this, arguments);
        };

        // Patch History
        const oPush = history.pushState;
        history.pushState = function(s, t, u) {
            if (u) u = p(u);
            return oPush.call(this, s, t, u);
        };
    })();`.replace(/<\/script/gi, '<\\/script');
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function decompress(buffer, encoding) {
    if (!encoding) return buffer;
    try {
        if (encoding.includes('gzip')) return zlib.gunzipSync(buffer);
        if (encoding.includes('deflate')) return zlib.inflateSync(buffer);
        if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer);
    } catch (err) {
        console.error('[Decompress Error]', err.message);
    }
    return buffer;
}

function proxyUrl(target, base, reqHost) {
    try {
        const absolute = new url.URL(target, base).toString();
        if (absolute.startsWith('data:') || absolute.startsWith('blob:')) return target;
        return `http://${reqHost}${PROXY_PATH}?url=${encodeURIComponent(absolute)}`;
    } catch {
        return target;
    }
}

function rewriteCss(css, base, reqHost) {
    return css.replace(/url\s*\(\s*['"]?([^'")]*)['"]?\s*\)/gi, (match, inner) => {
        return `url("${proxyUrl(inner, base, reqHost)}")`;
    });
}

function rewriteHtml(html, base, reqHost) {
    const $ = cheerio.load(html, { xmlMode: false });
    const targetOrigin = new url.URL(base).origin;
    const proxyBase = `http://${reqHost}${PROXY_PATH}`;
    
    // Inject Runtime
    $('head').prepend(`<script>${buildClientRuntime(targetOrigin, proxyBase)}</script>`);
    $('head').prepend('<meta name="referrer" content="no-referrer">');

    const tags = [
        { sel: 'a', attr: 'href' },
        { sel: 'link', attr: 'href' },
        { sel: 'img', attr: 'src' },
        { sel: 'script', attr: 'src' },
        { sel: 'iframe', attr: 'src' },
        { sel: 'form', attr: 'action' },
        { sel: 'source', attr: 'src' },
        { sel: 'video', attr: 'src' },
        { sel: 'video', attr: 'poster' },
        { sel: 'audio', attr: 'src' },
        { sel: 'track', attr: 'src' },
        { sel: 'embed', attr: 'src' },
        { sel: 'object', attr: 'data' },
        { sel: 'use', attr: 'href' },
        { sel: 'use', attr: 'xlink:href' },
        { sel: 'image', attr: 'href' },
        { sel: 'image', attr: 'xlink:href' }
    ];

    tags.forEach(({ sel, attr }) => {
        $(sel).each((_, el) => {
            const val = $(el).attr(attr);
            if (val) $(el).attr(attr, proxyUrl(val, base, reqHost));
            
            // Handle srcset
            const srcset = $(el).attr('srcset');
            if (srcset) {
                const rewritten = srcset.split(',').map(part => {
                    const bits = part.trim().split(/\s+/);
                    if (!bits[0]) return part;
                    bits[0] = proxyUrl(bits[0], base, reqHost);
                    return bits.join(' ');
                }).join(', ');
                $(el).attr('srcset', rewritten);
            }
        });
    });

    // Inline styles
    $('[style]').each((_, el) => {
        const s = $(el).attr('style');
        if (s) $(el).attr('style', rewriteCss(s, base, reqHost));
    });

    $('style').each((_, el) => {
        const c = $(el).html();
        if (c) $(el).html(rewriteCss(c, base, reqHost));
    });

    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="content-security-policy"]').remove();

    return $.html();
}

// ─── Proxy Handler ─────────────────────────────────────────────────────────────
const CHROME_LIKE_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const INCOMING_STRIP = new Set([
    "user-agent", "accept", "accept-language", "accept-encoding", "referer", "origin",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "host", "connection"
]);

function buildSpoofedHeaders(incoming, targetUrl, ref) {
    const target = new url.URL(targetUrl);
    const out = {};
    
    // 1. Pass through safe headers
    Object.entries(incoming).forEach(([k, v]) => {
        if (!INCOMING_STRIP.has(k.toLowerCase())) out[k] = v;
    });

    // 2. Rotate User-Agent
    const ua = CHROME_LIKE_UAS[Math.floor(Math.random() * CHROME_LIKE_UAS.length)];
    out['user-agent'] = ua;

    // 3. Realistic Accept/Language
    out['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
    out['accept-language'] = 'en-US,en;q=0.9';
    out['accept-encoding'] = 'identity';

    // 4. Sec-Ch-Ua
    const version = ua.match(/Chrome\/(\d+)/)[1];
    out['sec-ch-ua'] = `"Not A(Brand";v="99", "Google Chrome";v="${version}", "Chromium";v="${version}"`;
    out['sec-ch-ua-mobile'] = '?0';
    out['sec-ch-ua-platform'] = ua.includes('Windows') ? '"Windows"' : ua.includes('Mac') ? '"macOS"' : '"Linux"';

    // 5. Referer & Origin
    // If 'ref' is provided (original page URL), use its origin. Else use target origin.
    let baseRef = target.origin + '/';
    if (ref) {
        try { baseRef = new url.URL(ref).origin + '/'; } catch(e) {}
    }
    out['referer'] = baseRef;
    out['origin'] = target.origin;

    // 6. Sec-Fetch
    out['sec-fetch-dest'] = 'document';
    out['sec-fetch-mode'] = 'navigate';
    out['sec-fetch-site'] = 'none';
    out['sec-fetch-user'] = '?1';
    
    return out;
}

// ─── Proxy Handler ─────────────────────────────────────────────────────────────
app.all(PROXY_PATH, (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= query parameter.' });

    let targetParsed;
    try {
        targetParsed = new url.URL(targetUrl);
    } catch {
        return res.status(400).json({ error: 'Invalid target URL.' });
    }

    const reqHost = req.headers.host;
    const isHttps = targetParsed.protocol === 'https:';
    
    // Apply Header Spoofing
    const upstreamHeaders = buildSpoofedHeaders(req.headers, targetUrl, req.query.ref);
    
    const body = req.body && req.body.length > 0 ? req.body : null;
    if (body) upstreamHeaders['content-length'] = body.length;

    const options = {
        agent:    socksAgent,
        method:   req.method,
        hostname: targetParsed.hostname,
        port:     targetParsed.port || (isHttps ? 443 : 80),
        path:     targetParsed.pathname + targetParsed.search,
        headers:  upstreamHeaders,
        timeout:  30_000,
    };

    const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
            let buffer = Buffer.concat(chunks);
            buffer = decompress(buffer, proxyRes.headers['content-encoding']);

            const contentType = proxyRes.headers['content-type'] || '';
            let finalBody = buffer;

            try {
                if (contentType.includes('text/html')) {
                    finalBody = Buffer.from(rewriteHtml(buffer.toString('utf-8'), targetUrl, reqHost));
                } else if (contentType.includes('text/css')) {
                    finalBody = Buffer.from(rewriteCss(buffer.toString('utf-8'), targetUrl, reqHost));
                }
            } catch (err) {
                console.error('[Rewrite Error]', err.message);
            }

            const outHeaders = {};
            Object.entries(proxyRes.headers).forEach(([key, value]) => {
                if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) outHeaders[key] = value;
            });

            outHeaders['content-type'] = contentType;
            outHeaders['access-control-allow-origin'] = '*';
            outHeaders['access-control-allow-methods'] = 'GET, POST, HEAD, OPTIONS, PUT, DELETE, PATCH';
            outHeaders['access-control-allow-headers'] = 'Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Language, Referer, Origin';

            res.writeHead(proxyRes.statusCode || 200, outHeaders);
            res.end(finalBody);
        });
    });

    proxyReq.on('error', (err) => {
        console.error('[Proxy Error]', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Failed to reach target.' });
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
});

app.get('/', (req, res) => {
    res.json({ status: 'running', gateway: 'Blockway Robust Proxy' });
});

app.listen(port, () => {
    console.log(`[Server] Running on port ${port}`);
});
