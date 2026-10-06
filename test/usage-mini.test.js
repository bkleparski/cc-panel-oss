'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const { miniUsage } = require('../public/usage-mini');

const fmt = (t) => `@${t}`;
const ok = (key, pct, level, o) => ({ key, state: 'ok', pct, level, resetsAt: 100, stale: false, forecast: { state: 'safe' }, ...o });

test('fetch failure, missing db and empty windows: both items greyed, not hidden', () => {
  for (const u of [null, { error: 'Brak bazy pomiaru mozgd', windows: [] }, { windows: [] }]) {
    const m = miniUsage(u, fmt);
    assert.equal(m.off, true);
    assert.deepEqual(m.items.map((x) => [x.key, x.text, x.dim]), [['5h', '–', true], ['7d', '–', true]]);
    assert.match(m.label, /^Limit planu: /);
  }
  assert.match(miniUsage({ error: 'Brak bazy pomiaru mozgd', windows: [] }).label, /Brak bazy/);
});

test('levels are readable without colour: warn "!", crit "!!"', () => {
  const m = miniUsage({ windows: [ok('5h', 22.4, 'ok'), ok('7d', 71.6, 'warn')] }, fmt);
  assert.equal(m.off, false);
  assert.deepEqual(m.items.map((x) => [x.key, x.text, x.level, x.dim]), [['5h', '22%', 'ok', false], ['7d', '72%!', 'warn', false]]);
  assert.equal(miniUsage({ windows: [ok('5h', 93, 'crit')] }).items[0].text, '93%!!');
});

test('label carries reset and forecast ETA for hover/screen readers', () => {
  const m = miniUsage({ windows: [ok('5h', 5, 'ok'), ok('7d', 72, 'warn', { forecast: { state: 'limit', at: 555 } })] }, fmt);
  assert.equal(m.label, 'Limit planu: 5h 5%, reset @100; 7d 72% (uwaga), reset @100, limit ~@555 przy obecnym tempie');
});

test('stale, expired and nodata windows are dimmed; all dimmed = off', () => {
  const m = miniUsage({ windows: [ok('5h', 40, 'ok', { stale: true }), { key: '7d', state: 'nodata' }] }, fmt);
  assert.deepEqual(m.items.map((x) => [x.text, x.dim]), [['40%', true], ['–', true]]);
  assert.equal(m.off, true);
  assert.match(m.label, /dane nieaktualne/);
  const e = miniUsage({ windows: [{ key: '5h', state: 'expired', resetsAt: 1 }, ok('7d', 10, 'ok')] }, fmt);
  assert.deepEqual(e.items.map((x) => [x.text, x.dim]), [['0%', true], ['10%', false]]);
  assert.equal(e.off, false);
});

test('bar fill is clamped to 0-100', () => {
  assert.equal(miniUsage({ windows: [ok('5h', 130, 'crit')] }).items[0].pct, 100);
});
