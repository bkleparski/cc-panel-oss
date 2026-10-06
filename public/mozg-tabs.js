(function (root) {
  'use strict';
  const sortThreads = threads => [...threads].filter(t => !t.archived).sort((a, b) =>
    (a.id === 'general' ? -1 : b.id === 'general' ? 1 : (b.last_activity || 0) - (a.last_activity || 0)));
  function marker(thread, seen = 0) {
    if (thread.open_decisions > 0) return 'decision';
    if (thread.busy) return 'busy';
    if ((thread.last_brain_at || 0) > seen) return 'unread';
    return '';
  }
  function routeThread(hash, last = 'general') {
    // start aplikacji (pusty hash, '#/') i goła trasa otwierają Dyspozytora w ostatniej zakładce
    if (['', '#', '#/', '#/mozg'].includes(hash || '')) return last || 'general';
    const match = hash.match(/^#\/mozg\/([^/]+)$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return 'general'; }
  }
  const threadUrl = id => '/#/mozg/' + encodeURIComponent(id || 'general');
  const api = { sortThreads, marker, routeThread, threadUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MozgTabs = api;
})(typeof window === 'undefined' ? globalThis : window);
