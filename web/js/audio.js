// audio.js - Web Audio sound effects and two procedural rhythm tracks.
// Nothing is loaded from files, so there is nothing to license.

let ctx = null;
let master = null;
let muted = false;
let volume = 0.7;

export const TRACKS = [
  { name: 'Moss groove', bpm: 116, root: 45, scale: [0, 3, 5, 7, 10], bass: [0, 0, 7, 5, 0, 0, 10, 7] },
  { name: 'Firefly run', bpm: 138, root: 50, scale: [0, 2, 4, 7, 9], bass: [0, 7, 0, 9, 0, 7, 12, 4] },
];

export function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.connect(ctx.destination);
    applyGain();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function applyGain() {
  if (master) master.gain.value = muted ? 0 : volume * 0.6;
}

export function setMuted(m) { muted = m; applyGain(); }
export function setVolume(v) { volume = v; applyGain(); }
export function isMuted() { return muted; }
export function now() { return ctx ? ctx.currentTime : performance.now() / 1000; }
export function hasClock() { return !!ctx; }

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

function tone({ freq, type = 'sine', t = now(), dur = 0.12, gain = 0.3, slide = 0, attack = 0.005 }) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

let noiseBuf = null;
function noise({ t = now(), dur = 0.05, gain = 0.15, hp = 6000 }) {
  if (!ctx) return;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

export const sfx = {
  eat(type = 0, combo = 1) {
    if (!ensure()) return;
    const base = [76, 79, 83][type] + Math.min(combo - 1, 6);
    tone({ freq: mtof(base), type: 'triangle', dur: 0.09, gain: 0.25 });
    tone({ freq: mtof(base + 7), type: 'sine', t: now() + 0.05, dur: 0.12, gain: 0.18 });
  },
  perfect() {
    if (!ensure()) return;
    [84, 88, 91].forEach((n, i) => tone({ freq: mtof(n), type: 'square', t: now() + i * 0.04, dur: 0.1, gain: 0.08 }));
  },
  die() {
    if (!ensure()) return;
    tone({ freq: 220, type: 'sawtooth', dur: 0.5, gain: 0.2, slide: 0.25 });
    noise({ dur: 0.3, gain: 0.2, hp: 800 });
  },
  perk() {
    if (!ensure()) return;
    [72, 76, 79, 84].forEach((n, i) => tone({ freq: mtof(n), type: 'triangle', t: now() + i * 0.07, dur: 0.18, gain: 0.18 }));
  },
  pick() {
    if (!ensure()) return;
    tone({ freq: mtof(79), type: 'sine', dur: 0.2, gain: 0.25, slide: 2 });
  },
  rewind() {
    if (!ensure()) return;
    tone({ freq: 600, type: 'sawtooth', dur: 0.35, gain: 0.08, slide: 0.4 });
  },
  rewindTick() {
    if (!ensure()) return;
    tone({ freq: 900 + Math.random() * 200, type: 'square', dur: 0.03, gain: 0.03 });
  },
  portal() {
    if (!ensure()) return;
    tone({ freq: mtof(67), type: 'sine', dur: 0.25, gain: 0.15, slide: 3 });
  },
  turn() {
    if (!ensure()) return;
    tone({ freq: mtof(60), type: 'sine', dur: 0.03, gain: 0.04 });
  },
  win() {
    if (!ensure()) return;
    [72, 76, 79, 84, 88].forEach((n, i) => tone({ freq: mtof(n), type: 'triangle', t: now() + i * 0.09, dur: 0.3, gain: 0.2 }));
  },
  walls() {
    if (!ensure()) return;
    tone({ freq: 70, type: 'sawtooth', dur: 0.4, gain: 0.2, slide: 0.7 });
  },
};

// ---- rhythm music -------------------------------------------------------
// The scheduler plays eighth notes slightly ahead of time and hands each
// eighth-note time to the game, which steps the C core exactly then.
let music = null;

export function startMusic(trackIndex, onStepScheduled) {
  if (!ensure()) return null;
  stopMusic();
  const tr = TRACKS[trackIndex] || TRACKS[0];
  const eighth = 60 / tr.bpm / 2;
  music = { tr, eighth, next: ctx.currentTime + 0.4, n: 0, timer: 0, cb: onStepScheduled };
  const tick = () => {
    if (!music) return;
    while (music.next < ctx.currentTime + 0.15) {
      scheduleNote(music, music.next, music.n);
      music.cb(music.next, music.n % 2 === 0);
      music.next += music.eighth;
      music.n++;
    }
    music.timer = setTimeout(tick, 25);
  };
  tick();
  return { bpm: tr.bpm, eighth };
}

function scheduleNote(m, t, n) {
  const { tr } = m;
  const beat = n % 2 === 0;
  const bar = Math.floor(n / 16) % 4;
  if (n % 4 === 0) {                                   // kick
    tone({ freq: 140, type: 'sine', t, dur: 0.18, gain: 0.5, slide: 0.3 });
  }
  if (n % 8 === 4) noise({ t, dur: 0.12, gain: 0.12, hp: 1500 }); // snare
  noise({ t, dur: beat ? 0.04 : 0.025, gain: beat ? 0.05 : 0.03 }); // hat
  if (beat) {
    const b = tr.bass[(n / 2) % tr.bass.length] + (bar === 3 ? -2 : 0);
    tone({ freq: mtof(tr.root + b), type: 'triangle', t, dur: m.eighth * 1.8, gain: 0.22 });
  }
  // a small pentatonic melody that changes every bar
  const seed = (n * 7 + bar * 13) % 11;
  if (seed < 4) {
    const deg = tr.scale[(n + bar * 2) % tr.scale.length];
    tone({ freq: mtof(tr.root + 24 + deg), type: 'sine', t, dur: m.eighth * 0.9, gain: 0.08 });
  }
}

export function stopMusic() {
  if (music) {
    clearTimeout(music.timer);
    music = null;
  }
}
