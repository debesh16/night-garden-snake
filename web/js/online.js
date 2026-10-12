// online.js - optional online features (daily top run, score submission,
// community levels). Set API_BASE to the URL of server/api.c (CGI) to turn
// them on. When it is empty or unreachable every [data-online] element stays
// hidden and the game works fully offline.

export const API_BASE = '';   // e.g. 'https://example.com/cgi-bin/snake-api'

let available = false;

async function call(action, { method = 'GET', params = {}, body = null, timeout = 4000 } = {}) {
  const url = new URL(API_BASE, location.href);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: body ? new URLSearchParams(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function init() {
  if (!API_BASE) return false;
  try {
    const r = await call('ping', { timeout: 2500 });
    available = !!(r && r.ok);
  } catch {
    available = false;
  }
  document.querySelectorAll('[data-online]').forEach((el) => { el.hidden = !available; });
  return available;
}

export const isAvailable = () => available;

export async function submitRun({ nickname, replay, daily }) {
  if (!available) return null;
  try { return await call('submit', { method: 'POST', body: { nickname, replay, daily: daily ? 1 : 0 } }); } catch { return null; }
}

export async function dailyTop(day) {
  if (!available) return null;
  try { return await call('daily_top', { params: { day } }); } catch { return null; }
}

export async function listLevels() {
  if (!available) return [];
  try { const r = await call('levels'); return (r && r.levels) || []; } catch { return []; }
}

export async function publishLevel({ nickname, name, data }) {
  if (!available) return null;
  try { return await call('publish_level', { method: 'POST', body: { nickname, name, data } }); } catch { return null; }
}

export async function likeLevel(id, nickname) {
  if (!available) return null;
  try { return await call('like_level', { method: 'POST', body: { id, nickname } }); } catch { return null; }
}
