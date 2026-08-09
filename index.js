const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(compression());

// OPTIMIZATION 1: High-throughput agent settings
const agentOptions = {
  keepAlive: true,
  maxSockets: Infinity,       // Do not cap parallel chunk fetching
  maxFreeSockets: 256,
  keepAliveMsecs: 5000,       // Keep tunnels open longer for fast TS switching
  scheduling: 'fifo'
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
  const { url, referrer } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return res.status(400).send('Invalid url parameter');
  }

  // OPTIMIZATION 2: Pre-compute static proxy strings
  const isM3U8 = parsedUrl.pathname.endsWith('.m3u8') || url.includes('.m3u8');
  const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
  const encodedReferrer = referrer ? encodeURIComponent(referrer) : '';
  const baseProxyUrl = `${proxyHost}?referrer=${encodedReferrer}&url=`;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
      'Referer': referrer || '',
      'Origin': referrer ? new URL(referrer).origin : '',
      'Accept-Encoding': isM3U8 ? 'gzip, deflate' : 'identity' // Fetch compressed manifest from upstream
    },
    agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
    timeout: 5000 // Lowered timeout for faster failover
  };

  const lib = parsedUrl.protocol === 'https:' ? https : http;

  const proxyReq = lib.request(options, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      return res.status(proxyRes.statusCode).send('Upstream error');
    }

    if (isM3U8) {
      res.setHeader('Content-Type', 'application/x-mpegURL');
      res.setHeader('Cache-Control', 'public, max-age=2'); // Micro-caching avoids redundant heavy parsing

      // OPTIMIZATION 3: High-speed Array buffering instead of string concatenation
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      
      proxyRes.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        
        // OPTIMIZATION 4: Single-pass, optimized Regex pattern
        const rewritten = data
          .replace(/^(?!#)(.+)$/gm, (match) => {
            const trimmed = match.trim();
            if (!trimmed) return match;
            return baseProxyUrl + encodeURIComponent(resolveUrl(url, trimmed));
          })
          .replace(/URI=["']([^"']+)["']/g, (_, p1) => {
            return `URI="${baseProxyUrl}${encodeURIComponent(resolveUrl(url, p1))}"`;
          });

        res.send(rewritten);
      });
    } else {
      // OPTIMIZATION 5: Video Chunks (.ts) Stream Optimization
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/MP2T');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      
      if (proxyRes.headers['content-length']) {
        res.setHeader('Content-Length', proxyRes.headers['content-length']);
      }
      
      // Pipe stream directly with zero JS-land manipulation
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

  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});

app.listen(PORT, () => console.log(`Hyper-proxy running on port ${PORT}`));
