'use strict';
// UK platform departure board – small Node server (no dependencies).
// Serves the web page and proxies live departures so the API key stays hidden.

const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.RDM_API_KEY || '').trim();
const API_URL = process.env.RDM_DEPARTURES_URL ||
  'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails';
const CACHE_MS = 20 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const stations = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'stations.json'), 'utf8'));
const byCrs = new Map(stations.map(([name, crs]) => [crs, name]));
const stationList = stations.map(([name, crs]) => [name, crs]);
const cache = new Map();

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
  try {
    if (url.pathname === '/api/stations') return sendJson(res, 200, stationList);
    if (url.pathname === '/api/departures') return await departures(url, res);
    if (url.pathname === '/api/status') return sendJson(res, 200, { mode: API_KEY ? 'live' : 'sample' });
    return serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Server error' });
  }
});

async function departures(url, res) {
  const crs = (url.searchParams.get('crs') || '').toUpperCase();
  if (!byCrs.has(crs)) return sendJson(res, 400, { error: 'Unknown station code' });

  const hit = cache.get(crs);
  if (hit && Date.now() - hit.at < CACHE_MS) return sendJson(res, 200, hit.data);

  let data;
  if (!API_KEY) {
    data = sampleBoard(crs);
  } else {
    try {
      data = await liveBoard(crs);
    } catch (err) {
      console.error(`Live data failed for ${crs}:`, err.message);
      if (hit) return sendJson(res, 200, { ...hit.data, stale: true });
      return sendJson(res, 502, { error: 'Live data unavailable' });
    }
  }
  cache.set(crs, { at: Date.now(), data });
  sendJson(res, 200, data);
}

async function liveBoard(crs) {
  const r = await fetch(`${API_URL}/${crs}?numRows=10`, {
    headers: { 'x-apikey': API_KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  return {
    mode: 'live',
    crs,
    station: b.locationName || byCrs.get(crs),
    message: firstMessage(b.nrccMessages),
    services: (b.trainServices || []).map((s) => ({
      std: s.std,
      etd: s.etd,
      platform: s.platform || '',
      destination: (s.destination || []).map((d) => d.locationName).join(' & '),
      operator: s.operator || '',
      cancelled: !!s.isCancelled,
      callingPoints: ((s.subsequentCallingPoints || [])[0]?.callingPoint || []).map((c) => c.locationName),
    })),
  };
}

function firstMessage(msgs) {
  const m = (msgs || [])[0];
  const text = m && (m.Value || m.value || m.xhtmlMessage || '');
  return text ? text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
}

// Realistic-looking made-up data, used until an API key is set.
function sampleBoard(crs) {
  const seed = [...crs].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const rand = mulberry32(seed + Math.floor(Date.now() / 3600000) * 7919);
  const origin = stations.find(([, c]) => c === crs);
  const routes = sampleRoutes(origin, rand);
  // Timetable is fixed for the hour (seeded), and trains that have left drop off.
  const now = londonMinutes();
  let t = now - (now % 60) - 5 + Math.floor(rand() * 5);
  const services = [];
  while (services.length < 30) {
    const calls = routes[Math.floor(rand() * routes.length)];
    const destination = calls[calls.length - 1];
    const roll = rand();
    const delay = roll < 0.65 ? 0 : 2 + Math.floor(rand() * 15);
    const etd = roll > 0.95 ? 'Cancelled' : roll > 0.9 ? 'Delayed' : delay ? hhmm(t + delay) : 'On time';
    services.push({
      std: hhmm(t),
      etd,
      platform: String(1 + Math.floor(rand() * 8)),
      destination,
      operator: 'Sample Rail',
      cancelled: etd === 'Cancelled',
      callingPoints: calls,
      leaves: t + delay,
    });
    t += 3 + Math.floor(rand() * 12);
  }
  const upcoming = services.filter((s) => s.leaves >= now).map(({ leaves, ...s }) => s);
  return { mode: 'sample', crs, station: byCrs.get(crs), message: '', services: upcoming.slice(0, 10) };
}

// Build a few plausible routes: a destination 15-120 km away, stopping at stations close to the straight line.
function sampleRoutes([, crs, lat, lon], rand) {
  const kmX = 111 * Math.cos((lat * Math.PI) / 180), kmY = 111;
  const pos = ([, , la, lo]) => [(lo - lon) * kmX, (la - lat) * kmY];
  const others = stations.filter(([, c]) => c !== crs).map((s) => ({ s, p: pos(s) }));
  const far = others.filter(({ p }) => { const d = Math.hypot(...p); return d > 15 && d < 120; });
  const routes = [];
  for (let i = 0; i < 4 && far.length; i++) {
    const dest = far[Math.floor(rand() * far.length)];
    const len = Math.hypot(...dest.p);
    const [ux, uy] = [dest.p[0] / len, dest.p[1] / len];
    const stops = others
      .map((o) => ({ o, along: o.p[0] * ux + o.p[1] * uy, off: Math.abs(o.p[0] * uy - o.p[1] * ux) }))
      .filter(({ o, along, off }) => o !== dest && along > 2 && along < len - 2 && off < 3)
      .sort((a, b) => a.along - b.along);
    const keep = stops.filter(() => rand() < Math.min(1, 6 / Math.max(stops.length, 1))).slice(0, 7);
    routes.push([...keep.map(({ o }) => o.s[0]), dest.s[0]]);
  }
  return routes.length ? routes : [[stations[0][0]]];
}

function londonMinutes() {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date()).split(':').map(Number);
  return h * 60 + m;
}
function hhmm(min) {
  min = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
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
