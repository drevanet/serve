const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 10000;

const http = require('http');
const https = require('https');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 1000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 1000 });

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Fast URL resolution inline
function resolveUrl(baseUrl, relativeUrl) {
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
    return new URL(relativeUrl, baseUrl).href;
}

app.get('/proxy', async (req, res) => {
    const { url, referrer } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    const isM3U8 = url.includes('.m3u8');
    const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
    const encodedReferrer = referrer ? encodeURIComponent(referrer) : '';

    try {
        const config = {
            method: 'get',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
                'Referer': referrer || '',
                'Origin': referrer ? new URL(referrer).origin : '',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            responseType: isM3U8 ? 'text' : 'stream',
            httpAgent,
            httpsAgent,
            timeout: 4000
        };

        const response = await axios(config);

        if (isM3U8) {
            // Fast single-pass regex replacement for URI= and media segment lines
            let manifest = response.data;
            
            // Rewrite URI="..." attributes in tags like #EXT-X-KEY or #EXT-X-MAP
            manifest = manifest.replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                const abs = resolveUrl(url, p1);
                return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referrer=${encodedReferrer}"`;
            });

            // Rewrite line-by-line media/playlist paths without slow array splitting
            manifest = manifest.replace(/^(?!#)(.+)$/gm, (line) => {
                const cleanLine = line.trim();
                if (!cleanLine) return '';
                const abs = resolveUrl(url, cleanLine);
                return `${proxyHost}?url=${encodeURIComponent(abs)}&referrer=${encodedReferrer}`;
            });

            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'public, max-age=1');
            return res.send(manifest);
        }

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        response.data.pipe(res);
        req.on('close', () => response.data.destroy());

    } catch (error) {
        if (!res.headersSent) {
            res.status(error.response?.status || 500).send(error.message);
        }
    }
});

app.listen(PORT, () => console.log(`Ultra-fast proxy running on port ${PORT}`));
