'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');
const url     = require('url');
const zlib    = require('zlib');
const net     = require('net');
const cheerio = require('cheerio');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app  = express();
const port = process.env.PORT || 3000;

// ─── SOCKS5 / Cloudflare WARP Configuration ───────────────────────────────────
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || 'socks5h://127.0.0.1:40000';
const socksAgent = new SocksProxyAgent(SOCKS5_PROXY);
console.log(`[Proxy] Routing all traffic through SOCKS5: ${SOCKS5_PROXY}`);

// ─── Middleware ────────────────────────────────────────────────────────────────
// express.raw() buffers any body type as a raw Buffer – critical for relaying
// POST/PUT bodies to API endpoints without mangling them.
app.use(express.raw({ type: '*/*', limit: '30mb' }));

// ─── Constants ─────────────────────────────────────────────────────────────────
const PROXY_PATH = '/proxy';

const STRIP_FROM_RESPONSE = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'strict-transport-security',
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
]);

// ─── SSRF Protection ──────────────────────────────────────────────────────────
const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'ws:', 'wss:', 'data:', 'javascript:', 'gopher:', 'blob:']);


function isBlockedTarget(parsed) {
    if (!parsed) return true;
    if (BLOCKED_PROTOCOLS.has(parsed.protocol)) return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

    const h = parsed.hostname.toLowerCase();
    
    // 1. Literal hostnames
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '0:0:0:0:0:0:0:1'].includes(h)) return true;
    if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.test') || h.endsWith('.invalid')) return true;

    // 2. IPv4 Decimal/Hex/Octal bypass protection & private ranges
    // Node's new URL() normalizes most of these to dotted-quad.
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
        const a = +m[1], b = +m[2];
        if (a === 127 || a === 10 || a === 0) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        if (a >= 224) return true; // Multicast
    }

    // 3. IPv6 Private/Reserved ranges
    if (h.startsWith('[') && h.endsWith(']')) {
        const v6 = h.slice(1, -1);
        if (v6 === '::1' || v6 === '::') return true;
        if (v6.startsWith('fe80:') || v6.startsWith('fc00:') || v6.startsWith('fd00:')) return true;
    }

    return false;
}

// ─── Header Spoofing ──────────────────────────────────────────────────────────
const CHROME_LIKE_UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/131.0.0.0 Chrome/131.0.0.0 Safari/537.36',
];

// These incoming headers are replaced with spoofed browser-like equivalents
const INCOMING_STRIP = new Set([
    'user-agent', 'accept', 'accept-language', 'accept-encoding',
    'referer', 'origin',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'host', 'connection', 'content-length',
    // Strip proxy-reveal headers
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'via', 'forwarded',
]);

/**
 * Infers the resource kind from URL to set context-appropriate headers
 * (avoids sending text/html Accept for a .js file, which some CDNs flag).
 */
function inferKind(targetParsed) {
    const p = targetParsed.pathname.toLowerCase();
    if (/\.(js|mjs|cjs)(\?|$)/.test(p)) return 'script';
    if (/\.css(\?|$)/.test(p)) return 'style';
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|avif|bmp)(\?|$)/.test(p)) return 'image';
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/.test(p)) return 'font';
    return 'document';
}

function buildSpoofedHeaders(incoming, targetParsed, ref) {
    const out = {};

    // 1. Pass through safe, non-revealing client headers
    Object.entries(incoming).forEach(([k, v]) => {
        const l = k.toLowerCase();
        if (!INCOMING_STRIP.has(l) && !l.startsWith('x-')) out[l] = v;
    });

    // 2. Rotate User-Agent
    const ua = CHROME_LIKE_UAS[Math.floor(Math.random() * CHROME_LIKE_UAS.length)];
    out['user-agent'] = ua;

    // 3. Context-appropriate Accept header
    const kind = inferKind(targetParsed);
    if (kind === 'script') {
        out['accept'] = '*/*';
    } else if (kind === 'style') {
        out['accept'] = 'text/css,*/*;q=0.1';
    } else if (kind === 'image') {
        out['accept'] = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
    } else if (kind === 'font') {
        out['accept'] = 'application/font-woff2;q=1.0,font/woff2;q=1.0,*/*;q=0.8';
    } else {
        out['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
    }

    out['accept-language'] = 'en-US,en;q=0.9';
    out['accept-encoding'] = 'identity';

    // 4. Matching Sec-Ch-Ua client hints
    const m = ua.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/) || ua.match(/Chrome\/(\d+)/);
    const version = m ? m[1] : '131';
    const fullVersion = m && m[0] ? m[0].split('/')[1] : `${version}.0.0.0`;
    const isEdge = ua.includes('Edg/');

    out['sec-ch-ua'] = isEdge
        ? `"Not A(Brand";v="99", "Microsoft Edge";v="${version}", "Chromium";v="${version}"`
        : `"Not A(Brand";v="99", "Google Chrome";v="${version}", "Chromium";v="${version}"`;
    out['sec-ch-ua-mobile'] = '?0';
    out['sec-ch-ua-platform'] = ua.includes('Windows') ? '"Windows"' : ua.includes('Mac') ? '"macOS"' : '"Linux"';
    out['sec-ch-ua-full-version-list'] = isEdge
        ? `"Not A(Brand";v="99.0.0.0", "Microsoft Edge";v="${fullVersion}", "Chromium";v="${fullVersion}"`
        : `"Not A(Brand";v="99.0.0.0", "Google Chrome";v="${fullVersion}", "Chromium";v="${fullVersion}"`;

    // 5. Referer & Origin
    let referer = `${targetParsed.origin}/`;
    if (ref) {
        try {
            const refParsed = new url.URL(ref);
            if (refParsed.protocol === 'http:' || refParsed.protocol === 'https:') {
                referer = refParsed.href;
            }
        } catch (_) {}
    }
    out['referer'] = referer;
    out['origin']  = targetParsed.origin;

    // 6. Sec-Fetch headers
    if (kind === 'document') {
        out['sec-fetch-dest'] = 'document';
        out['sec-fetch-mode'] = 'navigate';
        out['sec-fetch-site'] = ref ? 'cross-site' : 'none';
        out['sec-fetch-user'] = '?1';
    } else {
        out['sec-fetch-dest'] = kind;
        out['sec-fetch-mode'] = 'no-cors';
        out['sec-fetch-site'] = 'cross-site';
        out['sec-fetch-user'] = '?0';
    }

    // 7. Modern Browser Extras
    out['priority'] = kind === 'document' || kind === 'style' ? 'u=0, i' : kind === 'script' ? 'u=1' : 'u=2';
    out['dnt'] = '1';
    if (targetParsed.protocol === 'https:') out['upgrade-insecure-requests'] = '1';

    return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function decompress(buffer, encoding) {
    if (!encoding) return buffer;
    const enc = encoding.toLowerCase();
    try {
        if (enc.includes('gzip'))    return zlib.gunzipSync(buffer);
        if (enc.includes('deflate')) return zlib.inflateSync(buffer);
        if (enc.includes('br'))      return zlib.brotliDecompressSync(buffer);
    } catch (err) {
        console.error('[Decompress Error]', err.message);
    }
    return buffer;
}

/**
 * Safely proxies a URL: resolves relative→absolute, validates, and
 * percent-encodes the full absolute URL before appending to /proxy?url=
 */
function proxyUrl(target, base, reqHost) {
    if (!target || typeof target !== 'string') return target;
    const t = target.trim();
    // Skip non-proxiable schemes
    if (!t || t.startsWith('#') || t.startsWith('javascript:') ||
        t.startsWith('mailto:') || t.startsWith('tel:') ||
        t.startsWith('data:') || t.startsWith('blob:')) {
        return target;
    }
    try {
        const absolute = new url.URL(t, base);
        // SSRF check on rewritten URLs too
        if (isBlockedTarget(absolute)) return target;
        // encodeURIComponent encodes the FULL absolute URL so special chars in
        // query strings (like & = ? #) are preserved intact on the proxy side.
        return `http://${reqHost}${PROXY_PATH}?url=${encodeURIComponent(absolute.toString())}`;
    } catch {
        return target;
    }
}

function rewriteCss(css, base, reqHost) {
    return css.replace(/url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (match, quote, inner) => {
        const rewritten = proxyUrl(inner, base, reqHost);
        return `url("${rewritten}")`;
    });
}

function rewriteSrcset(srcset, base, reqHost) {
    return srcset.split(',').map(part => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part;
        bits[0] = proxyUrl(bits[0], base, reqHost);
        return bits.join(' ');
    }).join(', ');
}

// ─── Client Runtime (injected into HTML) ─────────────────────────────────────
// Patches fetch/XHR/history so JS-driven requests stay inside the proxy.
function buildClientRuntime(targetOrigin, proxyBase) {
    return `(function(){
    var O=${JSON.stringify(targetOrigin)};
    var P=${JSON.stringify(proxyBase + '?url=')};
    function p(u){
        if(!u||typeof u!=='string'||u.startsWith('data:')||u.startsWith('blob:')) return u;
        try{
            var a=new URL(u,O).href;
            if(a.startsWith(P)) return a;
            return P+encodeURIComponent(a);
        }catch(e){return u;}
    }
    var oF=window.fetch;
    window.fetch=function(i,o){
        if(typeof i==='string') return oF.call(this,p(i),o);
        if(i instanceof Request){
            var r=new Request(p(i.url),i);
            return oF.call(this,r,o);
        }
        return oF.apply(this,arguments);
    };
    var oO=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
        if(typeof u==='string') arguments[1]=p(u);
        return oO.apply(this,arguments);
    };
    var oP=history.pushState, oR=history.replaceState;
    history.pushState=function(s,t,u){return oP.call(this,s,t,u?p(u):u);};
    history.replaceState=function(s,t,u){return oR.call(this,s,t,u?p(u):u);};
})();`.replace(/<\/script/gi, '<\\/script');
}

function rewriteHtml(html, base, reqHost) {
    const $ = cheerio.load(html, { xmlMode: false, decodeEntities: false });
    const targetOrigin = new url.URL(base).origin;
    const proxyBase = `http://${reqHost}${PROXY_PATH}`;

    // Inject client runtime at the very top of <head>
    $('head').prepend(`<script>${buildClientRuntime(targetOrigin, proxyBase)}</script>`);
    $('head').prepend('<meta name="referrer" content="no-referrer">');

    const URL_ATTRS = [
        { sel: 'a',                    attr: 'href' },
        { sel: 'link',                 attr: 'href' },
        { sel: 'img',                  attr: 'src' },
        { sel: 'img',                  attr: 'srcset', isSrcset: true },
        { sel: 'source',               attr: 'src' },
        { sel: 'source',               attr: 'srcset', isSrcset: true },
        { sel: 'script',               attr: 'src' },
        { sel: 'iframe',               attr: 'src' },
        { sel: 'form',                 attr: 'action' },
        { sel: 'video',                attr: 'src' },
        { sel: 'video',                attr: 'poster' },
        { sel: 'audio',                attr: 'src' },
        { sel: 'track',                attr: 'src' },
        { sel: 'embed',                attr: 'src' },
        { sel: 'object',               attr: 'data' },
        { sel: 'use',                  attr: 'href' },
        { sel: 'use',                  attr: 'xlink:href' },
        { sel: 'image',                attr: 'href' },
        { sel: 'image',                attr: 'xlink:href' },
        { sel: 'input[type=image]',    attr: 'src' },
        { sel: 'button[formaction]',   attr: 'formaction' },
    ];

    URL_ATTRS.forEach(({ sel, attr, isSrcset }) => {
        $(sel).each((_, el) => {
            const val = $(el).attr(attr);
            if (!val) return;
            if (isSrcset) {
                $(el).attr(attr, rewriteSrcset(val, base, reqHost));
            } else {
                $(el).attr(attr, proxyUrl(val, base, reqHost));
            }
        });
    });

    // Rewrite inline style attributes and <style> blocks
    $('[style]').each((_, el) => {
        const s = $(el).attr('style');
        if (s) $(el).attr('style', rewriteCss(s, base, reqHost));
    });
    $('style').each((_, el) => {
        const c = $(el).html();
        if (c) $(el).html(rewriteCss(c, base, reqHost));
    });

    // Neutralise CSP and X-Frame-Options equivalents in markup
    $('meta[http-equiv]').each((_, el) => {
        const equiv = ($(el).attr('http-equiv') || '').toLowerCase();
        if (equiv === 'content-security-policy' || equiv === 'x-frame-options') {
            $(el).remove();
        }
    });

    return $.html();
}

// ─── CORS Preflight Handler ───────────────────────────────────────────────────
app.options('*', (req, res) => {
    res.set({
        'access-control-allow-origin':  '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Language, Referer, Origin',
        'access-control-max-age':       '86400',
    }).sendStatus(204);
});

// ─── Proxy Handler ─────────────────────────────────────────────────────────────
app.all(PROXY_PATH, (req, res) => {
    // ── 1. Parse & validate target URL ──────────────────────────────────────────
    // Robust URL extraction: We look for the first occurrence of '?url=' in the 
    // original URL to avoid Express's automatic decoding/splitting of parameters.
    let rawTarget = '';
    const urlIdx = req.originalUrl.indexOf('url=');
    if (urlIdx !== -1) {
        const afterUrl = req.originalUrl.slice(urlIdx + 4);
        // Split at the first '&ref=' if it exists (internal proxy param)
        const refIdx = afterUrl.indexOf('&ref=');
        rawTarget = refIdx !== -1 ? afterUrl.slice(0, refIdx) : afterUrl;
        try {
            rawTarget = decodeURIComponent(rawTarget);
        } catch (e) {
            // Fallback to Express query param if decodeURIComponent fails
            rawTarget = req.query.url;
        }
    } else {
        rawTarget = req.query.url;
    }

    if (!rawTarget) {
        return res.status(400).json({ error: 'Missing ?url= query parameter.' });
    }

    let targetParsed;
    try {
        targetParsed = new url.URL(rawTarget);
    } catch {
        // Try fixing common missing-protocol cases
        if (!rawTarget.includes('://')) {
            try {
                targetParsed = new url.URL('https://' + rawTarget);
            } catch {
                return res.status(400).json({ error: 'Invalid target URL.' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid target URL.' });
        }
    }

    // Fix 5: SSRF Protection
    if (isBlockedTarget(targetParsed)) {
        return res.status(403).json({ error: 'Target URL is blocked for security reasons.' });
    }

    const reqHost  = req.headers.host;
    const isHttps  = targetParsed.protocol === 'https:';
    const ref      = typeof req.query.ref === 'string' ? req.query.ref : null;

    // Fix 2: Header Spoofing
    const upstreamHeaders = buildSpoofedHeaders(req.headers, targetParsed, ref);

    // Fix 3: Body handling – express.raw() gives us a Buffer; we relay it as-is.
    // The `body` is only set once here, avoiding the "body already used" problem
    // that occurs when arrayBuffer() is called multiple times on a consumed stream.
    const rawBody = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : null;
    if (rawBody) {
        upstreamHeaders['content-length'] = String(rawBody.length);
        // Preserve content-type for API calls (don't overwrite if already set)
        if (!upstreamHeaders['content-type'] && req.headers['content-type']) {
            upstreamHeaders['content-type'] = req.headers['content-type'];
        }
    }

    // Fix 1 (cont): Build upstream path preserving the exact path + query from
    // the parsed URL object so special chars are properly percent-encoded.
    let upstreamPath = targetParsed.pathname + targetParsed.search;
    upstreamPath = upstreamPath.replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

    const options = {
        agent:   socksAgent,
        method:  req.method,
        hostname: targetParsed.hostname,
        port:    Number(targetParsed.port) || (isHttps ? 443 : 80),
        path:    upstreamPath,
        headers: upstreamHeaders,
        timeout: 30_000,
    };

    const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
            // Fix 3: We concatenate chunks exactly once into a Buffer, so there
            // is no "body already used" scenario – we never consume it a second time.
            let buffer = Buffer.concat(chunks);

            // Decompress if the server ignored our 'identity' preference
            buffer = decompress(buffer, proxyRes.headers['content-encoding']);

            const contentType = proxyRes.headers['content-type'] || '';
            let finalBody = buffer;

            try {
                if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
                    finalBody = Buffer.from(rewriteHtml(buffer.toString('utf-8'), rawTarget, reqHost));
                } else if (contentType.includes('text/css')) {
                    // Fix 4: CSS rewritten so url() assets are proxied too
                    finalBody = Buffer.from(rewriteCss(buffer.toString('utf-8'), rawTarget, reqHost));
                }
            } catch (err) {
                console.error('[Rewrite Error]', err.message);
                // Fall back to raw buffer – better to send raw than nothing
            }

            // Build clean response headers
            const outHeaders = {};
            Object.entries(proxyRes.headers).forEach(([key, value]) => {
                if (!STRIP_FROM_RESPONSE.has(key.toLowerCase())) {
                    outHeaders[key] = value;
                }
            });

            // Rewrite Location header for redirects so they stay within the proxy
            const locationHeader = outHeaders['location'];
            if (locationHeader) {
                try {
                    const finalUrl = targetParsed.toString();
                    const absLocation = new url.URL(locationHeader, finalUrl).toString();
                    outHeaders['location'] = `${PROXY_PATH}?url=${encodeURIComponent(absLocation)}`;
                } catch (e) {}
            }

            // Enforce CORS and correct content-type
            outHeaders['content-type']                    = contentType;
            outHeaders['access-control-allow-origin']     = '*';
            outHeaders['access-control-allow-methods']    = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
            outHeaders['access-control-allow-headers']    = 'Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Language, Referer, Origin';
            outHeaders['cache-control']                   = 'no-store, no-cache, must-revalidate, private, max-age=0';

            res.writeHead(proxyRes.statusCode || 200, outHeaders);
            res.end(finalBody);
        });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: 'Gateway timeout.' });
    });

    proxyReq.on('error', (err) => {
        console.error(`[Proxy Error] ${req.method} ${rawTarget} → ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Failed to reach target.', detail: err.message });
    });

    if (rawBody) proxyReq.write(rawBody);
    proxyReq.end();
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.json({ status: 'running', gateway: 'Blockway Proxy', version: '3.0.0' });
});

app.listen(port, () => {
    console.log(`[Server] Blockway Proxy running on port ${port}`);
});
