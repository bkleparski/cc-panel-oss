'use strict';
// Limit planu Codex (okna 5h i 7d) z rolloutów ~/.codex/sessions/**/rollout-*.jsonl - tylko odczyt, bez API i logowania.
// Źródło: event_msg/token_count.payload.rate_limits (rozpoznanie 05.10, codex-cli 0.160): primary = 5h (300 min),
// secondary = 7d (10080 min), used_percent całkowite, resets_at epoch s, zakres per konto (każdy wątek podaje to samo).
// Próbki są tylko w trakcie pracy Codexa (co ~11 s), więc zwykle dane są stare: pokazujemy ostatni znany stan + wiek.
// Bez prognozy - za mało próbek (patrz rozpoznanie). Brak danych = codex: null (panel chowa wskaźnik), nigdy błąd.
//
// Koszt: najnowsze pliki z katalogów dni (od końca), z każdego końcówka; cache per plik (rozmiar, mtime, offset),
// rosnący plik doczytywany od zapamiętanego offsetu - bez czytania 37 MB co przebieg.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.codex', 'sessions');
const FILES = 6;                 // ile najnowszych rolloutów sprawdzać (limit jest per konto, wystarczy najświeższa próbka)
const TAIL = 512 * 1024;         // końcówka nowego pliku
const DELTA_MAX = 4 * 1024 * 1024; // większy przyrost = czytaj tylko końcówkę
const STALE_AFTER = 30 * 60;     // jak w lib/usage.js
const KEYS = { 300: '5h', 10080: '7d' };
const ROLLOUT = /^rollout-.*\.jsonl$/;

function readRange(file, from, to) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.max(0, to - from));
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8', 0, n);
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ostatnia próbka rate_limits w tekście (linie JSONL); niepełne linie na brzegach odpadają na JSON.parse
function lastSample(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const rl = j?.payload?.rate_limits;
    if (!rl || typeof rl !== 'object') continue;
    const at = Date.parse(j.timestamp) / 1000;
    if (!Number.isFinite(at)) continue;
    return { at, rl };
  }
  return null;
}

// najnowsze rollouty: katalogi RRRR/MM/DD od końca, aż uzbiera się FILES plików; sort po mtime
function newestRollouts(root = ROOT, limit = FILES) {
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse(); } catch { return []; } };
  const out = [];
  outer: for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => ROLLOUT.test(n)); } catch { continue; }
    for (const n of names) {
      const full = path.join(dir, n), st = fs.statSync(full, { throwIfNoEntry: false });
      if (st?.isFile()) out.push({ full, size: st.size, mtimeMs: st.mtimeMs });
    }
    if (out.length >= limit) break outer;
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// cache: Map(ścieżka -> { size, mtimeMs, sample }) - przekazywany między wywołaniami
function sampleOf(f, cache) {
  const c = cache.get(f.full);
  if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) return c.sample;
  let sample = null;
  if (c && f.size > c.size && f.size - c.size <= DELTA_MAX) {
    // przyrost pliku: od zapamiętanego offsetu (urwana pierwsza linia odpada na JSON.parse)
    sample = lastSample(readRange(f.full, c.size, f.size)) || c.sample;
  } else {
    sample = lastSample(readRange(f.full, Math.max(0, f.size - TAIL), f.size));
  }
  cache.set(f.full, { size: f.size, mtimeMs: f.mtimeMs, sample });
  return sample;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// rate_limits -> okna jak w lib/usage.js (key, state, pct, resetsAt, resetIn, level, sampleAt, age, stale)
function analyzeSample(s, now = Date.now() / 1000) {
  if (!s) return null;
  const rl = s.rl, age = Math.max(0, Math.round(now - s.at)), stale = age > STALE_AFTER;
  const found = {};
  for (const [slot, def] of [['primary', '5h'], ['secondary', '7d']]) {
    const w = rl[slot];
    if (!w || typeof w !== 'object') continue;
    const key = KEYS[w.window_minutes] || def;
    if (!found[key]) found[key] = w;
  }
  const windows = ['5h', '7d'].map((key) => {
    const w = found[key], pct = num(w?.used_percent), resetsAt = num(w?.resets_at);
    if (pct == null || resetsAt == null) return { key, state: 'nodata' };
    const base = { key, resetsAt, sampleAt: Math.round(s.at), age, stale };
    if (resetsAt <= now) return { ...base, state: 'expired', pct: 0 }; // okno minęło po ostatniej próbce
    const p = Math.round(pct * 10) / 10;
    return { ...base, state: 'ok', pct: p, resetIn: Math.round(resetsAt - now), level: p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok', forecast: { state: 'off' } };
  });
  if (windows.every((w) => w.state === 'nodata')) return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return { provider: 'codex', now: Math.round(now), sampleAt: Math.round(s.at), age, stale,
    planType: str(rl.plan_type), limitId: str(rl.limit_id), reached: str(rl.rate_limit_reached_type), windows };
}

const defaultCache = new Map();
function codexUsage(root = ROOT, now = Date.now() / 1000, cache = defaultCache) {
  try {
    let best = null;
    const files = newestRollouts(root);
    for (const f of files) {
      const s = sampleOf(f, cache);
      if (s && (!best || s.at > best.at)) best = s;
    }
    const keep = new Set(files.map((f) => f.full));
    for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
    return analyzeSample(best, now);
  } catch { return null; }
}

module.exports = { codexUsage, analyzeSample, lastSample, newestRollouts, sampleOf, ROOT, STALE_AFTER };
