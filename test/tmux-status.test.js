'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {tmuxStatus} = require('../lib/tmux-status');

test('tmuxStatus: plain shells and the herdr client are not agents', () => {
  for (const cmd of ['bash', 'zsh', 'sh', 'fish', 'herdr']) assert.equal(tmuxStatus(cmd, ['Do you want to proceed?'], 100), 'shell', cmd);
  assert.equal(tmuxStatus('', [], 100), 'idle', 'unknown command keeps old behaviour');
});

test('tmuxStatus: herdr showing a Claude pane with statusline is shell, not "czeka na Ciebie"', () => {
  const screen = ['● beacon ▕│  Następne: uruchom check_sharing.py', '❯ ', '  Opus 5.5 | HIGH | 162.3k/1.0M (16%) | $3.2467 | 41m03s | main'];
  assert.equal(tmuxStatus('herdr', screen, 3600), 'shell');
});

test('tmuxStatus: agents get approval from the last 15 lines, then working/idle from activity', () => {
  assert.equal(tmuxStatus('claude', ['x', 'Do you want to make this edit to server.js?', '❯ 1. Yes'], 100), 'approval');
  assert.equal(tmuxStatus('claude', ['Do you want to proceed?', ...Array(15).fill('later output')], 100), 'idle', 'old prompt scrolled out');
  assert.equal(tmuxStatus('2.1.30', ['output'], 2), 'working');
  assert.equal(tmuxStatus('codex', ['output'], 4), 'idle');
});
