'use strict';
// Push z prognozy limitu planu Max (lib/usage.js): "limit skończy się przed resetem" i przejście na crit (>= 90%).
// Czysta logika: decide() dostaje wynik analyze() i stan deduplikacji, zwraca powiadomienia i nowy stan.
// Serwer woła ją co 5 min, stan trzyma w ~/.config/cc-panel/usage-alerts-state.json (przeżywa restart).
//
// Bez spamu: każdy rodzaj (limit, crit) raz na serię okna. Seria = okno o danym resets_at; nowa seria także
// po resecie kuponem (resets_at bez zmian, a procent spada poniżej zapamiętanego szczytu). Ponowny push "limit"
// tylko, gdy ETA przesunie się wcześniej o więcej niż ETA_SHIFT względem ostatnio wysłanej.
const fs = require('fs');

const TZ = 'Europe/Warsaw';
const SAME_RESET = 120;                          // jak w lib/usage.js: resets_at różniące się o < 2 min = to samo okno
const DROP = 2;                                  // spadek procentu o >= 2 pp = nowa seria (reset kuponem)
const MIN_SPAN = { '5h': 30 * 60, '7d': 3 * 3600 }; // prognoza z krótszego odcinka danych nie budzi
const ETA_SHIFT = { '5h': 30 * 60, '7d': 2 * 3600 };
const DEFAULTS = { enabled: true, quietFrom: '22:00', quietTo: '07:00' }; // cisza tylko dla ostrzeżeń 5h

const parts = (t) => Object.fromEntries(new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, weekday: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
// "06:14" dziś, "czw. 06:14" w inny dzień (czas warszawski)
function when(t, now) {
  const a = parts(t), b = parts(now);
  const hm = `${a.hour}:${a.minute}`;
  return a.day === b.day && t - now < 86400 ? hm : `${a.weekday} ${hm}`;
}
const minutes = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
function quiet(now, cfg) {
  const p = parts(now), cur = +p.hour * 60 + +p.minute, from = minutes(cfg.quietFrom), to = minutes(cfg.quietTo);
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}
const rate = (r) => String(r).replace('.', ',');

// Czy prognoza "limit przed resetem" jest wiarygodna: świeże dane i dość długi odcinek, z którego liczono tempo.
function limitForecast(w) {
  const fc = w.forecast;
  if (w.state !== 'ok' || w.stale || fc?.state !== 'limit' || !(fc.at < w.resetsAt)) return null;
  return (fc.span || 0) >= MIN_SPAN[w.key] ? fc : null;
}

function limitText(w, fc, now) {
  return `Limit ${w.key} skończy się ok. ${when(fc.at, now)} (reset ${when(w.resetsAt, now)}) przy tempie ${rate(fc.ratePerHour)} pp/h. Teraz ${Math.round(w.pct)}%.`;
}

// Zwraca { notes: [{ key, kind, title, body, url, tag }], state, skipped: [powód] }.
// Codex (lib/codex-usage.js, 05.10): opts = CODEX - tylko crit >= 90%, bez pushu z prognozy (za mało próbek),
// stan pod kluczami "codex:5h"/"codex:7d" w tym samym pliku, push typu limitCodex (osobny wyłącznik w 🔔).
const CODEX = { prefix: 'codex:', name: 'Codex ', critOnly: true };
function decide(usage, prev = {}, now = Date.now() / 1000, cfg = DEFAULTS, opts = {}) {
  cfg = { ...DEFAULTS, ...cfg };
  const { prefix = '', name = '', critOnly = false } = opts;
  const state = { ...prev }, notes = [], skipped = [];
  if (!cfg.enabled) return { notes, state, skipped: ['wyłączone w konfiguracji'] };
  for (const w of usage?.windows || []) {
    if (!MIN_SPAN[w.key] || w.state !== 'ok') continue;
    const sk = prefix + w.key;
    let s = state[sk];
    const fresh = !s || Math.abs(s.resetsAt - w.resetsAt) >= SAME_RESET || w.pct <= s.peak - DROP;
    if (fresh) s = { resetsAt: w.resetsAt, peak: w.pct, limitAt: null, crit: false };
    else s = { ...s, resetsAt: w.resetsAt, peak: Math.max(s.peak, w.pct) };
    state[sk] = s;
    if (w.stale) { skipped.push(`${name}${w.key}: dane sprzed ${Math.round(w.age / 60)} min`); continue; }
    const fc = critOnly ? null : limitForecast(w);
    const tag = 'usage-' + sk.replace(':', '-');
    if (w.level === 'crit' && !s.crit) {
      const eta = fc ? ` Przy tempie ${rate(fc.ratePerHour)} pp/h skończy się ok. ${when(fc.at, now)}.` : '';
      notes.push({ key: sk, kind: 'crit', title: `🔴 Limit ${name}${w.key}: ${Math.round(w.pct)}%`,
        body: `Reset ${when(w.resetsAt, now)}.${eta}`, url: '/#/limit', tag });
      s.crit = true;
      if (fc) s.limitAt = fc.at; // crit z ETA zastępuje osobny push "limit"
      continue;
    }
    if (critOnly) continue;
    if (!fc) { if (w.forecast?.state === 'limit') skipped.push(`${w.key}: prognoza z za krótkiego odcinka danych`); continue; }
    const moved = s.limitAt != null && fc.at < s.limitAt - ETA_SHIFT[w.key];
    if (s.limitAt != null && !moved) continue;
    if (w.key === '5h' && quiet(now, cfg)) { skipped.push('5h: godziny ciszy'); continue; } // nie oznaczam - wyśle po ciszy
    notes.push({ key: w.key, kind: 'limit', title: moved ? `⏳ Limit ${w.key} wcześniej niż myślałem` : `⏳ Limit ${w.key} przed resetem`,
      body: limitText(w, fc, now), url: '/#/limit', tag });
    s.limitAt = fc.at;
  }
  return { notes, state, skipped };
}

// Wpisy do dzwonka: bieżący stan (bez deduplikacji i ciszy), te same progi wiarygodności co push.
function usageAttention(usage, now = Date.now() / 1000, opts = {}) {
  const { prefix = '', name = '', critOnly = false } = opts;
  const out = [];
  for (const w of usage?.windows || []) {
    if (!MIN_SPAN[w.key] || w.state !== 'ok' || w.stale) continue;
    const fc = critOnly ? null : limitForecast(w);
    if (w.level === 'crit') out.push({ id: 'usage:' + prefix + w.key, title: `🔴 Limit ${name}${w.key}: ${Math.round(w.pct)}%`, body: `Reset ${when(w.resetsAt, now)}`, url: '/#/limit', priority: 1 });
    else if (fc) out.push({ id: 'usage:' + w.key, title: `⏳ Limit ${w.key} przed resetem`, body: limitText(w, fc, now), url: '/#/limit', priority: 1 });
  }
  return out;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const loadConfig = (file) => ({ ...DEFAULTS, ...readJson(file, {}) });

module.exports = { decide, usageAttention, CODEX, quiet, when, loadConfig, readJson, DEFAULTS, MIN_SPAN, ETA_SHIFT };
