'use strict';
const net = require('net');
const path = require('path');
const os = require('os');
const { threadUrl } = require('../public/mozg-tabs');
const { imagesLabel } = require('../public/mozg-images');
const isBrainPane = (pane) => typeof pane?.tabLabel === 'string' && pane.tabLabel.startsWith('mozg-g');
function createMozg(socketPath = path.join(os.homedir(), '.local/state/mozg/mozgd.sock'), defaultTimeout = 3000) {
  // timeout per wywołanie: panel_* czyta Herdr i rotator (kilka procesów CLI), reszta to sama baza
  function call(method, params = {}, timeout = defaultTimeout) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let input = '', settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Dyspozytor offline (timeout)')), timeout);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
      socket.on('error', () => finish(new Error('Dyspozytor offline')));
      socket.on('end', () => finish(new Error('Dyspozytor offline (rozłączono)')));
      socket.on('data', (data) => {
        input += data;
        if (Buffer.byteLength(input) > 64 * 1024 * 1024) return finish(new Error('Zbyt duża odpowiedź dyspozytora'));
        const end = input.indexOf('\n');
        if (end < 0) return;
        try {
          const response = JSON.parse(input.slice(0, end));
          if (response.id !== 1 || (!('result' in response) && !response.error)) throw new Error('Zła odpowiedź dyspozytora');
          finish(response.error ? new Error(response.error) : null, response.result);
        } catch (e) { finish(e); }
      });
    });
  }
  async function threads(details = false) {
    return readThreads(call, details);
  }
  async function scoped(method, params, threadId = 'general') {
    const list = await threads();
    if (list.legacy && threadId !== 'general') throw new Error('Ta wersja dyspozytora obsługuje tylko Ogólne');
    return call(method, list.legacy ? params : { ...params, thread_id: threadId });
  }
  return { call, threads, scoped, status: async (threadId) => {
    try {
      const list = await threads();
      const selected = threadId ? list.threads.filter(t => t.id === threadId) : list.threads;
      const open = list.threads.filter(t => !t.archived);
      return { online: true, busy: selected.some(t => t.busy), tabs: open.length,
        decisions: open.reduce((n, t) => n + (Number(t.open_decisions) || 0), 0),
        activity: Math.max(0, ...open.map(t => Number(t.last_activity) || 0)) };
    } catch { return { online: false }; }
  } };

}
async function readThreads(call, details = false) {
  let threads, legacy = false;
  try { threads = await call('threads'); }
  catch (e) {
    if (!/^(register first|unknown method|unknown tool)$/.test(e.message)) throw e;
    const thread = await call('thread', { limit: 100 });
    legacy = true;
    threads = [{ id: 'general', title: 'Ogólne', archived: 0, last_activity: 0, busy: !!thread.busy, state: thread.state, open_decisions: (thread.open_decisions || []).length, session: null, last_brain_at: latestBrain(thread.messages), decisions: thread.open_decisions || [] }];
  }
  if (!Array.isArray(threads)) throw new Error('Zła lista zakładek dyspozytora');
  if (details && !legacy) threads = await Promise.all(threads.map(async t => {
    const thread = await call('thread', { limit: 100, thread_id: t.id });
    return { ...t, last_brain_at: latestBrain(thread.messages), decisions: thread.open_decisions || [] };
  }));
  return { threads, legacy };
}
function latestBrain(messages = []) {
  return messages.reduce((at, message) => ['reply', 'info', 'decision', 'alarm', 'digest'].includes(message.level) ? Math.max(at, message.created || 0) : at, 0);
}
let pullPausedUntil = 0;
async function pullNotifications(mozg, push, now = Date.now()) {
  if (now < pullPausedUntil) return;
  let due;
  try { due = await mozg.call('due_notifications', { limit: 100 }); } catch { return; }
  for (const n of due) {
    try {
      await push.notify('mozg', { title: n.thread_title ? `📡 ${n.thread_title}: ${n.level === 'decision' ? 'prosi o decyzję' : n.title}` : n.title, body: (n.images ? `🖼 +${imagesLabel(n.images)} · ` : '') + Array.from(n.text).slice(0, 120).join(''), url: n.thread_id ? threadUrl(n.thread_id) : '/#/mozg', tag: 'mozg-' + n.notification_id });
      await mozg.call('mark_sent', { notification_id: n.notification_id });
    } catch (e) {
      // usluga push albo mozg niedostepne: przerwa 60 s zamiast ponawiania co tick monitora
      console.error('mozg push:', e.message);
      pullPausedUntil = now + 60000;
      return;
    }
  }
}
module.exports = { createMozg, isBrainPane, pullNotifications, readThreads, latestBrain };
