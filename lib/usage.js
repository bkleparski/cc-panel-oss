'use strict';
// Limit planu Max (okna 5h i 7d) z próbek mozgd: procent, reset, wiek danych i prognoza wyczerpania.
// Baza mozgd tylko do odczytu (readOnly) - schematu i kolektora nie zmieniamy.
//
// Prognoza liniowa wzorowana na claudash `src/statusline.rs::forecast`
// (https://github.com/jguajardo/claudash, Jorge Guajardo, licencja MIT OR Apache-2.0):
// tempo z odczytów tego samego okna (ten sam reset) w oknie wstecz, minimum 5 minut danych.
//
// Dane z mozgd są zaszumione: sesja raportuje swoją ostatnią znaną wartość także wtedy, gdy dawno nie pytała API,
// więc w strumieniu pojawiają się odczyty nawet 20+ pp niższe od bieżących. Na danych z 03-05.10 każda sesja
// z osobna rośnie monotonicznie w obrębie okna, dlatego:
// - bieżące użycie = maksimum odczytów serii, niższe odczyty innych sesji to przeterminowane dane;
// - nowa seria (np. reset kuponem bez zmiany resets_at) = ta sama sesja zgłasza wartość niższą od swojej
//   wcześniejszej, albo sesja dwa razy po szczycie zgłasza rosnące wartości wyraźnie poniżej szczytu.
const os = require('os');
const path = require('path');

const DB_PATH = path.join(os.homedir(), '.local/state/mozg/mozg.db');
const WINDOWS = [
  // lookback: z jakiego okresu liczymy tempo; 7d z doby, żeby noc bez pracy obniżała tempo jak w rzeczywistości
  { key: '5h', pct: 'five_hour_pct', resets: 'five_hour_resets_at', lookback: 3600 },
  { key: '7d', pct: 'seven_day_pct', resets: 'seven_day_resets_at', lookback: 86400 },
];
const MIN_ELAPSED = 300;  // poniżej 5 min danych tempa nie liczymy
const SAME_RESET = 120;   // resets_at różniące się o mniej niż 2 min = to samo okno
const OWN_DROP = 2;       // spadek tej samej sesji o >= 2 pp = reset
const DROP = 10;          // "wyraźnie poniżej szczytu" dla innych sesji
const STALE_AFTER = 30 * 60;

function readSamples(dbPath = DB_PATH, since = Date.now() / 1000 - 8 * 86400) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
  try {
    return db.prepare(`SELECT ts, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, source_session
      FROM usage_samples WHERE ts >= ? ORDER BY ts`).all(since);
  } finally { db.close(); }
}

// Odczyty bieżącej serii okna: [{ at, pct, session }], plus czy w oknie był reset (nowa seria).
function currentSeries(readings) {
  let series = [], peak = -1, peakAt = 0, prevPeak = null, own = new Map(), resets = 0;
  for (const r of readings) {
    const mine = own.get(r.session);
    const ownDrop = mine && mine.max - r.pct >= OWN_DROP;
    // ta sama sesja: wcześniej odczyt po szczycie, poniżej szczytu, teraz wyżej, ale nadal wyraźnie poniżej
    const aliveLow = mine && mine.lastAt > peakAt && mine.last <= peak - DROP && r.pct > mine.last && r.pct <= peak - DROP;
    if (ownDrop || aliveLow) {
      resets++;
      prevPeak = peak;
      series = aliveLow ? [{ at: mine.lastAt, pct: mine.last, session: r.session }] : [];
      peak = aliveLow ? mine.last : -1;
      peakAt = aliveLow ? mine.lastAt : 0;
      own = new Map(aliveLow ? [[r.session, { max: mine.last, last: mine.last, lastAt: mine.lastAt }]] : []);
    } else if (!mine && prevPeak != null && r.pct >= prevPeak - DROP && r.pct > peak + DROP) {
      continue; // po resecie pierwszy odczyt sesji na poziomie sprzed resetu = przeterminowany sprzed kuponu
    }
    series.push(r);
    const m = own.get(r.session);
    own.set(r.session, { max: Math.max(m?.max ?? -1, r.pct), last: r.pct, lastAt: r.at });
    if (r.pct >= peak) { peak = r.pct; peakAt = r.at; }
  }
  return { series, reset: resets > 0 };
}

// Prognoza jak claudash forecast(): tempo z obwiedni (odczyty >= bieżące maksimum) w oknie wstecz.
function forecast(series, resetsAt, lookback, now) {
  const env = [];
  let max = -1;
  for (const r of series) if (r.pct >= max) { max = r.pct; env.push(r); }
  const current = max;
  const recent = env.filter((r) => now - r.at <= lookback);
  if (recent.length < 2) return { state: 'insufficient' };
  const first = recent[0], last = recent[recent.length - 1];
  const elapsed = last.at - first.at;
  if (elapsed < MIN_ELAPSED) return { state: 'insufficient' };
  const perSec = (current - first.pct) / elapsed;
  const ratePerHour = Math.round(perSec * 3600 * 10) / 10;
  // span: z ilu sekund danych liczone tempo (lib/usage-alerts.js nie budzi prognozą z krótkiego odcinka)
  if (perSec <= 0) return { state: 'safe', ratePerHour: 0, span: elapsed };
  const at = Math.round(now + Math.max(0, 100 - current) / perSec);
  return at < resetsAt ? { state: 'limit', at, ratePerHour, span: elapsed } : { state: 'safe', ratePerHour, span: elapsed };
}

function analyzeWindow(rows, w, now) {
  const all = rows.filter((s) => s[w.pct] != null && s[w.resets] != null);
  if (!all.length) return { key: w.key, state: 'nodata' };
  // bieżące okno = najpóźniejszy reset; przeterminowane odczyty z poprzedniego okna mają wcześniejszy
  const resetsAt = Math.max(...all.map((s) => s[w.resets]));
  const inWindow = all.filter((s) => resetsAt - s[w.resets] < SAME_RESET)
    .map((s) => ({ at: s.ts, pct: Math.round(s[w.pct] * 10) / 10, session: s.source_session || '' }));
  const lastAt = inWindow[inWindow.length - 1].at;
  const base = { key: w.key, resetsAt, sampleAt: lastAt, age: Math.max(0, Math.round(now - lastAt)) };
  base.stale = base.age > STALE_AFTER;
  if (resetsAt <= now) return { ...base, state: 'expired', pct: 0 }; // okno minęło, nowych próbek jeszcze brak
  const { series, reset } = currentSeries(inWindow);
  const pct = Math.max(...series.map((r) => r.pct));
  const fc = forecast(series, resetsAt, w.lookback, now);
  const level = pct >= 90 ? 'crit' : pct >= 70 || fc.state === 'limit' ? 'warn' : 'ok';
  return { ...base, state: 'ok', pct, resetIn: Math.round(resetsAt - now), seriesReset: reset, level, forecast: fc };
}

function analyze(rows, now = Date.now() / 1000) {
  return { now: Math.round(now), windows: WINDOWS.map((w) => analyzeWindow(rows, w, now)) };
}

function usageStatus(dbPath = DB_PATH, now = Date.now() / 1000) {
  let rows;
  try { rows = readSamples(dbPath, now - 8 * 86400); }
  catch (e) { return { now: Math.round(now), error: /no such table|unable to open|SQLITE_CANTOPEN/i.test(e.message) ? 'Brak bazy pomiaru mozgd' : e.message, windows: [] }; }
  return analyze(rows, now);
}

module.exports = { analyze, analyzeWindow, currentSeries, forecast, readSamples, usageStatus, WINDOWS, DB_PATH };
