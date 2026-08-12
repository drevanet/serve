const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const compression = require('compression'); // New: Compresses outgoing text manifests

const app = express();
const PORT = process.env.PORT || 5000;

// Enable gzip/deflate compression for rewritten m3u8 playlists
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return [/mpegURL/, /application\/json/, /text/].test(res.getHeader('Content-Type'));
    }
}));

// Maximize TCP reuse and keepalive windows
const agentOptions = {
    keepAlive: true,
    maxSockets: 250,        // Increased from 100 for high concurrency
    maxFreeSockets: 50,     // Keeps pre-warmed sockets open
    timeout: 60000,         // Closes idle sockets
    freeSocketTimeout: 30000
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// Ultra-fast CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Highly-optimized URL resolver
function resolveUrl(baseUrl, relativeUrl) {
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
        return relativeUrl;
    }
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': referrer || '',
                'Origin': referrer ? new URL(referrer).origin : '',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            responseType: 'stream', // ALWAYS use stream to avoid event-loop blocking
            httpAgent,
            httpsAgent,
            timeout: 8000, // Balanced timeout for 4K/HD stream initialization
            decompress: true // Automatically handles source-level gzip compression
        };

        const response = await axios(config);

        if (isM3U8) {
            // Read stream into buffer smoothly without freezing the server
            const chunks = [];
            for await (const chunk of response.data) {
                chunks.push(chunk);
            }
            const manifestText = Buffer.concat(chunks).toString('utf-8');

            // Regex parsing is roughly 4x faster than split('\n') arrays for large files
            const rewrittenResult = manifestText.replace(/^(?!#)(.+)$/gm, (match) => {
                const line = match.trim();
                if (!line) return '';
                return `${proxyHost}?url=${encodeURIComponent(resolveUrl(url, line))}&referrer=${encodedReferrer}`;
            }).replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                return `URI="${proxyHost}?url=${encodeURIComponent(resolveUrl(url, p1))}&referrer=${encodedReferrer}"`;
            });

            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'public, max-age=1, stale-while-revalidate=2');
            return res.send(rewrittenResult);
        }

        // --- Fast-Pipe Video Chunks (.ts / .m4s) ---
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
        
        // Pass-through exact content length to prevent video player stalling/seeking lag
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        // High-speed piping directly to client network socket
        response.data.pipe(res);

        req.on('close', () => {
            if (response.data && !response.data.destroyed) {
                response.data.destroy();
            }
        });

    } catch (error) {
        if (!res.headersSent) {
            res.status(error.response?.status || 500).send(error.message);
        }
    }
});

app.listen(PORT, () => {
    console.log(`Zero-buffer streaming proxy running on port ${PORT}`);
});
