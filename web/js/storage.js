// storage.js - remembers the player in localStorage. Every access is wrapped
// in try/catch so private windows or blocked storage never break the game.

const KEY = 'nightGardenSnake.v1';

const DEFAULTS = () => ({
  nickname: '',
  muted: false,
  volume: 70,
  theme: 'night',
  controls: 'both',
  showGhost: true,
  last: null,            // { mode, shape, score, length, at }
  lastSettings: null,    // { mode, shape, track }
  best: {},              // modeKey -> score
  totals: { games: 0, fruit: [0, 0, 0], longest: 0 },
  ghosts: {},            // modeKey -> { replay (base64url), score }
  daily: { lastDay: 0, lastScore: 0, streak: 0, lastResult: '' },
});

let data = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS();
    const parsed = JSON.parse(raw);
    const d = DEFAULTS();
    return { ...d, ...parsed, totals: { ...d.totals, ...(parsed.totals || {}) }, daily: { ...d.daily, ...(parsed.daily || {}) } };
  } catch {
    return DEFAULTS();
  }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

export function get() { return data; }

export function update(fn) {
  fn(data);
  save();
}

export function reset() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  data = DEFAULTS();
}

export function modeKey(mode, shape) {
  return mode === 3 ? `3-${shape}` : String(mode);
}

// base64url for replays and levels in share links
export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64decode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
