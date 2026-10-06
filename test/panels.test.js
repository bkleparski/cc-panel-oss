'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {plError, bindParams} = require('../lib/panels');
const {split, detail, statusText, minutes} = require('../public/mozg-panels');
const {parse, matches} = require('../public/session-search');

test('plError: mozgd errors become readable Polish', () => {
  const titles = {'4d38': 'mesa'};
  assert.equal(plError('panel w1V:p1 jest juz podpiety do watku 4d38; najpierw panel_unbind', titles),
    'Panel w1V:p1 jest już podpięty do zakładki „mesa” - najpierw go odepnij.');
  assert.match(plError("niejednoznaczna etykieta 'dup': w9:p1, w9:p2 - podaj id panelu"), /„dup” pasuje do kilku paneli \(w9:p1, w9:p2\)/);
  assert.match(plError("nie znaleziono panelu 'mesa-migracja'"), /Nie znalazłem panelu „mesa-migracja”/);
  assert.match(plError('panel w99:p9 nie istnieje'), /w99:p9 nie istnieje już w Herdr/);
  assert.match(plError('to panel mozgu - nie do podpiecia'), /panel mózgu/);
  assert.match(plError('to worker rotatora - nie do podpiecia (rotator nim zarzadza)'), /worker rotatora/);
  assert.match(plError('register first'), /restart mozgd/);
  assert.match(plError('internal error; reconciliation may be required'), /Herdr albo rotatora/);
  assert.equal(plError('coś innego'), 'coś innego');
});

test('bindParams: only existing tab, optional interval 1-1440', () => {
  const ids = new Set(['general', '4d38']);
  assert.deepEqual(bindParams({panel: 'mesa-monitoring', thread_id: '4d38'}, ids).params, {panel: 'mesa-monitoring', thread: '4d38'});
  assert.deepEqual(bindParams({panel: 'w1V:p1', thread_id: 'general', min_interval_min: 60}, ids).params, {panel: 'w1V:p1', thread: 'general', min_interval_min: 60});
  assert.deepEqual(bindParams({panel: 'x', thread_id: 'general', min_interval_min: ''}, ids).params, {panel: 'x', thread: 'general'});
  // nieznana zakładka nie trafia do mozgd (panel_bind założyłby z niej nowy wątek projektu)
  assert.ok(bindParams({panel: 'x', thread_id: 'klienci/mesa'}, ids).error);
  assert.ok(bindParams({panel: '  ', thread_id: 'general'}, ids).error);
  assert.ok(bindParams({panel: 'x'.repeat(201), thread_id: 'general'}, ids).error);
  for (const bad of [0, 1441, 1.5, '30', true]) assert.ok(bindParams({panel: 'x', thread_id: 'general', min_interval_min: bad}, ids).error, String(bad));
  assert.ok(bindParams(null, ids).error);
});

const PANELS = [
  {id: 'w1V:p1', label: 'mesa-monitoring', title: 'mesa-monitoring', agent_status: 'done', bindable: true, binding: null, selector: 'mesa-monitoring'},
  {id: 'wD:p1', label: 'mesa-coding', title: 'mesa-coding', agent_status: 'idle', bindable: true, binding: {id: 'b2', thread_id: 'general', min_interval_s: 1800}},
  {id: 'w9:p1', label: 'źródła', title: 'bash', agent_status: 'unknown', bindable: true, binding: {id: 'b1', thread_id: 'mes', min_interval_s: 3600}},
  {id: 'w28:pZ', label: 'mozg-g17-general', agent_status: 'done', bindable: false, reason: 'to panel mozgu', binding: null},
  {id: 'w2D:pS', label: 'worker-g1', agent_status: 'working', bindable: false, reason: 'worker', binding: null},
  {id: 'w3:p1', label: 'beacon', agent_status: 'working', bindable: true, binding: null},
];

test('split: bound to this tab, candidates searchable (bound elsewhere last), brain/workers hidden', () => {
  const all = split(PANELS, 'mes', [], matches);
  assert.deepEqual(all.bound.map(p => p.id), ['w9:p1']);
  assert.deepEqual(all.candidates.map(p => p.id), ['w3:p1', 'w1V:p1', 'wD:p1']);
  assert.equal(all.hidden, 2);
  assert.deepEqual(split(PANELS, 'mes', parse('MESA monit'), matches).candidates.map(p => p.id), ['w1V:p1']);
  assert.deepEqual(split(PANELS, 'mes', parse('w3:p1'), matches).candidates.map(p => p.id), ['w3:p1']);
  assert.deepEqual(split(PANELS, 'general', parse('zrodla'), matches).candidates.map(p => p.id), ['w9:p1']);
  assert.deepEqual(split(null, 'x', [], matches), {bound: [], candidates: [], hidden: 0});
});

test('detail and status texts', () => {
  assert.equal(detail(PANELS[0]), 'w1V:p1 · skończył turę');
  assert.equal(detail(PANELS[2]), 'w9:p1 · bez agenta · bash');
  assert.equal(statusText('blocked'), 'czeka na zgodę');
  assert.equal(statusText(undefined), '?');
  assert.equal(minutes(1800), 30);
});
