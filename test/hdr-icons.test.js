'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const H = require('../public/hdr-icons');

test('status text maps to an icon kind; online shows nothing, unknown text is an error', () => {
  assert.equal(H.mozgStatusKind('online').kind, 'online');
  assert.equal(H.mozgStatusKind('').kind, 'online');
  assert.equal(H.mozgStatusKind('pracuje').kind, 'work');
  assert.equal(H.mozgStatusKind('czeka w kolejce').label, 'Dyspozytor czeka w kolejce');
  assert.equal(H.mozgStatusKind('offline').kind, 'offline');
  const e = H.mozgStatusKind('mozgd nie odpowiada');
  assert.deepEqual([e.kind, e.label], ['err', 'Błąd: mozgd nie odpowiada']);
});

test('every icon is a 20x20 SVG hidden from screen readers, no emoji', () => {
  for (const n of H.ICONS) {
    const s = H.svg(n);
    assert.match(s, /^<svg class="hi" viewBox="0 0 20 20" aria-hidden="true"/);
    assert.doesNotMatch(s, /\p{Extended_Pictographic}/u);
  }
});

const it = (key, pct, level, dim = false) => ({ key, pct, level, dim, text: '' });
test('ring: centre shows the worse window, level before percent, "!" when warn or crit', () => {
  assert.equal(H.worstItem([it('5h', 90, 'ok'), it('7d', 72, 'warn')]).key, '7d');
  assert.equal(H.worstItem([it('5h', 40, 'ok'), it('7d', 30, 'ok')]).key, '5h');
  assert.equal(H.worstItem([it('5h', 0, '', true), it('7d', 0, '', true)]), null);
  const r = H.ringSvg([it('5h', 18, 'ok'), it('7d', 75, 'warn')]);
  assert.match(r, />75!<\/text>/);
  assert.match(r, /ur-arc ur-5h" .*stroke-dasharray="18 100"/);
  assert.match(r, /ur-arc warn ur-7d" .*stroke-dasharray="75 100"/);
  assert.match(H.ringSvg([it('5h', 0, '', true), it('7d', 0, '', true)]), />–<\/text>/);
  assert.match(H.ringSvg([it('5h', 100, 'crit'), it('7d', 5, 'ok')]), /font-size="7.5">100!</);
});
