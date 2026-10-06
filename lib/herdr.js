'use strict';
// Integracja z herdr (menedżer terminali dla agentów): lista paneli, tworzenie workspace z agentem,
// wznawianie, odczyt i zamykanie. Wszystko przez CLI `herdr`, które zwraca JSON.
// Każda funkcja przyjmuje maszynę `m`: null = lokalnie, obiekt z machines.js = przez SSH (cc-remote.py).
const { execFile } = require('child_process');
const { remoteCall } = require('./machines');

const PANE_RE = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const KINDS = new Set(['claude', 'codex']);
const STATUS = { working: 'working', blocked: 'approval', idle: 'idle', done: 'done' };

function runLocal(args, timeout) {
  return new Promise((resolve) =>
    execFile('herdr', args, { timeout, killSignal: 'SIGKILL', maxBuffer: 32 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr: stderr || (err ? err.message : '') })));
}

async function herdr(args, timeout = 8000, m = null) {
  const r = m ? await remoteCall(m, { op: 'herdr', args, timeout: timeout / 1000 }, timeout + 10000) : await runLocal(args, timeout);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  if (json?.error) throw new Error(json.error.message || json.error.code || 'herdr error');
  if (r.code && !json) throw new Error((r.stderr || `herdr: kod ${r.code}`).trim());
  return json ? json.result : r.stdout;
}

// jedno wywołanie zamiast trzech — ważne przy SSH; krótki cache chroni przed zalewem zapytań.
// Trwające zapytanie jest współdzielone (niedostępna maszyna = jedno SSH naraz, nie nowe co tick),
// a wiek wyniku liczony od jego otrzymania, nie od startu zapytania.
const cache = new Map(); // klucz maszyny -> { at, pending, p }
function listPanes(m = null, maxAgeMs = 2000) {
  const key = m ? m.ssh : '';
  const c = cache.get(key);
  if (c && (c.pending || Date.now() - c.at < maxAgeMs)) return c.p;
  const entry = { at: 0, pending: true, p: null };
  entry.p = fetchPanes(m).finally(() => { entry.pending = false; entry.at = Date.now(); }); // błąd wygasa po maxAgeMs jak zwykły wynik
  cache.set(key, entry);
  return entry.p;
}
const invalidate = (m = null) => cache.delete(m ? m.ssh : '');

async function fetchPanes(m) {
  let panes, workspaces, agents, tabs;
  try {
    [panes, workspaces, agents, tabs] = await Promise.all([
      herdr(['pane', 'list'], 8000, m), herdr(['workspace', 'list'], 8000, m), herdr(['agent', 'list'], 8000, m).catch(() => ({})), herdr(['tab', 'list'], 8000, m).catch(() => ({})),
    ]);
  } catch { return null; } // herdr nie działa albo maszyna niedostępna
  const tabLabels = new Map((tabs.tabs || []).map((t) => [t.tab_id, t.label || '']));
  const names = new Map();
  for (const a of agents.agents || []) if (a.name) names.set(a.pane_id, a.name);
  const wsLabel = new Map((workspaces.workspaces || []).map((w) => [w.workspace_id, w.label || w.workspace_id]));
  const perWs = new Map();
  for (const p of panes.panes || []) perWs.set(p.workspace_id, (perWs.get(p.workspace_id) || 0) + 1);
  return (panes.panes || []).map((p) => {
    const kind = KINDS.has(p.agent) ? p.agent : p.agent ? 'agent' : '';
    const workspace = wsLabel.get(p.workspace_id) || p.workspace_id;
    const title = p.terminal_title_stripped || '';
    return {
      pane: p.pane_id, terminal: p.terminal_id, workspaceId: p.workspace_id, workspace,
      agentName: names.get(p.pane_id) || '', label: p.label || '', tabLabel: tabLabels.get(p.tab_id) || '',
      // kilka paneli w workspace: dopisz etykietę/tytuł, chyba że powtarza nazwę workspace („app-code · app-code”)
      name: perWs.get(p.workspace_id) > 1 && (p.label || title || p.pane_id) !== workspace
        ? `${workspace} · ${p.label || title || p.pane_id}` : workspace,
      title, kind, agent: p.agent || '',
      status: p.agent ? (STATUS[p.agent_status] || 'working') : 'shell',
      cwd: p.foreground_cwd || p.cwd || '',
      sessionId: p.agent_session?.value || '',
    };
  });
}

async function getPane(m, pane) {
  if (!PANE_RE.test(pane)) return null;
  const list = await listPanes(m);
  return list ? list.find((p) => p.pane === pane) || null : null;
}

// nazwa agenta w herdr: [a-z][a-z0-9_-]{0,31}, unikalna wśród żywych agentów
async function freeAgentName(m, base) {
  let taken = new Set();
  try { taken = new Set(((await herdr(['agent', 'list'], 8000, m)).agents || []).map((a) => a.name).filter(Boolean)); } catch {}
  let b = String(base || 'agent').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 28) || 'agent';
  let n = b, i = 2;
  while (taken.has(n)) n = `${b}-${i++}`;
  return n;
}

// invalidate przed (nie serwuj starego) i po, także przy błędzie (odczyt w trakcie mógł złapać stan przejściowy)
async function startAgent(m, pane, kind, name, args, timeoutMs = 45000) {
  invalidate(m);
  try {
    return await herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(timeoutMs), '--', ...args], timeoutMs + 5000, m);
  } finally { invalidate(m); }
}

async function createWorkspace(m, { cwd, label, kind, args }) {
  const ws = await herdr(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'], 10000, m);
  invalidate(m);
  const pane = ws.root_pane.pane_id;
  if (KINDS.has(kind)) {
    // start agenta trwa kilka sekund; nie blokujemy odpowiedzi — terminal pokaże postęp
    startAgent(m, pane, kind, await freeAgentName(m, label), args)
      .catch((e) => console.error('herdr agent start:', e.message));
  }
  return pane;
}

async function readPane(m, pane, lines) {
  // recent-unwrapped skleja linie zawinięte przez terminal (łatwiej skopiować polecenie); herdr 0.8.x go nie zna
  const read = (src) => herdr(['pane', 'read', pane, '--source', src, '--lines', String(lines), '--format', 'text'], 10000, m);
  const out = await read('recent-unwrapped').catch(() => read('recent'));
  return typeof out === 'string' ? out : out.read?.text ?? out.text ?? JSON.stringify(out);
}

async function closePane(m, pane) {
  invalidate(m);
  try { return await herdr(['pane', 'close', pane], 8000, m); } finally { invalidate(m); }
}

module.exports = { PANE_RE, listPanes, getPane, createWorkspace, startAgent, freeAgentName, readPane, closePane };
