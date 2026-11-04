'use strict';

const MAX = 4;
const REFRESH_MS = 30 * 1000;
const CYCLE_MS = 4000;          // line 3: next train shown every 4 s
const PLATFORM_MS = 12000;      // Tube "all platforms": switch platform every 12 s
const SCROLL_EM_PER_S = 3;      // scrolling text speed
const STORE_KEY = 'departureBoard.stations';
const TUBE_ID = /^940GZZ[A-Z0-9]{2,6}$/;
const DIRECTIONS = ['northbound', 'southbound', 'eastbound', 'westbound'];

const $ = (id) => document.getElementById(id);
let stations = [];                    // [[name, id, 'rail'|'tube'], ...]
let byId = new Map();                 // id -> { name, kind }
let selected = [];                    // board keys: 'LBG', 'WAT:p2', '940GZZLUBNK:northbound'
const stationData = new Map();        // id -> { data, error, detail }
const boards = new Map();             // key -> board state

init();

async function init() {
  try {
    stations = await (await fetch('api/stations?v=3')).json();   // ?v= skips old cached copies
  } catch { stations = []; }
  byId = new Map(stations.map(([name, id, kind]) => [id, { name, kind }]));
  fillSuggestions();
  $('stationInput').addEventListener('input', onType);

  fetch('api/status').then((r) => r.json()).then(({ mode }) => {
    $('mode').innerHTML = mode === 'live' ? '<span class="live">● Live data</span>' : '<span class="sample">● Sample rail data</span>';
  });

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
// filter: '' = all platforms, 'p2' = platform 2, 'northbound' etc. = a direction (Tube)

function parseKey(key) {
  const [rawId, rawFilter = ''] = String(key).trim().split(':');
  const id = rawId.toUpperCase();
  let filter = rawFilter.toLowerCase();
  if (!/^p[0-9]{1,2}[a-z]?$/.test(filter) && !DIRECTIONS.includes(filter)) filter = '';
  return { id, filter, key: filter ? `${id}:${filter}` : id };
}

function filterLabel(filter) {
  if (!filter) return 'All platforms';
  if (filter.startsWith('p')) return `Platform ${filter.slice(1).toUpperCase()}`;
  return filter[0].toUpperCase() + filter.slice(1);
}

/* ---------- Selection & URL ---------- */

function readSelection(useStore = true) {
  let list = (new URLSearchParams(location.search).get('stations') || '').split(',');
  if (!list[0] && useStore) {
    try { list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { list = []; }
  }
  const keys = list.filter(Boolean).map(parseKey).filter(({ id }) => byId.has(id) || TUBE_ID.test(id)).map((k) => k.key);
  return [...new Set(keys)].slice(0, MAX);
}

function saveSelection() {
  const url = new URL(location.href);
  if (selected.length) url.searchParams.set('stations', selected.join(','));
  else url.searchParams.delete('stations');
  history.pushState(null, '', url);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(selected)); } catch { /* storage unavailable */ }
}

// "Bath Spa (BTH)" for rail, "Oxford Circus (Tube)" for the Underground.
function label(id) {
  const s = byId.get(id);
  return s ? `${s.name} (${s.kind === 'tube' ? 'Tube' : id})` : id;
}

function isTube(id) {
  return byId.get(id)?.kind === 'tube' || TUBE_ID.test(id);
}

function findStation(text) {
  let q = text.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const byLabel = stations.find(([, id]) => label(id).toLowerCase() === lower);
  if (byLabel) return byLabel[1];
  if (/^[A-Za-z]{3}$/.test(q) && byId.get(q.toUpperCase())?.kind === 'rail') return q.toUpperCase();

  // "Bank tube" / "Bank underground" → only Tube stations
  let pool = stations;
  const tubeWord = /\s+(\(?tube\)?|underground)$/i;
  if (tubeWord.test(q)) {
    q = q.replace(tubeWord, '');
    pool = stations.filter(([, , k]) => k === 'tube');
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
  for (const [name, id, kind] of list) {
    if (byId.has(id)) continue;
    byId.set(id, { name, kind });
    stations.push([name, id, kind]);
    added = true;
  }
  if (added) fillSuggestions();
  return added;
}

// Backup for Tube stations: ask TfL's station search through our server.
async function searchTube(q) {
  q = q.replace(/\s+(\(?tube\)?|underground)$/i, '').trim();
  if (q.length < 2) return [];
  try {
    const r = await fetch(`api/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const found = await r.json();
    remember(found);
    return found;
  } catch { return []; }
}

// While typing, top up the suggestions from TfL if the Tube list is missing.
function onType() {
  clearTimeout(onType.t);
  const q = $('stationInput').value;
  if (q.length < 3 || stations.some(([, , k]) => k === 'tube')) return;
  onType.t = setTimeout(() => searchTube(q), 300);
}

async function onAdd(e) {
  e.preventDefault();
  const input = $('stationInput');
  let id = findStation(input.value);
  if (!id) {
    const found = await searchTube(input.value);
    const want = input.value.replace(/\s+(\(?tube\)?|underground)$/i, '').trim().toLowerCase();
    const exact = found.filter(([n]) => n.toLowerCase() === want);
    if (exact.length === 1 || found.length === 1) id = (exact[0] || found[0])[1];
    else if (found.length) return flash(`Did you mean: ${found.slice(0, 4).map(([n]) => n).join(', ')}?`);
  }
  if (!id) return flash('Station not found or ambiguous. Pick one from the list.');
  if (selected.includes(id)) return flash('That station is already shown.');
  if (selected.length >= MAX) return flash(`Up to ${MAX} stations.`);
  selected.push(id);
  input.value = '';
  flash('');
  saveSelection();
  render();
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
  $('msg').textContent = text;
  clearTimeout(flash.t);
  if (text) flash.t = setTimeout(() => ($('msg').textContent = ''), 4000);
}

/* ---------- Platform filter choices ---------- */

function filterOptions(key) {
  const { id, filter } = parseKey(key);
  const d = stationData.get(id)?.data;
  const opts = new Set(['']);
  if (d?.kind === 'tube') {
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
      .map((f) => `<option value="${f}"${f === filter ? ' selected' : ''}>${esc(filterLabel(f))}</option>`).join('');
    return `<span class="chip">${esc(label(id))}`
      + `<select data-key="${key}" aria-label="Platform for ${esc(label(id))}">${options}</select>`
      + `<button type="button" data-key="${key}" aria-label="Remove ${esc(label(id))}">✕</button></span>`;
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
  $('stationInput').placeholder = full ? 'Maximum 4 stations' : 'Add rail or Tube station…';
  $('tflCredit').hidden = !selected.some((k) => isTube(parseKey(k).id));

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
    cell.innerHTML = `<div class="case"><div class="name"></div><div class="board">
      <div class="row r1"><span class="l"></span><span class="r"></span></div>
      <div class="row r2 hide"><span class="l"></span><span class="r"></span></div>
      <div class="call"><span></span></div>
      <div class="row r3"><span class="l"></span><span class="r"></span></div>
      <div class="clock"></div></div></div>`;
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
  if (entry.data?.kind === 'tube' && entry.data.station && remember([[entry.data.station, id, 'tube']])) render();
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
  b.el.querySelector('.name').textContent = `${label(b.id)}${b.filter ? ` · ${filterLabel(b.filter)}` : ''}`;
  if (!s?.data) return showText(b, s?.error || 'Loading…', s?.detail || '');
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

/* ---------- Timers & animation ---------- */

const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function tickClock() {
  const t = clockFmt.format(new Date());
  document.querySelectorAll('.clock').forEach((c) => (c.textContent = t));
  // Tube countdowns ("3 mins") tick down between refreshes.
  for (const b of boards.values()) if (stationData.get(b.id)?.data?.kind === 'tube') paint(b);
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

/* ---------- Misc ---------- */

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
