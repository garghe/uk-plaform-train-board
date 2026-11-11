'use strict';

const MAX = 4;
const REFRESH_MS = 30 * 1000;
const CYCLE_MS = 4000;          // line 3: next train shown every 4 s
const PLATFORM_MS = 12000;      // Tube "all platforms": switch platform every 12 s
const SCROLL_EM_PER_S = 3;      // scrolling text speed
const STORE_KEY = 'departureBoard.stations';
const TUBE_ID = /^940GZZ[A-Z0-9]{2,6}$/;
const BUS_ID = /^490(?!G)[0-9A-Z]{3,12}$/;
const BUS_WORDS = /\s+(\(?bus\)?|bus stop)$/i;
const TUBE_WORDS = /\s+(\(?tube\)?|underground)$/i;
const DIRECTIONS = ['northbound', 'southbound', 'eastbound', 'westbound'];

const $ = (id) => document.getElementById(id);
let stations = [];                    // [[name, id, 'rail'|'tube'|'bus', towards?], ...]
let byId = new Map();                 // id -> { name, kind, towards }
let selected = [];                    // board keys: 'LBG', 'WAT:p2', '940GZZLUBNK:northbound'
const stationData = new Map();        // id -> { data, error, detail }
const boards = new Map();             // key -> board state

init();

async function init() {
  try {
    stations = await (await fetch('api/stations?v=3')).json();   // ?v= skips old cached copies
  } catch { stations = []; }
  byId = new Map(stations.map(([name, id, kind, towards]) => [id, { name, kind, towards }]));
  fillSuggestions();
  $('stationInput').addEventListener('input', onType);

  fetch('api/status').then((r) => r.json()).then(({ mode, build }) => {
    $('mode').innerHTML = mode === 'live' ? '<span class="live">● Live data</span>' : '<span class="sample">● Sample rail data</span>';
    showBuild(build);
  }).catch(() => {});

  selected = readSelection();
  $('addForm').addEventListener('submit', onAdd);
  $('fsBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('is-fs', !!document.fullscreenElement));
  window.addEventListener('popstate', () => { selected = readSelection(false); render(); });

  render();
  setInterval(refreshAll, REFRESH_MS);
  setInterval(tickClock, 1000);
  setInterval(cycleNext, CYCLE_MS);
  setInterval(cyclePlatform, PLATFORM_MS);
  requestAnimationFrame(scrollLoop);
}

/* ---------- Board keys: "ID" or "ID:filter" ---------- */
// filter: '' = all, 'p2' = platform 2, 'northbound' etc. = a direction (Tube), 'r88' = route 88 (bus)

function parseKey(key) {
  const [rawId, rawFilter = ''] = String(key).trim().split(':');
  const id = rawId.toUpperCase();
  let filter = rawFilter.toLowerCase();
  if (!/^p[0-9]{1,2}[a-z]?$/.test(filter) && !/^r[0-9a-z]{1,5}$/.test(filter) && !DIRECTIONS.includes(filter)) filter = '';
  return { id, filter, key: filter ? `${id}:${filter}` : id };
}

function filterLabel(filter, id = '') {
  if (!filter) return kindOf(id) === 'bus' ? 'All routes' : 'All platforms';
  if (filter.startsWith('p')) return `Platform ${filter.slice(1).toUpperCase()}`;
  if (filter.startsWith('r')) return `Route ${filter.slice(1).toUpperCase()}`;
  return filter[0].toUpperCase() + filter.slice(1);
}

/* ---------- Selection & URL ---------- */

function readSelection(useStore = true) {
  let list = (new URLSearchParams(location.search).get('stations') || '').split(',');
  if (!list[0] && useStore) {
    try { list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { list = []; }
  }
  const keys = list.filter(Boolean).map(parseKey).filter(({ id }) => byId.has(id) || TUBE_ID.test(id) || BUS_ID.test(id)).map((k) => k.key);
  return [...new Set(keys)].slice(0, MAX);
}

function saveSelection() {
  const url = new URL(location.href);
  if (selected.length) url.searchParams.set('stations', selected.join(','));
  else url.searchParams.delete('stations');
  history.pushState(null, '', url);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(selected)); } catch { /* storage unavailable */ }
}

// Search list entries: "Bath Spa (BTH)", "Oxford Circus (Tube)", "Trafalgar Square · Stop S → Westminster (Bus)"
function label(id) {
  const s = byId.get(id);
  if (!s) return id;
  if (s.kind === 'tube') return `${s.name} (Tube)`;
  if (s.kind === 'bus') return `${s.name}${s.towards ? ` → ${s.towards}` : ''} (Bus)`;
  return `${s.name} (${id})`;
}

// Titles and tags: "London Bridge (LBG)", "Oxford Circus", "Trafalgar Square · Stop S"
function title(id) {
  const s = byId.get(id);
  if (!s) return BUS_ID.test(id) ? 'Bus stop' : id;
  return s.kind === 'rail' ? `${s.name} (${id})` : s.name;
}

function kindOf(id) {
  return byId.get(id)?.kind || (TUBE_ID.test(id) ? 'tube' : BUS_ID.test(id) ? 'bus' : 'rail');
}

function isTube(id) {
  return kindOf(id) === 'tube';
}

function findStation(text) {
  let q = text.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const byLabel = stations.find(([, id]) => label(id).toLowerCase() === lower);
  if (byLabel) return byLabel[1];
  if (/^[A-Za-z]{3}$/.test(q) && byId.get(q.toUpperCase())?.kind === 'rail') return q.toUpperCase();

  // "Bank tube" → only Tube stations; "Trafalgar Square bus" → only bus stops
  let pool = stations.filter(([, , k]) => k !== 'bus');
  if (TUBE_WORDS.test(q)) {
    q = q.replace(TUBE_WORDS, '');
    pool = stations.filter(([, , k]) => k === 'tube');
  } else if (BUS_WORDS.test(q)) {
    q = q.replace(BUS_WORDS, '');
    pool = stations.filter(([, , k]) => k === 'bus');
  }
  const ql = q.toLowerCase();
  const exact = pool.filter(([n]) => n.toLowerCase() === ql);
  if (exact.length === 1) return exact[0][1];
  if (exact.length > 1) return null;   // e.g. both a rail and a Tube station: pick from the list
  const starts = pool.filter(([n]) => n.toLowerCase().startsWith(ql));
  if (starts.length === 1) return starts[0][1];
  const contains = pool.filter(([n]) => n.toLowerCase().includes(ql));
  return contains.length === 1 ? contains[0][1] : null;
}

function fillSuggestions() {
  $('stationList').innerHTML = stations.map(([, id]) => `<option value="${esc(label(id))}">`).join('');
}

function remember(list) {
  let added = false;
  for (const [name, id, kind, towards = ''] of list) {
    const old = byId.get(id);
    if (old && old.name === name && (old.towards || '') === towards) continue;
    byId.set(id, { name, kind, towards });
    const i = stations.findIndex(([, sid]) => sid === id);
    if (i >= 0) stations[i] = [name, id, kind, towards]; else stations.push([name, id, kind, towards]);
    added = true;
  }
  if (added) fillSuggestions();
  return added;
}

const isStopCode = (q) => /^\s*\d{5}\s*$/.test(q);
const wantsBus = (q) => BUS_WORDS.test(q.trim()) || isStopCode(q);

// TfL search through our server: Tube (backup for the list) or bus stops (by name or stop code).
async function searchTfl(q, mode) {
  q = q.replace(TUBE_WORDS, '').replace(BUS_WORDS, '').trim();
  if (q.length < 2) return [];
  try {
    const r = await fetch(`api/search?mode=${mode}&q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const found = await r.json();
    remember(found);
    return found;
  } catch { return []; }
}

// While typing, top up the suggestions: bus stops when asked for ("… bus" or a stop code),
// Tube stations if the Tube list is missing.
function onType() {
  clearTimeout(onType.t);
  const q = $('stationInput').value;
  if (wantsBus(q)) { onType.t = setTimeout(() => searchTfl(q, 'bus'), 400); return; }
  if (q.length < 3 || stations.some(([, , k]) => k === 'tube')) return;
  onType.t = setTimeout(() => searchTfl(q, 'tube'), 300);
}

async function onAdd(e) {
  e.preventDefault();
  const input = $('stationInput');
  const text = input.value;
  let id = wantsBus(text) ? null : findStation(text);
  if (!id) {
    let found = wantsBus(text) ? [] : await searchTfl(text, 'tube');
    if (!found.length) found = await searchTfl(text, 'bus');
    const want = text.replace(TUBE_WORDS, '').replace(BUS_WORDS, '').trim().toLowerCase();
    const exact = found.filter(([n]) => n.toLowerCase() === want);
    if (exact.length === 1 || found.length === 1) id = (exact[0] || found[0])[1];
    else if (found.length) return offerChoices(found);
  }
  if (!id) return flash('Not found. Pick from the list, or add "bus" / a 5-digit stop code for bus stops.');
  addBoard(id);
}

function addBoard(id) {
  if (selected.includes(id)) return flash('That one is already shown.');
  if (selected.length >= MAX) return flash(`Up to ${MAX} boards.`);
  selected.push(id);
  $('stationInput').value = '';
  flash('');
  saveSelection();
  render();
}

// Several matches (e.g. the stops around Trafalgar Square): show them as buttons.
function offerChoices(found) {
  clearTimeout(flash.t);
  const msg = $('msg');
  msg.innerHTML = 'Pick one: ' + found.slice(0, 8).map(([, id]) =>
    `<button type="button" class="pick" data-id="${esc(id)}">${esc(label(id))}</button>`).join('');
  msg.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => addBoard(b.dataset.id)));
}

function removeBoard(key) {
  selected = selected.filter((k) => k !== key);
  saveSelection();
  render();
}

function changeFilter(oldKey, filter) {
  const { id } = parseKey(oldKey);
  const newKey = parseKey(`${id}:${filter}`).key;
  if (newKey === oldKey) return;
  if (selected.includes(newKey)) { flash('That board is already shown.'); renderChips(true); return; }
  selected = selected.map((k) => (k === oldKey ? newKey : k));
  saveSelection();
  render();
}

function flash(text) {
  $('msg').textContent = text;   // also clears any "Pick one" buttons
  clearTimeout(flash.t);
  if (text) flash.t = setTimeout(() => ($('msg').textContent = ''), 4000);
}

/* ---------- Platform filter choices ---------- */

function filterOptions(key) {
  const { id, filter } = parseKey(key);
  const d = stationData.get(id)?.data;
  const opts = new Set(['']);
  if (d?.kind === 'bus') {
    (d.routes || []).forEach((r) => opts.add(`r${String(r).toLowerCase()}`));
  } else if (d?.kind === 'tube') {
    const plats = d.platforms || [];
    for (const dir of DIRECTIONS) if (plats.some((p) => p.direction.toLowerCase() === dir)) opts.add(dir);
    plats.map((p) => p.number).filter(Boolean).sort(numeric).forEach((n) => opts.add(`p${n.toLowerCase()}`));
  } else if (d?.services) {
    d.services.map((s) => s.platform).filter(Boolean).sort(numeric).forEach((n) => opts.add(`p${String(n).toLowerCase()}`));
  }
  opts.add(filter);
  return [...opts].filter((f) => f === '' || parseKey(`X:${f}`).filter === f);
}

const numeric = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/* ---------- Rendering ---------- */

let chipsHtml = '';
function renderChips(force = false) {
  const html = selected.map((key) => {
    const { id, filter } = parseKey(key);
    const options = filterOptions(key)
      .map((f) => `<option value="${f}"${f === filter ? ' selected' : ''}>${esc(filterLabel(f, id))}</option>`).join('');
    const kind = kindOf(id);
    return `<span class="chip"><span class="badge ${kind}">${kind.toUpperCase()}</span>${esc(title(id))}`
      + `<select data-key="${key}" aria-label="Filter for ${esc(title(id))}">${options}</select>`
      + `<button type="button" data-key="${key}" aria-label="Remove ${esc(title(id))}">✕</button></span>`;
  }).join('');
  if (html === chipsHtml && !force) return;   // don't close an open menu for nothing
  chipsHtml = html;
  $('chips').innerHTML = html;
  $('chips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => removeBoard(b.dataset.key)));
  $('chips').querySelectorAll('select').forEach((s) => s.addEventListener('change', () => changeFilter(s.dataset.key, s.value)));
}

function render() {
  renderChips(true);

  const full = selected.length >= MAX;
  $('stationInput').disabled = full;
  $('addForm').querySelector('button').disabled = full;
  $('stationInput').placeholder = full ? 'Maximum 4 boards' : 'Station, Tube, or bus stop (name + "bus", or stop code)…';
  $('tflCredit').hidden = !selected.some((k) => kindOf(parseKey(k).id) !== 'rail');

  const n = selected.length;
  const grid = $('grid');
  grid.className = 'grid ' + (n <= 1 ? 'n1' : n === 2 ? 'n2' : 'n4');
  boards.clear();
  grid.innerHTML = '';
  if (!n) {
    grid.innerHTML = '<div class="cell"><div class="empty">Type a station name above to show its departures</div></div>';
    return;
  }
  for (const key of selected) {
    const { id, filter } = parseKey(key);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<div class="case">
      <div class="title"><span class="badge"></span><span class="nm"></span><span class="ft"></span></div>
      <div class="inner"><div class="board">
      <div class="row r1"><span class="l"></span><span class="mq hide"><span></span></span><span class="r"></span></div>
      <div class="row r2 hide"><span class="l"></span><span class="r"></span></div>
      <div class="call"><span></span></div>
      <div class="row r3"><span class="l"></span><span class="r"></span></div>
      <div class="clock"></div></div></div></div>`;
    grid.appendChild(cell);
    const b = { key, id, filter, el: cell, next: 1, plat: 0, x: null, lastText: '', mode: 'trains' };
    boards.set(key, b);
    paint(b);
  }
  if (n === 3) grid.insertAdjacentHTML('beforeend', '<div class="cell"><div class="empty">+ Add a 4th station</div></div>');
  for (const id of new Set(selected.map((k) => parseKey(k).id))) if (!stationData.get(id)?.data) load(id);
  tickClock();
}

async function load(id) {
  const entry = stationData.get(id) || {};
  try {
    const r = await fetch(`api/departures?id=${encodeURIComponent(id)}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${r.status}`);
    }
    entry.data = await r.json();
    entry.error = '';
    entry.detail = '';
  } catch (err) {
    entry.error = 'Unable to load departures';
    entry.detail = err.message;
    console.warn(id, err);
  }
  stationData.set(id, entry);
  const d = entry.data;
  if (d?.kind === 'tube' && d.station && remember([[d.station, id, 'tube']])) render();
  if (d?.kind === 'bus' && d.station && remember([[d.station, id, 'bus', d.towards || '']])) render();
  for (const b of boards.values()) if (b.id === id) paint(b);
  renderChips();
}

function refreshAll() {
  for (const id of new Set(selected.map((k) => parseKey(k).id))) load(id);
}

/* ---------- Painting ---------- */

function rows(b) {
  const q = (s) => b.el.querySelector(s);
  const set = (row, l = '', r = '') => { q(`.${row} .l`).textContent = l; q(`.${row} .r`).textContent = r; };
  const show = (sel, on) => q(sel).classList.toggle('hide', !on);
  return { set, show };
}

function paint(b) {
  const s = stationData.get(b.id);
  const kind = kindOf(b.id);
  const badge = b.el.querySelector('.title .badge');
  badge.className = `badge ${kind}`;
  badge.textContent = kind.toUpperCase();
  b.el.querySelector('.title .nm').textContent = title(b.id);
  b.el.querySelector('.title .ft').textContent = filterLabel(b.filter, b.id);
  b.el.querySelector('.r1 .mq').classList.toggle('hide', s?.data?.kind !== 'bus');
  if (!s?.data) return showText(b, s?.error || 'Loading…', s?.detail || '');
  if (s.data.kind === 'bus') return paintBus(b, s.data);
  return s.data.kind === 'tube' ? paintTube(b, s.data) : paintRail(b, s.data);
}

function showText(b, text, detail = '') {
  const { set, show } = rows(b);
  set('r1', text);
  show('.r2', false);
  show('.call', true);
  setCall(b, detail);
  show('.r3', true);
  set('r3');
}

// Rail: "11:05 4  Romford      Delayed" / scrolling calling points / "2nd 11:20 6  Woburn Sands"
function paintRail(b, d) {
  const { set, show } = rows(b);
  show('.r2', false);
  show('.call', true);
  show('.r3', true);
  const want = b.filter.startsWith('p') ? b.filter.slice(1) : '';
  const services = (d.services || []).filter((s) => !want || String(s.platform).toLowerCase() === want);
  if (!services.length) {
    set('r1', want ? `No trains from platform ${want.toUpperCase()}` : 'No services');
    setCall(b, d.message || 'Please check timetable for services.');
    set('r3');
    return;
  }
  const first = services[0];
  set('r1', `${first.std} ${plat(first.platform)} ${first.destination}`, status(first));
  setCall(b, callText(first));
  if (services.length < 2) return set('r3');
  if (b.next >= services.length || b.next < 1) b.next = 1;
  const s = services[b.next];
  set('r3', `${ordinal(b.next + 1)} ${s.std} ${plat(s.platform)} ${s.destination}`, status(s));
}

const plat = (p) => String(p || '').padEnd(2, ' ');

function callText(s) {
  if (s.cancelled) return 'This train has been cancelled.';
  const pts = s.callingPoints || [];
  if (!pts.length) return `Calling at: ${s.destination} only.`;
  const list = pts.length === 1 ? pts[0] : `${pts.slice(0, -1).join(', ')} and ${pts[pts.length - 1]}`;
  return `Calling at: ${list}.${s.operator ? `  ${s.operator} service.` : ''}`;
}

function status(s) {
  const etd = (s.etd || '').trim();
  if (s.cancelled || /cancel/i.test(etd)) return 'Cancelled';
  if (/^\d{1,2}:\d{2}$/.test(etd)) return `Exp ${etd}`;
  if (/delay/i.test(etd)) return 'Delayed';
  return 'On time';
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Tube, like an Underground platform board:
//   Westbound · Platform 1          Central
//   1 Ealing Broadway                2 mins
//   2 West Ruislip                   5 mins   (cycles 2, 3, … then scrolls the line status)
//   11:25:09
function tubePlatforms(b, d) {
  const f = b.filter;
  return (d.platforms || []).filter((p) => p.arrivals.length && (!f
    || (f.startsWith('p') ? p.number.toLowerCase() === f.slice(1) : p.direction.toLowerCase() === f)));
}

function upcoming(p) {
  const now = Date.now();
  const due = p.arrivals.filter((a) => new Date(a.expected).getTime() > now - 30000);
  return due.length ? due : p.arrivals;
}

function paintTube(b, d) {
  const { set, show } = rows(b);
  const platforms = tubePlatforms(b, d);
  if (!platforms.length) {
    set('r1', b.filter ? `No trains due · ${filterLabel(b.filter)}` : 'No trains due');
    show('.r2', false);
    show('.call', true);
    setCall(b, d.message || 'Please listen for announcements.');
    show('.r3', false);
    return;
  }
  if (b.plat >= platforms.length) b.plat = 0;
  const p = platforms[b.plat];
  const list = upcoming(p);
  const header = [p.direction, p.number ? `Platform ${p.number}` : (p.direction ? '' : p.platform)].filter(Boolean).join(' · ');
  set('r1', header, p.lines.join(' / '));
  show('.r2', true);
  set('r2', `1 ${list[0].destination}`, mins(list[0].expected));

  const statusText = p.status || d.message || '';
  if (b.mode === 'status' && statusText) {
    show('.r3', false);
    show('.call', true);
    setCall(b, statusText);
    return;
  }
  b.mode = 'trains';
  show('.call', false);
  show('.r3', true);
  if (list.length < 2) return set('r3');
  if (b.next >= list.length || b.next < 1) b.next = 1;
  const a = list[b.next];
  set('r3', `${b.next + 1} ${a.destination}`, mins(a.expected));
}

// Bus, like a London bus stop countdown sign:
//   Stop S → Westminster
//   453  Deptford Bridge     2 min
//   12   Dulwich Library     4 min   (cycles through the following buses)
//   11:25:09
function busArrivals(b, d) {
  const want = b.filter.startsWith('r') ? b.filter.slice(1) : '';
  const now = Date.now();
  return (d.arrivals || []).filter((a) => (!want || a.route.toLowerCase() === want)
    && new Date(a.expected).getTime() > now - 30000);
}

function paintBus(b, d) {
  const { set, show } = rows(b);
  show('.call', false);
  show('.r2', true);
  show('.r3', true);
  // "Stop E →" stays put; the destinations after it scroll if they don't fit.
  if (d.towards) {
    set('r1', d.stop ? `${d.stop} →` : '→');
    setMarquee(b, d.towards);
  } else {
    set('r1', d.stop || d.station);
    setMarquee(b, '');
  }
  const list = busArrivals(b, d);
  if (!list.length) {
    set('r2', b.filter ? `No ${filterLabel(b.filter, b.id).toLowerCase()} buses due` : 'No buses due');
    return set('r3');
  }
  const line = (a) => `${a.route.padEnd(4, ' ')} ${a.destination}`;
  set('r2', line(list[0]), busMins(list[0].expected));
  if (list.length < 2) return set('r3');
  if (b.next >= list.length || b.next < 1) b.next = 1;
  set('r3', line(list[b.next]), busMins(list[b.next].expected));
}

function busMins(iso) {
  const m = Math.floor((new Date(iso).getTime() - Date.now()) / 60000);
  return m < 1 ? 'Due' : `${m} min`;
}

function mins(iso) {
  const m = Math.floor((new Date(iso).getTime() - Date.now()) / 60000);
  return m < 1 ? 'Due' : m === 1 ? '1 min' : `${m} mins`;
}

function setCall(b, text) {
  if (text === b.lastText && b.x !== null) return;   // keep scrolling smoothly across refreshes
  b.lastText = text;
  b.el.querySelector('.call span').textContent = text;
  b.x = null;                                         // restart from the right edge
}

function setMarquee(b, text) {
  const span = b.el.querySelector('.r1 .mq span');
  if (span.textContent === text) return;
  span.textContent = text;
  b.mx = 0;
  b.mPause = 2;   // seconds to show the start before scrolling
}

/* ---------- Timers & animation ---------- */

const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function tickClock() {
  const t = clockFmt.format(new Date());
  document.querySelectorAll('.clock').forEach((c) => (c.textContent = t));
  // Tube and bus countdowns ("3 mins") tick down between refreshes.
  for (const b of boards.values()) if (['tube', 'bus'].includes(stationData.get(b.id)?.data?.kind)) paint(b);
}

function cycleNext() {
  for (const b of boards.values()) {
    const d = stationData.get(b.id)?.data;
    if (!d) continue;
    if (d.kind === 'tube') {
      if (b.mode === 'status') continue;               // ends when the status has scrolled past
      const p = tubePlatforms(b, d)[b.plat];
      if (!p) continue;
      b.next += 1;
      if (b.next >= upcoming(p).length) {
        b.next = 1;
        if (p.status || d.message) { b.mode = 'status'; b.x = null; b.lastText = ''; }
      }
    } else {
      b.next += 1;
    }
    paint(b);
  }
}

function cyclePlatform() {
  for (const b of boards.values()) {
    const d = stationData.get(b.id)?.data;
    if (d?.kind !== 'tube' || b.mode === 'status' || tubePlatforms(b, d).length < 2) continue;
    b.plat += 1;
    b.next = 1;
    paint(b);
  }
}

let lastFrame = performance.now();
function scrollLoop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  for (const b of boards.values()) {
    scrollMarquee(b, dt);
    const box = b.el.querySelector('.call');
    const span = box.firstElementChild;
    if (box.classList.contains('hide') || !span.textContent) continue;
    const em = parseFloat(getComputedStyle(box).fontSize) || 16;
    const boxW = box.clientWidth;
    if (b.x === null) b.x = boxW;
    b.x -= SCROLL_EM_PER_S * em * dt;
    if (b.x < -span.offsetWidth) {
      b.x = boxW;
      if (b.mode === 'status') { b.mode = 'trains'; b.next = 1; paint(b); }   // Tube: back to the trains
    }
    span.style.transform = `translateX(${Math.round(b.x)}px)`;
  }
  requestAnimationFrame(scrollLoop);
}

// Header text that doesn't fit: show the start, pause, scroll it away, then start again.
function scrollMarquee(b, dt) {
  const box = b.el.querySelector('.r1 .mq');
  const span = box.firstElementChild;
  if (box.classList.contains('hide') || !span.textContent) return;
  if (span.offsetWidth <= box.clientWidth + 1) {
    if (b.mx) { b.mx = 0; span.style.transform = ''; }
    return;
  }
  if (b.mPause > 0) {
    b.mPause -= dt;
  } else {
    const em = parseFloat(getComputedStyle(box).fontSize) || 16;
    b.mx -= SCROLL_EM_PER_S * em * dt;
    if (b.mx < -span.offsetWidth) { b.mx = 0; b.mPause = 2; }
  }
  span.style.transform = `translateX(${Math.round(b.mx)}px)`;
}

/* ---------- Misc ---------- */

// Footer: "Deployed 11 Nov 2026, 23:14 · version 1a2b3c4d"
function showBuild(build) {
  const when = build?.deployedAt ? new Date(build.deployedAt) : null;
  if (!when || isNaN(when)) return;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const what = build.how === 'started' ? 'Running locally, started' : 'Deployed';
  $('footer').textContent = `${what} ${fmt.format(when)} (UK time)${build.version ? ` · version ${build.version.slice(0, 8)}` : ''}`;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
