'use strict';

const MAX = 4;
const REFRESH_MS = 30 * 1000;
const CYCLE_MS = 4000;          // line 3: next train shown every 4 s
const SCROLL_EM_PER_S = 3;      // line 2: scroll speed
const STORE_KEY = 'departureBoard.stations';

const $ = (id) => document.getElementById(id);
let stations = [];                    // [[name, crs], ...]
let byCrs = new Map();
let selected = [];                    // ['LBG', 'WAT', ...]
const boards = new Map();             // crs -> board state

init();

async function init() {
  stations = await (await fetch('api/stations')).json();
  byCrs = new Map(stations.map(([n, c]) => [c, n]));
  $('stationList').innerHTML = stations.map(([n, c]) => `<option value="${esc(n)} (${c})">`).join('');

  fetch('api/status').then((r) => r.json()).then(({ mode }) => {
    $('mode').innerHTML = mode === 'live' ? '<span class="live">● Live data</span>' : '<span class="sample">● Sample data</span>';
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
  requestAnimationFrame(scrollLoop);
}

/* ---------- Selection & URL ---------- */

function readSelection(useStore = true) {
  let list = (new URLSearchParams(location.search).get('stations') || '').split(',');
  if (!list[0] && useStore) {
    try { list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { list = []; }
  }
  return [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter((c) => byCrs.has(c)))].slice(0, MAX);
}

function saveSelection() {
  const url = new URL(location.href);
  if (selected.length) url.searchParams.set('stations', selected.join(','));
  else url.searchParams.delete('stations');
  history.pushState(null, '', url);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(selected)); } catch { /* storage unavailable */ }
}

function findStation(text) {
  const q = text.trim();
  if (!q) return null;
  const code = q.match(/\(([A-Za-z]{3})\)\s*$/);
  if (code && byCrs.has(code[1].toUpperCase())) return code[1].toUpperCase();
  if (/^[A-Za-z]{3}$/.test(q) && byCrs.has(q.toUpperCase())) return q.toUpperCase();
  const lower = q.toLowerCase();
  const exact = stations.find(([n]) => n.toLowerCase() === lower);
  if (exact) return exact[1];
  const starts = stations.filter(([n]) => n.toLowerCase().startsWith(lower));
  if (starts.length === 1) return starts[0][1];
  const contains = stations.filter(([n]) => n.toLowerCase().includes(lower));
  return contains.length === 1 ? contains[0][1] : null;
}

function onAdd(e) {
  e.preventDefault();
  const input = $('stationInput');
  const crs = findStation(input.value);
  if (!crs) return flash('Station not found. Pick one from the list.');
  if (selected.includes(crs)) return flash('That station is already shown.');
  if (selected.length >= MAX) return flash(`Up to ${MAX} stations.`);
  selected.push(crs);
  input.value = '';
  flash('');
  saveSelection();
  render();
}

function removeStation(crs) {
  selected = selected.filter((c) => c !== crs);
  saveSelection();
  render();
}

function flash(text) {
  $('msg').textContent = text;
  clearTimeout(flash.t);
  if (text) flash.t = setTimeout(() => ($('msg').textContent = ''), 4000);
}

/* ---------- Rendering ---------- */

function render() {
  $('chips').innerHTML = selected.map((c) =>
    `<span class="chip">${esc(byCrs.get(c))} (${c})<button type="button" data-crs="${c}" aria-label="Remove ${esc(byCrs.get(c))}">✕</button></span>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => removeStation(b.dataset.crs)));

  const full = selected.length >= MAX;
  $('stationInput').disabled = full;
  $('addForm').querySelector('button').disabled = full;
  $('stationInput').placeholder = full ? 'Maximum 4 stations' : 'Add station (name or code)…';

  const n = selected.length;
  const grid = $('grid');
  grid.className = 'grid ' + (n <= 1 ? 'n1' : n === 2 ? 'n2' : 'n4');

  for (const crs of [...boards.keys()]) if (!selected.includes(crs)) boards.delete(crs);

  grid.innerHTML = '';
  if (!n) {
    grid.innerHTML = '<div class="cell"><div class="empty">Type a station name above to show its departures</div></div>';
    return;
  }
  for (const crs of selected) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<div class="case"><div class="name">${esc(byCrs.get(crs))}</div><div class="board">
      <div class="row r1"><span class="l"></span><span class="r"></span></div>
      <div class="call"><span></span></div>
      <div class="row r3"><span class="l"></span><span class="r"></span></div>
      <div class="clock"></div></div></div>`;
    grid.appendChild(cell);
    const st = boards.get(crs) || { crs, data: null, next: 1, x: null, lastText: '' };
    st.el = cell;
    st.x = null;
    boards.set(crs, st);
    if (st.data) paint(st); else showText(st, 'Loading…');
    if (!st.data) load(st);
  }
  if (n === 3) grid.insertAdjacentHTML('beforeend', '<div class="cell"><div class="empty">+ Add a 4th station</div></div>');
  tickClock();
}

async function load(st) {
  try {
    const r = await fetch(`api/departures?crs=${st.crs}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    st.data = await r.json();
    st.error = '';
  } catch (err) {
    st.error = 'Unable to load departures';
    console.warn(st.crs, err);
  }
  if (boards.get(st.crs) === st) paint(st);
}

function refreshAll() {
  for (const st of boards.values()) load(st);
}

function paint(st) {
  const q = (s) => st.el.querySelector(s);
  const services = st.data?.services || [];
  if (st.error && !st.data) return showText(st, st.error);
  if (!services.length) {
    q('.r1 .l').textContent = 'No services';
    q('.r1 .r').textContent = '';
    setCall(st, st.data?.message || 'Please check timetable for services.');
    q('.r3 .l').textContent = '';
    q('.r3 .r').textContent = '';
    return;
  }
  const first = services[0];
  q('.r1 .l').textContent = `${first.std} ${first.destination}`;
  q('.r1 .r').textContent = status(first);
  setCall(st, callText(first));
  paintNext(st);
}

function paintNext(st) {
  const services = st.data?.services || [];
  const q = (s) => st.el.querySelector(s);
  if (services.length < 2) {
    q('.r3 .l').textContent = '';
    q('.r3 .r').textContent = '';
    return;
  }
  if (st.next >= services.length || st.next < 1) st.next = 1;
  const s = services[st.next];
  q('.r3 .l').textContent = `${ordinal(st.next + 1)} ${s.std} ${s.destination}`;
  q('.r3 .r').textContent = status(s);
}

function showText(st, text) {
  const q = (s) => st.el.querySelector(s);
  q('.r1 .l').textContent = text;
  q('.r1 .r').textContent = '';
  setCall(st, '');
  q('.r3 .l').textContent = '';
  q('.r3 .r').textContent = '';
}

function setCall(st, text) {
  if (text === st.lastText && st.x !== null) return;   // keep scrolling smoothly across refreshes
  st.lastText = text;
  st.el.querySelector('.call span').textContent = text;
  st.x = null;                                         // restart from the right edge
}

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

/* ---------- Animation ---------- */

const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function tickClock() {
  const t = clockFmt.format(new Date());
  document.querySelectorAll('.clock').forEach((c) => (c.textContent = t));
}

function cycleNext() {
  for (const st of boards.values()) {
    if (!st.data?.services?.length) continue;
    st.next += 1;
    paintNext(st);
  }
}

let lastFrame = performance.now();
function scrollLoop(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  for (const st of boards.values()) {
    const box = st.el?.querySelector('.call');
    const span = box?.firstElementChild;
    if (!span || !span.textContent) continue;
    const em = parseFloat(getComputedStyle(box).fontSize) || 16;
    const boxW = box.clientWidth;
    if (st.x === null) st.x = boxW;
    st.x -= SCROLL_EM_PER_S * em * dt;
    if (st.x < -span.offsetWidth) st.x = boxW;
    span.style.transform = `translateX(${Math.round(st.x)}px)`;
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
