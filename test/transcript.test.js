const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pendingTool, describe, mask, clip, pendingAsk } = require('../lib/transcript');

const use = (id, name, input, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const prompt = (text) => JSON.stringify({ type: 'user', message: { content: text } });
const jsonl = (...lines) => lines.join('\n') + '\n';

test('pendingTool: sparowany tool_use nie czeka, niesparowany tak', () => {
  assert.equal(pendingTool(jsonl(use('a', 'Bash', { command: 'ls' }), result('a'))), null);
  const t = pendingTool(jsonl(use('a', 'Bash', { command: 'ls' }), result('a'), use('b', 'Edit', { file_path: '/x/server.js' })));
  assert.equal(t.name, 'Edit');
  assert.equal(t.count, 1);
});

test('pendingTool: kilka tool_use naraz - ostatni niesparowany i licznik', () => {
  const t = pendingTool(jsonl(use('a', 'Read', { file_path: '/a' }), use('b', 'Bash', { command: 'git push' }), use('c', 'Grep', { pattern: 'x' }), result('c')));
  assert.equal(t.name, 'Bash');
  assert.equal(t.count, 2);
  // wiele bloków w jednym rekordzie
  const one = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hej' },
    { type: 'tool_use', id: 'x', name: 'Write', input: { file_path: '/p/a.txt' } }, { type: 'tool_use', id: 'y', name: 'Bash', input: { command: 'rm -rf /tmp/z' } }] } });
  assert.equal(pendingTool(jsonl(one, result('y'))).name, 'Write');
});

test('pendingTool: nowe polecenie użytkownika zamyka osierocone tool_use, sidechain i śmieci pomijane', () => {
  assert.equal(pendingTool(jsonl(use('a', 'Bash', { command: 'ls' }), prompt('zrób coś innego'))), null);
  assert.equal(pendingTool(jsonl(use('a', 'Bash', { command: 'ls' }), JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'stop' }] } }))), null);
  // wstrzyknięcie isMeta nie jest poleceniem użytkownika
  assert.equal(pendingTool(jsonl(use('a', 'Bash', { command: 'ls' }), JSON.stringify({ type: 'user', isMeta: true, message: { content: 'skill' } }))).name, 'Bash');
  assert.equal(pendingTool(jsonl(use('a', 'Bash', { command: 'ls' }, { isSidechain: true }))), null);
  assert.equal(pendingTool('nie json\n{"type":"x"}\n{urwane'), null);
  assert.equal(pendingTool(''), null);
  assert.equal(pendingTool(jsonl(use('a', 'Bash', null))).name, 'Bash');
});

test('describe: opis do panelu i krótka forma do pusha bez argumentów', () => {
  const home = process.env.HOME;
  const bash = describe({ name: 'Bash', input: { command: 'git push origin main', description: 'Push' }, count: 1 });
  assert.equal(bash.text, 'Bash: $ git push origin main');
  assert.equal(bash.short, 'Bash');
  const edit = describe({ name: 'Edit', input: { file_path: home + '/Projekty/x/server.js', old_string: 'tajne', new_string: 'b' } });
  assert.equal(edit.text, 'Edit: ~/Projekty/x/server.js');
  assert.equal(edit.short, 'Edit: server.js');
  assert.ok(!JSON.stringify(edit).includes('tajne'));
  assert.equal(describe({ name: 'WebFetch', input: { url: 'https://ex.com/a?token=abc' } }).short, 'WebFetch: ex.com');
  assert.equal(describe({ name: 'WebFetch', input: { url: 'https://ex.com/a?token=abc' } }).text, 'WebFetch: https://ex.com/a');
  const mcp = describe({ name: 'mcp__claude_ai_Gmail__create_draft', input: { to: 'a@b.pl', body: 'treść' } });
  assert.equal(mcp.short, 'Gmail · create_draft');
  assert.equal(mcp.text, 'Gmail · create_draft: a@b.pl');
  assert.equal(describe({ name: 'Unknown', input: {} }).text, 'Unknown');
});

test('mask: sekrety w poleceniach', () => {
  const cases = [
    ['curl -H "Authorization: Bearer abcdef1234567890"', 'abcdef1234567890'],
    ['GITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 gh api', 'ghp_AbCd'],
    ['mysql --password=Sekret123 db', 'Sekret123'],
    ['tool --api-key s3cr3t-value', 's3cr3t-value'],
    ['git clone https://user:Haslo!23@git.ex.com/r.git', 'Haslo!23'],
    ['echo sk-ant-api03-AbCdEfGhIjKlMnOpQrSt', 'sk-ant-api03'],
    ['{"password": "p@ss"}', 'p@ss'],
    ['export X=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', 'eyJhbGciOiJIUzI1NiJ9'],
    ['key 0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
    ['x AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_- y', 'AbCdEfGhIjKlMnOp'],
  ];
  for (const [input, secret] of cases) {
    const out = mask(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.ok(out.includes('•••'), out);
  }
  // zwykłe polecenia i ścieżki zostają
  for (const plain of ['git status', 'cd /home/user/Projekty/2-infra/uslugi/cc-panel && npm test', 'sudo systemctl restart cc-panel']) assert.equal(mask(plain), plain);
});

test('clip: jedna linia, przycięcie po punktach kodowych', () => {
  assert.equal(clip('a\n  b\tc', 50), 'a b c');
  const long = 'ż'.repeat(200);
  const out = clip(long, 20);
  assert.equal(Array.from(out).length, 20);
  assert.ok(out.endsWith('…'));
  const d = describe({ name: 'Bash', input: { command: 'echo ' + 'x'.repeat(500) + '\nrm -rf /' } });
  assert.ok(Array.from(d.text).length <= 'Bash: '.length + 160);
});

test('pendingAsk: plik z dysku, brak transkryptu = null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-tr-'));
  const id = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(root, '-proj'));
  const file = path.join(root, '-proj', id + '.jsonl');
  fs.writeFileSync(file, jsonl(use('a', 'Bash', { command: 'npm test' })));
  assert.equal(pendingAsk(id, root).text, 'Bash: $ npm test');
  fs.appendFileSync(file, result('a') + '\n');
  assert.equal(pendingAsk(id, root), null);
  assert.equal(pendingAsk('99999999-2222-3333-4444-555555555555', root), null);
  assert.equal(pendingAsk('../etc/passwd', root), null);
  fs.rmSync(root, { recursive: true, force: true });
});
