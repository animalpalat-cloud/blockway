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
app.use(express.json());
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

    const tags = {
        'a': 'href', 'link': 'href', 'img': 'src', 'script': 'src',
        'iframe': 'src', 'form': 'action', 'source': 'src',
        'video': 'src', 'audio': 'src', 'track': 'src', 'embed': 'src'
    };

    Object.entries(tags).forEach(([tag, attr]) => {
        $(tag).each((_, el) => {
            const val = $(el).attr(attr);
            if (val) $(el).attr(attr, proxyUrl(val, base, reqHost));
            
            // Handle srcset
            const srcset = $(el).attr('srcset');
            if (srcset) {
                const rewritten = srcset.split(',').map(part => {
                    const [u, q] = part.trim().split(/\s+/);
                    return q ? `${proxyUrl(u, base, reqHost)} ${q}` : proxyUrl(u, base, reqHost);
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
    const upstreamHeaders = { ...req.headers };
    
    delete upstreamHeaders['host'];
    delete upstreamHeaders['connection'];
    upstreamHeaders['accept-encoding'] = 'identity'; 

    const body = req.body && req.body.length > 0 ? req.body : null;

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
