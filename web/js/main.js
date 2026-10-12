// main.js - boots the C core (WebAssembly), runs the game loop and connects
// input, rendering, audio, storage and UI. All rules live in C: this file
// only forwards inputs, asks the core to step, and reads the view.

import * as store from './storage.js';
import * as audio from './audio.js';
import * as input from './input.js';
import * as ui from './ui.js';
import * as online from './online.js';
import * as portal from './portal.js';
import { createRenderer, startAmbient } from './render.js';
import { initEditor } from './editor.js';

// ---- mirror of the view layout in core/snake_core.h --------------------------
export const V = {
  API: 0, W: 1, H: 2, SHAPE: 3, MODE: 4, TICK: 5, STATUS: 6, DELAY: 7,
  SCORE0: 8, SCORE1: 9, LEN0: 10, LEN1: 11, ALIVE0: 12, ALIVE1: 13, DIR0: 14, DIR1: 15,
  FRUITS: 16, COMBO: 17, MULT: 18, REWINDS: 19, RW_FILL: 20, REWINDING: 21,
  PERK0: 22, PERK1: 23, PERK2: 24, PASS_SELF: 25, SLOW: 26, MAGNET: 27, TWIN: 28,
  CLOSING: 29, WALLPASS: 30, FEVER: 31, FOOD_N: 32, FOOD: 33,
  EAT_TYPE: 45, EAT_CELL: 46, EAT_PTS: 47, EAT_PLAYER: 48, EVENTS: 49, WINNER: 50,
  LIGHT: 51, PLAYERS: 52, SEED: 53, DEATH_CELL: 54, SHRINK: 55, BEAT_STREAK: 56,
  WON: 57, REC_OK: 58, REPLAYING: 59, FLAGS: 60,
  HEADER: 64, MAX_CELLS: 32 * 24, MAX_FOOD: 4,
};
V.SNAKE0 = V.HEADER;
V.SNAKE1 = V.SNAKE0 + V.MAX_CELLS;
V.TILES = V.SNAKE1 + V.MAX_CELLS;
V.SIZE = V.TILES + V.MAX_CELLS;

export const EV = {
  MOVED: 0x1, ATE: 0x2, DIED: 0x4, PERK_READY: 0x8, BEAT_HIT: 0x10, PORTAL: 0x20, WON: 0x40,
  PASSED_SELF: 0x80, WRAPPED: 0x100, WALLS_CLOSED: 0x200, ICE: 0x400, CONVEYOR: 0x800,
  COMBO: 0x1000, GAME_OVER: 0x2000, REWOUND: 0x4000, FOOD_MOVED: 0x8000,
};
const ST = { RUNNING: 0, PERK: 1, OVER: 2 };
const M = { CLASSIC: 0, REWIND: 1, PERKS: 2, WEIRD: 3, RHYTHM: 4, DARKNESS: 5, ICE: 6, DAILY: 7, VERSUS: 8, CUSTOM: 9 };
const REWIND_MS = 45;

const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEBUG = new URLSearchParams(location.search).has('debug');
// ?debug drives the loop with a timer so automated tests also run in hidden tabs
const nextFrame = DEBUG ? (cb) => setTimeout(() => cb(performance.now()), 16) : (cb) => requestAnimationFrame(cb);

// ---- C core wrapper -------------------------------------------------------------
let core = null;

function makeCore(m) {
  const size = m._game_view_size();
  if (size !== V.SIZE) console.warn('View size mismatch between C and JS', size, V.SIZE);
  const io = () => m._game_io_ptr();
  return {
    version: () => m._game_api_version(),
    sel: (s) => m._game_select(s),
    view: () => new Int32Array(m.HEAP32.buffer, m._game_state_ptr(), size),
    newGame: (mode, shape, seed, flags = 0) => m._game_new(mode, shape, seed | 0, flags),
    input: (p, d) => m._game_input(p, d),
    beat: () => m._game_beat(),
    step: () => m._game_step(),
    rewindBegin: () => m._game_rewind_begin(),
    rewind: (n) => m._game_rewind(n),
    rewindEnd: () => m._game_rewind_end(),
    // older wasm builds lack this export; the rewarded rewind is then not offered
    grantRewind: typeof m._game_grant_rewind === 'function' ? () => m._game_grant_rewind() : null,
    choose: (i) => m._game_choose_perk(i),
    exportReplay() {
      const n = m._game_export_replay();
      return n ? m.HEAPU8.slice(io(), io() + n) : null;
    },
    loadReplay(bytes) {
      if (!bytes || bytes.length > 32768) return 0;
      m.HEAPU8.set(bytes, io());
      return m._game_load_replay(bytes.length);
    },
    replayAdvance: () => m._game_replay_advance(),
    loadLevel(bytes) {
      m.HEAPU8.set(bytes, io());
      return m._game_load_level(io(), bytes.length);
    },
    dailySeed: (y, mo, d) => m._game_daily_seed(y, mo, d),
    dailyNumber: (y, mo, d) => m._game_daily_number(y, mo, d),
  };
}

const readCells = (v, p) => Array.from(v.subarray(p ? V.SNAKE1 : V.SNAKE0, (p ? V.SNAKE1 : V.SNAKE0) + v[V.LEN0 + p]));
const readTiles = (v) => v.slice(V.TILES, V.TILES + v[V.W] * v[V.H]);
function readFoods(v) {
  const out = [];
  for (let i = 0; i < v[V.FOOD_N]; i++) out.push({ cell: v[V.FOOD + i * 2], type: v[V.FOOD + i * 2 + 1] });
  return out;
}

// ---- state -----------------------------------------------------------------------
let G = null;            // the current run
let renderer = null;
let ambient = null;
let editor = null;
let lastFrame = 0;
let comboTimer = 0;
let friendGhost = null;

function replayHeader(bytes) {
  if (!bytes || bytes.length < 10 || bytes[0] !== 83 || bytes[1] !== 82) return null;
  return { mode: bytes[3], shape: bytes[4], seed: (bytes[6] | bytes[7] << 8 | bytes[8] << 16 | bytes[9] << 24) >>> 0 };
}

function utcToday() {
  const n = new Date();
  return [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()];
}

// ---- starting a run ------------------------------------------------------------
function startGame(o) {
  stopRun();
  const d = store.get();
  const seed = o.seed !== undefined ? o.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
  core.sel(0);
  if (o.mode === M.CUSTOM) {
    if (!o.level || !core.loadLevel(o.level)) { ui.toast('That level could not be loaded.'); return; }
  }
  core.newGame(o.mode, o.shape || 0, seed, 0);
  const v = core.view();
  const key = store.modeKey(o.mode, v[V.SHAPE]);
  G = {
    mode: o.mode, shape: v[V.SHAPE], seed, track: o.track || 0, level: o.level || null,
    daily: o.daily || 0, practice: !!o.practice, key,
    best: o.mode === M.VERSUS || o.mode === M.CUSTOM ? 0 : (d.best[key] || 0),
    state: 'ready', acc: 0, rwAcc: 0,
    cur: [readCells(v, 0), readCells(v, 1)], prev: [null, null], dirs: [v[V.DIR0], v[V.DIR1]],
    hidden: [false, false], tiles: readTiles(v), foods: readFoods(v),
    fruitsEaten: [], beatQueue: [], eighth: 0.25, lastStepTime: 0, rhythmFallback: false,
    ghost: null, ghostOn: false, ghostSource: o.ghost || null, comboVisible: false, players: v[V.PLAYERS],
  };
  if (o.ghost) {
    G.ghost = setupGhost(o.ghost);
    G.ghostOn = !!G.ghost;
  }
  renderer.fx.clear();
  renderer.setBoard(v[V.W], v[V.H], v[V.SHAPE]);
  input.configure({ hex: v[V.SHAPE] === 4, versus: o.mode === M.VERSUS, enabled: true, getDir: (p) => G ? G.dirs[p] : 0 });

  $('hud-mode').textContent = o.mode === M.DAILY ? `Daily #${G.daily}` : ui.modeLabel(o.mode, G.shape);
  configurePad();
  ui.hideOverlays();
  $('stage').classList.remove('is-rewinding');
  ui.show('game');
  ambient.stop();
  renderer.resize();
  const touch = document.body.classList.contains('has-touch');
  ui.showHint(o.mode === M.VERSUS ? 'Green: WASD. Mint: arrow keys. Press a direction to start'
    : touch ? 'Swipe or tap a direction to start' : 'Press an arrow key or WASD to start');
  store.update((s) => { s.lastSettings = { mode: o.mode, shape: G.shape, track: G.track }; });
}

function setupGhost(bytes) {
  core.sel(1);
  const ok = core.loadReplay(bytes);
  const gv = core.view();
  const gh = ok ? { cells: readCells(gv, 0), prev: null, acc: 0, done: false, fade: 1, dir: gv[V.DIR0] } : null;
  core.sel(0);
  return gh;
}

function stopRun() {
  portal.gameplay(false);
  audio.stopMusic();
  if (G && G.state === 'rewind') core.rewindEnd();
  G = null;
}

function configurePad() {
  const d = store.get();
  const pad = $('pad');
  pad.classList.toggle('show-buttons', d.controls !== 'swipe');
  $('dpad').hidden = G.shape === 4;
  $('hexpad').hidden = G.shape !== 4;
  $('pad-rewind').hidden = G.mode !== M.REWIND;
}

// ---- ticking ------------------------------------------------------------------------
function doStep() {
  const before = core.view();
  G.prev = [readCells(before, 0), readCells(before, 1)];
  const ev = core.step();
  afterTick(ev);
}

function refresh() {
  const v = core.view();
  G.cur = [readCells(v, 0), readCells(v, 1)];
  G.dirs = [v[V.DIR0], v[V.DIR1]];
  G.foods = readFoods(v);
  G.tiles = readTiles(v);
  return v;
}

function afterTick(ev) {
  const v = refresh();
  if (ev & EV.ATE) {
    const type = v[V.EAT_TYPE];
    G.fruitsEaten.push(type);
    renderer.fx.eat(v[V.EAT_CELL], type, `+${v[V.EAT_PTS]}`, !!(ev & EV.BEAT_HIT));
    audio.sfx.eat(type, v[V.COMBO]);
    if (ev & EV.BEAT_HIT) audio.sfx.perfect();
    G.comboVisible = true;
    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => { if (G) G.comboVisible = false; }, 1600);
  }
  if (ev & EV.PORTAL) audio.sfx.portal();
  if (ev & EV.WALLS_CLOSED) { audio.sfx.walls(); renderer.fx.shake(6); }
  if (ev & EV.PASSED_SELF) renderer.fx.popup(G.cur[0][0], 'phased', '#E9E6CF');
  if (ev & EV.DIED) {
    const dead = [];
    for (let p = 0; p < G.players; p++) {
      if (!v[V.ALIVE0 + p] && !G.hidden[p]) {
        dead.push({ cells: G.cur[p], style: p });
        G.hidden[p] = true;
      }
    }
    renderer.fx.die(dead);
    audio.sfx.die();
  }
  if (ev & EV.WON) audio.sfx.win();
  if (ev & EV.PERK_READY) {
    G.state = 'perk';
    portal.gameplay(false);
    audio.sfx.perk();
    ui.showPerks([v[V.PERK0], v[V.PERK1], v[V.PERK2]], pickPerk);
  }
  if (ev & EV.GAME_OVER) {
    const canRewind = G.mode === M.REWIND && !v[V.WON] && v[V.RW_FILL] > 0;
    if (canRewind && v[V.REWINDS] > 0) {
      offerRewind(v);
    } else if (canRewind && !G.bonusUsed && core.grantRewind && portal.hasRewarded()) {
      G.state = 'dead-bonus';
      portal.gameplay(false);
      $('ov-bonus').hidden = false;
      $('bonus-watch').focus({ preventScroll: true });
    } else {
      finish();
    }
  }
}

function offerRewind(v) {
  G.state = 'dead-rewind';
  portal.gameplay(false);
  $('rw-left').textContent = `${v[V.REWINDS]} rewind${v[V.REWINDS] > 1 ? 's' : ''} left.`;
  $('ov-rewind').hidden = false;
}

// Out of rewinds: a rewarded ad buys one more, once per run.
async function watchForRewind() {
  if (!G || G.state !== 'dead-bonus') return;
  const run = G;
  $('bonus-watch').disabled = true;
  const ok = await portal.rewarded();
  $('bonus-watch').disabled = false;
  if (G !== run || run.state !== 'dead-bonus') return;
  $('ov-bonus').hidden = true;
  if (ok && core.grantRewind()) {
    run.bonusUsed = true;
    offerRewind(core.view());
  } else {
    ui.toast('No ad was available, so the run ends here.');
    finish();
  }
}

function skipBonus() {
  if (!G || G.state !== 'dead-bonus') return;
  $('ov-bonus').hidden = true;
  finish();
}

function pickPerk(i) {
  if (!G || G.state !== 'perk') return;
  if (!core.choose(i)) return;
  audio.sfx.pick();
  $('ov-perks').hidden = true;
  refresh();
  G.prev = [null, null];
  G.state = 'ready';
  ui.showHint('Steer to continue');
}

// ---- rewind ------------------------------------------------------------------------------
function rewindKey(down) {
  if (!G || G.mode !== M.REWIND) return;
  if (down) {
    if (!['play', 'dead-rewind', 'ready'].includes(G.state)) return;
    const v = core.view();
    if (!core.rewindBegin()) {
      ui.toast(v[V.REWINDS] === 0 ? 'No rewinds left this run.' : 'Nothing to rewind yet.');
      return;
    }
    G.state = 'rewind';
    portal.gameplay(true);
    G.rwAcc = REWIND_MS;
    G.hidden = [false, false];
    ui.hideOverlays();
    $('stage').classList.add('is-rewinding');
    audio.sfx.rewind();
  } else if (G.state === 'rewind') {
    core.rewindEnd();
    $('stage').classList.remove('is-rewinding');
    refresh();
    G.prev = [null, null];
    G.state = 'ready';
    G.acc = 0;
    ui.showHint('Steer to continue');
  }
}

// ---- end of a run --------------------------------------------------------------------------
function finish() {
  const v = core.view();
  G.state = 'over';
  portal.gameplay(false);
  audio.stopMusic();
  const replay = core.exportReplay();
  const score = v[V.SCORE0];
  const len = Math.max(v[V.LEN0], v[V.LEN1]);
  const ghostable = G.mode !== M.VERSUS && G.mode !== M.CUSTOM;
  const counted = !G.practice && ghostable;
  const newBest = counted && score > G.best && score > 0;
  const run = G;
  let shareText = '';

  store.update((d) => {
    d.totals.games++;
    run.fruitsEaten.forEach((t) => { d.totals.fruit[t] = (d.totals.fruit[t] || 0) + 1; });
    d.totals.longest = Math.max(d.totals.longest, len);
    d.last = { mode: run.mode, shape: run.shape, score: run.mode === M.VERSUS ? Math.max(score, v[V.SCORE1]) : score, length: len, at: Date.now() };
    if (newBest) {
      d.best[run.key] = score;
      if (replay) d.ghosts[run.key] = { replay: store.b64encode(replay), score };
    }
    if (run.mode === M.DAILY) {
      shareText = dailyShareText(run, score, !!v[V.WON]);
      if (!run.practice) {
        d.daily.streak = d.daily.lastDay === run.daily - 1 ? d.daily.streak + 1 : 1;
        d.daily.lastDay = run.daily;
        d.daily.lastScore = score;
        d.daily.lastResult = shareText;
      }
    }
  });

  if (replay && online.isAvailable() && counted) {
    online.submitRun({ nickname: store.get().nickname || 'anon', replay: store.b64encode(replay), daily: run.mode === M.DAILY });
  }

  // overlay
  let title = 'Game over';
  if (v[V.WON]) title = 'The garden is full!';
  else if (run.mode === M.VERSUS) title = v[V.WINNER] === 0 ? 'Green wins' : v[V.WINNER] === 1 ? 'Mint wins' : 'Draw';
  else if (newBest) title = 'New best!';
  $('over-title').textContent = title;
  $('over-score').textContent = run.mode === M.VERSUS ? `${score} : ${v[V.SCORE1]}` : String(score);
  $('over-detail').textContent = run.mode === M.VERSUS
    ? (v[V.WINNER] === 0 ? 'Mint crashed.' : v[V.WINNER] === 1 ? 'Green crashed.' : 'Both crashed at once.')
    : `Length ${v[V.LEN0]}, ${v[V.FRUITS]} fruit${run.practice ? '. Practice run, not scored.' : '.'}`;
  $('over-share').hidden = !shareText;
  $('over-share').textContent = shareText;
  $('over-share-row').hidden = !shareText;
  $('over-native-share').hidden = !(shareText && navigator.share && portal.allowLinks);
  $('over-ghost').hidden = !(replay && ghostable);
  $('over-link').hidden = !(replay && ghostable && portal.allowLinks);
  run.lastReplay = replay;
  run.shareText = shareText;
  setTimeout(() => {
    if (G !== run) return;
    $('ov-rewind').hidden = true;
    $('ov-over').hidden = false;
    $('over-again').focus({ preventScroll: true });
    if (newBest || v[V.WON]) { renderer.fx.confetti(); portal.happy(); }
  }, 650);
}

function dailyShareText(run, score, won) {
  const icons = ['🍎', '🍌', '🍇'];
  const fruit = run.fruitsEaten.slice(0, 12).map((t) => icons[t]).join('');
  const more = run.fruitsEaten.length > 12 ? `+${run.fruitsEaten.length - 12}` : '';
  const bars = '🟩'.repeat(Math.min(5, Math.ceil(score / 50)));
  return `🐍 Snake Daily #${run.daily}\n${bars}${fruit}${more}${won ? '🏆' : '💀'}\nScore ${score}`;
}

async function copyText(text, done = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
    ui.toast(done);
  } catch {
    window.prompt('Copy this:', text);
  }
}

// ---- pause ---------------------------------------------------------------------------------
function pause() {
  if (!G) return;
  if (G.state === 'over') { toMenu(); return; }
  if (G.state === 'paused') { resume(); return; }
  if (['play', 'ready', 'rewind'].includes(G.state)) {
    if (G.state === 'rewind') rewindKey(false);
    G.state = 'paused';
    portal.gameplay(false);
    audio.stopMusic();
    G.beatQueue = [];
    G.musicOn = false;
    G.rhythmFallback = false;
    ui.hideOverlays();
    $('ov-pause').hidden = false;
    $('pause-resume').focus({ preventScroll: true });
  }
}

function resume() {
  if (!G || G.state !== 'paused') return;
  $('ov-pause').hidden = true;
  G.state = 'ready';
  G.prev = [null, null];
  ui.showHint('Steer to continue');
}

function toMenu() {
  const wasCustom = G && G.mode === M.CUSTOM;
  stopRun();
  ui.hideOverlays();
  if (wasCustom) { ui.show('editor'); editor.open(); }
  else openMenu();
}

function openMenu() {
  ui.renderMenu(menuHandlers);
  renderDaily();
  ui.show('menu');
  ambient.start();
}

// ---- input wiring ----------------------------------------------------------------------------
function onDir(p, d) {
  if (!G) return;
  if (G.state === 'ready') {
    core.input(p, d);
    G.state = 'play';
    portal.gameplay(true);
    G.acc = 0;
    $('ov-hint').hidden = true;
    audio.ensure();
    if (G.mode === M.RHYTHM && !G.musicOn) startRhythm();
    return;
  }
  if (G.state === 'play') core.input(p, d);
}

function startRhythm() {
  G.beatQueue = [];
  const run = G;
  const info = audio.startMusic(G.track, (time, beat) => { if (G === run) run.beatQueue.push({ time, beat }); });
  G.eighth = 60 / audio.TRACKS[G.track].bpm / 2;
  G.stepCount = 0;
  G.musicOn = true;
  // no Web Audio at all: keep the same beat with a timer
  if (!info) { G.rhythmFallback = true; return; }
  G.audioT0 = audio.now();
  G.musicStartedAt = performance.now();
  G.lastStepTime = audio.now();
}

// ---- main loop -----------------------------------------------------------------------------------
function frame(ms) {
  const dtms = Math.min(100, lastFrame ? ms - lastFrame : 16);
  lastFrame = ms;
  if (G && document.body.dataset.screen === 'game') {
    core.sel(0);
    let alpha = 1;
    let v = core.view();
    if (G.state === 'play') {
      if (G.mode === M.RHYTHM && !G.rhythmFallback) {
        if (!G.musicOn) startRhythm();
        const now = audio.now();
        if (now === G.audioT0 && performance.now() - G.musicStartedAt > 400) {
          // the audio clock is not running (autoplay blocked): fall back to a timer
          audio.stopMusic();
          G.rhythmFallback = true;
          G.beatQueue = [];
        }
        while (G && G.beatQueue.length && G.beatQueue[0].time <= now) {
          const b = G.beatQueue.shift();
          if (G.state !== 'play') continue;
          if (b.beat) {
            core.beat();
            const st = $('stage');
            st.classList.add('beat');
            setTimeout(() => st.classList.remove('beat'), 90);
          }
          doStep();
          G.lastStepTime = b.time;
        }
        if (G) alpha = Math.min(1, Math.max(0, (now - G.lastStepTime) / G.eighth));
      } else if (G.mode === M.RHYTHM) {
        if (!G.musicOn) startRhythm();
        G.acc += dtms;
        const delay = G.eighth * 1000;
        while (G.state === 'play' && G.acc >= delay) {
          G.acc -= delay;
          if (G.stepCount++ % 2 === 0) core.beat();
          doStep();
        }
        alpha = G.state === 'play' ? Math.min(1, G.acc / delay) : 1;
      } else {
        G.acc += dtms;
        let delay = v[V.DELAY];
        while (G.state === 'play' && G.acc >= delay) {
          G.acc -= delay;
          doStep();
          v = core.view();
          delay = v[V.DELAY];
        }
        alpha = G.state === 'play' ? Math.min(1, G.acc / delay) : 1;
      }
      if (G.ghost) tickGhost(dtms);
    } else if (G.state === 'rewind') {
      G.rwAcc += dtms;
      while (G.state === 'rewind' && G.rwAcc >= REWIND_MS) {
        G.rwAcc -= REWIND_MS;
        if (core.rewind(1) === 0) { rewindKey(false); break; }
        refresh();
        G.prev = [null, null];
        if (Math.random() < 0.5) audio.sfx.rewindTick();
      }
    }
    if (G) draw(ms / 1000, alpha);
  }
  nextFrame(frame);
}

function tickGhost(dtms) {
  const gh = G.ghost;
  if (gh.done) { gh.fade = Math.max(0, gh.fade - dtms / 1200); return; }
  gh.acc += dtms;
  core.sel(1);
  let gv = core.view();
  const stepMs = () => (G.mode === M.RHYTHM ? G.eighth * 1000 : gv[V.DELAY]);
  let delay = gh.lastRewound ? REWIND_MS : stepMs();
  while (!gh.done && gh.acc >= delay) {
    gh.acc -= delay;
    gh.prev = gh.cells;
    const ev = core.replayAdvance();
    gv = core.view();
    gh.cells = readCells(gv, 0);
    gh.dir = gv[V.DIR0];
    gh.lastRewound = ev === EV.REWOUND;
    if (gh.lastRewound) gh.prev = null;
    if (ev === -1 || gv[V.STATUS] === ST.OVER) gh.done = true;
    delay = gh.lastRewound ? REWIND_MS : stepMs();
  }
  gh.alpha = Math.min(1, gh.acc / delay);
  core.sel(0);
}

function draw(t, alpha) {
  const v = core.view();
  const snakes = [];
  for (let p = 0; p < G.players; p++) {
    snakes.push({ cells: G.cur[p], prev: G.prev[p], dir: G.dirs[p], hidden: G.hidden[p], pass: p === 0 && v[V.PASS_SELF] > 0 });
  }
  const gh = G.ghost;
  renderer.draw({
    time: t,
    alpha: G.state === 'play' ? alpha : 1,
    tiles: G.tiles,
    foods: G.foods,
    snakes,
    ghost: gh && gh.fade > 0 && gh.cells.length ? { cells: gh.cells, prev: gh.prev, alpha: gh.done ? 1 : gh.alpha || 0, dir: gh.dir } : null,
    darkness: G.mode === M.DARKNESS ? { head: G.cur[0].length ? G.cur[0][0] : -1, radius: v[V.LIGHT] + 0.5 } : null,
  });
  ui.renderHUD(v, V, G);
}

// ---- daily card --------------------------------------------------------------------------------
function renderDaily() {
  const [y, mo, d] = utcToday();
  const n = core.dailyNumber(y, mo, d);
  const dd = store.get().daily;
  $('daily-number').textContent = `#${n}`;
  const played = dd.lastDay === n;
  $('daily-text').textContent = played
    ? `You scored ${dd.lastScore} today. A new board arrives at midnight UTC.`
    : 'Everyone gets the same board today. Your first run counts.';
  $('daily-play').textContent = played ? 'Practice today’s board' : 'Play today’s board';
  $('daily-copy').hidden = !(played && dd.lastResult);
  const streakOk = dd.lastDay >= n - 1 && dd.streak > 0;
  $('daily-streak').textContent = streakOk ? `Streak: ${dd.streak} day${dd.streak > 1 ? 's' : ''}` : '';
  if (online.isAvailable()) {
    online.dailyTop(n).then((top) => {
      const box = $('daily-top');
      if (!top || !top.replay) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = `Top run today: ${top.nickname}, ${top.score} points.`;
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Race the top run';
      b.onclick = () => raceGhost(top.replay);
      box.append(p, b);
    });
  }
}

function playDaily() {
  const [y, mo, d] = utcToday();
  const n = core.dailyNumber(y, mo, d);
  const seed = core.dailySeed(y, mo, d) >>> 0;
  startGame({ mode: M.DAILY, seed, daily: n, practice: store.get().daily.lastDay === n });
}

function raceGhost(b64) {
  let bytes;
  try { bytes = typeof b64 === 'string' ? store.b64decode(b64) : b64; } catch { ui.toast('That ghost link is damaged.'); return; }
  const h = replayHeader(bytes);
  if (!h) { ui.toast('That ghost link is damaged.'); return; }
  const o = { mode: h.mode, shape: h.shape, seed: h.seed, ghost: bytes };
  if (h.mode === M.DAILY) {
    const [y, mo, d] = utcToday();
    o.daily = core.dailyNumber(y, mo, d);
    o.practice = true;   // racing a ghost is never the scored daily attempt
  }
  startGame(o);
}

const menuHandlers = {
  play: (mode, shape, opts = {}) => startGame({ mode, shape, ...opts }),
  raceGhost,
};

// ---- links: #ghost=... and #level=... ---------------------------------------------------------
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has('ghost')) {
    try {
      const bytes = store.b64decode(h.get('ghost'));
      const hd = replayHeader(bytes);
      core.sel(2);
      if (hd && core.loadReplay(bytes)) {
        let guard = 0;
        while (core.replayAdvance() !== -1 && guard++ < 200000) { /* re-simulate in C */ }
        const score = core.view()[V.SCORE0];
        friendGhost = { bytes, score, mode: hd.mode, shape: hd.shape };
      }
    } catch { friendGhost = null; }
    core.sel(0);
    const box = $('friend-ghost');
    if (friendGhost) {
      box.hidden = false;
      box.innerHTML = '';
      const p = document.createElement('span');
      p.textContent = `A friend shared a run: ${ui.modeLabel(friendGhost.mode, friendGhost.shape)}, ${friendGhost.score} points.`;
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = 'Race it';
      b.onclick = () => raceGhost(friendGhost.bytes);
      box.append(p, b);
    } else {
      ui.toast('That ghost link is damaged.');
    }
  }
  if (h.has('level')) {
    ui.show('editor');
    ambient.stop();
    if (!editor.loadShared(h.get('level'))) ui.toast('That level link is damaged.');
    return true;
  }
  return false;
}

// ---- settings ------------------------------------------------------------------------------------
function applySettings() {
  const d = store.get();
  document.documentElement.dataset.theme = d.theme === 'dawn' ? 'dawn' : 'night';
  document.querySelector('meta[name="theme-color"]').content = d.theme === 'dawn' ? '#E7EEDF' : '#0E1A20';
  audio.setMuted(d.muted);
  audio.setVolume(d.volume / 100);
  $('btn-mute').innerHTML = d.muted
    ? '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  $('btn-mute').setAttribute('aria-label', d.muted ? 'Unmute sound' : 'Mute sound');
  if (renderer) renderer.readTheme();
  if (G) configurePad();
}

function toggleMute() {
  store.update((d) => { d.muted = !d.muted; });
  applySettings();
  ui.toast(store.get().muted ? 'Sound off' : 'Sound on');
}

function wireSettings() {
  const dlg = $('dlg-settings');
  $('open-settings').onclick = () => {
    const d = store.get();
    $('set-nick').value = d.nickname;
    $('set-volume').value = d.volume;
    $('set-mute').checked = d.muted;
    $('set-theme').value = d.theme;
    $('set-controls').value = d.controls;
    dlg.showModal();
  };
  $('set-nick').oninput = (e) => store.update((d) => { d.nickname = e.target.value.trim().slice(0, 16); });
  $('set-volume').oninput = (e) => { store.update((d) => { d.volume = Number(e.target.value); }); applySettings(); audio.sfx.eat(0); };
  $('set-mute').onchange = (e) => { store.update((d) => { d.muted = e.target.checked; }); applySettings(); };
  $('set-theme').onchange = (e) => { store.update((d) => { d.theme = e.target.value; }); applySettings(); };
  $('set-controls').onchange = (e) => store.update((d) => { d.controls = e.target.value; });
  $('set-reset').onclick = () => {
    if (!window.confirm('Delete all scores, ghosts, streaks and settings on this device?')) return;
    store.reset();
    applySettings();
    dlg.close();
    openMenu();
    ui.toast('Your data was reset.');
  };
  dlg.addEventListener('close', () => { if (document.body.dataset.screen === 'menu') ui.renderMenu(menuHandlers); });
  $('open-help').onclick = () => $('dlg-help').showModal();
  $('nick-edit').onclick = $('open-settings').onclick;
}

// ---- boot ----------------------------------------------------------------------------------------------
async function boot() {
  if (typeof window.createSnake !== 'function') throw new Error('snake.js did not load');
  const portalReady = portal.init();   // loads the portal SDK while the wasm loads
  const m = await window.createSnake();
  core = makeCore(m);

  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('has-touch');
  ambient = startAmbient($('ambient'), reduced);
  renderer = createRenderer($('board'), { reduced, fit: $('stage') });
  applySettings();
  wireSettings();
  editor = initEditor({
    core, store, ui,
    onPlay: (bytes) => startGame({ mode: M.CUSTOM, level: bytes }),
    onBack: () => openMenu(),
  });

  input.on({
    dir: onDir,
    pause,
    mute: toggleMute,
    rewind: rewindKey,
    perk: (i) => { if (G && G.state === 'perk') pickPerk(i); },
    confirm: () => {
      if (!G || document.body.dataset.screen !== 'game') return false;
      if (G.state === 'over') { $('over-again').click(); return true; }
      if (G.state === 'dead-rewind') { $('ov-rewind').hidden = true; finish(); return true; }
      if (G.state === 'dead-bonus') { skipBonus(); return true; }
      if (G.state === 'paused') { resume(); return true; }
      return false;
    },
  });
  input.attachSwipe($('stage'));
  input.attachPad($('pad'));
  input.attachHold($('pad-rewind'), 'rewind');
  input.attachHold($('rw-hold'), 'rewind');

  // buttons
  $('play-now').onclick = () => startGame({ mode: M.CLASSIC });
  $('daily-play').onclick = playDaily;
  $('daily-copy').onclick = () => copyText(store.get().daily.lastResult, 'Result copied.');
  $('continue-last').onclick = () => {
    const ls = store.get().lastSettings;
    if (ls) startGame(ls.mode === M.DAILY ? { mode: M.CLASSIC } : { mode: ls.mode, shape: ls.shape, track: ls.track });
  };
  $('open-editor').onclick = () => { ambient.stop(); ui.show('editor'); editor.open(); };
  $('open-community').onclick = () => { ui.show('community'); editor.openCommunity(); };
  $('cm-back').onclick = openMenu;
  $('btn-menu').onclick = toMenu;
  $('btn-pause').onclick = pause;
  $('btn-mute').onclick = toggleMute;
  $('pause-resume').onclick = resume;
  $('pause-restart').onclick = () => G && restart();
  $('pause-menu').onclick = toMenu;
  // interstitial ads only ever show between runs, on these two buttons
  $('over-menu').onclick = () => portal.breakThen(toMenu);
  $('over-again').onclick = () => G && portal.breakThen(() => G && restart());
  $('bonus-watch').onclick = watchForRewind;
  $('bonus-skip').onclick = skipBonus;
  $('over-ghost').onclick = () => G && G.lastReplay && raceGhost(G.lastReplay);
  $('over-link').onclick = () => {
    if (!G || !G.lastReplay) return;
    const url = `${location.origin}${location.pathname}#ghost=${store.b64encode(G.lastReplay)}`;
    copyText(url, 'Ghost link copied. Send it to a friend.');
  };
  $('over-copy').onclick = () => G && copyText(G.shareText, 'Result copied.');
  $('over-native-share').onclick = () => G && navigator.share && navigator.share({ text: G.shareText }).catch(() => {});
  $('rw-finish').onclick = () => { if (G && G.state === 'dead-rewind') { $('ov-rewind').hidden = true; finish(); } };

  window.addEventListener('resize', () => { if (document.body.dataset.screen === 'game') renderer.resize(); editor.resize(); });
  if (!DEBUG) {   // pause when the tab loses focus
    document.addEventListener('visibilitychange', () => { if (document.hidden && G && ['play', 'rewind'].includes(G.state)) pause(); });
    window.addEventListener('blur', () => { if (G && ['play', 'rewind'].includes(G.state)) pause(); });
  }

  if (!portal.allowLinks) {
    $('ed-share').hidden = true;
  }
  portal.onPauseRequest(() => { if (G && ['play', 'rewind'].includes(G.state)) pause(); });
  await portalReady;
  portal.loadingDone();

  if (!portal.embedded) online.init().then((ok) => { if (ok) renderDaily(); });
  if (portal.allowLinks && readHash()) {
    ui.renderMenu(menuHandlers);
  } else if (portal.name !== 'web') {
    // portal builds drop the player straight into a game; the menu is one tap away
    ui.renderMenu(menuHandlers);
    startGame({ mode: M.CLASSIC });
  } else {
    openMenu();
  }
  // test hook for automated play-testing only: http://host/?debug
  if (DEBUG) window.snakeDebug = { core, V, EV, get G() { return G; } };
  nextFrame(frame);
}

function restart() {
  if (G.ghostSource) { raceGhost(G.ghostSource); return; }
  if (G.mode === M.DAILY) { playDaily(); return; }
  startGame({ mode: G.mode, shape: G.shape, track: G.track, level: G.level });
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app').innerHTML =
    '<section class="screen is-active"><h1 style="font-size:40px">The game could not start</h1><p>WebAssembly failed to load. Serve the web folder over http(s) rather than opening the file directly, and use a current browser.</p></section>';
});
