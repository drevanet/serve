const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable fast compression ONLY for manifest text, completely bypass binary video chunks
app.use(compression({
    filter: (req, res) => {
        const type = res.getHeader('Content-Type');
        return type && (type.includes('mpegURL') || type.includes('mpegurl') || type.includes('text'));
    },
    level: 1 // Level 1 is lightning fast. Level 3 wastes unnecessary CPU on shared hosting.
}));

// Elite-tier network agent configuration to prevent connection dropping
const agentOptions = {
    keepAlive: true,
    maxSockets: 500,         // Increased: prevents bottlenecking multiple concurrent viewers
    maxFreeSockets: 100,
    keepAliveMsecs: 60000,    // Keep sockets warm longer to skip TCP/TLS handshakes entirely
    timeout: 15000            // Don't kill connections aggressively; gives upstream servers room to breathe
};

const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// Instant minimal CORS header setup
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

function resolveUrl(baseUrl, relativeUrl) {
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
        return relativeUrl;
    }
    try {
        return new URL(relativeUrl, baseUrl).href;
    } catch {
        return relativeUrl;
    }
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

    const isM3U8 = parsedUrl.pathname.endsWith('.m3u8') || parsedUrl.pathname.endsWith('.m3u') || url.includes('.m3u8');
    const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
    const encodedReferer = referer ? encodeURIComponent(referer) : '';

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': referer || '',
            'Origin': referer ? new URL(referer).origin : '',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
        timeout: 10000 // 10-second request timeout for establishing links safely
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(options, (proxyRes) => {
        if (proxyRes.statusCode >= 400) {
            return res.status(proxyRes.statusCode).send('Upstream Error');
        }

        if (isM3U8) {
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

            let buffer = '';
            proxyRes.setEncoding('utf8');

            // High-speed Chunked Buffer Stream instead of character-by-character Readline
            proxyRes.on('data', (chunk) => {
                buffer += chunk;
                let lineEndIndex;
                
                while ((lineEndIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, lineEndIndex);
                    buffer = buffer.substring(lineEndIndex + 1);
                    
                    const trimmed = line.trim();
                    if (!trimmed) {
                        res.write('\n');
                        continue;
                    }

                    if (trimmed[0] !== '#') {
                        // Fast path: Text lines representing segment URLs
                        const abs = resolveUrl(url, trimmed);
                        res.write(`${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`);
                    } else if (trimmed.includes('URI=')) {
                        // Optimised inline text scanning
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
                }
            });

            proxyRes.on('end', () => {
                if (buffer) {
                    const trimmed = buffer.trim();
                    if (trimmed && trimmed[0] !== '#') {
                        res.write(`${proxyHost}?url=${encodeURIComponent(resolveUrl(url, trimmed))}&referer=${encodedReferer}\n`);
                    } else {
                        res.write(buffer);
                    }
                }
                res.end();
            });

        } else {
            // Unrestricted lightning-speed raw pipeline pass-through for TS/MP4 streams
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
        if (!res.headersSent) res.status(504).send('Timeout');
    });

    req.on('close', () => {
        proxyReq.destroy();
    });

    proxyReq.end();
});

app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
