'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/chat-links');
const H = require('../public/hdr-icons');

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', platform: 'iPhone', maxTouchPoints: 5 };
const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };

test('iOS detection: iPhone and iPadOS (MacIntel with touch) yes, Mac WebView no', () => {
  assert.equal(C.isIOS(IPHONE), true);
  assert.equal(C.isIOS(IPAD), true);
  assert.equal(C.isIOS(MAC), false);
  assert.equal(C.isIOS(undefined), false);
});

test('iOS tiles use universal-link paths and offer the plain web page as a second link', () => {
  const [claude, gpt] = C.tiles(true);
  assert.deepEqual([claude.id, claude.href, claude.web], ['claude', 'https://claude.ai/new', 'https://claude.ai/']);
  assert.deepEqual([gpt.id, gpt.href, gpt.web], ['chatgpt', 'https://chatgpt.com/open-app', 'https://chatgpt.com/']);
  assert.match(gpt.hint, /App Store/);
});

test('desktop tiles open the home pages only (CC Panel.app intercepts them), no second link', () => {
  const t = C.tiles(false);
  assert.deepEqual(t.map((x) => x.href), ['https://claude.ai/', 'https://chatgpt.com/']);
  assert.deepEqual(t.map((x) => x.web), [null, null]);
});

test('desktop hints: native Mac app inside CC Panel.app, new tab in a plain browser, apps on iOS', () => {
  assert.deepEqual(C.tiles(false, true).map((x) => x.hint), ['Otwiera aplikację Claude na Macu', 'Otwiera aplikację ChatGPT na Macu']);
  assert.deepEqual(C.tiles(false, false).map((x) => x.hint), ['Otwiera claude.ai w nowej karcie', 'Otwiera chatgpt.com w nowej karcie']);
  for (const t of C.tiles(true, true)) assert.match(t.hint, /^Otwiera aplikację/);
});

test('every tile URL is https on exactly the two chat hosts', () => {
  for (const ios of [true, false]) for (const t of C.tiles(ios)) for (const u of [t.href, t.web].filter(Boolean)) {
    const url = new URL(u);
    assert.equal(url.protocol, 'https:');
    assert.ok(['claude.ai', 'chatgpt.com'].includes(url.host), u);
  }
});

test('header has a chat icon', () => {
  assert.ok(H.ICONS.includes('chat'));
});
