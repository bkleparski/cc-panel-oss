'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createMozg, isBrainPane, pullNotifications } = require('../lib/mozg');
async function fixture(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccp-mozg-'));
  const sock = path.join(dir, 'socket');
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  return createMozg(sock, 100);
}
test('JSON-lines: params, fragmented response, no register', async (t) => {
  const client = await fixture(t, (socket) => socket.once('data', (data) => {
    assert.deepEqual(JSON.parse(data), { id: 1, method: 'thread', params: { limit: 2 } });
    socket.write('{"id":1,"res');
    setTimeout(() => socket.end('ult":[{"text":"hej"}]}\n'), 5);
  }));
  assert.deepEqual(await client.call('thread', { limit: 2 }), [{ text: 'hej' }]);
});
test('missing socket is offline and monitor tolerates it', async () => {
  const client = createMozg('/tmp/nonexistent-cc13-' + process.pid);
  assert.deepEqual(await client.status(), { online: false });
  await pullNotifications(client, { notify: () => assert.fail('unexpected push') });
});
test('timeout and malformed/error response', async (t) => {
  const idle = await fixture(t, (s) => { s.on('data', () => {}); s.on('error', () => {}); });
  await assert.rejects(idle.call('thread'), /timeout/);
  for (const response of ['invalid\n', '{"id":1,"error":"denied"}\n']) {
    const client = await fixture(t, (s) => s.once('data', () => s.end(response)));
    await assert.rejects(client.call('thread'));
  }
});
test('brain filtering uses tab label, not workspace or display name', () => {
  assert.equal(isBrainPane({ tabLabel: 'mozg-g12', name: 'Claude' }), true);
  for (const pane of [null, {}, { label: 'mozg-g1' }, { workspace: 'mozg-g1' }, { tabLabel: 'worker-mozg-g1' }]) assert.equal(isBrainPane(pane), false);
});
test('push precedes mark, failed push stays due; preview is 120 characters', async () => {
  const calls = [];
  const client = { call: async (method) => { calls.push(method); return method === 'due_notifications' ? [{ notification_id: 'n1', title: 'Mózg odpowiada', text: '😀'.repeat(121) }] : {}; } };
  await pullNotifications(client, { notify: async (type, p) => { calls.push('push'); assert.equal(type, 'mozg'); assert.equal(Array.from(p.body).length, 120); assert.equal(p.tag, 'mozg-n1'); assert.equal(p.url, '/#/mozg'); } });
  assert.deepEqual(calls, ['due_notifications', 'push', 'mark_sent']);
  calls.length = 0;
  // blad push: bez mark_sent, bez wyjatku do monitora, potem 60 s przerwy (zadnego pull)
  const t0 = 1e12;
  await pullNotifications(client, { notify: async () => { throw new Error('push failed'); } }, t0);
  assert.deepEqual(calls, ['due_notifications']);
  calls.length = 0;
  await pullNotifications(client, { notify: async () => {} }, t0 + 30000);
  assert.deepEqual(calls, []);
  await pullNotifications(client, { notify: async () => {} }, t0 + 61000);
  assert.deepEqual(calls, ['due_notifications', 'mark_sent']);
});
test('push wspomina o obrazach od Dyspozytora', async () => {
  const bodies = [];
  const client = { call: async (method) => (method === 'due_notifications' ? [{ notification_id: 'n9', title: 'Mózg odpowiada', text: 'Mockupy gotowe', images: 6 }] : {}) };
  await pullNotifications(client, { notify: async (type, p) => bodies.push(p.body) }, Date.now() + 1e9);
  assert.deepEqual(bodies, ['🖼 +6 obrazów · Mockupy gotowe']);
});
