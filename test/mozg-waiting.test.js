'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {candidates, refs, resolve} = require('../public/mozg-waiting');
const herdr = [
  {name:'medley-falcon',display:'medley-falcon-coding',workspace:'medley-falcon',tabLabel:'1',machine:'coding',pane:'wR:p1',agent:'claude',status:'done'},
  {name:'beacon',display:'beacon-migracja',workspace:'beacon',tabLabel:'1',machine:'coding',pane:'w1Y:p1',agent:'claude',status:'working'},
  {name:'mesa',display:'Kopia crontab s24',workspace:'mesa',tabLabel:'1',machine:'coding',pane:'w38:p1',agent:'claude',status:'approval'},
  {name:'mesa-coding',display:'mesa-coding',workspace:'mesa-coding',tabLabel:'1',machine:'coding',pane:'wD:p1',agent:'claude',status:'idle'},
  {name:'workers · A',display:'A',workspace:'workers',tabLabel:'t-a-g1',machine:'coding',pane:'w35:p1R',agent:'claude',status:'idle'},
  {name:'workers · B',display:'B',workspace:'workers',tabLabel:'t-b-g1',machine:'coding',pane:'w35:p1S',agent:'claude',status:'idle'},
  {name:'medley-falcon · bash',display:'medley-falcon · bash',workspace:'medley-falcon',tabLabel:'2',machine:'coding',pane:'wR:p2',status:'shell'},
  {name:'mozg-mozgi · x',display:'📡 medley',workspace:'mozg-mozgi',tabLabel:'mozg-g64-abc',machine:'coding',pane:'w36:p0',agent:'claude',status:'done'},
];
const tmux = [{name:'cc-delta',kind:'claude',status:'approval'},{name:'ccp-shell',kind:'',status:'shell'}];
const c = candidates(herdr, tmux);
const keys = r => r.map(x => x.key);
test('candidates: agents only, brain panes and shells skipped, stable keys and hashes', () => {
  assert.deepEqual(keys(c), ['h:coding/wR:p1','h:coding/w1Y:p1','h:coding/w38:p1','h:coding/wD:p1','h:coding/w35:p1R','h:coding/w35:p1S','s:cc-delta']);
  assert.equal(c[0].hash, '#/h/coding/wR%3Ap1');
  assert.equal(c.at(-1).hash, '#/s/cc-delta');
});
test('message from the screenshot maps to the medley-falcon pane by key', () => {
  const r = refs('medley-falcon: panel czeka na Twoje „zapisz” (reguła o klasyfikatorze i draftach do pamięci).\n- Monitor poczty działa, o 16:00 przestaje się wznawiać', c);
  assert.deepEqual(r, [{key:'h:coding/wR:p1',hash:'#/h/coding/wR%3Ap1',label:'medley-falcon-coding',status:'done',waiting:true}]);
});
test('only sentences that say something waits; names elsewhere are ignored', () => {
  assert.deepEqual(keys(refs('- medley-falcon czeka na Twoją decyzję.\n- Beacon: migracja przeszła na rclone', c)), ['h:coding/wR:p1']);
  assert.deepEqual(refs('beacon skończył migrację. Wszystko gra.', c), []);
  assert.deepEqual(refs('Nadal czekam na Twoje „tak” w sprawie reguły.', c), []);
});
test('several waiting sessions = one ref each, in text order, no duplicates', () => {
  const r = refs('Czekają: cc-delta prosi o zgodę, beacon-migracja i beacon też czeka, medley-falcon-coding pyta o plik.', c);
  assert.deepEqual(keys(r), ['s:cc-delta','h:coding/w1Y:p1','h:coding/wR:p1']);
  assert.equal(r.find(x => x.key === 'h:coding/w1Y:p1').waiting, false);
});
test('word boundaries: a name inside a longer name does not match the shorter session', () => {
  assert.deepEqual(keys(refs('mesa-coding czeka na polecenie', c)), ['h:coding/wD:p1']);
  assert.deepEqual(keys(refs('mesa prosi o zgodę', c)), ['h:coding/w38:p1']);
});
test('ambiguous alias (two panes in "workers") is not guessed; unique tab label still works', () => {
  assert.deepEqual(refs('workers czeka na Ciebie', c), []);
  assert.deepEqual(keys(refs('t-b-g1 czeka na odpowiedź', c)), ['h:coding/w35:p1S']);
});
test('resolve by key: still there (fresh status) or gone (null)', () => {
  const later = candidates(herdr.map(x => x.pane === 'wR:p1' ? {...x, status:'working'} : x), []);
  assert.deepEqual(resolve('h:coding/wR:p1', later), {key:'h:coding/wR:p1',hash:'#/h/coding/wR%3Ap1',label:'medley-falcon-coding',status:'working',waiting:false});
  assert.equal(resolve('s:cc-delta', later), null);
});
