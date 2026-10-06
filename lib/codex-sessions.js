'use strict';
function codexMetadata(head) {
  for (const line of head.split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record.type !== 'session_meta') continue;
      const meta = record.payload || {};
      return { subagent: !!meta.parent_thread_id || !!(meta.source && typeof meta.source === 'object' && meta.source.subagent), parentThreadId: typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id : '' };
    } catch {}
  }
  return { subagent: false, parentThreadId: '' };
}
function matchCodexHerdr(sessions, items) {
  const panes = items.filter(i => i.kind === 'codex');
  const unique = list => list.length === 1 ? list[0].pane : null;
  for (const session of sessions || []) {
    session.herdr = null;
    if (session.tmux || session.subagent) continue;
    const exact = panes.filter(i => i.sessionId && i.sessionId === session.id);
    if (exact.length) { session.herdr = unique(exact); continue; }
    const candidates = panes.filter(i => i.cwd && i.cwd === session.cwd && (!i.sessionId || i.sessionId === session.id));
    const named = candidates.filter(i => session.title && (i.title || '').replace(/\s+\|\s+[^|]*$/, '').trim() === session.title);
    session.herdr = unique(named) || unique(candidates);
  }
}
function looseCodexItems(host) {
  const seen = new Set();
  return (host.codex || []).filter(c => {
    if (c.tmux || c.herdr) return false;
    const key = c.id || `pid:${c.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(c => ({ key: `codex:${host.host}:${c.pid}:${c.id}`, name: c.name, host: host.host, kind: 'codex', cwd: c.cwd, status: c.status, subagent: c.subagent, url: '/#/sesje' }));
}
module.exports = { codexMetadata, matchCodexHerdr, looseCodexItems };
