'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/session-sort');

const it = (key, o) => ({ key, name: key, status: 'idle', time: 0, machine: 'coding', project: '', agent: true, ...o });
const keys = (secs) => secs.map((s) => [s.key, s.items.map((x) => x.key)]);

test('mode: unknown falls back to attention, next cycles through all three', () => {
  assert.equal(S.parseMode(null), 'attention');
  assert.equal(S.parseMode('source'), 'attention');
  assert.equal(S.nextMode('attention'), 'project');
  assert.equal(S.nextMode('project'), 'name');
  assert.equal(S.nextMode('name'), 'attention');
  assert.equal(S.nextMode('bogus'), 'project');
});

test('attentionOf: approval beats background, finished after last look = you, before = idle', () => {
  const seen = { a: 100 };
  assert.equal(S.attentionOf(it('w', { status: 'approval', background: true }), seen, 0), 'you');
  assert.equal(S.attentionOf(it('b', { status: 'working', background: true }), seen, 0), 'bg');
  assert.equal(S.attentionOf(it('x', { status: 'working' }), seen, 0), 'work');
  assert.equal(S.attentionOf(it('x', { status: 'bg' }), seen, 0), 'work');
  assert.equal(S.attentionOf(it('a', { status: 'idle', time: 150 }), seen, 0), 'you');
  assert.equal(S.attentionOf(it('a', { status: 'done', time: 90 }), seen, 0), 'idle');
  assert.equal(S.attentionOf(it('s', { status: 'shell', agent: false, time: 999 }), seen, 0), 'idle');
});

test('attentionOf: no seen entry uses base, so old sessions do not flood "Do Ciebie" on first run', () => {
  assert.equal(S.attentionOf(it('old', { time: 50 }), {}, 100), 'idle');
  assert.equal(S.attentionOf(it('new', { time: 150 }), {}, 100), 'you');
  assert.equal(S.attentionOf(it('n', { time: 150 }), { n: 200 }, 100), 'idle', 'later look wins over base');
});

test('attention sections: fixed order, empty dropped, approval first then newest, tie = name', () => {
  const items = [
    it('idle-old', { time: 10 }),
    it('fresh', { status: 'done', time: 500 }),
    it('ask', { status: 'approval', time: 1 }),
    it('w2', { status: 'working', time: 300 }),
    it('w1', { status: 'working', time: 300 }),
    it('brain', { status: 'working', background: true, time: 400 }),
  ];
  const secs = S.sections('attention', items, { seen: {}, base: 100 });
  assert.deepEqual(keys(secs), [
    ['you', ['ask', 'fresh']],
    ['work', ['w1', 'w2']],
    ['idle', ['idle-old']],
    ['bg', ['brain']],
  ]);
  assert.equal(secs[2].collapsed, true);
  assert.equal(secs[3].collapsed, true);
  assert.equal(secs[0].collapsed, undefined);
  assert.deepEqual(keys(S.sections('attention', [it('w', { status: 'working' })], {})), [['work', ['w']]]);
});

test('project sections: approval group above working group above quiet ones, inside rank then time', () => {
  const items = [
    it('q1', { project: 'zz-quiet', time: 900 }),
    it('q2', { project: 'aa-quiet', time: 100 }),
    it('w', { project: 'work', status: 'working', time: 5 }),
    it('a-idle', { project: 'ask', time: 800 }),
    it('a-work', { project: 'ask', status: 'working', time: 700 }),
    it('a-ask', { project: 'ask', status: 'approval', time: 1 }),
    it('nodir', { project: '', time: 50 }),
  ];
  const secs = S.sections('project', items);
  assert.deepEqual(keys(secs), [
    ['p:ask', ['a-ask', 'a-work', 'a-idle']],
    ['p:work', ['w']],
    ['p:zz-quiet', ['q1']],
    ['p:aa-quiet', ['q2']],
    ['p:', ['nodir']],
  ]);
  assert.equal(secs[4].title, '(bez katalogu)');
});

test('name sections: Polish collation, case-insensitive, numeric, tie by machine; status ignored', () => {
  const items = [
    it('z', { name: 'Żaba', status: 'approval' }),
    it('a2', { name: 'alfa', machine: 'fedora' }),
    it('a1', { name: 'Alfa', machine: 'coding', status: 'working' }),
    it('z2', { name: 'zebra' }),
    it('n10', { name: 'sesja-10' }),
    it('n9', { name: 'sesja-9' }),
    it('l', { name: 'łódź' }),
    it('lo', { name: 'lody' }),
  ];
  const order = S.sections('name', items)[0].items.map((x) => x.key);
  assert.deepEqual(order, ['a1', 'a2', 'lo', 'l', 'n9', 'n10', 'z2', 'z']);
  assert.deepEqual(S.sections('name', []), []);
  const again = S.sections('name', [...items].reverse())[0].items.map((x) => x.key);
  assert.deepEqual(again, order, 'same order regardless of input order (no jumping between refreshes)');
});

test('pruneSeen: drops entries older than max age', () => {
  assert.deepEqual(S.pruneSeen({ a: 100, b: 10 }, 120, 50), { a: 100 });
  assert.deepEqual(S.pruneSeen(null, 1), {});
});
