const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyze, forecast, currentSeries, readSamples, usageStatus } = require('../lib/usage');

const R5 = 20_000, R7 = 500_000;
// próbka mozgd: [ts, 5h%, 7d%, sesja], resety domyślnie R5/R7
const row = (ts, five, seven = 50, session = 'a', r5 = R5) => ({ ts, five_hour_pct: five, five_hour_resets_at: five == null ? null : r5,
  seven_day_pct: seven, seven_day_resets_at: R7, source_session: session });
const win = (a, key) => a.windows.find((w) => w.key === key);

test('forecast: limit before reset at the current pace (claudash case: 10 -> 40% in 1500 s)', () => {
  const s = [{ at: 1000, pct: 10 }, { at: 2500, pct: 40 }];
  assert.deepEqual(forecast(s, 9000, 3600, 2500), { state: 'limit', at: 5500, ratePerHour: 72, span: 1500 });
  assert.equal(forecast(s, 4000, 3600, 2500).state, 'safe'); // okno resetuje się wcześniej
});

test('forecast: too few samples or under 5 minutes of data = insufficient, flat usage = safe', () => {
  assert.deepEqual(forecast([{ at: 1000, pct: 10 }], 9000, 3600, 1000), { state: 'insufficient' });
  assert.deepEqual(forecast([], 9000, 3600, 1000), { state: 'insufficient' });
  assert.deepEqual(forecast([{ at: 1000, pct: 10 }, { at: 1299, pct: 30 }], 9000, 3600, 1299), { state: 'insufficient' });
  assert.deepEqual(forecast([{ at: 1000, pct: 10 }, { at: 2000, pct: 10 }], 9000, 3600, 2000), { state: 'safe', ratePerHour: 0, span: 1000 });
  // próbki starsze niż okno wstecz nie liczą się do tempa
  assert.deepEqual(forecast([{ at: 0, pct: 0 }, { at: 5000, pct: 50 }], 99999, 3600, 5000), { state: 'insufficient' });
});

test('stale lower readings from other sessions do not lower usage nor start a new series', () => {
  const rows = [row(1000, 60, 50, 'a'), row(1300, 70, 51, 'a'), row(1400, 47, 48, 'old1'), row(1500, 49, 48, 'old2'),
    row(1600, 72, 51, 'a'), row(1700, 52, 48, 'old3')];
  const w = win(analyze(rows, 1800), '5h');
  assert.equal(w.pct, 72);
  assert.equal(w.seriesReset, false);
  assert.equal(w.forecast.state, 'limit'); // 60 -> 72 w 600 s, 28 pp przy 0,02 pp/s = 1400 s < reset
  assert.equal(w.forecast.at, 1800 + 1400);
});

test('coupon reset inside the window (same resets_at): forecast only from samples after the drop', () => {
  // sesja a: 80% i dalej 0 -> 5 -> 10 po kuponie; przeterminowany odczyt innej sesji nie psuje serii
  const rows = [row(1000, 70, 60, 'a'), row(2000, 80, 61, 'a'), row(2100, 0, 61, 'a'), row(2200, 79, 61, 'old'),
    row(2400, 5, 61, 'a'), row(2700, 10, 62, 'a')];
  const w = win(analyze(rows, 2700), '5h');
  assert.equal(w.seriesReset, true);
  assert.equal(w.pct, 10);
  // tempo 0 -> 10 w 600 s = 60 pp/h, nie z próbek sprzed resetu
  assert.equal(w.forecast.ratePerHour, 60);
  assert.equal(w.forecast.at, 2700 + 90 * 60);
});

test('coupon reset noticed through a fresh session that keeps growing well below the old peak', () => {
  const rows = [row(1000, 75, 60, 'a'), row(2000, 85, 61, 'a'), row(2100, 3, 61, 'b'), row(2500, 8, 61, 'b')];
  const { series, reset } = currentSeries(rows.map((r) => ({ at: r.ts, pct: r.five_hour_pct, session: r.source_session })));
  assert.equal(reset, true);
  assert.deepEqual(series.map((r) => r.pct), [3, 8]);
  // jeden niski odczyt nowej sesji to jeszcze nie reset (tak wyglądają przeterminowane)
  assert.equal(currentSeries([{ at: 1, pct: 80, session: 'a' }, { at: 2, pct: 3, session: 'b' }]).reset, false);
});

test('reset just after the drop with too few samples = insufficient, not an error', () => {
  const rows = [row(1000, 70, 60, 'a'), row(2000, 80, 61, 'a'), row(2100, 1, 61, 'a')];
  const w = win(analyze(rows, 2150), '5h');
  assert.equal(w.seriesReset, true);
  assert.equal(w.pct, 1);
  assert.deepEqual(w.forecast, { state: 'insufficient' });
});

test('new 5h window (later resets_at) ignores the previous one; stale readings from the old window skipped', () => {
  const rows = [row(1000, 90, 50, 'a', 15_000), row(15_100, 2, 50, 'a', 33_000), row(15_200, 88, 50, 'old', 15_000), row(15_800, 6, 50, 'a', 33_000)];
  const w = win(analyze(rows, 15_900), '5h');
  assert.equal(w.resetsAt, 33_000);
  assert.equal(w.pct, 6);
  assert.equal(w.seriesReset, false);
});

test('no data, inactive 5h window, expired window and stale age are readable states', () => {
  assert.deepEqual(analyze([], 100).windows.map((w) => w.state), ['nodata', 'nodata']);
  assert.equal(win(analyze([row(1000, null, 40)], 1100), '5h').state, 'nodata');
  const expired = win(analyze([row(1000, 50)], R5 + 10), '5h');
  assert.equal(expired.state, 'expired');
  assert.equal(expired.pct, 0);
  const old = win(analyze([row(1000, 50)], 1000 + 31 * 60), '5h');
  assert.equal(old.stale, true);
  assert.equal(old.age, 31 * 60);
  assert.equal(win(analyze([row(1000, 50)], 1100), '7d').stale, false);
});

test('readSamples opens the mozgd database read-only; missing database = readable error', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-usage-'));
  const file = path.join(dir, 'mozg.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE usage_samples (ts REAL PRIMARY KEY, five_hour_pct REAL, five_hour_resets_at REAL,
    seven_day_pct REAL, seven_day_resets_at REAL, source_session TEXT, other_sessions INTEGER)`);
  db.prepare('INSERT INTO usage_samples VALUES (?, ?, ?, ?, ?, ?, ?)').run(1000, 10, R5, 40, R7, 'a', null);
  db.prepare('INSERT INTO usage_samples VALUES (?, ?, ?, ?, ?, ?, ?)').run(1600, 20, R5, 41, R7, 'a', 2);
  db.close();
  try {
    assert.equal(readSamples(file, 0).length, 2);
    assert.equal(readSamples(file, 1500).length, 1);
    const st = usageStatus(file, 1700);
    assert.equal(win(st, '5h').pct, 20);
    assert.equal(fs.statSync(file).size > 0, true);
    const missing = usageStatus(path.join(dir, 'brak.db'), 1700);
    assert.equal(missing.windows.length, 0);
    assert.match(missing.error, /Brak bazy/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
