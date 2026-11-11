// UK platform departure board – local Node server (no dependencies).
// Serves the web page and proxies live departures so the API key stays hidden.
// For Cloudflare, see src/worker.js and wrangler.toml.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './src/api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.RDM_API_KEY || '').trim();
const api = createApi({
  stations: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stations.json'), 'utf8')),
  apiKey: API_KEY,
  apiUrl: process.env.RDM_DEPARTURES_URL,
  tflUrl: process.env.TFL_API_URL,
  tflKey: process.env.TFL_APP_KEY,
  build: { deployedAt: new Date().toISOString(), version: '', how: 'started' },
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const apiRes = await api(url);
  if (apiRes) {
    res.writeHead(apiRes.status, Object.fromEntries(apiRes.headers));
    return res.end(await apiRes.text());
  }
  serveStatic(url.pathname, res);
});

function serveStatic(pathname, res) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); }
  catch { rel = ''; }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!rel || !file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

server.listen(PORT, () => {
  console.log(`Departure board running at http://localhost:${PORT}`);
  console.log(API_KEY ? 'Mode: LIVE (Rail Data Marketplace)' : 'Mode: SAMPLE data (set RDM_API_KEY for live data)');
});
