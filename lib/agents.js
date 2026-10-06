'use strict';
// Wykrywanie działających sesji Codex (po otwartym pliku rollout) i lista ostatnich rozmów
// Claude/Codex do wznowienia. Tylko Linux (/proc) — inne maszyny raportują przez cc-report.py.
const fs = require('fs');
const path = require('path');
const { codexMetadata } = require('./codex-sessions');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_RE = new RegExp(`/\\.codex/sessions/.*rollout-.*?(${UUID})\\.jsonl$`);
const ID_RE = new RegExp(`^${UUID}$`);

function readChunk(file, fromEnd, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const readHead = (f, n = 65536) => readChunk(f, false, n);
const readTail = (f, n = 65536) => readChunk(f, true, n);

// pierwszy / ostatni string JSON pod danym kluczem, bez parsowania całych (ogromnych) linii
function jsonStr(text, key, last = false) {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m, found = null;
  while ((m = re.exec(text))) { found = m[1]; if (!last) break; }
  if (found === null) return '';
  try { return JSON.parse(`"${found}"`); } catch { return found; }
}

// ---------- Codex ----------
function codexThreadNames(home) {
  const names = new Map();
  const text = readTail(path.join(home, '.codex', 'session_index.jsonl'), 1 << 20);
  for (const line of text.split('\n')) {
    try { const j = JSON.parse(line); if (j.id && j.thread_name) names.set(j.id, { title: j.thread_name, at: Date.parse(j.updated_at) / 1000 || 0 }); } catch {}
  }
  return names;
}

// status z końcówki rolloutu: ostatnie zdarzenie cyklu zadania. Prośby o zgodę tu nie ma: Codex nie zapisuje
// zdarzeń *approval_request* do rolloutu (rozpoznanie 05.10, codex-cli 0.160, 0 w 36 plikach) - "approval" daje herdr.
function codexRolloutInfo(file, names) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  const id = (file.match(ROLLOUT_RE) || [])[1] || '';
  const head = readHead(file, 32768);
  const cwd = jsonStr(head, 'cwd');
  const metadata = codexMetadata(head);
  const lines = readTail(file, 65536).split('\n');
  let phase = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    const t = j.payload?.type || j.type || '';
    if (t === 'token_count' || j.type === 'token_usage_record') continue;
    if (/^(task_started|task_complete|turn_aborted)$/.test(t)) { phase = t; break; }
  }
  let status;
  if (phase === 'task_started') status = 'working';
  else if (phase) status = 'idle';
  else status = Date.now() / 1000 - st.mtimeMs / 1000 < 10 ? 'working' : 'idle';
  return { id, cwd, ...metadata, title: names.get(id)?.title || '', status, updated: st.mtimeMs / 1000 };
}

function procField(pid, name) {
  try { return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8'); } catch { return ''; }
}
function ppidOf(pid) {
  const s = procField(pid, 'stat');
  return s ? +s.slice(s.lastIndexOf(')') + 2).split(' ')[1] : 0;
}

// panes: Map(pid powłoki panelu tmux -> nazwa sesji)
function listCodexLocal(home, panes) {
  const names = codexThreadNames(home);
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    if (procField(pid, 'comm').trim() !== 'codex') continue;
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    const rollouts = new Set();
    for (const fd of fds) {
      let target = '';
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (ROLLOUT_RE.test(target)) rollouts.add(target);
    }
    if (!rollouts.size) continue;
    // serwer zdalnego sterowania Codexa (app-server) trzyma kilka wątków naraz — każdy to osobna rozmowa
    const appServer = procField(pid, 'cmdline').split('\0').includes('app-server');
    // przodkowie aż do powłoki panelu tmux (codex -> node -> bash)
    let tmux = null;
    for (let p = +pid, i = 0; p > 1 && i < 6 && !tmux; i++, p = ppidOf(p)) tmux = panes.get(p) || null;
    for (const rollout of appServer ? rollouts : [...rollouts].slice(0, 1)) {
      const info = codexRolloutInfo(rollout, names);
      if (info) out.push({ pid: +pid, ...info, name: info.title || path.basename(info.cwd || ''), tmux, appServer });
    }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

// ---------- ostatnie rozmowy do wznowienia ----------
function recentClaude(home, limit) {
  const root = path.join(home, '.claude', 'projects');
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl') || !ID_RE.test(f.slice(0, -6))) continue;
      const full = path.join(root, d, f);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (st?.isFile()) files.push({ full, id: f.slice(0, -6), at: st.mtimeMs / 1000 });
    }
  }
  files.sort((a, b) => b.at - a.at);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const head = readHead(f.full, 131072);
    const cwd = jsonStr(head, 'cwd');
    if (!cwd) continue; // rozmowa bez żadnej wymiany (np. od razu zamknięta)
    const tail = readTail(f.full, 262144);
    // pomiń „rozmowy” bez żadnej odpowiedzi (np. samo /model i wyjście)
    if (!head.includes('"type":"assistant"') && !tail.includes('"type":"assistant"')) continue;
    let title = jsonStr(tail, 'customTitle', true) || jsonStr(tail, 'aiTitle', true)
      || jsonStr(head, 'customTitle', true) || jsonStr(head, 'aiTitle', true);
    if (!title) {
      for (const line of head.split('\n')) {
        if (!line.includes('"type":"user"')) continue;
        try {
          const c = JSON.parse(line).message?.content;
          const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : '');
          if (text && !text.startsWith('<')) { title = text.replace(/\s+/g, ' ').slice(0, 90); break; }
        } catch {}
      }
    }
    out.push({ kind: 'claude', id: f.id, cwd, title: title || '(bez tytułu)', at: f.at });
  }
  return out;
}

function recentCodex(home, limit) {
  const names = codexThreadNames(home);
  const root = path.join(home, '.codex', 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && ROLLOUT_RE.test(full)) {
        files.push({ full, at: fs.statSync(full).mtimeMs / 1000 });
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.at - a.at);
  return files.slice(0, limit).map((f) => {
    const id = f.full.match(ROLLOUT_RE)[1];
    return { kind: 'codex', id, cwd: jsonStr(readHead(f.full, 32768), 'cwd'), title: names.get(id)?.title || '(bez tytułu)', at: f.at };
  }).filter((r) => r.cwd);
}

function listRecent(home, runningIds, limit = 12) {
  return [...recentClaude(home, limit + runningIds.size), ...recentCodex(home, limit)]
    .filter((r) => !runningIds.has(r.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

module.exports = { listCodexLocal, listRecent, ID_RE };
