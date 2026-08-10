const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Increase socket pool for heavy concurrent streaming
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 500, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500, maxFreeSockets: 100 });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
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

  const isM3U8 = url.includes('.m3u8');
  const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
  const encodedReferrer = referrer ? encodeURIComponent(referrer) : '';

  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
      'Referer': referrer || '',
      'Origin': referrer ? new URL(referrer).origin : '',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
    timeout: 5000
  };

  const proxyReq = client.request(options, (upstreamRes) => {
    if (!isM3U8) {
      res.writeHead(upstreamRes.statusCode, {
        'Content-Type': upstreamRes.headers['content-type'] || 'video/MP2T',
        'Cache-Control': 'public, max-age=86400, immutable'
      });
      upstreamRes.pipe(res);
      return;
    }

    // Accumulate manifest text safely and quickly
    let data = '';
    upstreamRes.setEncoding('utf8');
    upstreamRes.on('data', (chunk) => { data += chunk; });
    upstreamRes.on('end', () => {
      const rewritten = data.replace(/^(?!#)(.+)$/gm, (line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        const abs = resolveUrl(url, trimmed);
        return `${proxyHost}?url=${encodeURIComponent(abs)}&referrer=${encodedReferrer}`;
      }).replace(/URI=["']([^"']+)["']/g, (_, p1) => {
        const abs = resolveUrl(url, p1);
        return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referrer=${encodedReferrer}"`;
      });

      res.writeHead(200, {
        'Content-Type': 'application/x-mpegURL',
        'Cache-Control': 'public, max-age=2'
      });
      res.end(rewritten);
    });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(500).send(err.message);
  });

  req.on('close', () => {
    proxyReq.destroy();
  });

  proxyReq.end();
});

app.listen(PORT, () => console.log(`Ultra-fast proxy running on port ${PORT}`));
