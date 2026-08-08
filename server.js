const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression'); // Install via: npm install compression
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable text compression for faster playlist downloads
app.use(compression());

// Optimized socket settings for aggressive media streaming
const agentOptions = { 
    keepAlive: true, 
    maxSockets: 250, 
    maxFreeSockets: 50, 
    keepAliveMsecs: 1000 
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

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

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (e) {
        return res.status(400).send('Invalid url parameter');
    }

    const isM3U8 = parsedUrl.pathname.endsWith('.m3u8') || url.includes('.m3u8');
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
        timeout: 8000
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(options, (proxyRes) => {
        // Forward HTTP status errors from upstream source
        if (proxyRes.statusCode >= 400) {
            return res.status(proxyRes.statusCode).send('Upstream server error');
        }

        if (isM3U8) {
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'public, max-age=1');

            // Gather the playlist chunks fast into memory
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                const playlist = Buffer.concat(chunks).toString('utf8');
                
                // Fast regular expression rewrite instead of line-by-line reading
                const rewritten = playlist.replace(/^(?!#)(.+)$/gm, (match) => {
                    const trimmed = match.trim();
                    if (!trimmed) return match;
                    const abs = resolveUrl(url, trimmed);
                    return `${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}`;
                }).replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                    const abs = resolveUrl(url, p1);
                    return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
                });

                res.send(rewritten);
            });
        } else {
            // High speed pipelining for raw .ts video chunks
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/MP2T');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            
            if (proxyRes.headers['content-length']) {
                res.setHeader('Content-Length', proxyRes.headers['content-length']);
            }
            
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(500).send(err.message);
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('Gateway Timeout');
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

app.listen(PORT, () => console.log(`Fast proxy running on port ${PORT}`));