const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');
const { URL } = require('url');
const { Transform } = require('stream');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable lightweight compression for text/m3u8, completely ignore video chunks
app.use(compression({
  filter: (req, res) => {
    const type = res.getHeader('Content-Type');
    return type && (type.includes('mpegURL') || type.includes('mpegurl') || type.includes('text'));
  },
  level: 1 // Level 1 maximizes CPU speed; the size difference for M3U8 is negligible
}));

// High-performance agent settings for rapid HTTP reuse
const agentOptions = {
  keepAlive: true,
  maxSockets: 500,        // Increased to handle highly parallel segment requests from ReactPlayer
  maxFreeSockets: 100,
  keepAliveMsecs: 60000,   // Kept open longer to avoid TLS handshake overhead on every chunk
  timeout: 2500            // Faster failover to unblock the connection pool quickly
};

const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(httpsOptions); // If using https upstream, reuse session tokens

// Immediate CORS termination
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache OPTIONS preflight checks for 24 hours
  if (req.method === 'OPTIONS') return res.sendStatus(204);
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
    timeout: 3000
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
      
      // High-speed custom Transform Stream replacing the slow internal readline event-loop overhead
      const m3u8Transformer = new Transform({
        transform(chunk, encoding, callback) {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop(); // Hold onto incomplete last line

          let output = '';
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
              output += '\n';
              continue;
            }

            if (trimmed[0] !== '#') {
              const abs = resolveUrl(url, trimmed);
              output += `${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`;
            } else if (trimmed.includes('URI=')) {
              let parsedLine = line;
              let startIndex = 0;
              while ((startIndex = parsedLine.indexOf('URI=', startIndex)) !== -1) {
                let quoteChar = parsedLine[startIndex + 4];
                if (quoteChar === '"' || quoteChar === "'") {
                  let endIndex = parsedLine.indexOf(quoteChar, startIndex + 5);
                  if (endIndex !== -1) {
                    let originalUri = parsedLine.substring(startIndex + 5, endIndex);
                    let abs = resolveUrl(url, originalUri);
                    let replacement = `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}"`;
                    parsedLine = parsedLine.substring(0, startIndex) + replacement + parsedLine.substring(endIndex + 1);
                    startIndex += replacement.length;
                    continue;
                  }
                }
                startIndex += 4;
              }
              output += parsedLine + '\n';
            } else {
              output += line + '\n';
            }
          }
          this.push(output);
          callback();
        },
        flush(callback) {
          if (buffer) {
            const trimmed = buffer.trim();
            if (trimmed && trimmed[0] !== '#') {
              const abs = resolveUrl(url, trimmed);
              this.push(`${proxyHost}?url=${encodeURIComponent(abs)}&referer=${encodedReferer}\n`);
            } else {
              this.push(buffer + '\n');
            }
          }
          callback();
        }
      });

      proxyRes.pipe(m3u8Transformer).pipe(res);

    } else {
      // Direct binary pipeline streaming for .ts chunks
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
