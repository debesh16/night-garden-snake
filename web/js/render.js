// render.js - canvas drawing at 60fps. Reads plain arrays prepared by main.js
// from the C view; interpolates the snake between ticks, draws tiles, fruit,
// particles and screen effects. It never changes game state.

const SQRT3 = Math.sqrt(3);
const FRUIT = ['🍎', '🍌', '🍇'];
const FRUIT_COLOR = ['#FF7A6E', '#FFE27A', '#B98CFF'];
const PORTAL_COLOR = ['#C59BFF', '#FF9BC2', '#7FD6FF', '#FFD27F'];

export const SNAKE_STYLES = [
  { head: '#B6F5A8', body: '#A8EFA0', tail: '#7FD87A', glow: 'rgba(182,245,168,0.45)' },
  { head: '#9DEBD0', body: '#86E0C2', tail: '#4FB894', glow: 'rgba(134,224,194,0.4)' },
];
const GHOST_STYLE = { head: 'rgba(233,230,207,0.5)', body: 'rgba(233,230,207,0.32)', tail: 'rgba(233,230,207,0.12)', glow: null };

const lerp = (a, b, t) => a + (b - a) * t;
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp(pa >> 16, pb >> 16, t));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
  const bl = Math.round(lerp(pa & 255, pb & 255, t));
  return `rgb(${r},${g},${bl})`;
}

export function createRenderer(canvas, { reduced = false, fit = null } = {}) {
  const ctx = canvas.getContext('2d');
  const dark = document.createElement('canvas');
  const dctx = dark.getContext('2d');

  let W = 30, H = 20, shape = 0, cs = 20, dpr = 1, pxW = 600, pxH = 400;
  let particles = [], popups = [], pieces = [], confetti = [];
  let shake = 0;
  let foodBorn = new Map();
  let headPop = 0;
  let theme = {};

  function readTheme() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    theme = { moss: v('--moss'), fern: v('--fern'), fern2: v('--fern-2'), moon: v('--moon'), firefly: v('--firefly'), dawn: document.documentElement.dataset.theme === 'dawn' };
  }

  function units() {
    return shape === 4 ? [(W + 0.5) * SQRT3, H * 1.5 + 0.5] : [W, H];
  }

  function resize() {
    readTheme();
    const host = fit || canvas.parentElement;
    const availW = Math.max(200, host.clientWidth - 4);
    const availH = Math.max(160, host.clientHeight - 4);
    const [uw, uh] = units();
    cs = Math.max(6, Math.min(availW / uw, availH / uh));
    pxW = Math.floor(uw * cs);
    pxH = Math.floor(uh * cs);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(pxW * dpr);
    canvas.height = Math.floor(pxH * dpr);
    canvas.style.width = pxW + 'px';
    canvas.style.height = pxH + 'px';
    dark.width = canvas.width;
    dark.height = canvas.height;
    const scan = host.querySelector && host.querySelector('.scanlines');
    if (scan) {
      scan.style.width = pxW + 'px';
      scan.style.height = pxH + 'px';
    }
  }

  function setBoard(w, h, s) {
    if (w !== W || h !== H || s !== shape) {
      W = w; H = h; shape = s;
      resize();
    }
    foodBorn.clear();
  }

  function center(c) {
    const x = c % W, y = (c / W) | 0;
    if (shape === 4) return [cs * SQRT3 * (x + 0.5 + 0.5 * (y & 1)), cs * (1 + 1.5 * y)];
    return [(x + 0.5) * cs, (y + 0.5) * cs];
  }
  const stepLen = () => (shape === 4 ? SQRT3 * cs : cs);

  function cellPath(c, inset = 0) {
    const [cx, cy] = center(c);
    if (shape === 4) {
      const r = cs - inset;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
    } else {
      const s = cs - inset * 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cx - s / 2, cy - s / 2, s, s, cs * 0.22);
      else ctx.rect(cx - s / 2, cy - s / 2, s, s);
    }
  }

  // ---- layers -------------------------------------------------------------
  function drawBoard(t) {
    ctx.fillStyle = theme.moss;
    ctx.fillRect(0, 0, pxW, pxH);
    const r = Math.max(1, cs * 0.06);
    for (let c = 0; c < W * H; c++) {
      const x = c % W, y = (c / W) | 0;
      const wave = reduced ? 0 : Math.sin(t * 1.1 - (x + y) * 0.32);
      ctx.globalAlpha = 0.16 + 0.12 * wave;
      ctx.fillStyle = theme.fern2;
      const [cx, cy] = center(c);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawTiles(tiles, t) {
    for (let c = 0; c < W * H; c++) {
      const tile = tiles[c];
      if (!tile) continue;
      const [cx, cy] = center(c);
      if (tile === 1) {
        cellPath(c, cs * 0.04);
        ctx.fillStyle = theme.fern2;
        ctx.fill();
        ctx.fillStyle = theme.dawn ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.07)';
        ctx.fillRect(cx - cs * 0.3, cy - cs * 0.36, cs * 0.6, cs * 0.12);
      } else if (tile === 2) {
        cellPath(c, 0);
        ctx.fillStyle = theme.dawn ? 'rgba(110,195,225,0.5)' : 'rgba(130,215,245,0.42)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(200,240,250,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // frost glint
        ctx.fillStyle = 'rgba(235,252,255,0.75)';
        ctx.beginPath();
        ctx.arc(cx - cs * 0.22, cy - cs * 0.2, cs * 0.06, 0, Math.PI * 2);
        ctx.fill();
        const sh = reduced ? 0.5 : ((t * 0.5 + ((c % W) + ((c / W) | 0)) * 0.11) % 1.6);
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = 'rgba(230,250,255,0.45)';
        ctx.lineWidth = cs * 0.12;
        const ox = cx - cs + sh * cs * 1.6;
        ctx.beginPath();
        ctx.moveTo(ox, cy + cs * 0.6);
        ctx.lineTo(ox + cs * 0.6, cy - cs * 0.6);
        ctx.stroke();
        ctx.restore();
      } else if (tile >= 3 && tile <= 6) {
        const d = tile - 3;
        cellPath(c, cs * 0.02);
        ctx.fillStyle = 'rgba(244,195,90,0.13)';
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.rotate(d * Math.PI / 2);
        const off = reduced ? 0 : ((t * 2.2) % 1) * cs * 0.5;
        ctx.strokeStyle = 'rgba(244,195,90,0.75)';
        ctx.lineWidth = Math.max(1.5, cs * 0.09);
        ctx.lineCap = 'round';
        for (let k = -2; k <= 1; k++) {
          const y0 = -k * cs * 0.5 - off + cs * 0.25;
          ctx.beginPath();
          ctx.moveTo(-cs * 0.22, y0 + cs * 0.12);
          ctx.lineTo(0, y0 - cs * 0.08);
          ctx.lineTo(cs * 0.22, y0 + cs * 0.12);
          ctx.stroke();
        }
        ctx.restore();
      } else if (tile >= 8 && tile <= 11) {
        const col = PORTAL_COLOR[tile - 8];
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 0.7);
        g.addColorStop(0, col);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = g;
        ctx.fillRect(cx - cs, cy - cs, cs * 2, cs * 2);
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(reduced ? 0 : t * 2);
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1.5, cs * 0.1);
        ctx.setLineDash([cs * 0.35, cs * 0.2]);
        ctx.beginPath();
        ctx.arc(0, 0, cs * 0.38, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);
      }
    }
  }

  function drawFood(foods, t, dim = 1) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of foods) {
      if (!foodBorn.has(f.cell)) foodBorn.set(f.cell, t);
      const age = t - foodBorn.get(f.cell);
      const pop = Math.min(1, age / 0.25);
      const ease = 1 - Math.pow(1 - pop, 3) * (1 - pop * 0.6);
      const [cx, cy] = center(f.cell);
      const bob = reduced ? 0 : Math.sin(t * 3 + f.cell) * cs * 0.07;
      const pulse = reduced ? 1 : 1 + Math.sin(t * 4 + f.cell) * 0.05;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 0.9);
      g.addColorStop(0, 'rgba(244,195,90,0.35)');
      g.addColorStop(1, 'rgba(244,195,90,0)');
      ctx.globalAlpha = dim;
      ctx.fillStyle = g;
      ctx.fillRect(cx - cs, cy - cs, cs * 2, cs * 2);
      ctx.font = `${Math.round(cs * 0.86 * ease * pulse)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.fillText(FRUIT[f.type] || FRUIT[0], cx, cy + bob + cs * 0.04);
      ctx.globalAlpha = 1;
    }
    for (const cell of [...foodBorn.keys()]) if (!foods.some((f) => f.cell === cell)) foodBorn.delete(cell);
  }

  function snakePoints(cells, prev, alpha) {
    const pts = [];
    const step = stepLen();
    for (let i = 0; i < cells.length; i++) {
      const b = center(cells[i]);
      if (!prev || !prev.length) { pts.push(b); continue; }
      const a = center(prev[Math.min(i, prev.length - 1)]);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > step * 1.05) pts.push(b);               // wrapped or teleported: no slide
      else pts.push([lerp(a[0], b[0], alpha), lerp(a[1], b[1], alpha)]);
    }
    return pts;
  }

  function drawSnake(cells, prev, alpha, style, { dir = 1, pass = false } = {}) {
    if (!cells.length) return;
    const pts = snakePoints(cells, prev, alpha);
    const step = stepLen();
    const n = pts.length;
    const width = (i) => cs * lerp(0.78, 0.52, n > 1 ? i / (n - 1) : 0);
    const joined = (i) => {
      const a = center(cells[i]), b = center(cells[i - 1]);
      const p = pts[i], q = pts[i - 1];
      return Math.hypot(a[0] - b[0], a[1] - b[1]) <= step * 1.05 && Math.hypot(p[0] - q[0], p[1] - q[1]) <= step * 1.5;
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (style.glow && !reduced) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = cs * 0.7;
    }
    for (let i = n - 1; i >= 1; i--) {
      const col = style.glow ? mixHex(style.body, style.tail, (i / Math.max(1, n - 1))) : style.body;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = width(i);
      if (joined(i)) {
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[i - 1][0], pts[i - 1][1]);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(pts[i][0], pts[i][1], width(i) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0;
    // head
    const [hx, hy] = pts[0];
    const squash = 1 + headPop * 0.25;
    const hr = cs * 0.47 * squash;
    ctx.fillStyle = style.head;
    if (pass) ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // eyes look where the snake is heading
    let vx, vy;
    if (n > 1 && joined(1)) { vx = hx - pts[1][0]; vy = hy - pts[1][1]; }
    else {
      const sq = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const hx6 = [[1, 0], [0.5, -0.87], [-0.5, -0.87], [-1, 0], [-0.5, 0.87], [0.5, 0.87]];
      [vx, vy] = shape === 4 ? hx6[dir] || [1, 0] : sq[dir] || [1, 0];
    }
    const len = Math.hypot(vx, vy) || 1;
    vx /= len; vy /= len;
    const px = -vy, py = vx;
    if (style.glow) {
      for (const side of [-1, 1]) {
        const ex = hx + vx * cs * 0.16 + px * side * cs * 0.2;
        const ey = hy + vy * cs * 0.16 + py * side * cs * 0.2;
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath(); ctx.arc(ex, ey, cs * 0.12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#16301E';
        ctx.beginPath(); ctx.arc(ex + vx * cs * 0.04, ey + vy * cs * 0.04, cs * 0.065, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawDarkness(headCell, radius, foods, t) {
    if (headCell < 0) return;
    const [hx, hy] = center(headCell);
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.globalCompositeOperation = 'source-over';
    dctx.clearRect(0, 0, pxW, pxH);
    dctx.fillStyle = theme.dawn ? 'rgba(20,30,24,0.92)' : 'rgba(3,7,9,0.95)';
    dctx.fillRect(0, 0, pxW, pxH);
    dctx.globalCompositeOperation = 'destination-out';
    const flicker = reduced ? 1 : 1 + Math.sin(t * 7) * 0.015;
    const R = radius * cs * flicker;
    const g = dctx.createRadialGradient(hx, hy, R * 0.25, hx, hy, R);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    dctx.fillStyle = g;
    dctx.fillRect(0, 0, pxW, pxH);
    ctx.drawImage(dark, 0, 0, pxW, pxH);
    // fruit glows faintly through the dark
    for (const f of foods) {
      const [fx, fy] = center(f.cell);
      const gl = ctx.createRadialGradient(fx, fy, 0, fx, fy, cs * 1.3);
      const a = 0.22 + (reduced ? 0 : Math.sin(t * 2 + f.cell) * 0.06);
      gl.addColorStop(0, `rgba(244,195,90,${a})`);
      gl.addColorStop(1, 'rgba(244,195,90,0)');
      ctx.fillStyle = gl;
      ctx.fillRect(fx - cs * 1.4, fy - cs * 1.4, cs * 2.8, cs * 2.8);
    }
  }

  function drawEffects(dt) {
    // particles
    for (const p of particles) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt * (p.g || 0); p.vx *= 0.98; p.vy *= 0.98;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    particles = particles.filter((p) => p.life > 0);
    // breaking snake pieces
    for (const p of pieces) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; p.rot += p.vr * dt;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 0.6));
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-p.s / 2, -p.s / 2, p.s, p.s, p.s * 0.3); else ctx.rect(-p.s / 2, -p.s / 2, p.s, p.s);
      ctx.fill();
      ctx.restore();
    }
    pieces = pieces.filter((p) => p.life > 0);
    // floating score text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of popups) {
      p.life -= dt;
      const k = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / (p.max * 0.4)));
      ctx.font = `800 ${Math.round(p.size * (1 + (1 - Math.min(1, k * 4)) * 0.3))}px "Bricolage Grotesque", sans-serif`;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y - k * cs * 1.8);
    }
    popups = popups.filter((p) => p.life > 0);
    // confetti
    for (const c of confetti) {
      c.life -= dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt; c.vx *= 0.99;
      ctx.globalAlpha = Math.max(0, Math.min(1, c.life));
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
      ctx.fillStyle = c.color; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    confetti = confetti.filter((c) => c.life > 0 && c.y < pxH + 20);
    ctx.globalAlpha = 1;
  }

  let lastT = 0;
  function draw(frame) {
    const t = frame.time;
    const dt = Math.min(0.05, lastT ? t - lastT : 0.016);
    lastT = t;
    headPop = Math.max(0, headPop - dt * 5);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
    if (shake > 0 && !reduced) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = Math.max(0, shake - dt * 40);
    }
    drawBoard(t);
    drawTiles(frame.tiles, t);
    drawFood(frame.foods, t);
    if (frame.ghost) drawSnake(frame.ghost.cells, frame.ghost.prev, frame.ghost.alpha, GHOST_STYLE, { dir: frame.ghost.dir });
    frame.snakes.forEach((s, i) => {
      if (!s.hidden) drawSnake(s.cells, s.prev, frame.alpha, SNAKE_STYLES[i], { dir: s.dir, pass: s.pass });
    });
    if (frame.darkness) drawDarkness(frame.darkness.head, frame.darkness.radius, frame.foods, t);
    drawEffects(dt);
  }

  // ---- effects triggered by main.js on game events -------------------------
  const fx = {
    eat(cell, type, text, perfect) {
      const [x, y] = center(cell);
      headPop = 1;
      const n = reduced ? 4 : 16;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = cs * (2 + Math.random() * 5);
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: cs * (0.06 + Math.random() * 0.08),
          color: i % 3 ? FRUIT_COLOR[type] || FRUIT_COLOR[0] : '#B6F5A8', life: 0.6, max: 0.6, g: 0.4 });
      }
      popups.push({ x, y: y - cs * 0.4, text, color: '#F4C35A', size: cs * 0.75, life: 0.9, max: 0.9 });
      if (perfect) popups.push({ x, y: y - cs * 1.4, text: 'PERFECT', color: '#FFFFFF', size: cs * 0.95, life: 1.1, max: 1.1 });
    },
    popup(cell, text, color = '#E9E6CF') {
      const [x, y] = center(cell);
      popups.push({ x, y: y - cs * 0.6, text, color, size: cs * 0.7, life: 1, max: 1 });
    },
    die(cellsList) {
      shake = reduced ? 0 : 14;
      cellsList.forEach(({ cells, style }) => {
        const st = SNAKE_STYLES[style];
        cells.forEach((c, i) => {
          const [x, y] = center(c);
          const a = Math.random() * Math.PI * 2;
          const sp = cs * (3 + Math.random() * 7);
          pieces.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - cs * 6, rot: 0, vr: (Math.random() - 0.5) * 12,
            s: cs * (i === 0 ? 0.8 : 0.62), color: i === 0 ? st.head : mixHex(st.body, st.tail, i / Math.max(1, cells.length - 1)), life: 1.4 });
        });
      });
    },
    shake(n) { if (!reduced) shake = n; },
    confetti() {
      if (reduced) return;
      const cols = ['#B6F5A8', '#F4C35A', '#EE8FA8', '#9FD8E6', '#B98CFF', '#FFFFFF'];
      for (let i = 0; i < 140; i++) {
        confetti.push({ x: Math.random() * pxW, y: -20 - Math.random() * pxH * 0.5, vx: (Math.random() - 0.5) * 80, vy: 80 + Math.random() * 160,
          rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10, w: 5 + Math.random() * 5, h: 8 + Math.random() * 6,
          color: cols[i % cols.length], life: 3.5 });
      }
    },
    clear() { particles = []; popups = []; pieces = []; confetti = []; shake = 0; foodBorn.clear(); },
  };

  function cellAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let best = -1, bestD = Infinity;
    if (shape !== 4) {
      const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
      return cx >= 0 && cy >= 0 && cx < W && cy < H ? cy * W + cx : -1;
    }
    for (let c = 0; c < W * H; c++) {
      const [px, py] = center(c);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  return { resize, setBoard, draw, fx, center, cellAt, readTheme, get cellSize() { return cs; } };
}

// ---- menu background: a slow ambient snake --------------------------------
export function startAmbient(canvas, reduced) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, running = true;
  const trail = [];
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', size);
  const pos = (t) => [
    w * (0.5 + 0.36 * Math.sin(t * 0.21) + 0.08 * Math.sin(t * 0.67)),
    h * (0.5 + 0.34 * Math.sin(t * 0.17 + 1.3) + 0.07 * Math.cos(t * 0.53)),
  ];
  const fireflies = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6 }));
  function frame(ms) {
    if (!running) return;
    const t = ms / 1000;
    ctx.clearRect(0, 0, w, h);
    for (const f of fireflies) {
      const a = 0.15 + 0.35 * Math.max(0, Math.sin(t * 0.9 + f.p));
      ctx.fillStyle = `rgba(244,195,90,${a})`;
      ctx.beginPath();
      ctx.arc((f.x * w + Math.sin(t * 0.3 + f.p) * 20), (f.y * h + Math.cos(t * 0.25 + f.p) * 16), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    trail.unshift(pos(reduced ? 3 : t));
    if (trail.length > 70) trail.pop();
    ctx.lineCap = 'round';
    for (let i = trail.length - 1; i > 0; i -= 1) {
      const k = i / trail.length;
      ctx.strokeStyle = `rgba(168,239,160,${0.16 * (1 - k)})`;
      ctx.lineWidth = 26 * (1 - k * 0.5);
      ctx.beginPath();
      ctx.moveTo(trail[i][0], trail[i][1]);
      ctx.lineTo(trail[i - 1][0], trail[i - 1][1]);
      ctx.stroke();
    }
    if (!reduced) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return {
    stop() { running = false; canvas.style.visibility = 'hidden'; },
    start() { canvas.style.visibility = ''; if (!running) { running = true; requestAnimationFrame(frame); } },
  };
}
