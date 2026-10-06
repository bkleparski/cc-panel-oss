'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { codexUsage, analyzeSample, lastSample } = require('../lib/codex-usage');
const { decide, usageAttention, CODEX } = require('../lib/usage-alerts');
const { miniUsage } = require('../public/usage-mini');
const H = require('../public/hdr-icons');

const NOW = 1791216000;
const iso = (t) => new Date(t * 1000).toISOString();
const rl = (p5, r5, p7, r7, o = {}) => ({ limit_id: 'codex', limit_name: null,
  primary: { used_percent: p5, window_minutes: 300, resets_at: r5 },
  secondary: { used_percent: p7, window_minutes: 10080, resets_at: r7 },
  credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus', rate_limit_reached_type: null, ...o });
const tc = (at, limits) => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: limits } });
const other = (at, type) => JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type } });

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  for (const [rel, lines, mtime] of files) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, lines.join('\n') + '\n');
    if (mtime) fs.utimesSync(f, mtime, mtime);
  }
  return root;
}
const R = (d, n) => `2026/10/${d}/rollout-2026-10-${d}T10-00-00-0000000${n}-0000-0000-0000-000000000000.jsonl`;

test('sample: newest rate_limits across files, windows mapped by window_minutes, fresh = not stale', () => {
  const root = tree([
    [R('04', 1), [tc(NOW - 90000, rl(50, NOW - 80000, 40, NOW + 100000))], NOW - 90000],
    [R('05', 2), [other(NOW - 200, 'task_started'), tc(NOW - 120, rl(12, NOW + 9000, 33, NOW + 400000)), other(NOW - 100, 'task_complete')], NOW - 100],
  ]);
  const c = codexUsage(root, NOW, new Map());
  assert.equal(c.provider, 'codex');
  assert.equal(c.planType, 'plus');
  assert.equal(c.reached, null);
  assert.equal(c.age, 120);
  assert.equal(c.stale, false);
  assert.deepEqual(c.windows.map((w) => [w.key, w.state, w.pct, w.level, w.resetIn]), [['5h', 'ok', 12, 'ok', 9000], ['7d', 'ok', 33, 'ok', 400000]]);
  assert.equal(c.windows[0].forecast.state, 'off');
});

test('no samples: missing dir, empty files, rollouts without rate_limits = null (no error)', () => {
  assert.equal(codexUsage('/nonexistent/codex', NOW, new Map()), null);
  const root = tree([[R('05', 1), [other(NOW - 10, 'task_started'), '{zepsuta linia']]]);
  assert.equal(codexUsage(root, NOW, new Map()), null);
  assert.equal(analyzeSample({ at: NOW, rl: { primary: null, secondary: 'x' } }, NOW), null);
  assert.equal(lastSample('{"timestamp":"x","payload":{"rate_limits":{}}}'), null); // zły timestamp
});

test('stale: old sample keeps the last value, 5h past reset = expired 0%', () => {
  const c = analyzeSample({ at: NOW - 3 * 3600, rl: rl(60, NOW - 600, 16, NOW + 300000) }, NOW);
  assert.equal(c.stale, true);
  assert.deepEqual(c.windows.map((w) => [w.key, w.state, w.pct, w.stale]), [['5h', 'expired', 0, true], ['7d', 'ok', 16, true]]);
  const m = miniUsage({ windows: [], codex: c }, String);
  assert.deepEqual(m.codex.items.map((x) => [x.key, x.text, x.dim, !!x.ghost]), [['5h', '0%', true, false], ['7d', '16%', true, true]]);
  assert.equal(m.codex.age, 'sprzed 3 h');
  assert.match(m.label, /Codex: 5h okno zresetowane.*7d 16%, reset \d+, dane sprzed 3 h$/);
  // pierścień: stara wartość na szaro zamiast "–", z plakietką X
  const ring = H.ringSvg(m.codex.items, 'X', 'ur-codex');
  assert.match(ring, /class="um-ring ur-codex"/);
  assert.match(ring, /class="ur-num dim"[^>]*>16</);
  assert.match(ring, /ur-arc dim ur-7d" .*stroke-dasharray="16 100"/);
  assert.match(ring, />X<\/text>/);
});

test('resets_at change: newer sample with a new window wins, cache reads only the appended part', () => {
  const root = tree([[R('05', 1), [tc(NOW - 4000, rl(80, NOW - 3000, 30, NOW + 100000))], NOW - 4000]]);
  const cache = new Map();
  const a = codexUsage(root, NOW - 3500, cache);
  assert.deepEqual([a.windows[0].state, a.windows[0].pct, a.windows[0].level], ['ok', 80, 'warn']);
  const f = path.join(root, R('05', 1));
  const sizeBefore = fs.statSync(f).size;
  fs.appendFileSync(f, tc(NOW - 60, rl(3, NOW + 17000, 31, NOW + 100005)) + '\n');
  const b = codexUsage(root, NOW, cache);
  assert.deepEqual([b.windows[0].pct, b.windows[0].resetsAt, b.windows[1].pct], [3, NOW + 17000, 31]);
  assert.ok(cache.get(f).size > sizeBefore);
  // przyrost bez próbki: zostaje poprzednia
  fs.appendFileSync(f, other(NOW - 30, 'task_complete') + '\n');
  assert.equal(codexUsage(root, NOW, cache).windows[0].pct, 3);
});

test('reached: rate_limit_reached_type is passed through and shown', () => {
  const c = analyzeSample({ at: NOW - 30, rl: rl(100, NOW + 3000, 45, NOW + 90000, { rate_limit_reached_type: 'primary' }) }, NOW);
  assert.equal(c.reached, 'primary');
  assert.equal(c.windows[0].level, 'crit');
  assert.match(miniUsage({ windows: [], codex: c }).label, /limit osiągnięty \(primary\)/);
});

test('push: Codex only crit >= 90%, once per window series, separate state keys, stale skipped', () => {
  const fresh = analyzeSample({ at: NOW - 30, rl: rl(91, NOW + 3000, 75, NOW + 90000) }, NOW);
  const r = decide(fresh, { '5h': { resetsAt: 1, peak: 1, limitAt: null, crit: true } }, NOW, {}, CODEX);
  assert.deepEqual(r.notes.map((n) => [n.key, n.kind, n.title, n.tag]), [['codex:5h', 'crit', '🔴 Limit Codex 5h: 91%', 'usage-codex-5h']]);
  assert.equal(r.state['5h'].crit, true); // stan Claude nietknięty
  assert.equal(decide(fresh, r.state, NOW + 300, {}, CODEX).notes.length, 0);
  // nowe okno = nowa seria
  const next = analyzeSample({ at: NOW + 3100, rl: rl(92, NOW + 21000, 76, NOW + 90000) }, NOW + 3130);
  assert.equal(decide(next, r.state, NOW + 3130, {}, CODEX).notes.length, 1);
  const stale = analyzeSample({ at: NOW - 7200, rl: rl(95, NOW + 3000, 50, NOW + 90000) }, NOW);
  const s = decide(stale, {}, NOW, {}, CODEX);
  assert.equal(s.notes.length, 0);
  assert.match(s.skipped[0], /^Codex 5h: dane sprzed 120 min/);
  assert.deepEqual(decide(null, {}, NOW, {}, CODEX).notes, []);
  assert.deepEqual(usageAttention(fresh, NOW, CODEX).map((a) => a.id), ['usage:codex:5h']);
});

test('mini without Codex data stays as before (no codex section, no tags)', () => {
  const m = miniUsage({ windows: [{ key: '5h', state: 'ok', pct: 5, level: 'ok', resetsAt: 1, forecast: {} }], codex: null }, String);
  assert.equal(m.codex, null);
  assert.match(m.label, /^Limit planu: 5h 5%/);
  assert.doesNotMatch(H.ringSvg(m.items), /ur-tag/);
});
