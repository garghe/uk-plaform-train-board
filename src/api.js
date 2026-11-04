// Shared API logic for the departure board.
// Used by both the local Node server (server.js) and the Cloudflare Worker (src/worker.js).
// Uses only web-standard APIs (fetch, Response, Intl), so it runs in both.
// Rail stations use 3-letter CRS codes; Tube stations use TfL ids (940GZZLU...).

import { createTfl, isTubeId } from './tfl.js';

export const DEFAULT_API_URL =
  'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails';
const CACHE_MS = 20 * 1000;

/**
 * Build the API handler.
 * @param {object} opts
 * @param {Array} opts.stations  [[name, crs, lat, lon], ...]
 * @param {string} [opts.apiKey] Rail Data Marketplace consumer key; empty = sample data
 * @param {string} [opts.apiUrl] Departures endpoint (station code is appended)
 * @param {string} [opts.tflUrl] TfL API base URL
 * @param {string} [opts.tflKey] TfL app key (optional)
 * @returns {(url: URL) => Promise<Response|null>} null when the path is not an API path
 */
export function createApi({ stations, apiKey = '', apiUrl = DEFAULT_API_URL, tflUrl, tflKey }) {
  const tfl = createTfl({ baseUrl: tflUrl, appKey: tflKey });
  apiKey = String(apiKey || '').trim();
  apiUrl = String(apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const byCrs = new Map(stations.map(([name, crs]) => [crs, name]));
  const railList = stations.map(([name, crs]) => [name, crs, 'rail']);
  const cache = new Map();

  async function stationList() {
    const tube = await tfl.listStations();
    const tubeList = [...tube].map(([id, s]) => [s.name, id, 'tube']);
    const all = [...railList, ...tubeList].sort((a, b) => a[0].localeCompare(b[0]));
    // Only let browsers cache the list for long once the Tube part loaded.
    return json(200, all, tubeList.length ? 'public, max-age=86400' : 'no-store');
  }

  async function tubeDepartures(id) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return json(200, hit.data);
    try {
      const data = await tfl.board(id);
      cache.set(id, { at: Date.now(), data });
      return json(200, data);
    } catch (err) {
      console.error(`TfL data failed for ${id}:`, err.message);
      if (hit) return json(200, { ...hit.data, stale: true });
      return json(502, { error: 'Live data unavailable' });
    }
  }

  async function departures(url) {
    const raw = (url.searchParams.get('id') || url.searchParams.get('crs') || '').toUpperCase();
    if (isTubeId(raw)) return tubeDepartures(raw);
    const crs = raw;
    if (!byCrs.has(crs)) return json(400, { error: 'Unknown station code' });

    const hit = cache.get(crs);
    if (hit && Date.now() - hit.at < CACHE_MS) return json(200, hit.data);

    let data;
    if (!apiKey) {
      data = sampleBoard(crs, stations, byCrs);
    } else {
      try {
        data = await liveBoard(crs, byCrs, apiKey, apiUrl);
      } catch (err) {
        console.error(`Live data failed for ${crs}:`, err.message);
        if (hit) return json(200, { ...hit.data, stale: true });
        return json(502, { error: 'Live data unavailable' });
      }
    }
    cache.set(crs, { at: Date.now(), data });
    return json(200, data);
  }

  return async function handle(url) {
    try {
      if (url.pathname === '/api/stations') return await stationList();
      if (url.pathname === '/api/departures') return await departures(url);
      if (url.pathname === '/api/status') return json(200, { mode: apiKey ? 'live' : 'sample', tube: 'live' });
      if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found' });
      return null;
    } catch (err) {
      console.error(err);
      return json(500, { error: 'Server error' });
    }
  };
}

function json(status, body, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl },
  });
}

async function liveBoard(crs, byCrs, apiKey, apiUrl) {
  const r = await fetch(`${apiUrl}/${crs}?numRows=10`, {
    headers: { 'x-apikey': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  return {
    mode: 'live',
    kind: 'rail',
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
function sampleBoard(crs, stations, byCrs) {
  const seed = [...crs].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const rand = mulberry32(seed + Math.floor(Date.now() / 3600000) * 7919);
  const origin = stations.find(([, c]) => c === crs);
  const routes = sampleRoutes(origin, stations, rand);
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
      leaves: etd === 'Cancelled' ? t : t + delay,
    });
    t += 3 + Math.floor(rand() * 12);
  }
  const upcoming = services.filter((s) => s.leaves >= now).map(({ leaves, ...s }) => s);
  return { mode: 'sample', kind: 'rail', crs, station: byCrs.get(crs), message: '', services: upcoming.slice(0, 10) };
}

// Build a few plausible routes: a destination 15-120 km away, stopping at stations close to the straight line.
function sampleRoutes([, crs, lat, lon], stations, rand) {
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
