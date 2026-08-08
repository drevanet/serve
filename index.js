const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');
const readline = require('readline');
const { URL } = require('url');
const { Transform } = require('stream');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable fast compression for text/m3u8, bypass completely for ts/mp4 chunks
app.use(compression({
    filter: (req, res) => {
        const type = res.getHeader('Content-Type');
        return type && (type.includes('mpegURL') || type.includes('mpegurl') || type.includes('text'));
    },
    level: 3 // Lower compression level to trade minor bandwidth for massive CPU savings on Hostinger
}));

// Consolidated high-performance agent options
const agentOptions = {
    keepAlive: true,
    maxSockets: 250,      // Lowered from 500: Prevents Hostinger from flagging process for socket exhaustion
    maxFreeSockets: 50,
    keepAliveMsecs: 30000, // Kept alive longer to reuse channels for continuous segment pulling
    timeout: 3000          // Fast fail early to keep event loop clear
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': referer || '',
            'Origin': referer ? new URL(referer).origin : '',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
        timeout: 4000
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    
    const proxyReq = lib.request(options, (proxyRes) => {
        if (proxyRes.statusCode >= 400) {
            return res.status(proxyRes.statusCode).send('Upstream Error');
        }

        if (isM3U8) {
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

            // High-speed tokenization using built-in Readline instead of buffer splits
            const rl = readline.createInterface({
                input: proxyRes,
                terminal: false
            });

            rl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) {
                    res.write('\n');
                    return;
                }

                if (trimmed[0] !== '#') {
                    // Fast path: Text lines representing segment URLs
                    const abs = resolveUrl(url, trimmed);
                    res.write(`${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`);
                } else if (trimmed.includes('URI=')) {
                    // Safe string parsing replacing heavy global Regex evaluation
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

            rl.on('close', () => {
                res.end();
            });

            proxyRes.on('error', () => rl.close());

        } else {
            // Maximum speed pipeline bypass for raw media payloads (.ts / .mp4 / .m4s)
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
