'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../public/agent-cmds');
const {commandBlocks} = require('../lib/bang');

// format ze zgłoszenia 04.10: lista numerowana, `! …` w kodzie w linii, prefiks „Po ~8 min:”, id zadania w `…`
const DISPATCHER = [
  'Do odpalenia w Claude Code:',
  '1. `! ~/Projekty/2-infra/uslugi/news-portal/deploy/deploy.sh`',
  '2. `! ssh s11 \'docker exec -d prasowka sh -c "python -m app.translate backfill > /data/translate-backfill.log 2>&1"\'`',
  '3. Po ~8 min: `! ssh s11 docker exec prasowka python -m app.translate status` - ma być translated ~225',
  '`task_1791109610193_9f9fec74`',
].join('\n');

test('extract: dispatcher message from the report gives three ! commands, task id is not a command', () => {
  const r = A.extract(DISPATCHER);
  assert.deepEqual(r.map(c => c.text), [
    '~/Projekty/2-infra/uslugi/news-portal/deploy/deploy.sh',
    'ssh s11 \'docker exec -d prasowka sh -c "python -m app.translate backfill > /data/translate-backfill.log 2>&1"\'',
    'ssh s11 docker exec prasowka python -m app.translate status',
  ]);
  assert.ok(r.every(c => c.bang && c.lang === 'sh' && !c.multi));
});

test('extract: bare "! cmd" line counts, exclamation in prose does not', () => {
  const r = A.extract('Zrobione! Działa.\n! echo test-cc-panel\n- ! ls -la\nUwaga !!! ważne\n!\n');
  assert.deepEqual(r.map(c => c.text), ['echo test-cc-panel', 'ls -la']);
});

test('extract: fenced blocks - bash whole, ! lines separately, console only prompts, powershell, other langs ignored', () => {
  const md = [
    '```bash', 'cd /tmp', 'echo "a b" \\', '  c', '```',
    '```', '! echo one', '! echo two', '```',
    '```console', '$ ls -la', 'total 0', '$ pwd', '/tmp', '```',
    '```powershell', 'Get-Mailbox -ResultSize 10', '```',
    '```json', '{"a": 1}', '```',
    '```', 'zwykły output', '```',
  ].join('\n');
  const r = A.extract(md);
  assert.deepEqual(r.map(c => [c.text, c.lang, c.bang, c.multi]), [
    ['cd /tmp\necho "a b" \\\n  c', 'sh', false, true],
    ['echo one', 'sh', true, false],
    ['echo two', 'sh', true, false],
    ['ls -la\npwd', 'sh', false, true],
    ['Get-Mailbox -ResultSize 10', 'ps', false, false],
  ]);
});

test('extract: duplicates dropped, at most MAX cards, control characters removed', () => {
  const many = Array.from({length: 20}, (_, i) => `\`! echo ${i}\``).join('\n');
  assert.equal(A.extract(many).length, A.MAX);
  assert.equal(A.extract('`! ls`\n`! ls`').length, 1);
  const [c] = A.extract('`! echo a\x1b[201~\x07b`');
  assert.equal(c.text, 'echo a[201~b');
});

test('danger: destructive patterns flagged, harmless not', () => {
  for (const t of ['rm -rf /x', 'sudo rm -r -f build', 'rm -fr a', 'rm --recursive --force a', 'cd x && rm -Rf y',
    'rsync -a --delete a/ b/', 'git push -f origin main', 'git push --force-with-lease', 'git push origin +main',
    'psql -c "DROP TABLE users"', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda bs=1M', 'git reset --hard HEAD~3',
    'docker volume rm data', 'Remove-Item C:\\x -Recurse -Force']) {
    assert.ok(A.danger(t).length, t);
  }
  for (const t of ['echo test-cc-panel', 'rm -f plik.tmp', 'ls -rf', 'git push origin main', 'ssh s11 docker exec prasowka status',
    'grep -r dropdown .', 'python -m app.translate backfill']) {
    assert.deepEqual(A.danger(t), [], t);
  }
});

test('steps: run = lone "!", 150 ms, command, 80 ms, Enter; insert has no Enter', () => {
  assert.deepEqual(A.steps('echo test-cc-panel'), [
    {d: '!', wait: 0}, {d: 'echo test-cc-panel', wait: A.BANG_DELAY}, {d: '\r', wait: A.ENTER_DELAY},
  ]);
  assert.equal(A.BANG_DELAY, 150);
  const ins = A.steps('echo x', {mode: 'insert'});
  assert.deepEqual(ins.map(s => s.d), ['!', 'echo x']);
  assert.ok(!ins.some(s => s.d.includes('\r')));
  // „!” nigdy w jednym zapisie z poleceniem (inaczej Claude Code wysłałby zwykłą wiadomość)
  assert.ok(A.steps('ls').every((s, i) => i === 0 ? s.d === '!' : !s.d.startsWith('!')));
  assert.deepEqual(A.steps('   '), []);
});

test('steps: no bang = single bracketed paste without Enter, ESC stripped', () => {
  const [s, more] = A.steps('Get-Item a\nGet-Item b\x1b[201~', {bang: false});
  assert.equal(more, undefined);
  assert.equal(s.d, '\x1b[200~Get-Item a\rGet-Item b[201~\x1b[201~');
});

test('bashLine: multi-line becomes one line bash -c $\'…\' that runs the same script', () => {
  const script = "cd /tmp\necho \"it's\" \\\n  ok\nprintf '%s\\n' a\tb";
  const line = A.bashLine(script);
  assert.ok(!line.includes('\n'));
  assert.match(line, /^bash -c \$'/);
  const viaLine = execFileSync('bash', ['-c', line], {encoding: 'utf8'});
  const direct = execFileSync('bash', ['-c', script], {encoding: 'utf8'});
  assert.equal(viaLine, direct);
  assert.equal(A.bashLine('  ls -la  '), 'ls -la');
  // wieloliniowe: Enter dopiero po całej linii
  const st = A.steps(script);
  assert.deepEqual(st.map(s => s.d), ['!', line, '\r']);
});

test('allowed: confirmation rules per session state', () => {
  const ok = (info, mode, lang) => A.allowed(info, mode, lang).ok;
  assert.ok(ok({kind: 'claude', status: 'idle'}, 'run'));
  assert.ok(ok({kind: 'claude', status: 'done'}, 'run'));
  assert.ok(!ok({kind: 'claude', status: 'approval'}, 'run'), 'Enter zatwierdziłby okno zgody');
  assert.ok(!ok({kind: 'claude', status: 'approval'}, 'insert'));
  assert.ok(!ok({kind: 'claude', status: 'working'}, 'run'));
  assert.ok(ok({kind: 'claude', status: 'working'}, 'insert'));
  assert.ok(!ok({kind: 'codex', status: 'idle'}, 'run'), '„!” tylko w Claude Code');
  assert.ok(ok({kind: 'codex', status: 'idle'}, 'insert'));
  assert.ok(!ok({kind: 'claude', status: 'idle', readOnly: true}, 'insert'), 'panel Dyspozytora');
  assert.ok(!ok({kind: 'claude', status: 'idle'}, 'run', 'ps'));
  assert.ok(!ok({kind: '', status: 'shell'}, 'run'));
});

test('commandBlocks: reads ! lines and bash blocks from a Claude transcript, newest last', () => {
  const id = '00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
  const dir = path.join(os.homedir(), '.claude', 'projects', '-tmp-cc-panel-agent-cmds-test');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, id + '.jsonl');
  const msg = (text) => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text}]}});
  fs.writeFileSync(file, [msg('Odpal `! echo stare`'), msg('```bash\nls\npwd\n```\n`! echo nowe`'), msg('`! echo stare`')].join('\n') + '\n');
  try {
    assert.deepEqual(commandBlocks(id).map(c => c.text), ['ls\npwd', 'echo nowe', 'echo stare']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// zgłoszenie 04.10 z MacBooka: lista numerowana z kodem w linii bez „!”, opis po poleceniu, ścieżka i id w prozie
const MAC = [
  '**Na Macu wpisz w terminalu 4 komendy po kolei:**',
  '1. `cp -a ~/.funes/integrations ~/funes-integrations.bak-20261004` (backup)',
  '2. `funes add claude local` - na pytanie o push odpowiedz **n**',
  '3. `funes index --harness claude --yes` (backfill, kilka minut)',
  '4. `funes status` - nie powinno być linii "does not match", last indexed = dziś',
  'Później: heartbeat na Macu sprawdza stary log, nowy jest w `~/.claude/plugins/cache/huggingface/funes/*/scripts/funes-sync.log`.',
  'Źródło: handoff `ho_1791100427325_e1b7ce84` (04.10)',
].join('\n');

test('copyables: Mac list from the report gives 4 copy-only commands with notes; extract (mobile) stays empty', () => {
  assert.deepEqual(A.extract(MAC), []);
  const r = A.copyables(MAC);
  assert.deepEqual(r.map(c => c.text), [
    'cp -a ~/.funes/integrations ~/funes-integrations.bak-20261004',
    'funes add claude local',
    'funes index --harness claude --yes',
    'funes status',
  ]);
  assert.ok(r.every(c => c.run === false && !c.bang && !c.multi));
  assert.deepEqual(r.map(c => c.note), ['backup', 'na pytanie o push odpowiedz **n**', 'backfill, kilka minut',
    'nie powinno być linii "does not match", last indexed = dziś']);
  assert.equal(A.copyAll(r), r.map(c => c.text).join('\n'));
  assert.ok(!A.copyAll(r).includes('!') && !/^\d/m.test(A.copyAll(r)));
});

test('copyables: keeps ! commands and blocks from extract (run=true, text without "! "), in text order', () => {
  const md = ['Do odpalenia:', '1. `! echo a`', '2. `ls -la /tmp`', '3. Po ~8 min: `! ssh s11 docker ps` - ma być',
    '```bash\nuptime\npwd\n```', '`task_1791109610193_9f9fec74`'].join('\n');
  const r = A.copyables(md);
  assert.deepEqual(r.map(c => [c.text, c.run]), [['echo a', true], ['ls -la /tmp', false], ['ssh s11 docker ps', true], ['uptime\npwd', true]]);
  assert.equal(r[2].note, 'ma być');
  assert.equal(r.length, new Set(r.map(c => c.text)).size);
  // to samo, co karty na telefonie (extract) + jedno polecenie tylko do kopiowania
  assert.deepEqual(r.filter(c => c.run).map(c => c.text), A.extract(md).map(c => c.text));
});

test('copyables: prose bullets with a label, ids, file paths and single words are not commands', () => {
  const md = ['- Przyczyna: `funes update` 01.10 bez `funes add claude local`', '- `task_1791098853798_bbe2d1fc`',
    '- `ho_1791100427325_e1b7ce84`', '1. `README.md`', '2. `42`', '- `./deploy.sh --dry-run` najpierw', '3. Mac: `brew upgrade herdr`'].join('\n');
  assert.deepEqual(A.copyables(md).map(c => c.text), ['./deploy.sh --dry-run', 'brew upgrade herdr']);
  for (const t of ['task_1791098853798_bbe2d1fc', 'README.md', 'funes', 'Zrobione.']) assert.ok(!A.looksLikeCmd(t), t);
  for (const t of ['funes status', 'sudo systemctl restart cc-panel', '~/bin/x.sh', './deploy.sh']) assert.ok(A.looksLikeCmd(t), t);
});
