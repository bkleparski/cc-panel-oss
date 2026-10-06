'use strict';
// Skróty nawigacji ⌘T/⌘D/⌘S (public/nav-keys.js): tylko macOS, bez innych modyfikatorów, tooltipy w index.html.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isMac, navTarget, hint } = require('../public/nav-keys');

const key = (k, mods = {}, code) => ({ key: k, code: code || 'Key' + k.toUpperCase(), metaKey: true, ...mods });

test('isMac: macOS i iPadOS (MacIntel), nie Windows/Linux/iPhone', () => {
  assert.equal(isMac({ platform: 'MacIntel' }), true);
  assert.equal(isMac({ userAgentData: { platform: 'macOS' }, platform: '' }), true);
  for (const platform of ['Win32', 'Linux x86_64', 'iPhone', '']) assert.equal(isMac({ platform }), false);
  assert.equal(isMac(undefined), false);
});

test('navTarget: ⌘T terminal, ⌘D Dyspozytor, ⌘S sesje; tylko z samym Cmd i tylko na Macu', () => {
  assert.equal(navTarget(key('t'), true), 'terminal');
  assert.equal(navTarget(key('d'), true), 'dysp');
  assert.equal(navTarget(key('S'), true), 'sessions'); // Caps Lock
  assert.equal(navTarget(key('d'), false), null);       // Windows/Linux: Win+D zostaje systemowi
  for (const m of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: false }, { isComposing: true }])
    assert.equal(navTarget(key('s', m), true), null, JSON.stringify(m));
  assert.equal(navTarget(key('k'), true), null);        // ⌘K = szukanie sesji, nie ruszamy
  assert.equal(navTarget(key('1', {}, 'Digit1'), true), null);
});

test('navTarget: układ nie-łaciński bierze literę z e.code', () => {
  assert.equal(navTarget({ key: 'в', code: 'KeyD', metaKey: true }, true), 'dysp');
  assert.equal(navTarget({ key: 'ы', code: 'KeyS', metaKey: true }, true), 'sessions');
});

test('hint: ⌘T tylko w CC Panel.app, w przeglądarce terminal = Ctrl+`; poza Makiem bez ⌘', () => {
  assert.equal(hint('terminal', { mac: true, app: true }), '⌘T, Ctrl+`');
  assert.equal(hint('terminal', { mac: true, app: false }), 'Ctrl+`');
  assert.equal(hint('terminal', { mac: false, app: false }), 'Ctrl+`');
  assert.equal(hint('dysp', { mac: true, app: false }), '⌘D');
  assert.equal(hint('sessions', { mac: true, app: true }), '⌘S');
  assert.equal(hint('dysp', { mac: false, app: false }), '');
});

test('index.html: przyciski z data-nav, bazowe tytuły bez skrótu (dopisuje nav-keys.js), skrypt przed shell-dock/app', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const navs = [...html.matchAll(/<(?:a|button) id="([^"]+)"[^>]*data-nav="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(navs.sort(), ['btn-dysp=dysp', 'btn-sessions=sessions', 'chat-dysp=dysp', 'chat-sessions=sessions',
    'mozg-shell=terminal', 'shell-close=terminal'].sort());
  for (const m of html.matchAll(/title="([^"]*)"[^>]*data-nav=/g)) assert.doesNotMatch(m[1], /Ctrl\+`|⌘/);
  const at = (s) => html.indexOf(`<script src="/${s}"></script>`);
  assert.ok(at('nav-keys.js') > 0 && at('nav-keys.js') < at('shell-dock.js') && at('shell-dock.js') < at('app.js'));
});
