const zlib = require('zlib');

app.get('/proxy', (req, res) => {
    const { url, referer } = req.query;
    if (!url) return res.status(400).send('Missing url parameter');

    const parsedUrl = new URL(url);
    const isM3U8 = url.includes('.m3u8');
    const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
    const encodedReferer = referer ? encodeURIComponent(referer) : '';

    // If it's a TS video segment, redirect React Player directly to the source
    // This bypasses your Node server completely for heavy video files
    if (!isM3U8 && (url.includes('.ts') || url.includes('.mp4'))) {
        return res.redirect(302, url);
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
            'Referer': referer || '',
            'Origin': referer ? new URL(referer).origin : '',
            'Accept-Encoding': 'gzip, deflate' // Ask source for compression
        },
        agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
        timeout: 5000
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(options, (proxyRes) => {
        // Handle decompression if target server sent compressed content
        let stream = proxyRes;
        const contentEncoding = proxyRes.headers['content-encoding'];
        if (contentEncoding === 'gzip') {
            stream = proxyRes.pipe(zlib.createGunzip());
        } else if (contentEncoding === 'deflate') {
            stream = proxyRes.pipe(zlib.createInflate());
        }

        if (isM3U8) {
            res.setHeader('Content-Type', 'application/x-mpegURL');
            res.setHeader('Cache-Control', 'public, max-age=2');
            res.setHeader('Content-Encoding', 'gzip'); // Compress response back to client

            let body = '';
            stream.on('data', chunk => { body += chunk; });
            stream.on('end', () => {
                // Bulk rewrite via regex instead of sluggish line-by-line loops
                let updatedBody = body.replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                    const abs = resolveUrl(url, p1);
                    return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
                });

                // Rewrite URLs that don't start with '#' (the actual video/playlist links)
                updatedBody = updatedBody.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return line;
                    const abs = resolveUrl(url, trimmed);
                    return `${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}`;
                }).join('\n');

                // Zip manifest instantly before delivery
                zlib.gzip(updatedBody, (err, compressed) => {
                    if (err) {
                        if (!res.headersSent) res.status(500).send(err.message);
                        return;
                    }
                    res.end(compressed);
                });
            });
        } else {
            // Fallback safety for non-redirected files
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/MP2T');
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            stream.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(500).send(err.message);
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});
