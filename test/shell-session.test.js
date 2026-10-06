'use strict';
// Dok shella w Dyspozytorze: stała sesja tmux ccp-shell. Logika zakładania na atrapie tmux,
// potem kopia server.js na losowym porcie z własnym serwerem tmux (TMUX_TMPDIR w katalogu tymczasowym).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { SHELL_SESSION, ensureShellSession } = require('../lib/shell-session');

function fakeTmux(exists) {
  const calls = [];
  const tmux = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'has-session') { if (!exists()) throw new Error("can't find session"); return ''; }
    if (args[0] === 'new-session') return '';
    throw new Error('nieoczekiwane ' + args[0]);
  };
  return { tmux, calls };
}

test('ensureShellSession: brak sesji -> new-session -d w HOME, istniejąca -> tylko has-session', async () => {
  let exists = false;
  const t = fakeTmux(() => exists);
  assert.equal(await ensureShellSession(t.tmux, '/home/x'), SHELL_SESSION);
  assert.deepEqual(t.calls, ['has-session -t =ccp-shell', 'new-session -d -s ccp-shell -c /home/x']);
  exists = true;
  t.calls.length = 0;
  await ensureShellSession(t.tmux, '/home/x');
  assert.deepEqual(t.calls, ['has-session -t =ccp-shell']);
});

test('ensureShellSession: wyścig dwóch kart (duplicate session) nie jest błędem, prawdziwy błąd tak', async () => {
  let made = false;
  const race = async (args) => {
    if (args[0] === 'has-session') { if (!made) throw new Error('no'); return ''; }
    made = true; // inna karta zdążyła pierwsza
    throw new Error('duplicate session: ccp-shell');
  };
  assert.equal(await ensureShellSession(race, '/h'), SHELL_SESSION);
  const broken = async () => { throw new Error('no server'); };
  await assert.rejects(ensureShellSession(broken, '/h'), /no server/);
});

// ---------- kopia serwera ----------
const TOKEN = 'test-' + crypto.randomBytes(6).toString('hex');
const PORT = 20000 + Math.floor(Math.random() * 20000);
let home, child, env;
const tmuxT = (...a) => execFileSync('tmux', a, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hasShell = () => { try { tmuxT('has-session', '-t', '=ccp-shell'); return true; } catch { return false; } };
const capture = () => tmuxT('capture-pane', '-p', '-t', '=ccp-shell:');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return false;
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-shell-'));
  fs.mkdirSync(path.join(home, '.config/cc-panel'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/cc-panel/token'), TOKEN + '\n', { mode: 0o600 });
  env = { ...process.env, HOME: home, TMUX_TMPDIR: home, SHELL: '/bin/bash', PORT: String(PORT), HOST: '127.0.0.1',
    MOZG_SOCKET: path.join(home, 'brak.sock'), PROJECTS_ROOT: home, TLS_PORT: '0', REPORT_PORT: '' };
  delete env.TMUX; // test bywa odpalany z wnętrza tmux - bez tego tmux celowałby w serwer z TMUX
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server.js nie wystartował')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('cc-panel na')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error('server.js exit ' + code)));
  });
});
after(() => {
  child?.kill();
  try { tmuxT('kill-session', '-t', '=ccp-shell'); } catch {} // tylko testowy serwer tmux (socket w katalogu tymczasowym)
  fs.rmSync(home, { recursive: true, force: true });
});

function open(cookie = true, origin = `http://127.0.0.1:${PORT}`) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = 'ccp=' + encodeURIComponent(TOKEN);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?shell=1&c=100&r=30`, { headers });
  ws.out = '';
  ws.on('message', (d) => { ws.out += d; });
  return ws;
}
const status = (ws) => new Promise((resolve) => {
  ws.on('open', () => resolve('open'));
  ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
  ws.on('error', () => resolve('error'));
});
const closed = (ws) => new Promise((r) => { if (ws.readyState === 3) r(); else ws.on('close', r); });

test('shell=1 bez ciasteczka albo z obcym Origin: 401, sesja nie powstaje', async () => {
  assert.equal(await status(open(false)), 401);
  assert.equal(await status(open(true, 'https://evil.example')), 401);
  assert.equal(hasShell(), false);
});

test('shell=1: zakłada ccp-shell, ponowne otwarcie podpina tę samą, rozłączenie nie zabija sesji', async () => {
  const a = open();
  assert.equal(await status(a), 'open');
  assert.ok(await until(hasShell), 'ccp-shell powstał');
  assert.equal(tmuxT('display-message', '-p', '-t', '=ccp-shell:', '#{pane_current_path}').trim(), fs.realpathSync(home));
  a.close();
  await closed(a);
  await sleep(300);
  assert.equal(hasShell(), true, 'sesja przeżyła zamknięcie doku');
  const b = open();
  assert.equal(await status(b), 'open');
  await sleep(300);
  assert.equal(tmuxT('list-sessions', '-F', '#{session_name}').trim(), 'ccp-shell', 'jedna sesja, bez duplikatów');
  b.close();
  await closed(b);
});

test('wklejka wielu linii (bracketed paste) czeka na Enter, potem wykonuje obie', async () => {
  const ws = open();
  assert.equal(await status(ws), 'open');
  assert.ok(await until(() => /\$\s*$/m.test(capture().trimEnd())), 'prompt basha');
  // tmux włącza tryb 2004 w xtermie, gdy bash go zażąda - wtedy xterm.js sam owija Cmd+V w ESC[200~…ESC[201~
  assert.ok(await until(() => ws.out.includes('\x1b[?2004h')), 'tmux włączył bracketed paste po stronie przeglądarki');
  // tak wysyła xterm.js: \n zamienione na \r, całość w znacznikach
  ws.send(JSON.stringify({ t: 'i', d: '\x1b[200~echo P$((40+2))\recho Q$((40+3))\x1b[201~' }));
  await sleep(800);
  const before = capture();
  assert.match(before, /echo Q\$\(\(40\+3\)\)/, 'tekst wklejony');
  assert.doesNotMatch(before, /^P42$/m, 'nic się nie wykonało przed Enter');
  ws.send(JSON.stringify({ t: 'i', d: '\r' }));
  assert.ok(await until(() => /^P42$/m.test(capture()) && /^Q43$/m.test(capture())), 'po Enter obie linie wykonane');
  ws.close();
  await closed(ws);
});

test('skrót doku: Ctrl+` (także klawisz ISO Maca), bez Cmd/Option/Shift', () => {
  const { isShellShortcut } = require('../public/shell-dock');
  const k = (o) => ({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, code: 'Backquote', key: '`', ...o });
  assert.equal(isShellShortcut(k()), true);
  assert.equal(isShellShortcut(k({ code: 'IntlBackslash', key: '§' })), true);
  assert.equal(isShellShortcut(k({ ctrlKey: false })), false);
  assert.equal(isShellShortcut(k({ metaKey: true })), false, 'Cmd+` zostaje macOS (przełączanie okien)');
  assert.equal(isShellShortcut(k({ altKey: true })), false);
  assert.equal(isShellShortcut(k({ code: 'KeyA', key: 'a' })), false);
});

test('szerokość doku: granice przy przeciąganiu, zapis jako ułamek, śmieci = domyślna', () => {
  const { dockWidth, parseRatio, widthCss, SHELL_MIN, CHAT_MIN } = require('../public/shell-dock');
  // widok 1512 px od 0: kursor w 800 = dok 712 px
  assert.equal(dockWidth(800, 1512, 1512), 712);
  assert.equal(dockWidth(1400, 1512, 1512), SHELL_MIN, 'nie węższy niż minimum');
  assert.equal(dockWidth(10, 1512, 1512), 1512 - CHAT_MIN, 'czat zostaje widoczny');
  assert.equal(dockWidth(100, 700, 700), SHELL_MIN, 'wąskie okno: minimum doku wygrywa');
  for (const v of [null, '', 'abc', '0', '1', '-0.3', '1.5', 'NaN']) assert.equal(parseRatio(v), null, String(v));
  assert.equal(parseRatio('0.4709'), 0.4709);
  const css = widthCss(0.4709);
  assert.equal(css, `clamp(${SHELL_MIN}px, 47.09%, max(${SHELL_MIN}px, calc(100% - ${CHAT_MIN}px)))`);
});

test('uchwyt szerokości: w doku, separator z klawiaturą, schowany na telefonie', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(html, /<aside id="shell-dock"[^>]*>\s*<div id="shell-resize" class="shell-resize" role="separator" aria-orientation="vertical"[^>]*tabindex="0"/);
  assert.match(css, /\.shell-resize \{[^}]*cursor: col-resize;[^}]*touch-action: none;/);
  assert.match(css, /@media \(max-width: 899px\) \{[^}]*\}[^@]*\.shell-resize \{ display: none; \}/);
});
