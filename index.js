const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');
const readline = require('readline');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

// High-speed memory cache to serve identical segments instantly
const segmentCache = new Map();
const CACHE_MAX_ITEMS = 800; // Fits within modest RAM limits

// Aggressive compression for playlists only
app.use(compression({
    filter: (req, res) => {
        const type = res.getHeader('Content-Type');
        return type && (type.includes('mpegURL') || type.includes('mpegurl') || type.includes('text'));
    },
    level: 1 // Level 1 provides 90% of the benefit with near-zero CPU overhead
}));

// Maximize socket reuse to eliminate TCP/TLS handshake latency
const agentOptions = {
    keepAlive: true,
    maxSockets: 500,
    maxFreeSockets: 100,
    keepAliveMsecs: 60000, 
    timeout: 2500 // Drop stalling connections early
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// Instant CORS setup
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Timing-Allow-Origin', '*'); // Exposes precise network timing to the browser
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
    const { url, referrer } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (e) {
        return res.status(400).send('Invalid url parameter');
    }

    const isM3U8 = parsedUrl.pathname.endsWith('.m3u8') || url.includes('.m3u8');
    
    // Check internal memory cache for media chunks (.ts, .mp4, .m4s)
    if (!isM3U8 && segmentCache.has(url)) {
        const cached = segmentCache.get(url);
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Cache', 'HIT');
        return res.send(cached.buffer);
    }

    const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
    const encodedReferer = referrer ? encodeURIComponent(referrer) : '';

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referrer': referrer || '',
            'Origin': referrer ? new URL(referrer).origin : '',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
        timeout: 3000
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(options, (proxyRes) => {
        if (proxyRes.statusCode >= 400) {
            return res.status(proxyRes.statusCode).send('Upstream Error');
        }

        if (isM3U8) {
            // Browser performance headers for real-time video streaming
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('X-Content-Type-Options', 'nosniff');

            const rl = readline.createInterface({ input: proxyRes, terminal: false });
            
            // Asynchronous micro-task chunk writing to keep event loop free
            rl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) {
                    res.write('\n');
                    return;
                }

                if (trimmed[0] !== '#') {
                    const abs = resolveUrl(url, trimmed);
                    res.write(`${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`);
                } else if (trimmed.includes('URI=')) {
                    let output = line;
                    let startIndex = 0;
                    while ((startIndex = output.indexOf('URI=', startIndex)) !== -1) {
                        let quoteChar = output[startIndex + 4];
                        if (quoteChar === '"' || quoteChar === "'") {
                            let endIndex = output.indexOf(quoteChar, startIndex + 5);
                            if (endIndex !== -1) {
                                let originalUri = output.substring(startIndex + 5, endIndex);
                                let abs = resolveUrl(url, originalUri);
                                let replacement = `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
                                output = output.substring(0, startIndex) + replacement + output.substring(endIndex + 1);
                                startIndex += replacement.length;
                                continue;
                            }
                        }
                        startIndex += 4;
                    }
                    res.write(output + '\n');
                } else {
                    res.write(line + '\n');
                }
            });

            rl.on('close', () => res.end());
            proxyRes.on('error', () => rl.close());

        } else {
            // Process static media segments
            const contentType = proxyRes.headers['content-type'] || 'video/MP2T';
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('X-Cache', 'MISS');

            const chunks = [];
            
            proxyRes.on('data', (chunk) => {
                chunks.push(chunk);
                res.write(chunk); // Send to browser immediately while building cache buffer
            });

            proxyRes.on('end', () => {
                res.end();
                // Store chunk in internal RAM cache to serve future multi-bitrate or parallel requests instantly
                if (chunks.length > 0) {
                    const buffer = Buffer.concat(chunks);
                    if (segmentCache.size >= CACHE_MAX_ITEMS) {
                        const firstKey = segmentCache.keys().next().value;
                        segmentCache.delete(firstKey); // Simple Eviction
                    }
                    segmentCache.set(url, { buffer, contentType });
                }
            });
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(500).send(err.message);
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('Timeout');
    });

    req.on('close', () => {
        proxyReq.destroy();
    });

    proxyReq.end();
});

app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
