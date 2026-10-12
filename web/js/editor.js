// editor.js - paint walls, ice, conveyors and portals, set the start, then
// play or share the level as a compressed base64 URL hash. The C core
// validates every level before it can be played.

import { createRenderer } from './render.js';
import * as online from './online.js';

const W = 30, H = 20;
const TOOLS = [
  { id: 'wall', label: 'Wall', tile: 1, swatch: 'var(--fern-2)' },
  { id: 'ice', label: 'Ice', tile: 2, swatch: 'rgba(159,216,230,.6)' },
  { id: 'up', label: 'Conveyor', tile: 3, icon: '↑' },
  { id: 'right', label: 'Conveyor', tile: 4, icon: '→' },
  { id: 'down', label: 'Conveyor', tile: 5, icon: '↓' },
  { id: 'left', label: 'Conveyor', tile: 6, icon: '←' },
  { id: 'portal', label: 'Portal pair', swatch: '#C59BFF' },
  { id: 'start', label: 'Start', icon: '🐍' },
  { id: 'erase', label: 'Eraser', tile: 0, icon: '⌫' },
];

// tiny run-length encoding: (count, value) pairs
function rle(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let n = 1;
    while (i + n < bytes.length && bytes[i + n] === bytes[i] && n < 255) n++;
    out.push(n, bytes[i]);
    i += n;
  }
  return out;
}
function unrle(arr, size) {
  const out = new Uint8Array(size);
  let k = 0;
  for (let i = 0; i + 1 < arr.length && k < size; i += 2) for (let j = 0; j < arr[i] && k < size; j++) out[k++] = arr[i + 1];
  return k === size ? out : null;
}

export function initEditor({ core, store, ui, onPlay, onBack }) {
  const $ = (id) => document.getElementById(id);
  const canvas = $('ed-canvas');
  const r = createRenderer(canvas, { fit: canvas.parentElement });
  let tiles = new Uint8Array(W * H);
  let start = { x: 15, y: 10, dir: 1 };
  let shape = 0;
  let tool = 'wall';
  let pendingPortal = -1;
  let painting = false;
  let running = false;

  // toolbar
  const bar = $('ed-tools');
  TOOLS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'tool';
    b.type = 'button';
    b.dataset.tool = t.id;
    b.setAttribute('aria-pressed', String(t.id === tool));
    b.innerHTML = `<i style="${t.swatch ? `background:${t.swatch}` : ''}">${t.icon || ''}</i>${t.label}`;
    b.onclick = () => {
      tool = t.id;
      bar.querySelectorAll('.tool').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tool === tool)));
      status(t.id === 'portal' ? 'Click two cells to link a portal pair. Click a portal to remove its pair.'
        : t.id === 'start' ? 'Click to place the snake. Click the head again to turn it.' : '');
    };
    bar.append(b);
  });

  function status(msg) { if (msg) $('ed-status').textContent = msg; }

  function startCells() {
    const back = [[0, 1], [-1, 0], [0, -1], [1, 0]][start.dir];
    const cells = [];
    let x = start.x, y = start.y;
    cells.push(y * W + x);
    for (let i = 1; i < 3; i++) {
      const nx = x + back[0], ny = y + back[1];
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && tiles[ny * W + nx] === 0) { x = nx; y = ny; }
      cells.push(y * W + x);
    }
    return cells;
  }

  function usedPairs() {
    const used = new Set();
    tiles.forEach((t) => { if (t >= 8 && t <= 11) used.add(t - 8); });
    return used;
  }

  function removePair(t) {
    for (let i = 0; i < tiles.length; i++) if (tiles[i] === t) tiles[i] = 0;
    if (pendingPortal >= 0 && tiles[pendingPortal] === 0) pendingPortal = -1;
  }

  function apply(cell, first) {
    if (cell < 0) return;
    const x = cell % W, y = (cell / W) | 0;
    const isStart = x === start.x && y === start.y;
    const t = TOOLS.find((k) => k.id === tool);
    if (tool === 'start') {
      if (!first) return;
      if (isStart) start.dir = (start.dir + 1) % 4;
      else if (tiles[cell] === 0) start = { x, y, dir: start.dir };
      else status('The start needs empty floor.');
      return;
    }
    if (tool === 'portal') {
      if (!first) return;
      const cur = tiles[cell];
      if (cur >= 8 && cur <= 11) { removePair(cur); status('Portal pair removed.'); return; }
      if (isStart) return;
      if (pendingPortal >= 0) {
        tiles[cell] = tiles[pendingPortal];
        pendingPortal = -1;
        status('Portal pair linked.');
      } else {
        const used = usedPairs();
        const free = [0, 1, 2, 3].find((p) => !used.has(p));
        if (free === undefined) { status('Four portal pairs is the limit.'); return; }
        tiles[cell] = 8 + free;
        pendingPortal = cell;
        status('Now click where this portal leads.');
      }
      return;
    }
    if (isStart && t.tile !== 0) return;
    const cur = tiles[cell];
    if (cur >= 8 && cur <= 11) removePair(cur);
    tiles[cell] = t.tile;
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    painting = true;
    apply(r.cellAt(e.clientX, e.clientY), true);
  });
  canvas.addEventListener('pointermove', (e) => { if (painting) apply(r.cellAt(e.clientX, e.clientY), false); });
  const stop = () => { painting = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  $('ed-shape').onchange = (e) => { shape = Number(e.target.value); };

  function bytes() {
    const out = new Uint8Array(9 + W * H);
    out.set([83, 76, 1, shape, W, H, start.x, start.y, start.dir]);
    out.set(tiles, 9);
    return out;
  }

  function encode() {
    const b = bytes();
    return store.b64encode(new Uint8Array([...b.slice(0, 9), ...rle(b.slice(9))]));
  }

  function decode(str) {
    const raw = store.b64decode(str);
    if (raw.length < 9 || raw[0] !== 83 || raw[1] !== 76 || raw[2] !== 1 || raw[4] !== W || raw[5] !== H) return false;
    const t = unrle(Array.from(raw.slice(9)), W * H);
    if (!t || raw[3] > 2) return false;
    tiles = t;
    shape = raw[3];
    start = { x: raw[6], y: raw[7], dir: raw[8] % 4 };
    $('ed-shape').value = String(shape);
    pendingPortal = -1;
    return true;
  }

  function check() {
    if (pendingPortal >= 0) { status('One portal has no partner yet. Place its exit or remove it.'); return null; }
    const b = bytes();
    core.sel(0);
    if (!core.loadLevel(b)) { status('This level is not valid. The start must sit on empty floor.'); return null; }
    return b;
  }

  $('ed-play').onclick = () => { const b = check(); if (b) { running = false; onPlay(b); } };
  $('ed-share').onclick = async () => {
    if (!check()) return;
    const name = $('ed-name').value.trim();
    const url = `${location.origin}${location.pathname}#level=${encode()}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
    try { await navigator.clipboard.writeText(url); ui.toast('Level link copied.'); } catch { window.prompt('Copy this link:', url); }
  };
  $('ed-clear').onclick = () => { tiles = new Uint8Array(W * H); pendingPortal = -1; status('Board cleared.'); };
  $('ed-back').onclick = () => { running = false; onBack(); };
  $('ed-publish').onclick = async () => {
    if (!check()) return;
    const res = await online.publishLevel({ nickname: store.get().nickname || 'anon', name: $('ed-name').value.trim() || 'Untitled garden', data: encode() });
    ui.toast(res && res.ok ? 'Published to community levels.' : 'Publishing failed. Try again later.');
  };

  function loop(ms) {
    if (!running) return;
    r.draw({ time: ms / 1000, alpha: 1, tiles, foods: [], snakes: [{ cells: startCells(), prev: null, dir: start.dir }], ghost: null, darkness: null });
    requestAnimationFrame(loop);
  }

  function open() {
    r.setBoard(W, H, 0);
    r.resize();
    if (!running) { running = true; requestAnimationFrame(loop); }
  }

  async function openCommunity() {
    const list = $('cm-list');
    list.innerHTML = '<li>Loading levels…</li>';
    const levels = await online.listLevels();
    list.innerHTML = '';
    if (!levels.length) { list.innerHTML = '<li>No levels yet. Make one in the editor and publish it.</li>'; return; }
    for (const lv of levels) {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'grow';
      const name = document.createElement('b');
      name.textContent = lv.name;
      const by = document.createElement('small');
      by.textContent = ` by ${lv.nickname}, ${lv.likes} like${lv.likes === 1 ? '' : 's'}`;
      info.append(name, by);
      const play = document.createElement('button');
      play.className = 'btn btn-primary';
      play.textContent = 'Play';
      play.onclick = () => { if (decode(lv.data)) { const b = check(); if (b) onPlay(b); } };
      const like = document.createElement('button');
      like.className = 'btn';
      like.textContent = 'Like';
      like.onclick = async () => { const res = await online.likeLevel(lv.id, store.get().nickname || 'anon'); ui.toast(res && res.ok ? 'Liked.' : 'Already liked.'); };
      li.append(info, play, like);
      list.append(li);
    }
  }

  return {
    open,
    resize: () => { if (running) r.resize(); },
    openCommunity,
    loadShared(str) {
      const params = new URLSearchParams(location.hash.slice(1));
      let ok = false;
      try { ok = decode(str); } catch { ok = false; }
      if (params.get('name')) $('ed-name').value = params.get('name');
      open();
      if (ok) status('Shared level loaded. Press Play level to try it.');
      return ok;
    },
  };
}
