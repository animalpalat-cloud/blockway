const express = require('express');
const https = require('https');
const url = require('url');
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON and raw bodies
app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// RapidAPI Configuration
const RAPIDAPI_KEY = '9edd2be2bcmsh71a42028043951ep18be61jsnbb7b74d1937b';
const RAPIDAPI_HOST = 'bypass-akamai-cloudflare.p.rapidapi.com';

/**
 * Custom Request Handler / Proxy Gateway
 */
app.all('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing url query parameter.' });
    }

    console.log(`[Proxy] Handling ${req.method} request to: ${targetUrl}`);

    try {
        const parsedUrl = new url.URL(targetUrl);
        
        // Prepare headers to forward to the target
        const headersToForward = { ...req.headers };
        delete headersToForward['host'];
        delete headersToForward['x-rapidapi-key'];
        delete headersToForward['x-rapidapi-host'];

        // Prepare the RapidAPI request payload
        const rapidApiPayload = {
            url: targetUrl,
            method: req.method,
            headers: headersToForward,
            payload: req.body && Object.keys(req.body).length > 0 ? req.body : {},
            proxy: '',
            impersonate: 'chrome120'
        };

        const options = {
            method: 'POST',
            hostname: RAPIDAPI_HOST,
            port: null,
            path: '/paid/akamai',
            headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': RAPIDAPI_HOST,
                'Content-Type': 'application/json'
            }
        };

        const proxyReq = https.request(options, (proxyRes) => {
            const chunks = [];
            proxyRes.on('data', (chunk) => chunks.push(chunk));
            proxyRes.on('end', () => {
                const responseBody = Buffer.concat(chunks);

                // Relay response headers and cookies
                Object.entries(proxyRes.headers).forEach(([key, value]) => {
                    // Skip certain headers that might interfere with the client
                    if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) return;
                    res.setHeader(key, value);
                });

                res.status(proxyRes.statusCode || 200).send(responseBody);
            });
        });

        proxyReq.on('error', (err) => {
            console.error('[Proxy Error]', err);
            res.status(502).json({ error: 'Failed to reach RapidAPI gateway.', details: err.message });
        });

        proxyReq.write(JSON.stringify(rapidApiPayload));
        proxyReq.end();

    } catch (err) {
        console.error('[URL Error]', err);
        res.status(400).json({ error: 'Invalid target URL.' });
    }
});

// Simple health check
app.get('/', (req, res) => {
    res.send('Blockway Custom Proxy Gateway is running.');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`Proxy endpoint: http://localhost:${port}/proxy?url=TARGET_URL`);
});
