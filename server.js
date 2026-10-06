'use strict';
// cc-panel: mobilny panel do sesji Claude Code / Codex działających w tmux.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { listCodexLocal, listRecent, ID_RE } = require('./lib/agents');
const { createPush } = require('./lib/push');
const herdr = require('./lib/herdr');
const { createMozg, isBrainPane, pullNotifications } = require('./lib/mozg');
const { plError, bindParams } = require('./lib/panels');
const mozg = createMozg(process.env.MOZG_SOCKET || undefined); // MOZG_SOCKET: tylko dla kopii testowej
const { createAttachments, attachmentsConfig, validList, readRaw } = require('./lib/attachments');
const calendar = require('./lib/calendar').createCalendar({ mozg });
// jeden katalog na obrazy w obie strony (od użytkownika i kopie od workerów), katalog i retencja z ~/.config/mozg/config.json
const attachmentsCfg = attachmentsConfig();
const attachments = createAttachments(attachmentsCfg.dir, attachmentsCfg.retentionDays);
// retencja załączników mózgu: domyślnie 30 dni od zapisu (attachments_retention_days)
const sweepAttachments = () => { try { const n = attachments.cleanup(); if (n) console.log(`załączniki mózgu: usunięto ${n} starszych niż ${attachments.retentionDays} dni`); } catch (e) { console.error('załączniki mózgu:', e.message); } };
sweepAttachments();
setInterval(sweepAttachments, 6 * 3600 * 1000).unref();
const { attention, excluded, summary } = require('./lib/attention');
const { matchCodexHerdr, looseCodexItems } = require('./lib/codex-sessions');
const { usageStatus } = require('./lib/usage');
const usageAlerts = require('./lib/usage-alerts');
const { codexUsage } = require('./lib/codex-usage');
const { pendingAsk } = require('./lib/transcript');
const { tmuxStatus } = require('./lib/tmux-status');
const { ensureShellSession } = require('./lib/shell-session');
function workerLabel() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/mozg/config.json'), 'utf8')).worker_workspace_label || ''; } catch { return ''; }
}
const os = require('os');
const { bangCommands, commandBlocks } = require('./lib/bang');
const { loadMachines, remoteCall, attachArgs } = require('./lib/machines');

const PORT = +process.env.PORT || 7690;
const HOST = process.env.HOST || '127.0.0.1';
const HOME = process.env.HOME;
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(HOME, 'Projekty');
const CFG_DIR = path.join(HOME, '.config', 'cc-panel');
const TOKEN_FILE = path.join(CFG_DIR, 'token');
const PUBLIC = path.join(__dirname, 'public');
const NM = path.join(__dirname, 'node_modules');

// ---------- token ----------
fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(18).toString('base64url') + '\n', { mode: 0o600 });
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} // zły %-kod: pomiń wpis
  }
  return out;
}
const authed = (req) => safeEq(cookies(req).ccp || '', TOKEN);

// jednorazowe kody logowania z bin/ccp-kod: plik <sha256 kodu> z czasem wygaśnięcia; zużycie = unlink (atomowe, bez wyścigów)
const CODES_DIR = path.join(CFG_DIR, 'login-codes');
function useLoginCode(input) {
  const code = String(input || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{8}$/.test(code)) return false;
  const file = path.join(CODES_DIR, crypto.createHash('sha256').update(code).digest('hex'));
  let exp;
  try { exp = +fs.readFileSync(file, 'utf8').trim(); } catch { return false; }
  try { fs.unlinkSync(file); } catch { return false; } // ktoś zużył go przed nami
  return exp * 1000 > Date.now() ? true : 'expired';
}
// wszystkie połączenia przychodzą przez proxy z 127.0.0.1, więc limit jest globalny, nie per adres
const LOGIN_MAX_FAILS = 20, LOGIN_WINDOW_MS = 5 * 60 * 1000;
let loginFails = [];

// ---------- tmux ----------
function tmux(args) {
  return new Promise((resolve, reject) =>
    execFile('tmux', args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 32 << 20 }, (err, out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(out)));
}
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const target = (name) => `=${name}:`;

async function listSessions() {
  let out;
  try {
    out = await tmux(['list-sessions', '-F',
      '#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}\t#{@ccp_kind}']);
  } catch (e) {
    if (/no server running|error connecting|No such file/i.test(e.message)) return [];
    throw e;
  }
  const now = Date.now() / 1000;
  const sessions = out.trim().split('\n').filter(Boolean).map((line) => {
    const [name, created, activity, attached, cwd, cmd, kind] = line.split('\t');
    return { name, created: +created, activity: +activity, attached: +attached, cwd, cmd, kind: kind || '' };
  });
  await Promise.all(sessions.map(async (s) => {
    let tail = '';
    try { tail = await tmux(['capture-pane', '-p', '-J', '-t', target(s.name), '-S', '-30']); } catch {}
    const lines = tail.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!s.kind) s.kind = /claude/i.test(s.cmd) ? 'claude' : /codex/i.test(s.cmd) ? 'codex' : '';
    s.status = tmuxStatus(s.cmd, lines, now - s.activity);
    s.preview = lines.filter((l) => !/^[\s─━╭╮╰╯│┃▔▁>❯]*$/.test(l)).slice(-3).join('\n').slice(-300);
  }));
  // „o co prosi”: heurystyka tmux jest najsłabsza, więc podgląd tylko gdy transkrypt też ma otwarty tool_use
  if (sessions.some((s) => s.status === 'approval')) {
    const ids = new Map(listClaudeSessions(await tmuxPanes()).filter((c) => c.tmux).map((c) => [c.tmux, c.id]));
    for (const s of sessions) if (s.status === 'approval') s.ask = pendingAsk(ids.get(s.name));
  }
  sessions.sort((a, b) => b.activity - a.activity);
  return sessions;
}

// ---------- sesje Claude Code (rejestr ~/.claude/sessions, w tym Remote Control) ----------
const CLAUDE_SESSIONS = path.join(HOME, '.claude', 'sessions');
const CLAUDE_STATUS = { idle: 'idle', shell: 'bg', waiting: 'approval', permission: 'approval', approval: 'approval' };

function procStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' '); // f[0] = pole 3
    return { ppid: +f[1], start: f[19] };
  } catch { return null; }
}

async function tmuxPanes() {
  const panes = new Map(); // pid powłoki w panelu tmux -> nazwa sesji
  try {
    const out = await tmux(['list-panes', '-a', '-F', '#{pane_pid}\t#{session_name}']);
    for (const l of out.trim().split('\n')) { const [pid, name] = l.split('\t'); panes.set(+pid, name); }
  } catch {}
  return panes;
}

async function localAgents() {
  const panes = await tmuxPanes();
  return { claude: listClaudeSessions(panes), codex: listCodexLocal(HOME, panes) };
}

// jak localAgents, ale sesje działające w herdr dostają pole herdr = id panelu
async function localAgentsWithHerdr() {
  const [local, hitems] = await Promise.all([localAgents(), herdr.listPanes(null)]);
  matchHerdr(local.claude, local.codex, hitems || []);
  return local;
}

function listClaudeSessions(panes) {
  let files = [];
  try { files = fs.readdirSync(CLAUDE_SESSIONS).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS, f), 'utf8')); } catch { continue; }
    const st = procStat(j.pid);
    if (!st || (j.procStart && st.start !== String(j.procStart))) continue; // proces nie żyje
    out.push({
      pid: j.pid, name: j.name || path.basename(j.cwd || ''), named: !!j.name && j.nameSource === 'user', cwd: j.cwd, version: j.version,
      rawStatus: j.status || '', status: CLAUDE_STATUS[j.status] || 'working',
      ask: CLAUDE_STATUS[j.status] === 'approval' ? pendingAsk(j.sessionId) : null, // „o co prosi”, tylko przy potwierdzonej zgodzie
      updated: (j.statusUpdatedAt || j.updatedAt || j.startedAt || 0) / 1000,
      started: (j.startedAt || 0) / 1000,
      id: j.sessionId || '', rcUrl: j.bridgeSessionId ? `https://claude.ai/code/${j.bridgeSessionId}` : null,
      tmux: panes.get(st.ppid) || panes.get(j.pid) || null,
    });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// ---------- raporty z innych maszyn (cc-report.py) ----------
// raporty przychodzą na główny serwer (/report, w LAN przez HTTPS 443 -> 7443); osobny port HTTP tylko jawnie z env (dawniej 7691)
const REPORT_PORT = +process.env.REPORT_PORT || 0;
const REPORT_TOKEN_FILE = path.join(CFG_DIR, 'report-token');
if (!fs.existsSync(REPORT_TOKEN_FILE)) {
  fs.writeFileSync(REPORT_TOKEN_FILE, crypto.randomBytes(18).toString('base64url') + '\n', { mode: 0o600 });
}
const REPORT_TOKEN = fs.readFileSync(REPORT_TOKEN_FILE, 'utf8').trim();
const REPORT_TTL = 90; // s bez raportu = maszyna znika z listy
const LOCAL_HOST = process.env.HOST_LABEL || require('os').hostname();
const remote = new Map(); // host -> { at, sessions, codex }

// ---------- maszyny do uruchamiania sesji (lokalna + zdalne przez SSH) ----------
const MACHINES = loadMachines(CFG_DIR);
const isLocal = (name) => !name || name === LOCAL_HOST;
function machineOf(name) {
  if (isLocal(name)) return null;
  const m = MACHINES[name];
  if (!m) throw new Error('Nieznana maszyna: ' + name);
  return m;
}
const machineNames = () => [LOCAL_HOST, ...Object.keys(MACHINES)];

// panele herdr ze wszystkich maszyn (null = maszyna/herdr niedostępne)
async function allHerdr() {
  return Promise.all(machineNames().map(async (name) => {
    const items = await herdr.listPanes(machineOf(name));
    return { machine: name, local: isLocal(name), available: items !== null,
      items: (items || []).map((i) => ({ ...i, machine: name })) };
  }));
}

// sessions = Claude, codex = Codex; lokalna maszyna zawsze pierwsza
function allHosts(local) {
  const now = Date.now() / 1000;
  const hosts = [{ host: LOCAL_HOST, at: now, local: true, sessions: local.claude, codex: local.codex }];
  for (const [host, r] of remote) {
    if (now - r.at > REPORT_TTL) { remote.delete(host); continue; }
    hosts.push({ host, at: r.at, local: false, sessions: r.sessions, codex: r.codex });
  }
  return hosts;
}

function sanitizeReported(s) {
  const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const bridge = str(s.bridgeSessionId, 80);
  return {
    pid: num(s.pid), id: str(s.sessionId, 40), name: str(s.name, 80) || path.basename(str(s.cwd)), named: !!str(s.name, 80) && s.nameSource === 'user', cwd: str(s.cwd), version: str(s.version, 20),
    rawStatus: str(s.status, 30), status: CLAUDE_STATUS[s.status] || 'working',
    updated: num(s.statusUpdatedAt || s.updatedAt || s.startedAt) / 1000, started: num(s.startedAt) / 1000,
    rcUrl: /^session_[A-Za-z0-9]+$/.test(bridge) ? `https://claude.ai/code/${bridge}` : null, tmux: null,
  };
}

// nazwa wyświetlana panelu herdr = nazwa sesji agenta: nazwa sesji Claude (z rejestru),
// a gdy jej brak — tytuł terminala ustawiany przez agenta (tytuł rozmowy Claude, wątek Codexa);
// nazwa workspace herdr zostaje jako informacja dodatkowa
// ostatnia zmiana statusu panelu herdr widziana przez serwer (monitor co 3 s + każde /api/herdr)
const paneSeen = new Map(); // `${maszyna}/${panel}` -> { status, at, seen }
function trackPanes(hs) {
  const now = Date.now() / 1000;
  for (const it of hs.flatMap((h) => h.items)) {
    const key = `${it.machine}/${it.pane}`;
    const prev = paneSeen.get(key);
    // pierwsze zobaczenie: czas nieznany (0) — nie udajemy, że coś działo się „teraz”
    if (!prev || prev.status !== it.status) paneSeen.set(key, { status: it.status, at: prev ? now : 0, seen: now });
    else prev.seen = now;
  }
  for (const [k, v] of paneSeen) if (now - v.seen > 86400) paneSeen.delete(k);
}

async function addDisplayNames(hs) {
  const brainThreads = await mozg.threads().catch(() => ({ threads: [] }));
  const brainNames = new Map(brainThreads.threads.filter(t => t.session?.pane).map(t => [t.session.pane, t.title]));
  const hosts = markRemoteHerdr(allHosts(await localAgentsWithHerdr()), hs);
  trackPanes(hs);
  const named = new Map();
  const updated = new Map(); // czas ostatniej zmiany z rejestru Claude / pliku rollout Codexa
  for (const h of hosts) {
    for (const c of h.sessions) if (c.herdr) updated.set(`${h.host}/${c.herdr}`, c.updated);
    for (const c of h.codex || []) if (c.herdr) updated.set(`${h.host}/${c.herdr}`, c.updated);
  }
  const now = Date.now() / 1000;
  for (const h of hosts) for (const c of h.sessions) if (c.herdr && c.named) named.set(`${h.host}/${c.herdr}`, c.name);
  // „o co prosi”: herdr `blocked` = potwierdzona zgoda; transkrypty są tylko lokalnie
  const localIds = new Map((hosts.find((h) => h.local)?.sessions || []).filter((c) => c.herdr && c.id).map((c) => [c.herdr, c.id]));
  for (const it of hs.flatMap((h) => h.items)) {
    it.ask = it.status === 'approval' && it.kind === 'claude' && isLocal(it.machine) ? pendingAsk(it.sessionId || localIds.get(it.pane)) : null;
  }
  for (const it of hs.flatMap((h) => h.items)) {
    const key = `${it.machine}/${it.pane}`;
    it.activity = it.status === 'working' ? now : Math.max(updated.get(key) || 0, paneSeen.get(key)?.at || 0);
  }
  for (const it of hs.flatMap((h) => h.items)) {
    const title = (it.title || '').replace(/\s+\|\s+[^|]*$/, '').trim(); // Codex: „wątek | katalog”
    const generic = !title || /^(claude code|codex|claude|bash|zsh|-?zsh|~)$/i.test(title) || /^[^@\s]+@[^:\s]+/.test(title)
      || (it.cwd || '').split('/').includes(title); // sama nazwa katalogu to nie nazwa sesji
    it.display = (isBrainPane(it) && isLocal(it.machine) && brainNames.has(it.pane) ? '📡 ' + brainNames.get(it.pane) : '') || named.get(`${it.machine}/${it.pane}`) || (it.agent && !generic ? title : '') || it.name;
  }
}

// sesje Claude/Codex działające w panelach herdr dostają pole herdr = id panelu.
// Najpierw po identyfikatorze rozmowy (herdr zna go tylko z zainstalowaną integracją),
// potem po katalogu — gdy w tym katalogu jest dokładnie jeden taki panel i jedna taka sesja.
function matchHerdr(sessions, codex, items) {
  const byId = new Map(items.filter((i) => i.sessionId).map((i) => [i.sessionId, i.pane]));
  const uniq = (list, key) => {
    const m = new Map();
    for (const x of list) m.set(key(x), m.has(key(x)) ? null : x);
    return m;
  };
  const claudePanes = uniq(items.filter((i) => i.kind === 'claude' && !i.sessionId), (i) => i.cwd);
  const loose = sessions.filter((c) => !c.tmux && !(c.id && byId.has(c.id)));
  const looseByCwd = uniq(loose, (c) => c.cwd);
  for (const c of sessions) {
    if (c.tmux) { c.herdr = null; continue; }
    c.herdr = (c.id && byId.get(c.id)) || (looseByCwd.get(c.cwd) === c && claudePanes.get(c.cwd)?.pane) || null;
  }
  matchCodexHerdr(codex, items);
}

function markRemoteHerdr(hosts, hs) {
  for (const h of hosts) {
    if (h.local) continue;
    matchHerdr(h.sessions, h.codex, hs.find((x) => x.machine === h.host)?.items || []);
  }
  return hosts;
}

function sanitizeCodex(s) {
  const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const status = ['working', 'idle', 'approval'].includes(s.status) ? s.status : 'idle';
  const title = str(s.title, 120);
  return { pid: num(s.pid), id: str(s.id, 40), title, name: title || path.basename(str(s.cwd)), cwd: str(s.cwd), status,
    updated: num(s.updated), tmux: null, appServer: !!s.appServer, subagent: s.subagent === true, parentThreadId: str(s.parentThreadId, 40) };
}

async function handleReport(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!safeEq((req.headers.authorization || '').replace(/^Bearer /, ''), REPORT_TOKEN)) return send(res, 401, { error: 'unauthorized' });
  try {
    const body = await readBody(req);
    const host = String(body.host || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
    if (!host || !Array.isArray(body.sessions)) return send(res, 400, { error: 'bad report' });
    // tylko maszyny z machines.json — wycofana maszyna ze starym reporterem nie wraca na listę
    if (!Object.hasOwn(MACHINES, host)) return send(res, 403, { error: 'unknown host' });
    remote.set(host, {
      at: Date.now() / 1000,
      sessions: body.sessions.slice(0, 100).map(sanitizeReported),
      codex: (Array.isArray(body.codex) ? body.codex : []).slice(0, 100).map(sanitizeCodex),
    });
    return send(res, 200, { ok: true });
  } catch (e) { return send(res, 400, { error: e.message }); }
}

// alarm ze skryptu bez sesji Claude (np. check.sh mesa, gdy crony Claude stoją); 502 = nie doszło do żadnego urządzenia
async function handleNotify(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!safeEq((req.headers.authorization || '').replace(/^Bearer /, ''), REPORT_TOKEN)) return send(res, 401, { error: 'unauthorized' });
  try {
    const body = await readBody(req);
    const title = String(body.title || '').slice(0, 120);
    if (!title) return send(res, 400, { error: 'title required' });
    const tag = 'notify-' + String(body.tag || 'skrypt').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    const sent = await push.notify('alarm', { title: '🚨 ' + title, body: String(body.body || '').slice(0, 400), url: '/#/', tag });
    return send(res, sent ? 200 : 502, { sent });
  } catch (e) { return send(res, 400, { error: e.message }); }
}

// ---------- indeks katalogów do wyszukiwarki w „Nowa sesja” ----------
const DIR_MAX_DEPTH = +process.env.DIR_MAX_DEPTH || 5;
const DIR_SKIP = new Set(['node_modules', 'venv', '__pycache__', 'dist', 'build', 'target', 'vendor']);
let dirIndex = { at: 0, dirs: [] };

function buildDirIndex() {
  const out = [];
  const walk = (abs, rel, depth) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    // ~/Projekty sam bywa repozytorium, więc regułę stosujemy dopiero poniżej korzenia
    const isRepo = depth > 1 && entries.some((e) => e.name === '.git');
    for (const e of entries) {
      if (e.name.startsWith('.') || DIR_SKIP.has(e.name)) continue;
      const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(abs, e.name), { throwIfNoEntry: false })?.isDirectory());
      if (!isDir) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      // nie schodź w głąb repozytoriów (src/, lib/ itd. zaśmieciłyby wyniki)
      if (depth < DIR_MAX_DEPTH && !isRepo) walk(path.join(abs, e.name), r, depth + 1);
    }
  };
  walk(PROJECTS_ROOT, '', 1);
  return out;
}

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

function searchDirs(q) {
  if (Date.now() - dirIndex.at > 60000) dirIndex = { at: Date.now(), dirs: buildDirIndex() };
  const terms = fold(q).split(/[\s/]+/).filter(Boolean);
  if (!terms.length) return dirIndex.dirs.filter((d) => !d.includes('/')).sort();
  const scored = [];
  for (const d of dirIndex.dirs) {
    const fd = fold(d);
    if (!terms.every((t) => fd.includes(t))) continue;
    const base = fd.slice(fd.lastIndexOf('/') + 1), last = terms[terms.length - 1];
    const score = (base === last ? 0 : base.startsWith(last) ? 1 : base.includes(last) ? 2 : 3) * 1000
      + d.split('/').length * 50 + d.length;
    scored.push([score, d]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, 40).map((x) => x[1]);
}

function listChildren(rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  if (parts.some((x) => x === '..' || x === '.')) throw new Error('Niedozwolona ścieżka');
  const abs = path.join(PROJECTS_ROOT, ...parts);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { throw new Error('Brak katalogu: ' + parts.join('/')); }
  const dirs = entries.filter((e) => !e.name.startsWith('.') && !DIR_SKIP.has(e.name) && (e.isDirectory()
    || (e.isSymbolicLink() && fs.statSync(path.join(abs, e.name), { throwIfNoEntry: false })?.isDirectory())))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b, 'pl'));
  return { path: parts.join('/'), dirs };
}

function makeDir(rel) {
  const parts = String(rel || '').replace(/^~\/Projekty\/?/, '').split('/').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Podaj nazwę katalogu');
  for (const x of parts) {
    if (x === '.' || x === '..' || x.startsWith('.') || /[\x00-\x1f\\]/.test(x) || x.length > 100) {
      throw new Error('Niedozwolona nazwa: ' + x);
    }
  }
  const abs = path.join(PROJECTS_ROOT, ...parts);
  if (!abs.startsWith(PROJECTS_ROOT + path.sep)) throw new Error('Katalog musi być w ' + PROJECTS_ROOT);
  fs.mkdirSync(abs, { recursive: true });
  dirIndex.at = 0; // przebuduj indeks przy następnym wyszukiwaniu
  return parts.join('/');
}

function listProjects() {
  const out = [];
  const visible = (d) => !d.name.startsWith('.') && d.isDirectory();
  let top = [];
  try { top = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter(visible); } catch { return out; }
  for (const cat of top) {
    out.push(cat.name);
    try {
      for (const p of fs.readdirSync(path.join(PROJECTS_ROOT, cat.name), { withFileTypes: true }).filter(visible)) {
        out.push(`${cat.name}/${p.name}`);
      }
    } catch {}
  }
  return out.sort();
}

function resolveDir(dir) {
  if (!dir) return PROJECTS_ROOT;
  let abs = dir.startsWith('~') ? path.join(HOME, dir.slice(1)) : dir;
  if (!path.isAbsolute(abs)) abs = path.join(PROJECTS_ROOT, abs);
  abs = path.resolve(abs);
  if (abs !== HOME && !abs.startsWith(HOME + path.sep)) throw new Error('Katalog musi być w ' + HOME);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Brak katalogu: ' + abs);
  return abs;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- modele i effort ----------
const CLAUDE_MODELS = ['fable', 'opus', 'opus[1m]', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function listModels() {
  let codex = [];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'models_cache.json'), 'utf8'));
    codex = (d.models || []).filter((m) => m.visibility !== 'hide').map((m) => ({
      id: m.slug, name: m.display_name || m.slug, default: m.default_reasoning_level || '',
      efforts: (m.supported_reasoning_levels || []).map((e) => e.effort).filter(Boolean),
    }));
  } catch {}
  return { claude: { models: CLAUDE_MODELS.map((id) => ({ id, name: id })), efforts: CLAUDE_EFFORTS }, codex: { models: codex } };
}
const MODEL_RE = /^[A-Za-z0-9._:\[\]-]{1,60}$/;
const EFFORT_RE = /^[a-z]{2,10}$/;

// argumenty agenta jako tablica (dla herdr agent start — bez powłoki, więc bez cytowania)
function agentArgs(kind, { cont, yolo, prompt, model, effort, rc, resume }, rcName) {
  const a = [];
  if (kind === 'claude') {
    if (resume) a.push('--resume', resume); else if (cont) a.push('--continue');
    if (model) a.push('--model', model);
    if (effort) a.push('--effort', effort);
    if (yolo) a.push('--dangerously-skip-permissions');
    if (rc) a.push('--remote-control', rcName);
    if (prompt) a.push(prompt);
  } else if (kind === 'codex') {
    if (resume) a.push('resume', resume); else if (cont) a.push('resume', '--last');
    if (model) a.push('-m', model);
    if (effort) a.push('-c', 'model_reasoning_effort=' + effort);
    if (yolo) a.push('--dangerously-bypass-approvals-and-sandbox');
    if (prompt) a.push(prompt);
  }
  return a;
}

async function createHerdrSession(opts) {
  const { kind, dir, name, model, effort, resume } = opts;
  const mach = machineOf(opts.machine);
  if (!['claude', 'codex', 'shell'].includes(kind)) throw new Error('Nieznany typ sesji');
  if (model && !MODEL_RE.test(model)) throw new Error('Niepoprawna nazwa modelu');
  if (effort && !EFFORT_RE.test(effort)) throw new Error('Niepoprawny poziom effort');
  if (resume && !ID_RE.test(resume)) throw new Error('Niepoprawny identyfikator rozmowy');
  const cwd = mach ? (await remoteCall(mach, { op: 'resolve', path: dir || '' })).abs : resolveDir(dir);
  const label = (name || `${kind}-${path.basename(cwd)}`).replace(/[^\p{L}\p{N}_. -]+/gu, '-').slice(0, 40) || kind;
  const rcName = label.replace(/[^A-Za-z0-9_-]+/g, '-');
  return herdr.createWorkspace(mach, { cwd, label, kind, args: agentArgs(kind, opts, rcName) });
}

async function createSession({ kind, dir, name, cont, yolo, prompt, model, effort, rc, resume }) {
  if (resume && !ID_RE.test(resume)) throw new Error('Niepoprawny identyfikator rozmowy');
  if (model && !MODEL_RE.test(model)) throw new Error('Niepoprawna nazwa modelu');
  if (effort && !EFFORT_RE.test(effort)) throw new Error('Niepoprawny poziom effort');
  if (!['claude', 'codex', 'shell'].includes(kind)) throw new Error('Nieznany typ sesji');
  const cwd = resolveDir(dir);
  const existing = new Set((await listSessions()).map((s) => s.name));
  let base = (name || `${kind}-${path.basename(cwd)}`).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || kind;
  let n = base, i = 2;
  while (existing.has(n)) n = `${base}-${i++}`;

  let cmd = '';
  if (kind === 'claude') {
    cmd = 'claude';
    if (resume) cmd += ' --resume ' + resume;
    else if (cont) cmd += ' --continue';
    if (model) cmd += ' --model ' + shq(model);
    if (effort) cmd += ' --effort ' + effort;
    // nazwa zawsze jawnie: bez niej --remote-control połknąłby prompt jako nazwę
    if (rc) cmd += ' --remote-control ' + shq(n);
    if (yolo) cmd += ' --dangerously-skip-permissions';
    if (prompt) cmd += ' ' + shq(prompt);
  } else if (kind === 'codex') {
    cmd = resume ? 'codex resume ' + resume : cont ? 'codex resume --last' : 'codex';
    if (model) cmd += ' -m ' + shq(model);
    if (effort) cmd += ' -c model_reasoning_effort=' + effort;
    if (yolo) cmd += ' --dangerously-bypass-approvals-and-sandbox';
    if (prompt) cmd += ' ' + shq(prompt);
  }
  await tmux(['new-session', '-d', '-s', n, '-c', cwd, '-x', '100', '-y', '40']);
  await tmux(['set-option', '-s', 'focus-events', 'on']).catch(() => {}); // Claude/Codex chcą zdarzeń fokusu
  await tmux(['set-option', '-t', target(n), '@ccp_kind', kind]);
  await tmux(['set-option', '-t', target(n), 'status', 'off']);
  await tmux(['set-option', '-t', target(n), 'window-size', 'latest']);
  await tmux(['set-option', '-t', target(n), 'history-limit', '20000']);
  if (cmd) await tmux(['send-keys', '-t', target(n), cmd, 'Enter']);
  return n;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const VENDOR = {
  '/vendor/xterm.js': path.join(NM, '@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': path.join(NM, '@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'),
  '/vendor/event-calendar.js': path.join(NM, '@event-calendar/build/dist/event-calendar.min.js'),
  '/vendor/event-calendar.css': path.join(NM, '@event-calendar/build/dist/event-calendar.min.css'),
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/report') return await handleReport(req, res); // własny token (report-token), nie ciasteczko
    if (p === '/notify') return await handleNotify(req, res); // push ze skryptów (dead-man mesa), ten sam token
    if (p === '/api/login' && req.method === 'POST') {
      const { token } = await readBody(req);
      // pełny token zawsze przechodzi (nie do zgadnięcia), limit chroni tylko krótkie kody — spam nie odetnie właściciela
      if (!safeEq(token || '', TOKEN)) {
        const now = Date.now();
        loginFails = loginFails.filter((t) => now - t < LOGIN_WINDOW_MS);
        if (loginFails.length >= LOGIN_MAX_FAILS) return send(res, 429, { error: 'Za dużo prób, spróbuj za kilka minut' });
        const used = useLoginCode(token);
        if (used !== true) {
          loginFails.push(now);
          return send(res, 401, { error: used === 'expired' ? 'Kod wygasł - wygeneruj nowy (ccp-kod)' : 'Zły token albo kod' });
        }
      }
      res.setHeader('Set-Cookie', `ccp=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET' && req.headers['x-ccp'] !== '1') return send(res, 403, { error: 'csrf' });

      if (p === '/api/sessions' && req.method === 'GET') return send(res, 200, await listSessions());
      // kalendarz: tylko odczyt (crontab, timery systemd, harmonogramy mozgd); żadnej metody zapisu
      if (p === '/api/calendar') {
        if (req.method !== 'GET') return send(res, 405, { error: 'Kalendarz jest tylko do odczytu' });
        try { return send(res, 200, await calendar.list(url.searchParams.get('from'), url.searchParams.get('to'))); }
        catch (e) { return send(res, e.code === 400 ? 400 : 500, { error: e.code === 400 ? e.message : 'Błąd odczytu kalendarza' }); }
      }
      // <img> nie wysyła X-CCP: odczyt obrazu tylko z ciasteczkiem (SameSite=Strict), bez zapisu
      const attMatch = req.method === 'GET' && p.match(/^\/api\/mozg\/attachment\/([0-9a-f]{32})$/);
      if (attMatch) return attachments.serve(res, attMatch[1], url.searchParams); // ?download=1: oryginał jako plik do zapisania
      if (p.startsWith('/api/mozg/')) {
        if (req.headers['x-ccp'] !== '1') return send(res, 403, { error: 'csrf' });
        if (p === '/api/mozg/status' && req.method === 'GET') return send(res, 200, await mozg.status(url.searchParams.get('thread_id') || undefined));
        if (p === '/api/mozg/threads' && req.method === 'GET') {
          try { return send(res, 200, await mozg.threads(true)); } catch (e) { return send(res, 503, { error: e.message }); }
        }
        if (p === '/api/mozg/projects' && req.method === 'GET') {
          const rel = url.searchParams.get('path') || '';
          if (path.isAbsolute(rel) || rel.split('/').includes('..')) return send(res, 400, { error: 'Wybierz katalog pod ~/Projekty' });
          return send(res, 200, url.searchParams.has('q') ? { dirs: searchDirs(url.searchParams.get('q') || '') } : listChildren(rel));
        }
        if (p === '/api/mozg/threads' && req.method === 'POST') {
          const body = await readBody(req);
          try { return send(res, 200, await mozg.call('thread_create', { project: body.project })); } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (p === '/api/mozg/archive' && req.method === 'POST') {
          const body = await readBody(req);
          try { return send(res, 200, await mozg.call('thread_archive', { id: body.id })); } catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (p === '/api/mozg/attachment' && req.method === 'POST') {
          try { return send(res, 200, attachments.save(await readRaw(req))); }
          catch (e) { return send(res, e.code || 500, { error: e.code ? e.message : 'Nie udało się zapisać obrazu' }); }
        }
        if (p === '/api/mozg/message'  && req.method === 'POST') {
          const body = await readBody(req);
          const files = body?.attachments ?? [];
          if (!body || typeof body.text !== 'string' || !(body.text.trim() || files.length) || Array.from(body.text).length > 20000 ||
              typeof body.client_message_id !== 'string' || !body.client_message_id || body.client_message_id.length > 200)
            return send(res, 400, { error: 'Nieprawidłowa wiadomość (limit 20 000 znaków)' });
          if (!validList(files)) return send(res, 400, { error: 'Nieprawidłowe załączniki (max 6 obrazów)' });
          const params = { client_message_id: body.client_message_id, text: body.text };
          if (files.length) params.attachments = files; // bez pola dla starszego mozgd
          try { return send(res, 200, await mozg.scoped('enqueue_user_message', params, body.thread_id || 'general')); }
          catch (e) { return send(res, 503, { error: e.message }); }
        }
        // podpięte panele Herdr: lista paneli z podpięciami (panel_inventory) oraz bind/unbind; zakładka musi istnieć
        if (p === '/api/mozg/panels' && req.method === 'GET') {
          try { return send(res, 200, { panels: await mozg.call('panel_inventory', {}, 20000) }); }
          catch (e) { return send(res, 503, { error: plError(e.message) }); }
        }
        if ((p === '/api/mozg/panels/bind' || p === '/api/mozg/panels/unbind') && req.method === 'POST') {
          const body = await readBody(req);
          let list;
          try { list = (await mozg.threads()).threads.filter(t => !t.archived); } catch (e) { return send(res, 503, { error: e.message }); }
          const titles = Object.fromEntries(list.map(t => [t.id, t.title]));
          let method, params;
          if (p.endsWith('/bind')) {
            const parsed = bindParams(body, new Set(list.map(t => t.id)));
            if (parsed.error) return send(res, 400, { error: parsed.error });
            method = 'panel_bind'; params = parsed.params;
          } else {
            if (!body || typeof body.panel !== 'string' || !body.panel.trim() || body.panel.length > 200) return send(res, 400, { error: 'Wybierz panel.' });
            method = 'panel_unbind'; params = { panel: body.panel };
          }
          try { return send(res, 200, await mozg.call(method, params, 20000)); }
          catch (e) { return send(res, /offline/.test(e.message) ? 503 : 400, { error: plError(e.message, titles) }); }
        }
        if (p === '/api/mozg/thread' && req.method === 'GET') {
          try { return send(res, 200, attachments.markExpired(await mozg.scoped('thread', { limit: 100 }, url.searchParams.get('thread_id') || 'general'))); }
          catch (e) { return send(res, 503, { error: e.message }); }
        }
      }
      if (p === '/api/models') return send(res, 200, listModels());
      if (p === '/api/claude') return send(res, 200, markRemoteHerdr(allHosts(await localAgentsWithHerdr()), await allHerdr()));
      if (p === '/api/machines') {
        const hs = await allHerdr();
        return send(res, 200, hs.map((h) => ({ name: h.machine, local: h.local, herdr: h.available })));
      }
      if (p === '/api/recent') {
        const local = await localAgents();
        const running = new Set([...local.claude.map((c) => c.id), ...local.codex.map((c) => c.id)].filter(Boolean));
        return send(res, 200, listRecent(HOME, running));
      }
      if (p === '/api/push/key') return send(res, 200, { key: push.publicKey });
      if (p === '/api/attention' && req.method === 'GET') {
        const [items, list] = await Promise.all([watchItems(), mozg.threads(true).catch(() => ({ threads: [] }))]);
        const decisions = list.threads.flatMap(t => (t.decisions || []).map(d => ({ ...d, thread_id: t.id, thread_title: t.title })));
        const usage = usageWithCodex();
        return send(res, 200, attention(items, decisions, workerLabel(),
          [...usageAlerts.usageAttention(usage), ...usageAlerts.usageAttention(usage.codex, usage.now, usageAlerts.CODEX)]));
      }
      if (p === '/api/summary' && req.method === 'GET') return send(res, 200, summary(await watchItems(), workerLabel()));
      if (p === '/api/usage' && req.method === 'GET') return send(res, 200, usageWithCodex());
      if (p === '/api/notifications' && req.method === 'GET') return send(res, 200, push.history()); // najnowsze pierwsze
      if (p === '/api/push/prefs' && req.method === 'POST') {
        return send(res, 200, { prefs: push.prefsFor((await readBody(req)).endpoint) });
      }
      if (p === '/api/push/subscribe' && req.method === 'POST') {
        const { subscription, prefs } = await readBody(req);
        return send(res, 200, { prefs: push.subscribe(subscription, prefs) });
      }
      if (p === '/api/push/unsubscribe' && req.method === 'POST') {
        push.unsubscribe((await readBody(req)).endpoint);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/push/test' && req.method === 'POST') {
        const n = await push.notify('test', { title: 'CC Panel', body: 'Powiadomienia działają ✅', url: '/#/', tag: 'test' },
          (await readBody(req)).endpoint);
        return send(res, 200, { sent: n });
      }
      if (p === '/api/dirs') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const mach = machineOf(body.machine || url.searchParams.get('machine'));
        if (mach) {
          if (req.method === 'POST') return send(res, 200, await remoteCall(mach, { op: 'mkdir', path: body.path }));
          if (url.searchParams.has('path')) return send(res, 200, await remoteCall(mach, { op: 'dirs', path: url.searchParams.get('path') }));
          return send(res, 200, await remoteCall(mach, { op: 'search', q: url.searchParams.get('q') || '' }, 30000));
        }
        if (req.method === 'POST') return send(res, 200, { dir: makeDir(body.path) });
        if (url.searchParams.has('path')) return send(res, 200, listChildren(url.searchParams.get('path')));
        return send(res, 200, { root: PROJECTS_ROOT, dirs: searchDirs(url.searchParams.get('q') || '') });
      }
      if (p === '/api/projects') return send(res, 200, { root: PROJECTS_ROOT, projects: listProjects() });
      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        if (!isLocal(body.machine) || body.backend === 'herdr') {
          const machine = isLocal(body.machine) ? LOCAL_HOST : body.machine;
          return send(res, 200, { herdr: await createHerdrSession(body), machine });
        }
        return send(res, 200, { name: await createSession(body) });
      }
      if (p === '/api/herdr' && req.method === 'GET') {
        const hs = await allHerdr();
        await addDisplayNames(hs);
        return send(res, 200, { available: hs.some((h) => h.available), machines: hs, items: hs.flatMap((h) => h.items), workerWorkspace: workerLabel() });
      }
      const hm = p.match(/^\/api\/herdr\/([^/]+)\/([^/]+)(\/[a-z]+)?$/);
      if (hm) {
        const mach = machineOf(decodeURIComponent(hm[1]));
        const pane = decodeURIComponent(hm[2]);
        hm[2] = hm[3];
        const it = await herdr.getPane(mach, pane);
        if (!it) return send(res, 404, { error: 'Brak panelu herdr' });
        if (isBrainPane(it) && req.method !== 'GET') return send(res, 403, { error: 'Panel dyspozytora tylko do podglądu' });
        if (hm[2] === '/log' && req.method === 'GET') {
          const lines = Math.min(+url.searchParams.get('lines') || 3000, 20000);
          return send(res, 200, await herdr.readPane(mach, pane, lines), 'text/plain; charset=utf-8');
        }
        if (hm[2] === '/cmds' && req.method === 'GET') {
          // transkrypty Claude są tylko lokalnie; zdalny panel = pusta lista
          const own = !mach && it.kind === 'claude';
          return send(res, 200, { cmds: own ? bangCommands(it.sessionId) : [], blocks: own ? commandBlocks(it.sessionId) : [] });
        }
        if (hm[2] === '/continue' && req.method === 'POST') {
          const { kind = 'claude' } = await readBody(req);
          if (it.agent) return send(res, 409, { error: 'Agent w tym panelu wciąż działa' });
          if (!['claude', 'codex'].includes(kind)) return send(res, 400, { error: 'Nieznany typ' });
          const rcName = it.workspace.replace(/[^A-Za-z0-9_-]+/g, '-');
          const agentName = await herdr.freeAgentName(mach, it.workspace);
          try {
            await herdr.startAgent(mach, pane, kind, agentName, agentArgs(kind, { cont: true, rc: kind === 'claude' }, rcName), 20000);
          } catch {
            // np. „No conversation found to continue” — agent nie wystartował, więc zaczynamy nową rozmowę
            const again = await herdr.getPane(mach, pane);
            if (again && !again.agent) {
              await herdr.startAgent(mach, pane, kind, agentName, agentArgs(kind, { rc: kind === 'claude' }, rcName));
              return send(res, 200, { ok: true, fresh: true });
            }
          }
          return send(res, 200, { ok: true });
        }
        if (!hm[2] && req.method === 'DELETE') {
          await herdr.closePane(mach, pane);
          return send(res, 200, { ok: true });
        }
      }
      const m = p.match(/^\/api\/sessions\/([^/]+)(\/[a-z]+)?$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!NAME_RE.test(name) && !(await listSessions()).some((s) => s.name === name)) return send(res, 404, { error: 'Brak sesji' });
        if (m[2] === '/log' && req.method === 'GET') {
          const lines = Math.min(+url.searchParams.get('lines') || 3000, 20000);
          const out = await tmux(['capture-pane', '-p', '-J', '-t', target(name), '-S', `-${lines}`]);
          return send(res, 200, out.replace(/\n+$/, '\n'), 'text/plain; charset=utf-8');
        }
        if (m[2] === '/cmds' && req.method === 'GET') {
          const c = (await localAgents()).claude.find((x) => x.tmux === name);
          return send(res, 200, { cmds: c ? bangCommands(c.id) : [], blocks: c ? commandBlocks(c.id) : [] });
        }
        if (m[2] === '/send' && req.method === 'POST') {
          const { text, enter = true } = await readBody(req);
          await tmux(['send-keys', '-t', target(name), '-l', String(text || '')]);
          if (enter) await tmux(['send-keys', '-t', target(name), 'Enter']);
          return send(res, 200, { ok: true });
        }
        if (m[2] === '/continue' && req.method === 'POST') {
          const s = (await listSessions()).find((x) => x.name === name);
          if (!s) return send(res, 404, { error: 'Brak sesji' });
          if (s.status !== 'shell') return send(res, 409, { error: 'Agent w tej sesji wciąż działa' });
          const cmd = s.kind === 'codex' ? 'codex resume --last'
            : s.kind === 'claude' ? `claude --continue --remote-control ${shq(name)}` : '';
          if (!cmd) return send(res, 400, { error: 'To nie jest sesja agenta' });
          await tmux(['send-keys', '-t', target(name), cmd, 'Enter']);
          return send(res, 200, { ok: true });
        }
        if (!m[2] && req.method === 'DELETE') {
          await tmux(['kill-session', '-t', `=${name}`]);
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    }
    if (VENDOR[p]) return serveStatic(res, VENDOR[p]);
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    return serveStatic(res, file);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

// ---------- WebSocket: terminal podpięty do sesji tmux ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
// Origin bywa „null” albo śmieciem — nieparsowalny = odrzucony (wcześniej wyjątek kładł proces przed sprawdzeniem tokenu)
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function onUpgrade(req, socket, head) {
  socket.on('error', () => {});
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || !authed(req) || !originOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  } catch (e) {
    console.error('upgrade:', e.message);
    socket.destroy();
  }
}
server.on('upgrade', onUpgrade);

const clampInt = (v, min, max, def) => {
  if (v == null || v === '') return def; // +null i +'' dałyby 0, czyli minimum zamiast domyślnej
  const n = Math.trunc(+v);
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : def;
};

const WS_PING_MS = clampInt(process.env.WS_PING_MS, 1000, 300000, 25000); // też keepalive, żeby proxy nie zrywały bezczynnych połączeń
const WS_STALL_MS = 2 * WS_PING_MS; // tyle bez postępu wysyłki (klient nic nie odbiera) = martwy
const WS_HIGH = 1 << 20;   // > 1 MiB niewysłanych danych do klienta: pauza pty
const WS_LOW = 256 << 10;  // < 256 KiB: wznowienie

wss.on('connection', (ws, url) => {
  ws.on('error', (e) => console.error('ws:', e.message)); // np. zła ramka od klienta — bez tego wyjątek kładzie proces
  openTerminal(ws, url).catch((e) => {
    console.error('terminal:', e.message);
    try { ws.send(`\r\n\x1b[31mBłąd: ${e.message}\x1b[0m\r\n`); ws.close(); } catch {}
  });
});

async function openTerminal(ws, url) {
  const name = url.searchParams.get('s') || '';
  const hpane = url.searchParams.get('h') || '';
  let mach = null;
  try { mach = machineOf(url.searchParams.get('m')); } catch { ws.send('\r\n\x1b[31mNieznana maszyna.\x1b[0m\r\n'); return ws.close(); }
  const cols = clampInt(url.searchParams.get('c'), 20, 400, 80);
  const rows = clampInt(url.searchParams.get('r'), 5, 200, 24);
  let cmd, args, readOnly = false;
  if (hpane) {
    const it = await herdr.getPane(mach, hpane);
    if (!it) { ws.send('\r\n\x1b[31mPanel herdr nie istnieje.\x1b[0m\r\n'); return ws.close(); }
    readOnly = isBrainPane(it);
    [cmd, args] = mach ? ['ssh', attachArgs(mach, it.terminal)] : ['herdr', ['terminal', 'attach', it.terminal]];
  } else if (url.searchParams.get('shell') === '1') {
    // dok shella w Dyspozytorze: stała sesja ccp-shell (zakładana przy pierwszym otwarciu), mysz jak w zwykłej sesji
    const shell = await ensureShellSession(tmux, HOME);
    await tmux(['set-option', '-t', target(shell), 'mouse', 'on']).catch(() => {});
    [cmd, args] = ['tmux', ['attach-session', '-t', `=${shell}`]];
  } else {
    if (!(await listSessions()).some((s) => s.name === name)) {
      ws.send('\r\n\x1b[31mSesja nie istnieje.\x1b[0m\r\n');
      return ws.close();
    }
    // mysz w tmux: przewijanie gestem na telefonie przychodzi jako kółko myszy
    await tmux(['set-option', '-t', target(name), 'mouse', 'on']).catch(() => {});
    [cmd, args] = ['tmux', ['attach-session', '-t', `=${name}`]];
  }
  // klient mógł się rozłączyć w trakcie await — wtedy nie startujemy procesu, którego nikt by nie zamknął
  if (ws.readyState !== 1) return;
  const term = pty.spawn(cmd, args, {
    name: 'xterm-256color', cols, rows, cwd: HOME,
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' },
  });
  let closed = false, paused = false;
  let pongDue = 0, pingPending = false, lastDrain = Date.now();
  let ping = null, nudge = null;
  const size = { c: cols, r: rows }; // ostatni rozmiar zgłoszony przez klienta
  // jedno sprzątanie dla close, error i końca procesu (wołane wielokrotnie — działa raz)
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    clearTimeout(nudge);
    try { term.kill(); } catch {}
  };
  // backpressure: wolny telefon nie może zbierać w pamięci serwera nieograniczonej kolejki —
  // przy pełnym buforze WS wstrzymujemy odczyt z pty (tmux/herdr same trzymają historię), wznawiamy po opróżnieniu
  const resumeIfDrained = (err) => {
    if (err || closed || ws.readyState !== 1) return; // błąd zapisu kończy się close -> cleanup
    lastDrain = Date.now();
    if (paused && ws.bufferedAmount < WS_LOW) {
      paused = false;
      try { term.resume(); } catch {}
    }
  };
  term.onData((d) => {
    if (closed || ws.readyState !== 1) return;
    if (ws.bufferedAmount === 0) lastDrain = Date.now(); // kolejka była pusta — liczymy postęp od teraz
    ws.send(d, resumeIfDrained);
    if (!paused && ws.bufferedAmount > WS_HIGH) { paused = true; term.pause(); }
  });
  term.onExit(() => { cleanup(); if (ws.readyState === 1) ws.close(); });
  // pełny przerys po podłączeniu: przy niezmienionym rozmiarze herdr/tmux nie wysyłają aplikacji SIGWINCH,
  // a odtworzony ekran TUI (dół z paskiem statusu Claude) bywa rozjechany, dopóki okno nie zmieni rozmiaru.
  // Chwilowe -1 wiersz i powrót wymusza przerys bez udziału klienta.
  nudge = setTimeout(() => {
    if (closed) return;
    try { term.resize(size.c, Math.max(5, size.r - 1)); } catch { return; }
    nudge = setTimeout(() => { if (!closed) try { term.resize(size.c, size.r); } catch {} }, 150);
  }, 400);
  // heartbeat: ping stoi w tej samej kolejce co dane, więc czas na pong liczymy dopiero od jego faktycznego wysłania —
  // inaczej wolny, ale żywy klient z zaległym buforem byłby rozłączany. Osobno: brak jakiegokolwiek postępu wysyłki.
  // terminate -> 'close' -> cleanup
  ws.on('pong', () => { pongDue = 0; });
  ping = setInterval(() => {
    if (ws.readyState !== 1) return;
    const now = Date.now();
    if (pongDue && now > pongDue) return ws.terminate();                              // telefon zgubił sieć bez zamknięcia
    if (ws.bufferedAmount > 0 && now - lastDrain > WS_STALL_MS) return ws.terminate(); // klient nic nie odbiera
    if (pongDue || pingPending) return;
    pingPending = true;
    if (ws.bufferedAmount === 0) lastDrain = now; // po bezczynności licz zastój od tego pinga, nie od ostatnich danych
    ws.ping(undefined, undefined, (err) => {
      pingPending = false;
      if (err || closed) return;
      lastDrain = Date.now();
      // ping mógł utknąć w buforze jądra za danymi terminala — stąd zapas 2 interwałów; bardzo wolne łącze
      // i tak zostanie rozłączone, a frontend podłączy się ponownie i dostanie świeży ekran zamiast zaległości
      pongDue = Date.now() + WS_STALL_MS;
    });
  }, WS_PING_MS);
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.t === 'i' && !readOnly && typeof msg.d === 'string') term.write(msg.d);
      else if (msg.t === 'r') {
        size.c = clampInt(msg.c, 20, 400, cols);
        size.r = clampInt(msg.r, 5, 200, rows);
        term.resize(size.c, size.r);
      }
    } catch (e) { console.error('terminal msg:', e.message); }
  });
}

// ---------- powiadomienia: monitor zmian statusu ----------
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://panel.your-tailnet.ts.net';
const push = createPush(CFG_DIR, PUBLIC_URL);
const MIN_WORK_MS = 10000; // krótsze „pracuje” (np. echo pisania) nie daje powiadomienia
const watch = new Map();   // klucz -> { status, pending, pendingN, workSince, seen }
const shortCwd = (p) => (p || '').replace(/^\/(home|Users)\/[^/]+\/Projekty\//, '').replace(/^\/(home|Users)\/[^/]+/, '~');

async function watchItems() {
  const items = [];
  const tmuxList = await listSessions();
  for (const s of tmuxList) {
    if (s.status === 'shell') continue;
    items.push({ key: 'tmux:' + s.name, name: s.name, host: LOCAL_HOST, kind: s.kind || 'agent', cwd: s.cwd,
      status: s.status, ask: s.ask || null, url: '/#/s/' + encodeURIComponent(s.name), attached: s.attached > 0 });
  }
  const hs = await allHerdr();
  await addDisplayNames(hs);
  for (const it of hs.flatMap((h) => h.items)) {
    if (!it.agent) continue;
    items.push({ key: `herdr:${it.machine}:${it.pane}`, name: it.display || it.name, host: it.machine, kind: it.kind, cwd: it.cwd, workspace: it.workspace, tabLabel: it.tabLabel,
      status: it.status, ask: it.ask || null, url: `/#/h/${encodeURIComponent(it.machine)}/${encodeURIComponent(it.pane)}` });
  }
  for (const h of markRemoteHerdr(allHosts(await localAgentsWithHerdr()), hs)) {
    for (const c of h.sessions) {
      if (c.tmux || c.herdr) continue; // już monitorowana jako sesja tmux / herdr
      items.push({ key: `claude:${h.host}:${c.pid}`, name: c.name, host: h.host, kind: 'claude', cwd: c.cwd,
        status: c.status === 'bg' ? 'idle' : c.status, ask: c.ask || null, url: '/#/sesje' });
    }
    items.push(...looseCodexItems(h));
  }
  return items;
}

// powiadomienie w tle: nie blokuje ticka, a odrzucenie nie ucieka jako unhandled rejection
const notifySafe = (type, payload) => push.notify(type, payload).catch((e) => console.error('push:', e.message));

async function monitorTick() {
  await pullNotifications(mozg, push);
  if (!push.count()) return;
  const now = Date.now();
  for (const it of await watchItems()) {
    if (it.status === 'done') it.status = 'idle';
    let w = watch.get(it.key);
    if (!w) { watch.set(it.key, { status: it.status, workSince: it.status === 'working' ? now : 0, seen: now }); continue; }
    w.seen = now;
    if (it.status === w.status) { w.pending = null; continue; }
    // zmiana musi się utrzymać przez 2 odczyty (heurystyka tmux potrafi mignąć)
    if (w.pending !== it.status) { w.pending = it.status; continue; }
    const prev = w.status;
    w.status = it.status; w.pending = null;
    const where = `${it.host} · ${shortCwd(it.cwd)}`;
    const label = it.kind === 'codex' ? 'Codex' : it.kind === 'claude' ? 'Claude' : 'Agent';
    if (it.status === 'working') { w.workSince = now; continue; }
    if (it.status === 'approval') {
      // tylko krótka forma (nazwa narzędzia, plik): push idzie przez serwery push na telefon
      const ask = it.ask?.short ? `\n${it.ask.short}` : '';
      notifySafe('approval', { title: `⚠️ ${label} prosi o zgodę`, body: `${it.name}\n${where}${ask}`, url: it.url, tag: it.key });
    } else if (prev === 'working' && it.status === 'idle' && now - w.workSince >= MIN_WORK_MS && !it.attached && !excluded(it, workerLabel())) {
      notifySafe('done', { title: `✅ ${label} skończył`, body: `${it.name}\n${where}`, url: it.url, tag: it.key });
    }
  }
  for (const [k, w] of watch) if (now - w.seen > 60000) watch.delete(k);
}
// jeden przebieg naraz: przy niedostępnej maszynie tick trwa dłużej niż 3 s i przebiegi nakładałyby się na siebie,
// psując wspólną mapę watch (zła kolejność przejść = fałszywe powiadomienia)
let monitorBusy = false;
setInterval(async () => {
  if (monitorBusy) return;
  monitorBusy = true;
  try { await monitorTick(); } catch (e) { console.error('monitor:', e.message); } finally { monitorBusy = false; }
}, 3000);

// ---------- limit planu: Claude (mozgd) + sekcja codex (rollouty Codexa), kontrakt w docs/ARCHITEKTURA.md ----------
// MOZG_DB i CODEX_SESSIONS: tylko dla kopii testowej
function usageWithCodex() {
  const u = usageStatus(process.env.MOZG_DB || undefined);
  return { ...u, codex: codexUsage(process.env.CODEX_SESSIONS || undefined, u.now) };
}

// ---------- push z prognozy limitu planu (5h/7d) ----------
// Co 5 min: lib/usage-alerts.js decyduje, stan deduplikacji w CFG_DIR (przeżywa restart), mozg.db tylko odczyt.
// Codex: ten sam stan (klucze codex:5h/codex:7d) i ta sama konfiguracja, tylko crit.
// Konfiguracja: usage-alerts.json ({ enabled, quietFrom, quietTo }), czytana przy każdym przebiegu - bez restartu.
// USAGE_ALERTS_DRY=1: tylko log, bez wysyłki i bez zapisu stanu.
const USAGE_ALERTS_STATE = path.join(CFG_DIR, 'usage-alerts-state.json');
const USAGE_ALERTS_CFG = path.join(CFG_DIR, 'usage-alerts.json');
async function usageAlertsTick() {
  const dry = process.env.USAGE_ALERTS_DRY === '1';
  const usage = usageWithCodex(), cfg = usageAlerts.loadConfig(USAGE_ALERTS_CFG);
  let state = usageAlerts.readJson(USAGE_ALERTS_STATE, {});
  const notes = [];
  if (!usage.error) { const r = usageAlerts.decide(usage, state, usage.now, cfg); state = r.state; notes.push(...r.notes.map((n) => ['limit', n])); }
  // Codex: tylko crit >= 90%, push typu limitCodex (osobny wyłącznik w 🔔); brak próbek = nic
  if (usage.codex) { const r = usageAlerts.decide(usage.codex, state, usage.now, cfg, usageAlerts.CODEX); state = r.state; notes.push(...r.notes.map((n) => ['limitCodex', n])); }
  for (const [type, n] of notes) {
    console.log(`usage-alerts${dry ? ' (dry)' : ''}: ${n.title} | ${n.body}`);
    if (!dry) await push.notify(type, { title: n.title, body: n.body, url: n.url, tag: n.tag });
  }
  if (!dry) fs.writeFileSync(USAGE_ALERTS_STATE, JSON.stringify(state), { mode: 0o600 });
}
const usageAlertsSafe = () => usageAlertsTick().catch((e) => console.error('usage-alerts:', e.message));
setTimeout(usageAlertsSafe, 60 * 1000).unref();
setInterval(usageAlertsSafe, 5 * 60 * 1000).unref();

server.listen(PORT, HOST, () => console.log(`cc-panel na http://${HOST}:${PORT}, projekty: ${PROJECTS_ROOT}`));
// ---------- HTTPS dla dostępu z LAN (panel.example.com), certyfikat Let's Encrypt z certbota ----------
const TLS_PORT = +process.env.TLS_PORT || 7443;
const TLS_DIR = process.env.TLS_DIR || path.join(CFG_DIR, 'tls', 'le', 'live', process.env.TLS_NAME || 'panel.example.com');
function tlsOptions() {
  return { key: fs.readFileSync(path.join(TLS_DIR, 'privkey.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'fullchain.pem')) };
}
if (fs.existsSync(path.join(TLS_DIR, 'fullchain.pem'))) {
  const https = require('https');
  const tlsServer = https.createServer(tlsOptions(), (req, res) => server.emit('request', req, res));
  tlsServer.on('upgrade', onUpgrade);
  tlsServer.listen(TLS_PORT, HOST, () => console.log(`HTTPS (LAN) na https://${HOST}:${TLS_PORT}`));
  // certbot odnawia certyfikat w miejscu — przeładuj go okresowo bez restartu
  setInterval(() => { try { tlsServer.setSecureContext(tlsOptions()); } catch (e) { console.error('tls reload:', e.message); } }, 12 * 3600 * 1000);
}

if (REPORT_PORT) {
  http.createServer((req, res) => (req.url === '/report' ? handleReport(req, res) : send(res, 404, { error: 'not found' })))
    .listen(REPORT_PORT, HOST, () => console.log(`raporty (HTTP, przestarzałe) na http://${HOST}:${REPORT_PORT}/report`));
}
