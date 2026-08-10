const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 10000;

// Massive socket pool for lightning-fast concurrent chunk fetches
const agentOptions = { keepAlive: true, maxSockets: 500, maxFreeSockets: 100, timeout: 5000 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function resolveUrl(baseUrl, relativeUrl) {
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
  return new URL(relativeUrl, baseUrl).href;
}

app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  const referrer = req.query.referrer;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  const parsedTarget = new URL(targetUrl);
  const isM3U8 = targetUrl.includes('.m3u8');
  const proxyHost = `${req.protocol}://${req.get('host')}/proxy`;
  const encodedReferrer = referrer ? encodeURIComponent(referrer) : '';

  const lib = parsedTarget.protocol === 'https:' ? https : http;
  
  const options = {
    method: 'GET',
    hostname: parsedTarget.hostname,
    port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
    path: parsedTarget.pathname + parsedTarget.search,
    agent: parsedTarget.protocol === 'https:' ? httpsAgent : httpAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
      'Referer': referrer || '',
      'Origin': referrer ? new URL(referrer).origin : '',
      'Accept-Encoding': 'gzip, deflate'
    }
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    if (isM3U8) {
      let data = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        // Fast string replacement for .m3u8 contents
        const lines = data.split('\n');
        let out = '';
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i].trim();
          if (!line) continue;
          if (line[0] === '#') {
            if (line.includes('URI=')) {
              line = line.replace(/URI=["']([^"']+)["']/g, (_, p1) => {
                const abs = resolveUrl(targetUrl, p1);
                return `URI="${proxyHost}?url=${encodeURIComponent(abs)}&referrer=${encodedReferrer}"`;
              });
            }
            out += line + '\n';
          } else {
            const abs = resolveUrl(targetUrl, line);
            out += `${proxyHost}?url=${encodeURIComponent(abs)}&referrer=${encodedReferrer}\n`;
          }
        }
        res.setHeader('Content-Type', 'application/x-mpegURL');
        res.setHeader('Cache-Control', 'public, max-age=2');
        res.send(out);
      });
      return;
    }

    res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    proxyRes.pipe(res);
    req.on('close', () => proxyRes.destroy());
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(500).send(err.message);
  });

  proxyReq.end();
});

app.listen(PORT, () => console.log(`Lightning proxy running on port ${PORT}`));
