const express = require('express');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200 });

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

function resolveUrl(baseUrl, relativeUrl) {
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
        return relativeUrl;
    }
    return new URL(relativeUrl, baseUrl).href;
}

app.get('/proxy', (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    const parsedUrl = new URL(url);
    const isM3U8 = url.includes('.m3u8');
    const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
    const encodedReferer = referer ? encodeURIComponent(referer) : '';

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
            'Referer': referer || '',
            'Origin': referer ? new URL(referer).origin : ''
        },
        agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
        timeout: 5000
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(options, (proxyRes) => {
        if (isM3U8) {
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'public, max-age=2');

            const rl = readline.createInterface({
                input: proxyRes,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                if (trimmed[0] === '#') {
                    if (trimmed.includes('URI=')) {
                        const updated = trimmed.replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                            const abs = resolveUrl(url, p1);
                            return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
                        });
                        res.write(updated + '\n');
                    } else {
                        res.write(trimmed + '\n');
                    }
                } else {
                    const abs = resolveUrl(url, trimmed);
                    res.write(`${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`);
                }
            });

            rl.on('close', () => res.end());
        } else {
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/MP2T');
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(500).send(err.message);
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

app.listen(PORT, () => console.log(`Fast proxy running on port ${PORT}`));