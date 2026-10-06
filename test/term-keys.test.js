'use strict';
// Pasek klawiszy terminala (public/term-keys.js): sekwencje i zgodność przycisków w index.html z mapą KEYS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KEYS, seq } = require('../public/term-keys');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const bar = (id) => {
  const m = html.match(new RegExp(`<div id="${id}"[^>]*>([\\s\\S]*?)</div>`));
  assert.ok(m, `brak paska #${id}`);
  return m[1];
};
const attrs = (src, a) => [...src.matchAll(new RegExp(`data-${a}="([^"]*)"`, 'g'))].map((x) => x[1]);

test('seq: strzałki zależą od trybu kursora aplikacji, reszta dosłownie', () => {
  assert.equal(seq('up', undefined, false), '\x1b[A');
  assert.equal(seq('left', undefined, true), '\x1bOD');
  assert.equal(seq('ctrlc'), '\x03');
  assert.equal(seq('enter'), '\r');
  assert.equal(seq('stab'), '\x1b[Z');
  assert.equal(seq(undefined, 'A', false), 'A', 'data-s „A” to litera, nie strzałka');
  assert.equal(seq(undefined, '|'), '|');
  assert.equal(seq('nieznany'), null);
  assert.equal(seq(undefined, undefined), null, 'przycisk z własnym listenerem (⚙ Model) nic nie wysyła');
});

test('każdy data-k w index.html ma sekwencję w KEYS', () => {
  for (const k of attrs(html, 'k')) assert.ok(k in KEYS, `data-k="${k}" bez wpisu w KEYS`);
});

test('dok shella ma minimum z terminala sesji: Wklej, Zaznacz, Schowek, Enter, Esc, Tab, ^C, strzałki', () => {
  const dock = bar('shell-keys'), sess = bar('keys');
  assert.deepEqual(attrs(dock, 'act').sort(), ['clips', 'paste', 'select']);
  for (const k of ['enter', 'esc', 'tab', 'ctrlc', 'up', 'down', 'left', 'right', 'bs', 'ctrld']) {
    assert.ok(attrs(dock, 'k').includes(k), `dok bez ${k}`);
    assert.ok(attrs(sess, 'k').includes(k), `terminal sesji bez ${k}`);
  }
  assert.match(html, /<script src="\/term-keys\.js"><\/script>[\s\S]*<script src="\/shell-dock\.js"><\/script>[\s\S]*<script src="\/app\.js"><\/script>/,
    'term-keys.js musi się załadować przed shell-dock.js i app.js');
});

test('app.js i shell-dock.js używają wspólnego modułu, bez własnej kopii mapy klawiszy', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const dock = fs.readFileSync(path.join(__dirname, '../public/shell-dock.js'), 'utf8');
  assert.match(app, /TermKeys\.attach\(\$\('#keys'\)/);
  assert.match(dock, /TermKeys\.attach\(document\.getElementById\('shell-keys'\)/);
  assert.doesNotMatch(app + dock, /esc: '\\x1b'/);
});
