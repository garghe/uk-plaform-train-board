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
let stations = [];                    // [[name, id, 'rail'|'tube'|'bus', towards?, routes/lines?], ...]
let byId = new Map();                 // id -> { name, kind, towards, routes }
let selected = [];                    // board keys: 'LBG', 'WAT:p2', '940GZZLUBNK:northbound'
const stationData = new Map();        // id -> { data, error, detail }
const boards = new Map();             // key -> board state

init();

async function init() {
  try {
    stations = await (await fetch('api/stations?v=3')).json();   // ?v= skips old cached copies
  } catch { stations = []; }
  byId = new Map(stations.map(([name, id, kind, towards = '', routes = []]) => [id, { name, kind, towards, routes }]));
  setupSearch();

  fetch('api/status').then((r) => r.json()).then(({ mode, build }) => {
    $('mode').innerHTML = mode === 'live' ? '<span class="live">● Live data</span>' : '<span class="sample">● Sample rail data</span>';
    showBuild(build);
  }).catch(() => {});

  selected = readSelection();
  setupInstallHelp();
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

// view: '' = classic board, 'screens' = platform screens (rail). Key: "ID[:filter][:screens]"
const validFilter = (f) => /^p[0-9]{1,2}[a-z]?$/.test(f) || /^r[0-9a-z]{1,5}$/.test(f) || DIRECTIONS.includes(f);

function makeKey(id, filter = '', view = '') {
  return [id, filter, view === 'screens' ? 'screens' : ''].filter(Boolean).join(':');
}

function parseKey(key) {
  const [rawId, ...rest] = String(key).trim().split(':');
  const id = rawId.toUpperCase();
  const parts = rest.map((p) => p.toLowerCase());
  const filter = parts.find(validFilter) || '';
  const view = parts.includes('screens') ? 'screens' : '';
  return { id, filter, view, key: makeKey(id, filter, view) };
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

function remember(list) {
  let added = false;
  for (const [name, id, kind, newTowards = '', newRoutes = []] of list) {
    const old = byId.get(id);
    // Keep details we already know if this source doesn't have them.
    const towards = newTowards || old?.towards || '';
    const routes = newRoutes?.length ? newRoutes : old?.routes || [];
    if (old && old.name === name && (old.towards || '') === towards && (old.routes || []).join() === routes.join()) continue;
    byId.set(id, { name, kind, towards, routes });
    const i = stations.findIndex(([, sid]) => sid === id);
    const row = [name, id, kind, towards, routes];
    if (i >= 0) stations[i] = row; else stations.push(row);
    added = true;
  }
  return added;
}

const isStopCode = (q) => /^\s*\d{5}\s*$/.test(q);
const wantsBus = (q) => BUS_WORDS.test(q.trim()) || isStopCode(q);
const cleanQuery = (q) => q.replace(TUBE_WORDS, '').replace(BUS_WORDS, '').trim();

// TfL search through our server: Tube (backup for the list) or bus stops (by name or stop code).
async function searchTfl(q, mode) {
  q = cleanQuery(q);
  if (q.length < 2) return [];
  try {
    const r = await fetch(`api/search?mode=${mode}&q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const found = await r.json();
    remember(found);
    return found;
  } catch { return []; }
}

/* ---------- Search drop-down ---------- */
// Sections of rows; each row is [name, id, kind, towards, routes, metres?]

const dd = { sections: [], hint: '', hl: -1 };

function setupSearch() {
  const input = $('stationInput');
  input.addEventListener('input', onType);
  input.addEventListener('focus', () => { if (input.value.trim()) onType(); });
  input.addEventListener('keydown', onSearchKey);
  input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
  $('nearBtn').addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the box
  $('nearBtn').addEventListener('click', nearMe);
}

// Rail and Tube from the local list, best matches first.
function localMatches(q) {
  if (BUS_WORDS.test(q) || isStopCode(q)) return [];
  const tubeOnly = TUBE_WORDS.test(q);
  const ql = cleanQuery(q).toLowerCase();
  if (!ql) return [];
  const score = ([name, id, kind]) => {
    if (kind === 'bus' || (tubeOnly && kind !== 'tube')) return 0;
    const n = name.toLowerCase();
    if (n === ql || id.toLowerCase() === ql) return 5;
    if (n.startsWith(ql)) return 4;
    if (n.split(/[\s(/-]+/).some((w) => w.startsWith(ql))) return 3;
    return n.includes(ql) ? 2 : 0;
  };
  return stations.map((r) => [score(r), r]).filter(([sc]) => sc)
    .sort((a, b) => b[0] - a[0] || a[1][0].localeCompare(b[1][0])).slice(0, 6).map(([, r]) => r);
}

function onType() {
  clearTimeout(onType.t);
  const q = $('stationInput').value;
  if (!q.trim()) return closeDropdown();
  const stationsFound = localMatches(q);
  const busWanted = cleanQuery(q).length >= 3 || isStopCode(q);
  const sections = [];
  if (stationsFound.length) sections.push({ title: 'Stations', items: stationsFound });
  if (busWanted) sections.push({ title: 'Bus stops', items: [], note: 'Searching…' });
  openDropdown(sections, '↑↓ to move · Enter to add · or type a 5-digit stop code');
  if (!busWanted) return;
  onType.t = setTimeout(async () => {
    const tubeMissing = !stations.some(([, , k]) => k === 'tube') && !BUS_WORDS.test(q) && !isStopCode(q);
    const [buses, tubes] = await Promise.all([searchTfl(q, 'bus'), tubeMissing ? searchTfl(q, 'tube') : []]);
    if ($('stationInput').value !== q) return;   // the user kept typing
    const st = [...stationsFound, ...tubes.filter(([, id]) => !stationsFound.some(([, s]) => s === id))].slice(0, 6);
    const secs = [];
    if (st.length) secs.push({ title: 'Stations', items: st });
    secs.push({ title: 'Bus stops', items: buses, note: buses.length ? '' : 'No London bus stops found' });
    openDropdown(secs, dd.hint);
  }, 350);
}

function openDropdown(sections, hint) {
  dd.sections = sections;
  dd.hint = hint;
  const items = ddItems();
  dd.hl = items.length ? Math.min(Math.max(dd.hl, 0), items.length - 1) : -1;
  const routesHtml = (routes) => (routes || []).slice(0, 6).map((r) => `<span>${esc(r)}</span>`).join('');
  let i = 0;
  const html = sections.map((sec) => `<div class="sec">${esc(sec.title)}</div>`
    + sec.items.map(([name, id, kind, towards = '', routes = [], metres]) => {
      const detail = kind === 'bus' ? (towards ? `→ ${towards}` : '') : kind === 'tube' ? (routes || []).join(', ') : id;
      const tags = kind === 'bus' ? `<span class="rt">${routesHtml(routes)}</span>` : '';
      const dist = metres != null ? `<span class="dist">${metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`}</span>` : '';
      const n = i++;
      return `<div class="it${n === dd.hl ? ' hl' : ''}" role="option" data-id="${esc(id)}" data-n="${n}">${dist}`
        + `<span class="badge ${kind}">${kind.toUpperCase()}</span>`
        + `<span class="tx"><span class="n">${esc(name)}</span> <span class="d">${esc(detail)}</span></span>${tags}</div>`;
    }).join('')
    + (sec.note ? `<div class="note">${esc(sec.note)}</div>` : '')).join('')
    + (hint ? `<div class="hint">${esc(hint)}</div>` : '');
  const box = $('dd');
  box.innerHTML = html;
  box.hidden = !sections.length;
  $('stationInput').setAttribute('aria-expanded', String(!box.hidden));
  box.querySelectorAll('.it').forEach((el) => {
    el.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the box
    el.addEventListener('click', () => addBoard(el.dataset.id));
  });
}

function ddItems() {
  return dd.sections.flatMap((s) => s.items);
}

function closeDropdown() {
  const box = $('dd');
  box.hidden = true;
  box.innerHTML = '';
  dd.sections = [];
  dd.hl = -1;
  $('stationInput').setAttribute('aria-expanded', 'false');
}

function onSearchKey(e) {
  const items = ddItems();
  if (e.key === 'Escape') return closeDropdown();
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
    e.preventDefault();
    dd.hl = (dd.hl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    openDropdown(dd.sections, dd.hint);
    $('dd').querySelector('.it.hl')?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter' && !$('dd').hidden && dd.hl >= 0 && items[dd.hl]) {
    e.preventDefault();
    addBoard(items[dd.hl][1]);
  }
}

// "Near me": bus stops, Tube and rail stations around the viewer's location (used once, not stored).
function nearMe() {
  const hint = 'Uses your location once, only to find nearby stops. Nothing is stored.';
  if (!navigator.geolocation) return flash('Location is not available in this browser.');
  clearTimeout(onType.t);            // drop any search still waiting
  $('stationInput').value = '';
  $('stationInput').focus();
  openDropdown([{ title: 'Near you', items: [], note: 'Finding your location…' }], hint);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      const r = await fetch(`api/near?lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      remember(body.results.map((x) => x.slice(0, 5)));
      const note = body.results.length ? '' : (body.error ? `Couldn't get stops from TfL (${body.error})` : 'Nothing found nearby');
      openDropdown([{ title: `Near you · within ${body.radius} m`, items: body.results, note }], hint);
    } catch (err) {
      openDropdown([{ title: 'Near you', items: [], note: `Couldn't find nearby stops: ${err.message}` }], hint);
    }
  }, (err) => {
    const why = err.code === 1 ? 'Location permission was refused. Allow it in your browser to use Near me.'
      : 'Your location could not be found. Try again, or search by name.';
    openDropdown([{ title: 'Near you', items: [], note: why }], '');
  }, { timeout: 15000, maximumAge: 60000 });
}

async function onAdd(e) {
  e.preventDefault();
  const items = ddItems();
  if (!$('dd').hidden && (dd.hl >= 0 || items.length === 1)) return addBoard(items[Math.max(dd.hl, 0)][1]);
  const text = $('stationInput').value;
  let id = wantsBus(text) ? null : findStation(text);
  if (!id) {
    let found = wantsBus(text) ? [] : await searchTfl(text, 'tube');
    if (!found.length) found = await searchTfl(text, 'bus');
    const want = cleanQuery(text).toLowerCase();
    const exact = found.filter(([n]) => n.toLowerCase() === want);
    if (exact.length === 1 || found.length === 1) id = (exact[0] || found[0])[1];
    else if (found.length) {
      $('stationInput').focus();
      return openDropdown([{ title: 'Pick one', items: found }], '');
    }
  }
  if (!id) return flash('Not found. Try another name, a 5-digit bus stop code, or 📍 Near me.');
  addBoard(id);
}

function addBoard(id) {
  closeDropdown();
  if (selected.includes(id)) return flash('That one is already shown.');
  if (selected.length >= MAX) return flash(`Up to ${MAX} boards.`);
  selected.push(id);
  $('stationInput').value = '';
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
  const { id, view } = parseKey(oldKey);
  changeKey(oldKey, makeKey(id, filter, view));
}

function changeView(oldKey, view) {
  const { id, filter } = parseKey(oldKey);
  changeKey(oldKey, makeKey(id, filter, view));
}

function changeKey(oldKey, newKey) {
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
    const { id, filter, view } = parseKey(key);
    const options = filterOptions(key)
      .map((f) => `<option value="${f}"${f === filter ? ' selected' : ''}>${esc(filterLabel(f, id))}</option>`).join('');
    const kind = kindOf(id);
    const viewMenu = kind !== 'rail' ? '' : `<select class="view" data-key="${key}" aria-label="View for ${esc(title(id))}">`
      + `<option value=""${view ? '' : ' selected'}>Classic board</option>`
      + `<option value="screens"${view ? ' selected' : ''}>Platform screens</option></select>`;
    return `<span class="chip"><span class="badge ${kind}">${kind.toUpperCase()}</span>${esc(title(id))}${viewMenu}`
      + `<select class="filter" data-key="${key}" aria-label="Filter for ${esc(title(id))}">${options}</select>`
      + `<button type="button" data-key="${key}" aria-label="Remove ${esc(title(id))}">✕</button></span>`;
  }).join('');
  if (html === chipsHtml && !force) return;   // don't close an open menu for nothing
  chipsHtml = html;
  $('chips').innerHTML = html;
  $('chips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => removeBoard(b.dataset.key)));
  $('chips').querySelectorAll('select.filter').forEach((s) => s.addEventListener('change', () => changeFilter(s.dataset.key, s.value)));
  $('chips').querySelectorAll('select.view').forEach((s) => s.addEventListener('change', () => changeView(s.dataset.key, s.value)));
}

function render() {
  renderChips(true);

  const full = selected.length >= MAX;
  $('stationInput').disabled = full;
  $('addForm').querySelector('button').disabled = full;
  $('stationInput').placeholder = full ? 'Maximum 4 boards' : 'Station, Tube or bus stop…';
  $('nearBtn').disabled = full;
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
    const { id, filter, view } = parseKey(key);
    const cell = document.createElement('div');
    const screens = view === 'screens' && kindOf(id) === 'rail';
    cell.className = screens ? 'cell screens' : 'cell';
    cell.innerHTML = screens ? `<div class="case">
      <div class="title"><span class="badge"></span><span class="nm"></span><span class="ft"></span></div>
      <div class="wall" tabindex="0" aria-label="Platform screens, scroll sideways for more"></div>
      <div class="wclock clock"></div></div>` : `<div class="case">
      <div class="title"><span class="badge"></span><span class="nm"></span><span class="ft"></span></div>
      <div class="inner"><div class="board">
      <div class="row r1"><span class="l"></span><span class="mq hide"><span></span></span><span class="r"></span></div>
      <div class="row r2 hide"><span class="l"></span><span class="r"></span></div>
      <div class="call"><span></span></div>
      <div class="row r3"><span class="l"></span><span class="r"></span></div>
      <div class="clock"></div></div></div></div>`;
    grid.appendChild(cell);
    const b = { key, id, filter, view: screens ? 'screens' : '', el: cell, next: 1, plat: 0, x: null, lastText: '', mode: 'trains' };
    boards.set(key, b);
    paint(b);
  }
  if (n === 3) grid.insertAdjacentHTML('beforeend', '<div class="cell slot"><div class="empty">+ Add a 4th station</div></div>');
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
  if (d?.kind === 'bus' && d.station && remember([[d.station, id, 'bus', d.towards || '', byId.get(id)?.routes || d.routes || []]])) render();
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
  b.el.querySelector('.title .ft').textContent = `${b.view === 'screens' ? 'Platform screens · ' : ''}${filterLabel(b.filter, b.id)}`;
  if (b.view === 'screens') return paintScreens(b, s);
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

/* ---------- Platform screens (rail) ---------- */
// One tall screen per platform showing its next train, like the screens at big stations:
//   14:27   Platform 10 / Cambridge / status / Calling at: … (Page 1 of 2) / operator / formation
// Screens are ordered by departure time, up to 10, and scroll sideways.
const MAX_SCREENS = 10;

function paintScreens(b, s) {
  const wall = b.el.querySelector('.wall');
  if (!s?.data) {
    wall.innerHTML = `<div class="wmsg">${esc(s?.error || 'Loading…')}${s?.detail ? `<br>${esc(s.detail)}` : ''}</div>`;
    return;
  }
  const want = b.filter.startsWith('p') ? b.filter.slice(1) : '';
  const firstPerPlatform = new Map();
  for (const sv of s.data.services || []) {
    const p = String(sv.platform || '').toLowerCase();
    if (!p || (want && p !== want) || firstPerPlatform.has(p)) continue;
    firstPerPlatform.set(p, sv);
  }
  const list = [...firstPerPlatform.values()].slice(0, MAX_SCREENS);   // services already come in time order
  if (!list.length) {
    wall.innerHTML = `<div class="wmsg">${want ? `No trains from platform ${esc(want.toUpperCase())}` : 'No platforms announced yet'}</div>`;
    return;
  }
  // Build the screens once per data change, then only flip pages.
  const sig = list.map((sv) => `${sv.std}|${sv.platform}|${sv.etd}|${sv.destination}`).join(';');
  if (wall.dataset.sig !== sig) {
    wall.dataset.sig = sig;
    wall.innerHTML = list.map((sv) => {
      const st = status(sv);
      const stops = (sv.calling?.length ? sv.calling : (sv.callingPoints || []).map((name) => ({ name, time: '' })));
      const lines = stops.map((c, i) => `${i === stops.length - 1 && stops.length > 1 ? '& ' : ''}${c.name}${c.time ? ` (${c.time})` : ''}`);
      const formation = sv.cancelled || st === 'Cancelled' ? 'This train has been cancelled.'
        : sv.length ? `${/^[aeiou]/i.test(sv.operator || '') ? 'An' : 'A'} ${sv.operator || ''} service formed of ${sv.length} coaches`.replace(/\s+/g, ' ')
        : sv.operator ? `${sv.operator} service` : '';
      return `<div class="screen">
        <div class="hd"><span>${esc(sv.std)}</span><span>Platform ${esc(sv.platform)}</span></div>
        <div class="ds sx"><span>${esc(sv.destination)}</span></div>
        <div class="stl">${st === 'On time' ? '&nbsp;' : esc(st)}</div>
        <div class="cl"><span>Calling at:</span><span class="pg"></span></div>
        <div class="stops">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
        <div class="op">${esc(sv.operator || '')}</div>
        <div class="fm sx"><span>${esc(formation)}</span></div></div>`;
    }).join('');
    // Destination or bottom line too long for the screen: scroll it, like the real ones.
    wall.querySelectorAll('.sx').forEach((el) => {
      const over = el.firstElementChild.scrollWidth - el.clientWidth;
      el.classList.toggle('run', over > 2);
      el.style.setProperty('--d', `${-over}px`);
      el.style.setProperty('--t', `${Math.max(6, over / 25)}s`);
    });
  }
  // Pages: fill each page with as many stops as fit (long names wrap onto a
  // second line, so rows differ in height), flip every few seconds.
  wall.querySelectorAll('.screen').forEach((scr) => {
    const box = scr.querySelector('.stops');
    const rows = [...box.children];
    rows.forEach((r) => { r.hidden = false; });
    const room = box.clientHeight;
    const pageOf = [];
    let page = 0, used = 0;
    for (const r of rows) {
      const h = r.offsetHeight;
      if (used > 0 && used + h > room) { page += 1; used = 0; }
      pageOf.push(page);
      used += h;
    }
    const pages = page + 1;
    const show = b.next % pages;
    rows.forEach((r, i) => { r.hidden = pageOf[i] !== show; });
    scr.querySelector('.pg').textContent = `Page ${show + 1} of ${pages}`;
  });
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
    if (b.view === 'screens') continue;
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

/* ---------- "Add to Home Screen" help ---------- */
// Shown once on a phone or tablet's first visit, and any time from the toolbar button.
// Not shown when the page is already running from the home screen.
const INSTALL_SEEN = 'departureBoard.installHelpSeen';
let installPrompt = null;   // Android/Chrome can install with one tap

function setupInstallHelp() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const modal = $('install');
  $('installBtn').hidden = standalone;
  if (!document.fullscreenEnabled) $('fsBtn').hidden = true;   // e.g. iPhone Safari has no full-screen mode
  $('installBtn').addEventListener('click', openInstallHelp);
  modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeInstallHelp));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeInstallHelp(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeInstallHelp(); });
  modal.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => showInstallTab(t.dataset.tab)));
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    modal.querySelector('.direct').hidden = false;
  });
  $('installNow').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    closeInstallHelp();
  });
  let seen = false;
  try { seen = !!localStorage.getItem(INSTALL_SEEN); } catch { /* storage unavailable */ }
  const phoneOrTablet = matchMedia('(pointer: coarse)').matches;
  if (!standalone && !seen && phoneOrTablet) setTimeout(openInstallHelp, 1200);
}

function deviceTab() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return /Android/.test(ua) && !ios ? 'android' : 'ios';
}

function showInstallTab(tab) {
  const modal = $('install');
  modal.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  modal.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
}

function openInstallHelp() {
  showInstallTab(deviceTab());
  $('install').hidden = false;
  $('install').querySelector('.primary[data-close]').focus();
}

function closeInstallHelp() {
  $('install').hidden = true;
  try { localStorage.setItem(INSTALL_SEEN, '1'); } catch { /* storage unavailable */ }
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
