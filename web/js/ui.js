// ui.js - screens, menu, HUD, overlays and toasts. Only presentation: the
// numbers shown here are read from the C view by main.js.

import * as store from './storage.js';
import { TRACKS } from './audio.js';

export const MODE_INFO = {
  0: { name: 'Classic', icon: '🍎', desc: 'The original rules. Every fruit makes you a little faster.' },
  1: { name: 'Rewind', icon: '⏪', desc: 'Hold R to pull time back about five seconds. Three uses a run.' },
  2: { name: 'Perk cards', icon: '🃏', desc: 'Every 10 fruit, keep one of three cards. Some are cursed.' },
  3: { name: 'Weird boards', icon: '🌀', desc: 'Pick a board: torus, Möbius strip, portals or hex grid.' },
  4: { name: 'Rhythm', icon: '🥁', desc: 'You move on the music. Eat on the beat for a PERFECT bonus.' },
  5: { name: 'Darkness', icon: '🌑', desc: 'You only see near your head. Fruit glows through the dark.' },
  6: { name: 'Ice and conveyors', icon: '🧊', desc: 'Ice keeps you sliding. Conveyors push you along.' },
  7: { name: 'Daily seed', icon: '📅', desc: 'Same board for everyone today.' },
  8: { name: 'Two players', icon: '👥', desc: 'Green uses WASD, mint uses the arrow keys. One keyboard.' },
  9: { name: 'Custom level', icon: '🧱', desc: 'A level from the editor.' },
};
export const MENU_ORDER = [0, 1, 2, 3, 4, 5, 6, 8];

export const SHAPES = { 1: 'Torus', 2: 'Möbius', 3: 'Portals', 4: 'Hex grid' };

export const PERKS = [
  { icon: '👻', name: 'Ghost body', desc: 'Pass through yourself once.' },
  { icon: '🐌', name: 'Slow time', desc: 'The garden slows down for about 10 seconds.' },
  { icon: '🍒', name: 'Twin fruit', desc: 'Fruit spawns in pairs from now on.' },
  { icon: '🧲', name: 'Magnet', desc: 'Fruit drifts toward your head for a while.' },
  { icon: '✂️', name: 'Trim', desc: 'Drop four tail segments. Your score stays.' },
  { icon: '✨', name: 'Golden fruit', desc: 'Every fruit scores 1.5× points.' },
  { icon: '🚪', name: 'Edge door', desc: 'Slip through the outer wall twice.' },
  { icon: '🥀', name: 'Closing garden', desc: 'Cursed. ×3 score, but the walls creep inward.', cursed: true },
  { icon: '🔥', name: 'Fever', desc: 'Cursed. ×2 score, but you stay at top speed.', cursed: true },
];

const $ = (id) => document.getElementById(id);

export function modeLabel(mode, shape) {
  if (mode === 3) return `${SHAPES[shape] || 'Weird'} board`;
  return MODE_INFO[mode] ? MODE_INFO[mode].name : 'Snake';
}

export function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === `screen-${screen}`));
  document.body.dataset.screen = screen;
}

let toastTimer = 0;
export function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const units = [[86400 * 30, 'month'], [86400 * 7, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [sec, name] of units) {
    if (s >= sec) {
      const n = Math.floor(s / sec);
      return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

// ---- menu -------------------------------------------------------------------
export function renderMenu(h) {
  const d = store.get();
  const list = $('mode-list');
  list.innerHTML = '';
  for (const id of MENU_ORDER) {
    const info = MODE_INFO[id];
    const row = document.createElement('div');
    row.className = 'mode';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.dataset.mode = id;
    let best = d.best[store.modeKey(id, 0)] || 0;
    if (id === 3) best = Math.max(0, ...Object.keys(SHAPES).map((s) => d.best[store.modeKey(3, Number(s))] || 0));
    row.innerHTML = `
      <span class="mode-icon" aria-hidden="true">${info.icon}</span>
      <span class="mode-name">${info.name}</span>
      <span class="mode-desc">${info.desc}</span>
      <span class="mode-best">${best ? `best<b>${best}</b>` : ''}</span>`;
    const opts = document.createElement('div');
    opts.className = 'mode-opts';
    if (id === 3) {
      for (const [s, name] of Object.entries(SHAPES)) {
        opts.append(chip(name, () => h.play(3, Number(s))));
      }
    } else if (id === 4) {
      TRACKS.forEach((t, i) => opts.append(chip(`${t.name} (${t.bpm} bpm)`, () => h.play(4, 0, { track: i }))));
    }
    const ghostKeys = id === 3 ? Object.keys(SHAPES).map((s) => store.modeKey(3, Number(s))) : [store.modeKey(id, 0)];
    if (id !== 8) {
      for (const k of ghostKeys) {
        const g = d.ghosts[k];
        if (g) opts.append(chip(`Race your best${id === 3 ? ` (${SHAPES[k.split('-')[1]]})` : ''}: ${g.score}`, () => h.raceGhost(g.replay), 'chip chip-ghost'));
      }
    }
    if (opts.childElementCount) row.append(opts);
    const activate = (e) => {
      if (e.target.closest('.chip')) return;
      if (id === 3) h.play(3, Number(d.lastSettings && d.lastSettings.mode === 3 ? d.lastSettings.shape : 1));
      else if (id === 4) h.play(4, 0, { track: (d.lastSettings && d.lastSettings.track) || 0 });
      else h.play(id, 0);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); } });
    list.append(row);
  }

  // welcome back banner
  const wb = $('welcome');
  if (d.last) {
    wb.hidden = false;
    wb.innerHTML = '';
    const p = document.createElement('span');
    p.textContent = `Welcome back${d.nickname ? `, ${d.nickname}` : ''}! Last time: ${modeLabel(d.last.mode, d.last.shape)}${d.last.mode === 3 ? '' : ' mode'}, score ${d.last.score}, ${ago(d.last.at)}.`;
    wb.append(p);
  } else {
    wb.hidden = true;
  }
  $('continue-last').hidden = !d.lastSettings;

  // stats
  const t = d.totals;
  const bestAll = Math.max(0, ...Object.values(d.best));
  $('stats').innerHTML = `
    <div class="stat"><b>${bestAll}</b><span>best score</span></div>
    <div class="stat"><b>${t.games}</b><span>games</span></div>
    <div class="stat"><b>${t.longest}</b><span>longest snake</span></div>
    <div class="stat"><b>🍎 ${t.fruit[0]}</b><span>apples</span></div>
    <div class="stat"><b>🍌 ${t.fruit[1]}</b><span>bananas</span></div>
    <div class="stat"><b>🍇 ${t.fruit[2]}</b><span>grapes</span></div>`;
  $('nick-edit').textContent = d.nickname || 'a nameless snake';
}

function chip(text, fn, cls = 'chip') {
  const b = document.createElement('button');
  b.className = cls;
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

// ---- HUD --------------------------------------------------------------------
export function renderHUD(v, V, g) {
  const players = v[V.PLAYERS];
  const best = g.best;
  let html = '';
  if (players === 2) {
    html = `<div class="hud-score p1"><b>${v[V.SCORE0]}</b><span>green</span></div>
            <div class="hud-score p2"><b>${v[V.SCORE1]}</b><span>mint</span></div>`;
  } else {
    html = `<div class="hud-score p1"><b>${v[V.SCORE0]}</b><span>score</span></div>
            <div class="hud-score"><b>${Math.max(best, v[V.SCORE0])}</b><span>best</span></div>
            <div class="hud-score"><b>${v[V.LEN0]}</b><span>length</span></div>`;
  }
  const scores = $('hud-scores');
  if (scores.innerHTML !== html) scores.innerHTML = html;

  const chips = [];
  if (v[V.MODE] === 1) {
    for (let i = 0; i < 3; i++) chips.push(`<span class="hchip gold ${i < v[V.REWINDS] ? '' : 'used'}">⏪</span>`);
  }
  if (v[V.PASS_SELF]) chips.push(`<span class="hchip">👻 ×${v[V.PASS_SELF]}</span>`);
  if (v[V.WALLPASS]) chips.push(`<span class="hchip">🚪 ×${v[V.WALLPASS]}</span>`);
  if (v[V.SLOW]) chips.push(`<span class="hchip">🐌 ${v[V.SLOW]}</span>`);
  if (v[V.MAGNET]) chips.push(`<span class="hchip">🧲 ${v[V.MAGNET]}</span>`);
  if (v[V.TWIN]) chips.push('<span class="hchip">🍒</span>');
  if (v[V.CLOSING]) chips.push('<span class="hchip warn">🥀 closing</span>');
  if (v[V.FEVER]) chips.push('<span class="hchip warn">🔥 fever</span>');
  if (v[V.MULT] !== 100) chips.push(`<span class="hchip gold">×${(v[V.MULT] / 100).toFixed(v[V.MULT] % 100 ? 1 : 0)}</span>`);
  if (v[V.MODE] === 4 && v[V.BEAT_STREAK] > 1) chips.push(`<span class="hchip gold">🎵 ${v[V.BEAT_STREAK]} in a row</span>`);
  if (g.ghostOn) chips.push('<span class="hchip">👤 ghost</span>');
  if (g.practice) chips.push('<span class="hchip">practice</span>');
  const ch = chips.join('');
  const el = $('hud-chips');
  if (el.innerHTML !== ch) el.innerHTML = ch;

  const combo = $('combo');
  if (v[V.COMBO] >= 2 && g.comboVisible) {
    combo.textContent = `combo ×${v[V.COMBO]}`;
    combo.classList.add('show');
  } else {
    combo.classList.remove('show');
  }
}

// ---- overlays -----------------------------------------------------------------
export function hideOverlays() {
  ['ov-hint', 'ov-perks', 'ov-rewind', 'ov-pause', 'ov-over'].forEach((id) => { $(id).hidden = true; });
}

export function showHint(text) {
  $('hint-text').textContent = text;
  $('ov-hint').hidden = false;
}

export function showPerks(ids, onPick) {
  const cards = $('cards');
  cards.innerHTML = '';
  ids.forEach((id, i) => {
    const p = PERKS[id] || PERKS[0];
    const b = document.createElement('button');
    b.className = `card${p.cursed ? ' cursed' : ''}`;
    b.innerHTML = `<span class="card-key">${i + 1}</span><span class="card-icon">${p.icon}</span>
      <span class="card-name">${p.name}</span><span class="card-desc">${p.desc}</span>`;
    b.addEventListener('click', () => onPick(i));
    cards.append(b);
  });
  $('ov-perks').hidden = false;
  setTimeout(() => cards.firstElementChild && cards.firstElementChild.focus({ preventScroll: true }), 50);
}
