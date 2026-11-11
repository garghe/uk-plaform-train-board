// London Underground and bus support via the TfL Unified API (https://api.tfl.gov.uk).
// Works without a key (lower rate limit); set TFL_APP_KEY for the higher limit.
// Powered by TfL Open Data.

export const DEFAULT_TFL_URL = 'https://api.tfl.gov.uk';
export const TUBE_LINES = [
  'bakerloo', 'central', 'circle', 'district', 'hammersmith-city', 'jubilee',
  'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city',
];
const HINT = {
  401: 'app key not accepted',
  403: 'access refused - an app key may be needed',
  404: 'not found',
  429: 'too many requests - add a TFL_APP_KEY',
};
const STATIONS_TTL = 24 * 3600 * 1000;
const STATIONS_RETRY = 5 * 60 * 1000;
const STATUS_TTL = 60 * 1000;

const STOP_TTL = 24 * 3600 * 1000;
export const LINE_NAMES = {
  bakerloo: 'Bakerloo', central: 'Central', circle: 'Circle', district: 'District',
  'hammersmith-city': 'Hammersmith & City', jubilee: 'Jubilee', metropolitan: 'Metropolitan',
  northern: 'Northern', piccadilly: 'Piccadilly', victoria: 'Victoria', 'waterloo-city': 'Waterloo & City',
};

export const isTubeId = (id) => /^940GZZ[A-Z0-9]{2,6}$/.test(id);
// Individual bus stops: 490 + code (not "490G…", which are groups of stops)
export const isBusId = (id) => /^490(?!G)[0-9A-Z]{3,12}$/.test(id);

export function createTfl({ baseUrl = DEFAULT_TFL_URL, appKey = '' } = {}) {
  baseUrl = String(baseUrl || DEFAULT_TFL_URL).replace(/\/+$/, '');
  appKey = String(appKey || '').trim();
  let stations = null;        // Map id -> { name, lines: Set }
  let stationsAt = 0;
  let stationsPending = null;
  let lastError = '';
  let status = null;          // Map lineId -> { name, text }
  let statusAt = 0;

  async function get(path, retry = true) {
    const url = new URL(baseUrl + path);
    if (appKey) url.searchParams.set('app_key', appKey);
    let r;
    try {
      r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'uk-platform-train-board/1.3' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`could not reach TfL (${err.name === 'TimeoutError' ? 'timed out' : err.message})`);
    }
    if (r.ok) return r.json();
    // One quick retry for rate limits and TfL hiccups.
    if (retry && (r.status === 429 || r.status >= 500)) {
      const wait = Math.min(2000, (Number(r.headers.get('retry-after')) || 1) * 1000);
      await new Promise((ok) => setTimeout(ok, wait));
      return get(path, false);
    }
    const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ');
    const msg = (body.match(/"message"\s*:\s*"([^"]{1,160})/) || [])[1] || '';
    throw new Error(`TfL HTTP ${r.status}${HINT[r.status] ? ` (${HINT[r.status]})` : ''}${msg ? `: ${msg}` : ''}`);
  }

  // All Tube stations, built from each line's stop list. Cached for a day once
  // every line loaded; lines that failed (e.g. rate limit) are retried after 5 min.
  let loadedLines = new Set();
  async function listStations() {
    const complete = loadedLines.size === TUBE_LINES.length;
    const fresh = stations && Date.now() - stationsAt < (complete ? STATIONS_TTL : STATIONS_RETRY);
    if (fresh) return stations;
    stationsPending ||= (async () => {
      const map = complete ? new Map() : new Map(stations || []);
      const todo = complete ? TUBE_LINES : TUBE_LINES.filter((l) => !loadedLines.has(l));
      if (complete) loadedLines = new Set();
      const results = await Promise.allSettled(todo.map((line) => get(`/Line/${line}/StopPoints`)));
      const errors = [];
      results.forEach((r, i) => {
        const line = todo[i];
        if (r.status !== 'fulfilled') { errors.push(`${line}: ${r.reason?.message || r.reason}`); return; }
        loadedLines.add(line);
        for (const s of r.value || []) {
          const id = s.naptanId || s.id;
          if (!isTubeId(id || '')) continue;
          const entry = map.get(id) || { name: cleanName(s.commonName || id), lines: new Set() };
          entry.lines.add(line);
          map.set(id, entry);
        }
      });
      lastError = errors.length ? `Station list: ${errors.join('; ')}` : '';
      if (lastError) console.error('TfL', lastError);
      if (map.size || !stations) stations = map;   // keep the last good list if everything failed
      stationsAt = Date.now();
      stationsPending = null;
      return stations;
    })();
    return stationsPending;
  }

  // Station search. Tube: backup when the full list is not available.
  // Bus: the only way in (London has ~19,000 stops), by name or 5-digit stop code.
  async function search(query, mode = 'tube') {
    const q = String(query || '').trim().slice(0, 60);
    if (q.length < 2) return [];
    if (mode === 'bus') return searchBus(q);
    const res = await get(`/StopPoint/Search/${encodeURIComponent(q)}?modes=tube`);
    return (res?.matches || [])
      .filter((m) => isTubeId(m.id || ''))
      .map((m) => [cleanName(m.name || m.id), m.id, 'tube'])
      .slice(0, 10);
  }

  // ---- Buses ----
  const stopCache = new Map();   // id -> { at, info }

  // Stop name, letter and direction, e.g. { name: 'Trafalgar Square', stop: 'Stop S', towards: 'Westminster' }
  async function stopInfo(id) {
    const hit = stopCache.get(id);
    if (hit && Date.now() - hit.at < STOP_TTL) return hit.info;
    const sp = await get(`/StopPoint/${id}`);
    // TfL may return the stop itself or its parent area; find the stop in the tree.
    const node = findNode(sp, id) || sp;
    const info = busStop(node);
    stopCache.set(id, { at: Date.now(), info });
    return info;
  }

  async function searchBus(q) {
    let nodes = [];
    if (/^\d{5}$/.test(q)) {
      // Stop code from the sign at the stop
      const res = await get(`/StopPoint/Sms/${q}`);
      nodes = (Array.isArray(res) ? res : [res]).filter(Boolean);
    } else {
      const res = await get(`/StopPoint/Search/${encodeURIComponent(q)}?modes=bus&maxResults=5`);
      const areas = (res?.matches || []).slice(0, 5);
      const details = await Promise.allSettled(areas.map((m) => get(`/StopPoint/${m.id}`)));
      nodes = details.filter((d) => d.status === 'fulfilled').map((d) => d.value);
    }
    const stops = new Map();
    const walk = (n, depth = 0) => {
      if (!n || depth > 3) return;
      const id = n.naptanId || n.id || '';
      if (isBusId(id) && (!n.modes || n.modes.includes('bus'))) {
        const info = busStop(n);
        stopCache.set(id, { at: Date.now(), info });
        stops.set(id, [stopTitle(info), id, 'bus', info.towards, info.routes]);
      }
      for (const c of n.children || []) walk(c, depth + 1);
    };
    nodes.forEach((n) => walk(n));
    return [...stops.values()].slice(0, 15);
  }

  // Bus stops and Tube stations near a point, nearest first: [name, id, kind, towards, routes, metres]
  async function near(lat, lon, radius = 400) {
    const res = await get(`/StopPoint?lat=${lat}&lon=${lon}&radius=${radius}`
      + '&stopTypes=NaptanPublicBusCoachTram,NaptanMetroStation&modes=bus,tube&returnLines=true');
    const out = [];
    for (const sp of res?.stopPoints || []) {
      const id = sp.naptanId || sp.id || '';
      const metres = Math.round(sp.distance || 0);
      if (isBusId(id)) {
        const info = busStop(sp);
        stopCache.set(id, { at: Date.now(), info });
        out.push([stopTitle(info), id, 'bus', info.towards, info.routes, metres]);
      } else if (isTubeId(id)) {
        const lines = (sp.lines || []).map((l) => LINE_NAMES[l.id]).filter(Boolean);
        out.push([cleanName(sp.commonName || id), id, 'tube', '', lines, metres]);
      }
    }
    return out;
  }

  async function busBoard(id) {
    const [info, preds] = await Promise.all([
      stopInfo(id).catch(() => null),
      get(`/StopPoint/${id}/Arrivals`).catch((err) => {
        lastError = `Arrivals ${id}: ${err.message}`;
        throw err;
      }),
    ]);
    const buses = (preds || [])
      .filter((p) => !p.modeName || p.modeName === 'bus')
      .sort((a, b) => (a.timeToStation ?? 0) - (b.timeToStation ?? 0));
    const first = buses[0] || {};
    const stop = info || {
      name: cleanName(first.stationName || id),
      stop: first.platformName && first.platformName !== 'null' ? `Stop ${first.platformName}` : '',
      towards: first.towards || '',
    };
    return {
      mode: 'live',
      kind: 'bus',
      id,
      station: stopTitle(stop),
      stop: stop.stop,
      towards: stop.towards,
      routes: [...new Set(buses.map((p) => p.lineName).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      arrivals: buses.slice(0, 12).map((p) => ({
        route: p.lineName || '',
        destination: cleanDestination(p.destinationName || p.towards || ''),
        expected: p.expectedArrival || new Date(Date.now() + (p.timeToStation || 0) * 1000).toISOString(),
      })),
    };
  }

  function info() {
    return { stations: stations ? stations.size : 0, linesLoaded: loadedLines.size, lastError };
  }

  async function lineStatus() {
    if (status && Date.now() - statusAt < STATUS_TTL) return status;
    try {
      const lines = await get(`/Line/${TUBE_LINES.join(',')}/Status`);
      const map = new Map();
      for (const l of lines || []) {
        const st = (l.lineStatuses || [])[0] || {};
        const desc = st.statusSeverityDescription || 'Good Service';
        const reason = (st.reason || '').replace(/\s+/g, ' ').trim();
        map.set(l.id, { name: l.name || l.id, text: reason || `${desc}.` });
      }
      status = map;
      statusAt = Date.now();
    } catch (err) {
      console.error('TfL line status failed:', err.message);
    }
    return status || new Map();
  }

  async function board(id) {
    let preds;
    const [list, , statuses] = await Promise.all([
      listStations(),
      get(`/StopPoint/${id}/Arrivals`).then((p) => { preds = p; }, (err) => {
        lastError = `Arrivals ${id}: ${err.message}`;
        throw err;
      }),
      lineStatus(),
    ]);
    const station = list.get(id);
    const tubePreds = (preds || []).filter((p) => !p.modeName || p.modeName === 'tube');

    // One group per platform, like the real per-platform boards.
    const groups = new Map();
    for (const p of tubePreds) {
      const key = p.platformName || 'Platform';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const platforms = [...groups.entries()]
      .map(([platform, list]) => {
        list.sort((a, b) => (a.timeToStation ?? 0) - (b.timeToStation ?? 0));
        const lineIds = [...new Set(list.map((p) => p.lineId).filter(Boolean))];
        const tidy = tidyPlatform(platform);
        return {
          platform: tidy,
          direction: capitalise(tidy.match(/\b(north|south|east|west)bound\b/i)?.[0] || ''),
          number: tidy.match(/platform\s*([0-9]+[a-z]?)/i)?.[1] || '',
          lines: lineIds.map((l) => statuses.get(l)?.name || list.find((p) => p.lineId === l)?.lineName || l),
          status: lineIds.map((l) => statusLine(statuses.get(l))).filter(Boolean).join('  '),
          arrivals: list.slice(0, 6).map((p) => ({
            destination: cleanDestination(p.destinationName || p.towards || 'Check front of train'),
            expected: p.expectedArrival || new Date(Date.now() + (p.timeToStation || 0) * 1000).toISOString(),
            line: p.lineName || '',
          })),
        };
      })
      .sort((a, b) => platNum(a.platform) - platNum(b.platform) || a.platform.localeCompare(b.platform));

    const stationLines = station ? [...station.lines] : [];
    return {
      mode: 'live',
      kind: 'tube',
      id,
      station: station?.name || cleanName(tubePreds[0]?.stationName || id),
      message: stationLines.map((l) => statusLine(statuses.get(l))).filter(Boolean).join('  '),
      platforms,
    };
  }

  return { listStations, board, busBoard, search, near, info };
}

function findNode(n, id, depth = 0) {
  if (!n || depth > 3) return null;
  if ((n.naptanId || n.id) === id) return n;
  for (const c of n.children || []) {
    const hit = findNode(c, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function busStop(n) {
  const props = n.additionalProperties || [];
  const towards = props.find((p) => /^towards$/i.test(p.key || ''))?.value || '';
  const letter = (n.stopLetter || '').replace(/^->/, '').trim();
  const indicator = (n.indicator || '').trim();
  const stop = /^stop\b/i.test(indicator) ? indicator
    : letter && /^[A-Z0-9]{1,3}$/i.test(letter) ? `Stop ${letter.toUpperCase()}` : '';
  const routes = [...new Set((n.lines || []).map((l) => l.name || l.id).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
  return { name: cleanName(n.commonName || n.name || ''), stop, towards, routes };
}

function stopTitle({ name, stop }) {
  return [name, stop].filter(Boolean).join(' · ');
}

function statusLine(s) {
  return s ? `${s.name} line: ${s.text.replace(/^[A-Za-z &]+ (?:LINE|Line): ?/, '')}` : '';
}

function cleanName(name) {
  return String(name).replace(/\s+Underground Station$/i, '').replace(/\s+Station$/i, '').trim();
}

function cleanDestination(name) {
  return cleanName(name).replace(/\s+\(.*?\)$/, '').trim();
}

function capitalise(word) {
  return word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : '';
}

function platNum(name) {
  const m = String(name).match(/platform\s*(\d+)/i);
  return m ? Number(m[1]) : 999;
}

function tidyPlatform(name) {
  // "Southbound - Platform 4" -> "Southbound Platform 4"
  return String(name).replace(/\s+-\s+/g, ' ').trim();
}
