'use strict';
// Kopia server.js na losowym porcie z HOME w katalogu tymczasowym: pobranie oryginału, autoryzacja, wygasłe obrazy w wątku.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(5000)]);
const ID = 'c'.repeat(32), GONE = 'd'.repeat(32), TOKEN = 'test-token-' + crypto.randomBytes(6).toString('hex');
const PORT = 20000 + Math.floor(Math.random() * 20000);
let home, child, mozgd, base;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-srv-'));
  const dir = path.join(home, 'att');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, ID + '.png'), PNG, { mode: 0o600 });
  fs.mkdirSync(path.join(home, '.config/cc-panel'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cc-panel/token'), TOKEN + '\n', { mode: 0o600 });
  fs.mkdirSync(path.join(home, '.config/mozg'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/mozg/config.json'), JSON.stringify({ attachments_dir: dir, attachments_retention_days: 7 }));
  const sock = path.join(home, 'mozgd.sock');
  mozgd = net.createServer((s) => s.once('data', (d) => {
    const { id, method } = JSON.parse(d);
    const result = method === 'threads' ? [{ id: 'general', title: 'Ogólne', archived: 0 }]
      : { messages: [{ id: 'n1', level: 'reply', text: 'Mockupy', created: 1, attachments: [
        { id: ID, mime: 'image/png', size: PNG.length, name: '01-tydzień.png' }, { id: GONE, mime: 'image/png', size: 10 }] }], open_decisions: [], busy: false };
    s.end(JSON.stringify({ id, result }) + '\n');
  }));
  await new Promise((r) => mozgd.listen(sock, r));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOME: home, PORT: String(PORT), HOST: '127.0.0.1', MOZG_SOCKET: sock, PROJECTS_ROOT: home, TLS_PORT: '0', REPORT_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server.js nie wystartował')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('cc-panel na')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error('server.js exit ' + code)));
  });
  base = `http://127.0.0.1:${PORT}`;
});
after(() => { child?.kill(); mozgd?.close(); fs.rmSync(home, { recursive: true, force: true }); });

const auth = { Cookie: 'ccp=' + encodeURIComponent(TOKEN) };

test('pobranie oryginału wymaga ciasteczka panelu', async () => {
  assert.equal((await fetch(`${base}/api/mozg/attachment/${ID}`)).status, 401);
  assert.equal((await fetch(`${base}/api/mozg/attachment/${ID}?download=1`, { headers: { Cookie: 'ccp=zly' } })).status, 401);
});

test('podgląd: oryginalne bajty bez Content-Disposition', async () => {
  const res = await fetch(`${base}/api/mozg/attachment/${ID}`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-disposition'), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test('download=1: attachment z nazwą od workera i zgodnym sha256', async () => {
  const res = await fetch(`${base}/api/mozg/attachment/${ID}?download=1&name=${encodeURIComponent('../01-tydzień.png')}`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="01-tydzien.png"; filename*=UTF-8''01-tydzie%C5%84.png`);
  assert.equal(res.headers.get('content-length'), String(PNG.length));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal(sha(Buffer.from(await res.arrayBuffer())), sha(PNG));
});

test('brak pliku: 404 z retencją z konfiguracji', async () => {
  const res = await fetch(`${base}/api/mozg/attachment/${GONE}?download=1`, { headers: auth });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /7 dni/);
});

test('wątek: wygasły obraz oznaczony, istniejący bez zmian', async () => {
  const res = await fetch(`${base}/api/mozg/thread?thread_id=general`, { headers: { ...auth, 'X-CCP': '1' } });
  const thread = await res.json();
  assert.equal(thread.retention_days, 7);
  const [ok, gone] = thread.messages[0].attachments;
  assert.equal(ok.expired, undefined);
  assert.equal(gone.expired, true);
  assert.equal((await fetch(`${base}/api/mozg/thread`, { headers: auth })).status, 403);
});
