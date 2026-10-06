'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {add, togglePin, remove, preview, pasteSeq, clean, LIMIT, PIN_LIMIT, MAX_CHARS} = require('../public/clip-history');

test('history: newest first, duplicates move up, empty and huge texts ignored', () => {
  let l = add([], 'a', 1);
  l = add(l, 'b', 2);
  l = add(l, 'a', 3);
  assert.deepEqual(l.map(x => x.t), ['a', 'b']);
  assert.equal(add(l, '  \n ', 4), l);
  assert.equal(add(l, 'x'.repeat(MAX_CHARS + 1), 5), l);
});
test('history: limit counts only unpinned, pinned stay on top and survive re-copy', () => {
  let l = add([], 'keep', 0);
  l = togglePin(l, 'keep');
  for (let i = 1; i <= LIMIT + 5; i++) l = add(l, 't' + i, i);
  assert.equal(l.length, LIMIT + 1);
  assert.equal(l[0].t, 'keep');
  assert.equal(l[1].t, 't' + (LIMIT + 5));
  l = add(l, 'keep', 100);
  assert.equal(l[0].pin, true);
  l = togglePin(l, 'keep');
  assert.equal(l.find(x => x.t === 'keep').pin, false);
  assert.deepEqual(remove(l, 'keep').map(x => x.t).includes('keep'), false);
});
test('history: pin limit', () => {
  let l = [];
  for (let i = 0; i <= PIN_LIMIT; i++) { l = add(l, 'p' + i, i); l = togglePin(l, 'p' + i); }
  assert.equal(l.filter(x => x.pin).length, PIN_LIMIT);
});
test('preview: first non-empty lines, total line count', () => {
  assert.deepEqual(preview('\na\n\nb\nc\nd'), {text: 'a\nb\nc', lines: 6});
  assert.equal(preview('x'.repeat(300)).text.length, 160);
});
// regresja wklejki wieloliniowej: jedna wklejka (bracketed paste), \r zamiast \n, bez Entera na końcu,
// a sekwencje sterujące z kopiowanego tekstu nie mogą zamknąć wklejki przed czasem
test('pasteSeq: multiline text is one bracketed paste without trailing Enter', () => {
  const seq = pasteSeq('linia 1\r\nlinia 2\nlinia 3\n');
  assert.equal(seq, '\x1b[200~linia 1\rlinia 2\rlinia 3\r\x1b[201~');
  assert.equal(seq.match(/\x1b\[20[01]~/g).length, 2);
  assert.ok(seq.endsWith('\x1b[201~'));
  assert.equal(pasteSeq('evil\x1b[201~\rrm -rf ~\x03'), '\x1b[200~evil[201~\rrm -rf ~\x1b[201~');
  assert.equal(clean('tab\tzażółć ✓'), 'tab\tzażółć ✓');
});
