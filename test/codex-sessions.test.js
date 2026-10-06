'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexMetadata, matchCodexHerdr, looseCodexItems } = require('../lib/codex-sessions');
const { attention, excluded } = require('../lib/attention');
const pane = { pane: 'w1:p1', kind: 'codex', agent: 'codex', cwd: '/project', title: 'Main | Projekty', status: 'idle' };
function list(sessions, panes = [pane]) {
  matchCodexHerdr(sessions, panes);
  return [...panes.map(p => ({...p, key: 'herdr:host:' + p.pane})), ...looseCodexItems({host: 'host', codex: sessions})];
}
test('main and old thread in same cwd and app-server represented only by panel', () => {
  const sessions = [{id: 'main', pid: 1, title: 'Main', cwd: '/project', status: 'idle', appServer: true}, {id: 'old', pid: 1, cwd: '/project', status: 'idle', appServer: true}];
  const items = list(sessions);
  assert.equal(items.length, 1);
  assert.equal(attention(items, [], 'workers').length, 1);
  assert.deepEqual(sessions.map(s => s.herdr), ['w1:p1', 'w1:p1']);
});
test('metadata uses real session_meta source and parent, not title', () => {
  assert.equal(codexMetadata(JSON.stringify({type: 'session_meta', payload: {source: {subagent: {other: 'guardian'}}, parent_thread_id: 'main', thread_source: 'guardian_review'}})).subagent, true);
  assert.equal(codexMetadata(JSON.stringify({type: 'session_meta', payload: {source: 'vscode', thread_source: 'user'}})).subagent, false);
  assert.equal(codexMetadata(JSON.stringify({type: 'session_meta', payload: {source: {subagent: {other: 'review'}}}})).subagent, true);
});
test('subagent idle excluded from attention and done pushes; approval retained', () => {
  const session = {id: 'child', pid: 1, subagent: true, cwd: '/project', status: 'idle'};
  const items = list([session], []);
  assert.equal(attention(items, [], 'workers').length, 0);
  assert.equal(excluded(items[0], 'workers'), true);
  session.status = 'approval';
  assert.equal(attention(list([session], []), [], 'workers').length, 1);
  list([session]);
  assert.equal(session.herdr, null);
});
test('exact ID wins; ambiguous cwd and tmux remain safe', () => {
  const sessions = [{id: 'a', cwd: '/project'}, {id: 'b', cwd: '/project'}, {id: 'c', cwd: '/project', tmux: 'terminal'}];
  matchCodexHerdr(sessions, [{...pane, sessionId: 'a'}, {...pane, pane: 'w2:p1', sessionId: 'other'}]);
  assert.deepEqual(sessions.map(s => s.herdr), ['w1:p1', null, null]);
  matchCodexHerdr(sessions, [pane, {...pane, pane: 'w2:p1'}]);
  assert.equal(sessions[0].herdr, null);
});
test('duplicate rollout id emits one standalone item', () => {
  assert.equal(looseCodexItems({host: 'host', codex: [{id:'a',pid:1}, {id:'a',pid:2}]}).length, 1);
});
