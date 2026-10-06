'use strict';
// Tor obrazu od workera do użytkownika bez przetwarzania: plik workera -> mozgd (read_outgoing/write_outgoing, prawdziwy kod
// z ../mozg w jego venv) -> attachments -> server.js (podgląd i ?download=1). Wszędzie ten sam sha256.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const MOZG = path.join(fs.realpathSync(path.join(__dirname, '..')), '..', 'mozg');
const PY = path.join(MOZG, '.venv/bin/python');
const skip = fs.existsSync(path.join(MOZG, 'mozgd/mozgd.py')) && fs.existsSync(PY) ? false : 'brak ../mozg z .venv';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// PNG i JPEG z losową treścią: mozgd i panel rozpoznają typ po sygnaturze, nie dekodują obrazu
const FILES = {
  'infografika-1.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300000)]),
  'mockup-kie.jpg': Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200000)]),
};
const TOKEN = 'tok-' + crypto.randomBytes(6).toString('hex');
const PORT = 20000 + Math.floor(Math.random() * 20000);
let home, child, mozgd, base, copies;

// mozgd: tylko metody kopiowania, bez Store/Hub - te same funkcje, których używa mozg_notify(attachments=[...])
const PY_COPY = `
import json, sys, types
from mozgd.mozgd import Daemon
from pathlib import Path
roots, att, paths = json.loads(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])
d = types.SimpleNamespace(outgoing_roots=[Path(r) for r in roots], attachments_dir=Path(att))
d.read_outgoing_file = lambda raw: Daemon.read_outgoing_file(d, raw)
print(json.dumps(Daemon.write_outgoing(d, Daemon.read_outgoing(d, paths))))
`;

before(async () => {
  if (skip) return;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-orig-')));
  const projects = path.join(home, 'Projekty'), docs = path.join(projects, 'demo', 'docs'), att = path.join(home, 'att');
  fs.mkdirSync(docs, { recursive: true });
  for (const [name, buf] of Object.entries(FILES)) fs.writeFileSync(path.join(docs, name), buf);
  const out = execFileSync(PY, ['-c', PY_COPY, JSON.stringify([projects]), att, JSON.stringify(Object.keys(FILES).map(n => path.join(docs, n)))],
    { cwd: MOZG, encoding: 'utf8' });
  copies = JSON.parse(out);
  fs.mkdirSync(path.join(home, '.config/cc-panel'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cc-panel/token'), TOKEN + '\n', { mode: 0o600 });
  fs.mkdirSync(path.join(home, '.config/mozg'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/mozg/config.json'), JSON.stringify({ attachments_dir: att }));
  const sock = path.join(home, 'mozgd.sock');
  mozgd = net.createServer((s) => s.once('data', (d) => s.end(JSON.stringify({ id: JSON.parse(d).id, result: [] }) + '\n')));
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
after(() => { child?.kill(); mozgd?.close(); if (home) fs.rmSync(home, { recursive: true, force: true }); });

test('plik workera = kopia mozgd = podgląd = pobranie (sha256)', { skip }, async () => {
  assert.equal(copies.length, Object.keys(FILES).length);
  for (const c of copies) {
    const src = FILES[c.name];
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg' }[c.mime];
    const stored = fs.readFileSync(path.join(home, 'att', `${c.id}.${ext}`));
    assert.equal(c.sha256, sha256(src), `${c.name}: sha256 w metadanych mozgd`);
    assert.equal(sha256(stored), sha256(src), `${c.name}: kopia w attachments`);
    for (const q of ['', `?download=1&name=${encodeURIComponent(c.name)}`]) {
      const res = await fetch(`${base}/api/mozg/attachment/${c.id}${q}`, { headers: { Cookie: 'ccp=' + encodeURIComponent(TOKEN) } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), c.mime);
      assert.equal(res.headers.get('content-length'), String(src.length));
      assert.equal(sha256(Buffer.from(await res.arrayBuffer())), sha256(src), `${c.name}: odpowiedź ${q || 'podgląd'}`);
      if (q) assert.match(res.headers.get('content-disposition'), new RegExp(`filename="${c.name.replace('.', '\\.')}"`));
    }
  }
});
