// Podpinanie paneli Herdr do zakładek Dyspozytora: podział listy z panel_inventory i teksty (czyste funkcje, testy w node).
(function (root) {
  'use strict';
  const STATUS = { idle: 'bezczynny', done: 'skończył turę', working: 'pracuje', blocked: 'czeka na zgodę', unknown: 'bez agenta' };
  const statusText = s => STATUS[s] || s || '?';
  const minutes = s => Math.round((Number(s) || 0) / 60);
  const fields = p => [p.label, p.id, p.title, p.pane_label, p.tab_label, p.workspace_label];
  // bound: podpięte do tej zakładki; candidates: do podpięcia (pasujące do szukania, podpięte gdzie indziej na końcu);
  // hidden: panele mózgu i workery (nie do podpięcia)
  function split(panels, threadId, tokens, matches) {
    const bound = [], candidates = [];
    let hidden = 0;
    for (const p of panels || []) {
      if (p.binding && p.binding.thread_id === threadId) bound.push(p);
      else if (!p.bindable) hidden++;
      else if (!tokens.length || matches(fields(p), tokens)) candidates.push(p);
    }
    candidates.sort((a, b) => (!!a.binding - !!b.binding) || String(a.label || a.id).localeCompare(String(b.label || b.id), 'pl'));
    return { bound, candidates, hidden };
  }
  // drugi wiersz pozycji: id, status, tytuł terminala gdy różni się od etykiety
  const detail = p => [p.id, statusText(p.agent_status), p.title && p.title !== p.label ? p.title : ''].filter(Boolean).join(' · ');
  const api = { statusText, minutes, split, detail, fields };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MozgPanels = api;
})(typeof window === 'undefined' ? globalThis : window);
