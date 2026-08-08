const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');
const { URL } = require('url');
const { Transform } = require('stream');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable compression for m3u8 playlists, bypass for binary TS video chunks
app.use(compression({
  filter: (req, res) => {
    const type = res.getHeader('Content-Type');
    return type && (type.includes('mpegURL') || type.includes('mpegurl') || type.includes('text'));
  }
}));

// Hyper-aggressive socket pooling for rapid-fire segment loading
const agentOptions = {
  keepAlive: true,
  maxSockets: 500,        // Doubled to prevent socket starvation under player load
  maxFreeSockets: 100,
  keepAliveMsecs: 15000,  // Keep warm longer for continuous streaming
  timeout: 5000           // Fast fail on dead sockets
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

// Instant CORS response for smooth web player handshakes
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': referer || '',
      'Origin': referer ? new URL(referer).origin : '',
      'Accept': '*/*',
      'Connection': 'keep-alive'
    },
    agent: parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent,
    timeout: 6000
  };

  const lib = parsedUrl.protocol === 'https:' ? https : http;

  const proxyReq = lib.request(options, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      return res.status(proxyRes.statusCode).send('Upstream server error');
    }

    if (isM3U8) {
      res.setHeader('Content-Type', 'application/x-mpegURL');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Prevents web players from caching live indexes

      let bufferStr = '';
      
      // Real-time line-by-line streaming transformer (Zero delay parsing)
      const rewriteStream = new Transform({
        transform(chunk, encoding, callback) {
          bufferStr += chunk.toString('utf8');
          const lines = bufferStr.split(/\r?\n/);
          
          // Keep the last partial line in the buffer
          bufferStr = lines.pop(); 

          for (let line of lines) {
            let trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              // It's a segment URL line
              const abs = resolveUrl(url, trimmed);
              this.push(`${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`);
            } else if (trimmed.includes('URI=')) {
              // It's an encryption key or sub-playlist tag
              const rewrittenLine = line.replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                const abs = resolveUrl(url, p1);
                return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
              });
              this.push(rewrittenLine + '\n');
            } else {
              this.push(line + '\n');
            }
          }
          callback();
        },
        flush(callback) {
          if (bufferStr) {
            this.push(bufferStr);
          }
          callback();
        }
      });

      proxyRes.pipe(rewriteStream).pipe(res);

    } else {
      // High speed pipelining for raw binary video data (.ts, .m4s, .mp4)
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/MP2T');
      // Tell web player / browser to aggressively cache video segments permanently
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

app.listen(PORT, () => console.log(`Instant playback proxy running on port ${PORT}`));
