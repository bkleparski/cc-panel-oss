const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, usageAttention, quiet, when, DEFAULTS } = require('../lib/usage-alerts');

// pon. 05.10.2026 12:00 czasu warszawskiego (CEST = UTC+2)
const NOON = Date.UTC(2026, 9, 5, 10, 0) / 1000;
const H = 3600;
const R7 = NOON + 2 * 86400;   // reset 7d: śr. 12:00
const R5 = NOON + 3 * H;       // reset 5h: 15:00
// okno z analyze(): domyślnie 7d na 75%, prognoza limitu z 4 h danych
const w7 = (o = {}) => ({ key: '7d', state: 'ok', pct: 75, resetsAt: R7, stale: false, age: 60, level: 'warn',
  forecast: { state: 'limit', at: NOON + 30 * H, ratePerHour: 0.5, span: 4 * H }, ...o });
const w5 = (o = {}) => ({ key: '5h', state: 'ok', pct: 60, resetsAt: R5, stale: false, age: 60, level: 'warn',
  forecast: { state: 'limit', at: NOON + 2 * H, ratePerHour: 20, span: 40 * 60 }, ...o });
const u = (...windows) => ({ windows });

test('first limit forecast in a window sends one push with ETA, reset and pace', () => {
  const r = decide(u(w7()), {}, NOON);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].kind, 'limit');
  assert.equal(r.notes[0].title, '⏳ Limit 7d przed resetem');
  assert.equal(r.notes[0].body, 'Limit 7d skończy się ok. wt. 18:00 (reset śr. 12:00) przy tempie 0,5 pp/h. Teraz 75%.');
  assert.equal(r.notes[0].url, '/#/limit');
  assert.equal(r.state['7d'].limitAt, NOON + 30 * H);
});

test('dedup: the same window does not push again, small ETA shifts are ignored', () => {
  const first = decide(u(w7()), {}, NOON).state;
  assert.equal(decide(u(w7()), first, NOON + 300).notes.length, 0);
  // wcześniej o 1,5 h (< 2 h dla 7d) - nadal cisza; później - też cisza
  assert.equal(decide(u(w7({ forecast: { ...w7().forecast, at: NOON + 28.5 * H } })), first, NOON + 600).notes.length, 0);
  assert.equal(decide(u(w7({ forecast: { ...w7().forecast, at: NOON + 40 * H } })), first, NOON + 600).notes.length, 0);
});

test('ETA moved earlier by more than the threshold pushes again (7d: 2 h, 5h: 30 min)', () => {
  const s7 = decide(u(w7()), {}, NOON).state;
  const r7 = decide(u(w7({ forecast: { ...w7().forecast, at: NOON + 27 * H } })), s7, NOON + 600);
  assert.equal(r7.notes.length, 1);
  assert.match(r7.notes[0].title, /wcześniej/);
  assert.equal(r7.state['7d'].limitAt, NOON + 27 * H);
  const s5 = decide(u(w5()), {}, NOON).state;
  assert.equal(decide(u(w5({ forecast: { ...w5().forecast, at: NOON + 2 * H - 20 * 60 } })), s5, NOON + 300).notes.length, 0);
  assert.equal(decide(u(w5({ forecast: { ...w5().forecast, at: NOON + 2 * H - 40 * 60 } })), s5, NOON + 300).notes.length, 1);
});

test('crit (>= 90%) is a second push, once per window, and carries the ETA', () => {
  const s = decide(u(w7()), {}, NOON).state;
  const crit = w7({ pct: 91, level: 'crit', forecast: { ...w7().forecast, at: NOON + 29 * H } });
  const r = decide(u(crit), s, NOON + H);
  assert.deepEqual(r.notes.map((n) => n.kind), ['crit']);
  assert.equal(r.notes[0].title, '🔴 Limit 7d: 91%');
  assert.match(r.notes[0].body, /Reset śr\. 12:00\. Przy tempie 0,5 pp\/h skończy się ok\. wt\. 17:00\./);
  assert.equal(decide(u(crit), r.state, NOON + 2 * H).notes.length, 0);
  // crit bez prognozy limitu (np. insufficient) też idzie - to fakt, nie prognoza
  assert.equal(decide(u(w7({ pct: 92, level: 'crit', forecast: { state: 'insufficient' } })), {}, NOON).notes[0].kind, 'crit');
});

test('new resets_at or a coupon reset (same resets_at, usage drops) starts the count again', () => {
  const s = decide(u(w7({ pct: 91, level: 'crit' })), {}, NOON).state;
  assert.equal(s['7d'].crit, true);
  // kupon: resets_at bez zmian, procent spadł z 91 do 4, potem znowu limit przed resetem
  const after = decide(u(w7({ pct: 4, level: 'ok', forecast: { state: 'insufficient' } })), s, NOON + H);
  assert.equal(after.notes.length, 0);
  assert.deepEqual(after.state['7d'], { resetsAt: R7, peak: 4, limitAt: null, crit: false });
  assert.equal(decide(u(w7({ pct: 40 })), after.state, NOON + 5 * H).notes[0].kind, 'limit');
  // nowe okno 7d (inny resets_at)
  assert.equal(decide(u(w7({ resetsAt: R7 + 7 * 86400 })), s, NOON + 2 * 86400 + 60).notes[0].kind, 'limit');
  // drobny spadek procentu (< 2 pp) to nie reset
  assert.equal(decide(u(w7({ pct: 90, level: 'crit' })), s, NOON + 600).notes.length, 0);
});

test('stale data, insufficient forecast or too short data span = no push', () => {
  const stale = decide(u(w7({ stale: true, age: 40 * 60 }), w5({ stale: true, age: 40 * 60, pct: 95, level: 'crit' })), {}, NOON);
  assert.equal(stale.notes.length, 0);
  assert.equal(stale.skipped.length, 2);
  assert.equal(decide(u(w7({ forecast: { state: 'insufficient' } })), {}, NOON).notes.length, 0);
  // 7d: 2 h danych < 3 h; 5h: 20 min < 30 min
  assert.equal(decide(u(w7({ forecast: { ...w7().forecast, span: 2 * H } })), {}, NOON).notes.length, 0);
  assert.equal(decide(u(w5({ forecast: { ...w5().forecast, span: 20 * 60 } })), {}, NOON).notes.length, 0);
  assert.equal(decide(u(w5()), {}, NOON).notes.length, 1);
  // nie oznaczam jako wysłane - gdy danych przybędzie, push pójdzie
  const short = decide(u(w7({ forecast: { ...w7().forecast, span: 2 * H } })), {}, NOON);
  assert.equal(decide(u(w7()), short.state, NOON + H).notes.length, 1);
});

test('quiet hours (22-7 Warsaw) hold back only 5h limit warnings; 7d and crit always; sent after quiet', () => {
  const night = NOON + 11 * H; // 23:00
  const win5 = w5({ resetsAt: night + 3 * H, forecast: { ...w5().forecast, at: night + 2 * H } });
  const r = decide(u(win5, w7()), {}, night);
  assert.deepEqual(r.notes.map((n) => n.key), ['7d']);
  assert.deepEqual(r.skipped, ['5h: godziny ciszy']);
  assert.equal(decide(u(w5({ pct: 93, level: 'crit' })), {}, night).notes[0].kind, 'crit');
  // po 7:00 ostrzeżenie 5h, które przeczekało ciszę, idzie
  const morning = NOON - 4 * H; // 08:00
  assert.equal(decide(u(w5({ resetsAt: morning + 3 * H, forecast: { ...w5().forecast, at: morning + 2 * H } })), r.state, morning).notes.length, 1);
  assert.equal(quiet(NOON - 5 * H - 60, DEFAULTS), true);  // 06:59
  assert.equal(quiet(NOON - 5 * H, DEFAULTS), false);           // 07:00
  assert.equal(quiet(NOON + 10 * H, DEFAULTS), true);           // 22:00
  assert.equal(quiet(NOON, { quietFrom: '00:00', quietTo: '00:00' }), false);
});

test('disabled in config = nothing; time format is local Warsaw time with weekday for other days', () => {
  assert.equal(decide(u(w7()), {}, NOON, { enabled: false }).notes.length, 0);
  assert.equal(when(NOON + H, NOON), '13:00');
  assert.equal(when(NOON + 30 * H, NOON), 'wt. 18:00');
});

test('bell entries mirror the current reliable state, without dedup or quiet hours', () => {
  const night = NOON + 11 * H;
  const items = usageAttention(u(w5({ resetsAt: night + 3 * H, forecast: { ...w5().forecast, at: night + 2 * H } }), w7({ pct: 95, level: 'crit' })), night);
  assert.deepEqual(items.map((i) => [i.id, i.url]), [['usage:5h', '/#/limit'], ['usage:7d', '/#/limit']]);
  assert.equal(items[1].title, '🔴 Limit 7d: 95%');
  assert.equal(usageAttention(u(w7({ stale: true })), NOON).length, 0);
  assert.equal(usageAttention(u(w7({ forecast: { state: 'safe', ratePerHour: 0.1 } })), NOON).length, 0);
});
