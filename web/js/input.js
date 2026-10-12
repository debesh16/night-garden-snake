// input.js - keyboard, swipe and on-screen buttons. Turns raw input into
// direction codes for the C core; it never decides anything about the game.

// Square: 0 up, 1 right, 2 down, 3 left.  Hex: 0 E, 1 NE, 2 NW, 3 W, 4 SW, 5 SE.
const SQUARE_KEYS = {
  KeyW: [0, 0], KeyD: [0, 1], KeyS: [0, 2], KeyA: [0, 3],
  ArrowUp: [1, 0], ArrowRight: [1, 1], ArrowDown: [1, 2], ArrowLeft: [1, 3],
};
const HEX_KEYS = { KeyQ: 2, KeyW: 1, KeyE: 0, KeyD: 5, KeyS: 4, KeyA: 3, ArrowLeft: 3, ArrowRight: 0 };
const HEX_ANGLES = [0, -60, -120, 180, 120, 60];

let cfg = { hex: false, versus: false, getDir: () => 0, enabled: false };
let handlers = {};

export function configure(c) { cfg = { ...cfg, ...c }; }
export function on(h) { handlers = { ...handlers, ...h }; }

const emit = (name, ...args) => handlers[name] && handlers[name](...args);

function hexUpDown(up) {
  const d = cfg.getDir(0);
  const eastish = d === 0 || d === 1 || d === 5;
  if (up) return eastish ? 1 : 2;
  return eastish ? 5 : 4;
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.querySelector('dialog[open]')) return;
  const code = e.code;

  if (code === 'Escape' || code === 'KeyP') { emit('pause'); e.preventDefault(); return; }
  if (code === 'KeyM') { emit('mute'); return; }
  if (code === 'KeyR' || code === 'Backspace') {
    if (!e.repeat) emit('rewind', true);
    e.preventDefault();
    return;
  }
  if (code === 'Enter' || code === 'Space') { if (emit('confirm') !== false) e.preventDefault(); }
  if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3') emit('perk', Number(code.slice(5)) - 1);

  if (!cfg.enabled) return;
  if (cfg.hex) {
    let d = HEX_KEYS[code];
    if (code === 'ArrowUp') d = hexUpDown(true);
    if (code === 'ArrowDown') d = hexUpDown(false);
    if (d !== undefined) { emit('dir', 0, d); e.preventDefault(); }
    return;
  }
  const k = SQUARE_KEYS[code];
  if (k) {
    emit('dir', cfg.versus ? k[0] : 0, k[1]);
    e.preventDefault();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyR' || e.code === 'Backspace') emit('rewind', false);
});

// ---- swipe on the board ---------------------------------------------------
export function attachSwipe(el) {
  let anchor = null;
  const fromVector = (dx, dy) => {
    if (cfg.hex) {
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      let best = 0, bestDiff = 999;
      HEX_ANGLES.forEach((a, i) => {
        let diff = Math.abs(((ang - a + 540) % 360) - 180);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      });
      return best;
    }
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
    return dy > 0 ? 2 : 0;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    anchor = { x: e.clientX, y: e.clientY };
    emit('touch');
  });
  el.addEventListener('pointermove', (e) => {
    if (!anchor || !cfg.enabled) return;
    const dx = e.clientX - anchor.x, dy = e.clientY - anchor.y;
    if (Math.hypot(dx, dy) > 26) {
      emit('dir', 0, fromVector(dx, dy));
      anchor = { x: e.clientX, y: e.clientY };   // keep swiping to queue another turn
    }
  });
  const end = () => { anchor = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ---- on-screen buttons --------------------------------------------------
export function attachPad(root) {
  root.querySelectorAll('[data-dir]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (cfg.enabled) emit('dir', 0, Number(b.dataset.dir));
    });
  });
}

export function attachHold(el, name) {
  const down = (e) => { e.preventDefault(); emit(name, true); };
  const up = () => emit(name, false);
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
}
